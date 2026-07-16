import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  retryDelayMs,
  type ContinuationClaim,
  type ContinuationCreateRequest,
  type ContinuationDeliveryClaim,
  type ContinuationDeliveryResult,
  type ContinuationDeliveryRoute,
  type ContinuationExecutionResult,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationStatus,
} from '../domain/continuation.js';
import type { ContinuationRepository } from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

interface SqliteContinuationRepositoryOptions {
  databasePath: string;
  artifactsDir: string;
  jitter?: () => number;
}

const SCHEMA_VERSION = 1;
const DELIVERY_LEASE_MS = 30_000;
const EMPTY_CHECKPOINT = {
  summary: '',
  completedSteps: [],
  remainingSteps: [],
  constraints: [],
  decisions: [],
  references: [],
};

export class SqliteContinuationRepository implements ContinuationRepository {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly artifacts: ContinuationArtifactStore,
    private readonly jitter: () => number,
  ) {}

  static async open(
    options: SqliteContinuationRepositoryOptions,
  ): Promise<SqliteContinuationRepository> {
    const databasePath = path.resolve(options.databasePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(databasePath), 0o700);

    // Keep loading node:sqlite behind the explicit Node version gate used at startup.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });
    try {
      await fs.chmod(databasePath, 0o600);
      const artifacts = new ContinuationArtifactStore(options.artifactsDir);
      await artifacts.ensureRoot();
      const repository = new SqliteContinuationRepository(
        database,
        artifacts,
        options.jitter ?? Math.random,
      );
      await repository.initialize();
      return repository;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async initialize(): Promise<void> {
    const existingVersion = Number(this.scalar('PRAGMA user_version'));
    if (existingVersion > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported continuation database schema version ${existingVersion}; expected at most ${SCHEMA_VERSION}.`,
      );
    }
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    if (existingVersion === 0) this.transaction(() => {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS continuation_jobs (
        job_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        retry_of_job_id TEXT REFERENCES continuation_jobs(job_id),
        creator_open_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK(origin_kind IN ('message_thread', 'comment_thread')),
        route_json TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_thread_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        context_snapshot_json TEXT NOT NULL,
        required_tools_json TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        model TEXT,
        parent_session_id TEXT,
        max_steps INTEGER NOT NULL,
        max_retries INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        row_version INTEGER NOT NULL CHECK(row_version >= 1),
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'waiting_retry', 'cancel_requested',
          'completed', 'failed', 'cancelled'
        )),
        execution_session_id TEXT,
        checkpoint_json TEXT,
        step_count INTEGER NOT NULL CHECK(step_count >= 0),
        failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
        next_run_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        result_summary TEXT,
        result_artifacts_json TEXT NOT NULL,
        error_code TEXT,
        error_summary TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        deleted_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS continuation_jobs_due_idx
        ON continuation_jobs(status, next_run_at, created_at)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS continuation_jobs_creator_idx
        ON continuation_jobs(creator_open_id, created_at DESC)
        WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS continuation_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
        ordinal INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        execution_session_id TEXT,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN (
          'continue', 'completed', 'failed', 'blocked', 'error', 'cancelled'
        )),
        error_code TEXT,
        error_summary TEXT,
        UNIQUE(job_id, ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS continuation_outbox (
        outbox_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES continuation_jobs(job_id),
        route_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'sending', 'delivered', 'delivery_unknown', 'failed'
        )),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        worker_id TEXT,
        lease_expires_at TEXT,
        first_attempt_at TEXT,
        last_attempt_at TEXT,
        message_id TEXT,
        error_code TEXT,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS continuation_outbox_due_idx
        ON continuation_outbox(status, next_attempt_at, created_at);
      PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
    await this.healthCheck();
  }

  async healthCheck(): Promise<void> {
    const version = Number(this.scalar('PRAGMA user_version'));
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `Unsupported continuation database schema version ${version}; expected ${SCHEMA_VERSION}.`,
      );
    }
    const row = this.database.prepare('PRAGMA quick_check').get();
    const value = row ? String(Object.values(row)[0]) : '';
    if (value !== 'ok') throw new Error(`Continuation database quick_check failed: ${value}`);
  }

  async create(
    request: ContinuationCreateRequest,
  ): Promise<{ job: ContinuationJob; created: boolean }> {
    validateCreateRequest(request);
    const jobId = makeId('job');
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO continuation_jobs (
        job_id, idempotency_key, retry_of_job_id, creator_open_id, origin_kind, route_json,
        source_message_id, source_thread_id, title, objective,
        acceptance_criteria_json, context_snapshot_json, required_tools_json,
        working_directory, model, parent_session_id, max_steps, max_retries,
        timeout_seconds, created_at, expires_at, row_version, status,
        step_count, failure_count, next_run_at, result_artifacts_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued',
        0, 0, ?, '[]', ?
      )
    `).run(
      jobId,
      request.idempotencyKey,
      request.retryOfJobId ?? null,
      request.creatorOpenId,
      request.route.kind,
      JSON.stringify(request.route),
      request.sourceMessageId,
      request.sourceThreadId ?? null,
      request.title,
      request.objective,
      JSON.stringify(request.acceptanceCriteria),
      JSON.stringify(request.contextSnapshot),
      JSON.stringify(request.requiredTools),
      request.workingDirectory,
      request.model ?? null,
      request.parentSessionId ?? null,
      request.maxSteps,
      request.maxRetries,
      request.timeoutSeconds,
      request.createdAt,
      request.expiresAt,
      request.createdAt,
      request.createdAt,
    );
    const created = Number(inserted.changes) === 1;
    const job = created
      ? await this.get(jobId)
      : this.readJobByIdempotencyKey(request.idempotencyKey);
    if (!job) throw new Error('Continuation create succeeded without a readable job row.');
    return { job, created };
  }

  async get(jobId: string): Promise<ContinuationJob | null> {
    return this.readJobBy('j.job_id = ?', jobId);
  }

  async listByCreator(creatorOpenId: string, limit: number): Promise<ContinuationJob[]> {
    return this.listJobs('j.creator_open_id = ?', creatorOpenId, limit);
  }

  async listAll(limit: number): Promise<ContinuationJob[]> {
    return this.listJobs('1 = 1', undefined, limit);
  }

  async claimDue(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ContinuationClaim | null> {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT job_id
        FROM continuation_jobs
        WHERE status IN ('queued', 'waiting_retry')
          AND deleted_at IS NULL
          AND next_run_at <= ?
          AND expires_at > ?
        ORDER BY next_run_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now);
      if (!row) return null;
      const jobId = stringField(row, 'job_id');
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?, row_version = row_version + 1
        WHERE job_id = ?
          AND status IN ('queued', 'waiting_retry')
          AND deleted_at IS NULL
          AND next_run_at <= ?
          AND expires_at > ?
      `).run(workerId, leaseExpiresAt, now, now, now, jobId, now, now);
      if (Number(update.changes) !== 1) return null;

      const ordinal = Number(this.database.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM continuation_attempts WHERE job_id = ?
      `).get(jobId)?.ordinal ?? 1);
      const attemptId = makeId('att');
      this.database.prepare(`
        INSERT INTO continuation_attempts (
          attempt_id, job_id, ordinal, worker_id, started_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(attemptId, jobId, ordinal, workerId, now, now);

      const job = this.readJobBy('j.job_id = ?', jobId);
      if (!job) throw new Error(`Claimed continuation job ${jobId} disappeared.`);
      return {
        job,
        workerId,
        claimedRowVersion: job.rowVersion,
        attempt: {
          attemptId,
          jobId,
          ordinal,
          workerId,
          executionSessionId: job.executionSessionId,
          startedAt: now,
          heartbeatAt: now,
        },
      };
    });
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE continuation_jobs
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running' AND lease_owner = ?
      `).run(now, leaseExpiresAt, now, jobId, workerId);
      if (Number(result.changes) !== 1) return false;
      const attemptId = this.activeAttemptId(jobId, workerId);
      if (attemptId) {
        this.database.prepare(`
          UPDATE continuation_attempts
          SET heartbeat_at = ?
          WHERE attempt_id = ? AND finished_at IS NULL
        `).run(now, attemptId);
      }
      return true;
    });
  }

  async completeStep(
    claim: ContinuationClaim,
    result: ContinuationExecutionResult,
    now: string,
  ): Promise<void> {
    this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      const executionSessionId = result.executionSessionId === undefined
        ? current.executionSessionId
        : result.executionSessionId ?? undefined;
      const outcome = result.outcome;

      if (outcome.outcome === 'continue') {
        assertJsonBytes(
          'checkpoint',
          outcome.checkpoint,
          CONTINUATION_LIMITS.checkpointBytes,
        );
        const stepCount = current.stepCount + 1;
        if (stepCount >= current.maxSteps) {
          this.finishTerminal(
            claim,
            current,
            'failed',
            now,
            'max_steps_exceeded',
            `Continuation reached its maximum of ${current.maxSteps} steps.`,
          );
          return;
        }
        const nextRunAt = addMilliseconds(now, Math.max(0, outcome.resumeAfterSeconds ?? 0) * 1_000);
        const update = this.database.prepare(`
          UPDATE continuation_jobs
          SET status = 'waiting_retry', execution_session_id = ?, checkpoint_json = ?,
              step_count = ?, failure_count = 0, next_run_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?,
              row_version = row_version + 1, error_code = NULL, error_summary = NULL
          WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
        `).run(
          executionSessionId ?? null,
          JSON.stringify(outcome.checkpoint),
          stepCount,
          nextRunAt,
          now,
          claim.job.jobId,
          claim.workerId,
          claim.claimedRowVersion,
        );
        assertOneChange(update.changes, claim.job.jobId);
        this.finishAttempt(claim, now, 'continue', executionSessionId);
        return;
      }

      if (outcome.outcome === 'completed') {
        validateFinalResult(
          outcome.finalMessage,
          outcome.resultSummary,
          outcome.artifacts,
        );
        const update = this.database.prepare(`
          UPDATE continuation_jobs
          SET status = 'completed', execution_session_id = ?, step_count = step_count + 1,
              result_summary = ?, result_artifacts_json = ?, completed_at = ?, updated_at = ?,
              lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
              row_version = row_version + 1
          WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
        `).run(
          executionSessionId ?? null,
          outcome.resultSummary ?? null,
          JSON.stringify(outcome.artifacts),
          now,
          now,
          claim.job.jobId,
          claim.workerId,
          claim.claimedRowVersion,
        );
        assertOneChange(update.changes, claim.job.jobId);
        this.finishAttempt(claim, now, 'completed', executionSessionId);
        this.insertTerminalOutbox(
          current,
          `Task completed: ${current.jobId}\n${outcome.finalMessage}`,
          now,
        );
        return;
      }

      const retryable = outcome.outcome === 'failed' && outcome.retryable;
      this.finishFailure(
        claim,
        current,
        {
          errorCode: outcome.errorCode,
          errorSummary: outcome.errorSummary,
          retryable,
        },
        now,
        executionSessionId,
      );
    });
  }

  async failAttempt(
    claim: ContinuationClaim,
    failure: ContinuationFailure,
    now: string,
  ): Promise<void> {
    this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      this.finishFailure(claim, current, failure, now, current.executionSessionId);
    });
  }

  async requestCancel(
    jobId: string,
    now: string,
  ): Promise<'cancelled' | 'cancel_requested' | 'terminal' | 'missing'> {
    return this.transaction(() => {
      const current = this.readJobBy('j.job_id = ?', jobId);
      if (!current) return 'missing';
      if (isContinuationTerminal(current.status)) return 'terminal';
      if (current.status === 'cancel_requested') return 'cancel_requested';
      if (current.status === 'running') {
        this.database.prepare(`
          UPDATE continuation_jobs
          SET status = 'cancel_requested', updated_at = ?, row_version = row_version + 1
          WHERE job_id = ? AND status = 'running'
        `).run(now, jobId);
        return 'cancel_requested';
      }

      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET status = 'cancelled', completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            row_version = row_version + 1
        WHERE job_id = ? AND status IN ('queued', 'waiting_retry')
      `).run(now, now, jobId);
      if (Number(update.changes) !== 1) return 'terminal';
      this.insertTerminalOutbox(
        current,
        `Task cancelled: ${jobId}\nThe background task was cancelled.`,
        now,
      );
      return 'cancelled';
    });
  }

  async completeCancellation(claim: ContinuationClaim, now: string): Promise<void> {
    this.transaction(() => {
      const current = this.readJobBy('j.job_id = ?', claim.job.jobId);
      if (!current || current.status !== 'cancel_requested' || current.leaseOwner !== claim.workerId) {
        throw staleClaimError(claim.job.jobId);
      }
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET status = 'cancelled', completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            row_version = row_version + 1
        WHERE job_id = ? AND status = 'cancel_requested' AND lease_owner = ?
      `).run(now, now, claim.job.jobId, claim.workerId);
      assertOneChange(update.changes, claim.job.jobId);
      this.finishAttempt(claim, now, 'cancelled', current.executionSessionId);
      this.insertTerminalOutbox(
        current,
        `Task cancelled: ${current.jobId}\nThe background task was cancelled.`,
        now,
      );
    });
  }

  async recoverExpiredLeases(now: string): Promise<number> {
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT job_id
        FROM continuation_jobs
        WHERE status IN ('running', 'cancel_requested')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
          AND deleted_at IS NULL
      `).all(now);
      for (const row of rows) {
        const jobId = stringField(row, 'job_id');
        const current = this.readJobBy('j.job_id = ?', jobId);
        if (!current) continue;
        const attemptId = this.activeAttemptId(jobId, current.leaseOwner);
        if (current.status === 'cancel_requested') {
          this.database.prepare(`
            UPDATE continuation_jobs
            SET status = 'cancelled', completed_at = ?, updated_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                row_version = row_version + 1
            WHERE job_id = ? AND status = 'cancel_requested' AND lease_expires_at <= ?
          `).run(now, now, jobId, now);
          this.finishAttemptById(attemptId, now, 'cancelled', 'lease_expired', 'Cancelled after worker lease expired.');
          this.insertTerminalOutbox(
            current,
            `Task cancelled: ${jobId}\nThe background task was cancelled.`,
            now,
          );
          continue;
        }

        const failureCount = current.failureCount + 1;
        if (failureCount <= current.maxRetries && current.expiresAt > now) {
          const nextRunAt = addMilliseconds(now, retryDelayMs(failureCount, this.jitter()));
          this.database.prepare(`
            UPDATE continuation_jobs
            SET status = 'waiting_retry', failure_count = ?, next_run_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                error_code = 'lease_expired', error_summary = 'Worker lease expired.',
                updated_at = ?, row_version = row_version + 1
            WHERE job_id = ? AND status = 'running' AND lease_expires_at <= ?
          `).run(failureCount, nextRunAt, now, jobId, now);
          this.finishAttemptById(attemptId, now, 'error', 'lease_expired', 'Worker lease expired.');
        } else {
          this.database.prepare(`
            UPDATE continuation_jobs
            SET status = 'failed', failure_count = ?, completed_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                error_code = 'lease_expired', error_summary = 'Worker lease expired and retry budget was exhausted.',
                updated_at = ?, row_version = row_version + 1
            WHERE job_id = ? AND status = 'running' AND lease_expires_at <= ?
          `).run(failureCount, now, now, jobId, now);
          this.finishAttemptById(
            attemptId,
            now,
            'error',
            'lease_expired',
            'Worker lease expired and retry budget was exhausted.',
          );
          this.insertTerminalOutbox(
            current,
            `Task failed: ${jobId}\nWorker lease expired and retry budget was exhausted.`,
            now,
          );
        }
      }
      return rows.length;
    });
  }

  async cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob> {
    const source = await this.get(jobId);
    if (!source || !isContinuationTerminal(source.status) || source.deletedAt) {
      throw new Error(`Continuation ${jobId} is not an available terminal job.`);
    }
    const lifetimeMs = Math.max(1, Date.parse(source.expiresAt) - Date.parse(source.createdAt));
    const { job } = await this.create({
      idempotencyKey: `manual-retry:${jobId}:${requestId}`,
      retryOfJobId: jobId,
      creatorOpenId: source.creatorOpenId,
      route: source.route,
      sourceMessageId: source.sourceMessageId,
      sourceThreadId: source.sourceThreadId,
      title: source.title,
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria,
      contextSnapshot: source.contextSnapshot,
      requiredTools: source.requiredTools,
      workingDirectory: source.workingDirectory,
      model: source.model,
      parentSessionId: source.parentSessionId,
      maxSteps: source.maxSteps,
      maxRetries: source.maxRetries,
      timeoutSeconds: source.timeoutSeconds,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + lifetimeMs).toISOString(),
    });
    return job;
  }

  async redactTerminal(jobId: string, now: string): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current || !isContinuationTerminal(current.status) || current.deletedAt) return false;
    await this.artifacts.remove(jobId);
    return this.transaction(() => {
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET idempotency_key = ?, origin_kind = 'message_thread', route_json = ?,
            source_message_id = '', source_thread_id = NULL,
            title = '', objective = '', acceptance_criteria_json = '[]',
            context_snapshot_json = ?, required_tools_json = '[]', working_directory = '',
            model = NULL, parent_session_id = NULL, execution_session_id = NULL,
            checkpoint_json = NULL, result_summary = NULL, result_artifacts_json = '[]',
            error_summary = NULL, deleted_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE job_id = ? AND status IN ('completed', 'failed', 'cancelled') AND deleted_at IS NULL
      `).run(
        `redacted:${jobId}`,
        JSON.stringify(emptyRoute()),
        JSON.stringify(EMPTY_CHECKPOINT),
        now,
        now,
        jobId,
      );
      if (Number(update.changes) !== 1) return false;
      this.database.prepare(`
        UPDATE continuation_outbox
        SET route_json = ?, payload = '', error_summary = NULL, updated_at = ?
        WHERE job_id = ?
      `).run(JSON.stringify(emptyRoute()), now, jobId);
      return true;
    });
  }

  async claimPendingDelivery(
    workerId: string,
    now: string,
  ): Promise<ContinuationDeliveryClaim | null> {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT outbox_id
        FROM continuation_outbox
        WHERE (
          status = 'pending'
          OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now);
      if (!row) return null;
      const outboxId = stringField(row, 'outbox_id');
      const leaseExpiresAt = addMilliseconds(now, DELIVERY_LEASE_MS);
      const update = this.database.prepare(`
        UPDATE continuation_outbox
        SET status = 'sending', worker_id = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            first_attempt_at = COALESCE(first_attempt_at, ?), last_attempt_at = ?, updated_at = ?
        WHERE outbox_id = ?
          AND (status = 'pending' OR (status = 'sending' AND lease_expires_at <= ?))
          AND next_attempt_at <= ?
      `).run(workerId, leaseExpiresAt, now, now, now, outboxId, now, now);
      if (Number(update.changes) !== 1) return null;
      return this.readDeliveryClaim(outboxId, workerId);
    });
  }

  async markDeliveryResult(
    claim: ContinuationDeliveryClaim,
    result: ContinuationDeliveryResult,
    now: string,
  ): Promise<void> {
    this.transaction(() => {
      let update;
      if (result.status === 'delivered') {
        update = this.database.prepare(`
          UPDATE continuation_outbox
          SET status = 'delivered', message_id = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = NULL, error_summary = NULL, updated_at = ?
          WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
        `).run(result.messageId, now, claim.outboxId, claim.workerId);
      } else if (result.status === 'retry') {
        const nextAttemptAt = addMilliseconds(
          now,
          retryDelayMs(Math.max(1, claim.attemptCount), this.jitter()),
        );
        update = this.database.prepare(`
          UPDATE continuation_outbox
          SET status = 'pending', next_attempt_at = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = ?, error_summary = ?, updated_at = ?
          WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
        `).run(
          nextAttemptAt,
          result.errorCode,
          result.errorSummary,
          now,
          claim.outboxId,
          claim.workerId,
        );
      } else {
        update = this.database.prepare(`
          UPDATE continuation_outbox
          SET status = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = ?, error_summary = ?, updated_at = ?
          WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
        `).run(
          result.status,
          result.errorCode,
          result.errorSummary,
          now,
          claim.outboxId,
          claim.workerId,
        );
      }
      if (Number(update.changes) !== 1) {
        throw new Error(`Stale continuation delivery claim for ${claim.outboxId}.`);
      }
    });
  }

  async purgeExpired(retainAfter: string, now: string): Promise<number> {
    const rows = this.database.prepare(`
      SELECT job_id
      FROM continuation_jobs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at IS NOT NULL
        AND completed_at < ?
        AND deleted_at IS NULL
      ORDER BY completed_at ASC
    `).all(retainAfter);
    let purged = 0;
    for (const row of rows) {
      if (await this.redactTerminal(stringField(row, 'job_id'), now)) purged += 1;
    }
    return purged;
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private assertActiveClaim(claim: ContinuationClaim): ContinuationJob {
    const current = this.readJobBy('j.job_id = ?', claim.job.jobId);
    if (
      !current
      || current.status !== 'running'
      || current.leaseOwner !== claim.workerId
      || current.rowVersion !== claim.claimedRowVersion
    ) {
      throw staleClaimError(claim.job.jobId);
    }
    return current;
  }

  private finishFailure(
    claim: ContinuationClaim,
    current: ContinuationJob,
    failure: ContinuationFailure,
    now: string,
    executionSessionId?: string,
  ): void {
    failure = boundedFailure(failure);
    const failureCount = current.failureCount + 1;
    if (failure.retryable && failureCount <= current.maxRetries && current.expiresAt > now) {
      const nextRunAt = addMilliseconds(now, retryDelayMs(failureCount, this.jitter()));
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET status = 'waiting_retry', execution_session_id = ?, failure_count = ?,
            next_run_at = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            error_code = ?, error_summary = ?, updated_at = ?, row_version = row_version + 1
        WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
      `).run(
        executionSessionId ?? null,
        failureCount,
        nextRunAt,
        failure.errorCode,
        failure.errorSummary,
        now,
        current.jobId,
        claim.workerId,
        claim.claimedRowVersion,
      );
      assertOneChange(update.changes, current.jobId);
      this.finishAttempt(claim, now, 'failed', executionSessionId, failure);
      return;
    }
    this.finishTerminal(
      claim,
      current,
      'failed',
      now,
      failure.errorCode,
      failure.errorSummary,
      executionSessionId,
      failureCount,
    );
  }

  private finishTerminal(
    claim: ContinuationClaim,
    current: ContinuationJob,
    status: Extract<ContinuationStatus, 'failed'>,
    now: string,
    errorCode: string,
    errorSummary: string,
    executionSessionId = current.executionSessionId,
    failureCount = current.failureCount,
  ): void {
    const update = this.database.prepare(`
      UPDATE continuation_jobs
      SET status = ?, execution_session_id = ?, failure_count = ?, error_code = ?,
          error_summary = ?, completed_at = ?, updated_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1
      WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
    `).run(
      status,
      executionSessionId ?? null,
      failureCount,
      errorCode,
      errorSummary,
      now,
      now,
      current.jobId,
      claim.workerId,
      claim.claimedRowVersion,
    );
    assertOneChange(update.changes, current.jobId);
    this.finishAttempt(
      claim,
      now,
      'failed',
      executionSessionId,
      { errorCode, errorSummary, retryable: false },
    );
    this.insertTerminalOutbox(current, `Task failed: ${current.jobId}\n${errorSummary}`, now);
  }

  private finishAttempt(
    claim: ContinuationClaim,
    now: string,
    outcome: 'continue' | 'completed' | 'failed' | 'cancelled',
    executionSessionId?: string,
    failure?: ContinuationFailure,
  ): void {
    this.database.prepare(`
      UPDATE continuation_attempts
      SET execution_session_id = ?, finished_at = ?, heartbeat_at = ?, outcome = ?,
          error_code = ?, error_summary = ?
      WHERE attempt_id = ? AND finished_at IS NULL
    `).run(
      executionSessionId ?? null,
      now,
      now,
      outcome,
      failure?.errorCode ?? null,
      failure?.errorSummary ?? null,
      claim.attempt.attemptId,
    );
  }

  private finishAttemptById(
    attemptId: string | undefined,
    now: string,
    outcome: 'error' | 'cancelled',
    errorCode: string,
    errorSummary: string,
  ): void {
    if (!attemptId) return;
    this.database.prepare(`
      UPDATE continuation_attempts
      SET finished_at = ?, heartbeat_at = ?, outcome = ?, error_code = ?, error_summary = ?
      WHERE attempt_id = ? AND finished_at IS NULL
    `).run(now, now, outcome, errorCode, errorSummary, attemptId);
  }

  private insertTerminalOutbox(job: ContinuationJob, payload: string, now: string): void {
    this.database.prepare(`
      INSERT INTO continuation_outbox (
        outbox_id, job_id, route_json, idempotency_key, payload, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(job_id) DO NOTHING
    `).run(
      makeId('out'),
      job.jobId,
      JSON.stringify(job.route),
      deliveryIdempotencyKey(job.jobId),
      payload,
      now,
      now,
      now,
    );
  }

  private readJobByIdempotencyKey(idempotencyKey: string): ContinuationJob | null {
    return this.readJobBy('j.idempotency_key = ?', idempotencyKey);
  }

  private readJobBy(predicate: string, value: string): ContinuationJob | null {
    const row = this.database.prepare(`${jobSelectSql()} WHERE ${predicate}`).get(value);
    return row ? mapJob(row) : null;
  }

  private listJobs(predicate: string, value: string | undefined, limit: number): ContinuationJob[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const statement = this.database.prepare(`
      ${jobSelectSql()}
      WHERE ${predicate}
      ORDER BY j.created_at DESC
      LIMIT ?
    `);
    const rows = value === undefined
      ? statement.all(boundedLimit)
      : statement.all(value, boundedLimit);
    return rows.map(mapJob);
  }

  private readDeliveryClaim(outboxId: string, workerId: string): ContinuationDeliveryClaim {
    const row = this.database.prepare(`
      SELECT outbox_id, job_id, worker_id, route_json, idempotency_key, payload,
             status, attempt_count, first_attempt_at, last_attempt_at
      FROM continuation_outbox
      WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
    `).get(outboxId, workerId);
    if (!row) throw new Error(`Continuation delivery claim ${outboxId} disappeared.`);
    return {
      outboxId: stringField(row, 'outbox_id'),
      jobId: stringField(row, 'job_id'),
      workerId: stringField(row, 'worker_id'),
      route: parseJson<ContinuationDeliveryRoute>(row.route_json, emptyRoute()),
      idempotencyKey: stringField(row, 'idempotency_key'),
      payload: stringField(row, 'payload'),
      status: 'sending',
      attemptCount: numberField(row, 'attempt_count'),
      firstAttemptAt: optionalStringField(row, 'first_attempt_at'),
      lastAttemptAt: optionalStringField(row, 'last_attempt_at'),
    };
  }

  private activeAttemptId(jobId: string, workerId?: string): string | undefined {
    if (!workerId) return undefined;
    const row = this.database.prepare(`
      SELECT attempt_id
      FROM continuation_attempts
      WHERE job_id = ? AND worker_id = ? AND finished_at IS NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(jobId, workerId);
    return row ? stringField(row, 'attempt_id') : undefined;
  }

  private scalar(sql: string): string | number | bigint | null {
    const row = this.database.prepare(sql).get();
    if (!row) return null;
    return Object.values(row)[0] as string | number | bigint | null;
  }
}

function jobSelectSql(): string {
  return `
    SELECT j.*, o.status AS delivery_status
    FROM continuation_jobs j
    LEFT JOIN continuation_outbox o ON o.job_id = j.job_id
  `;
}

function mapJob(row: SqlRow): ContinuationJob {
  return {
    jobId: stringField(row, 'job_id'),
    idempotencyKey: stringField(row, 'idempotency_key'),
    retryOfJobId: optionalStringField(row, 'retry_of_job_id'),
    creatorOpenId: stringField(row, 'creator_open_id'),
    route: parseJson<ContinuationDeliveryRoute>(row.route_json, emptyRoute()),
    sourceMessageId: stringField(row, 'source_message_id'),
    sourceThreadId: optionalStringField(row, 'source_thread_id'),
    title: stringField(row, 'title'),
    objective: stringField(row, 'objective'),
    acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria_json, []),
    contextSnapshot: parseJson(row.context_snapshot_json, EMPTY_CHECKPOINT),
    requiredTools: parseJson<string[]>(row.required_tools_json, []),
    workingDirectory: stringField(row, 'working_directory'),
    model: optionalStringField(row, 'model'),
    parentSessionId: optionalStringField(row, 'parent_session_id'),
    maxSteps: numberField(row, 'max_steps'),
    maxRetries: numberField(row, 'max_retries'),
    timeoutSeconds: numberField(row, 'timeout_seconds'),
    createdAt: stringField(row, 'created_at'),
    expiresAt: stringField(row, 'expires_at'),
    rowVersion: numberField(row, 'row_version'),
    status: stringField(row, 'status') as ContinuationStatus,
    executionSessionId: optionalStringField(row, 'execution_session_id'),
    checkpoint: row.checkpoint_json
      ? parseJson(row.checkpoint_json, EMPTY_CHECKPOINT)
      : undefined,
    stepCount: numberField(row, 'step_count'),
    failureCount: numberField(row, 'failure_count'),
    nextRunAt: stringField(row, 'next_run_at'),
    leaseOwner: optionalStringField(row, 'lease_owner'),
    leaseExpiresAt: optionalStringField(row, 'lease_expires_at'),
    heartbeatAt: optionalStringField(row, 'heartbeat_at'),
    resultSummary: optionalStringField(row, 'result_summary'),
    resultArtifacts: parseJson<string[]>(row.result_artifacts_json, []),
    errorCode: optionalStringField(row, 'error_code'),
    errorSummary: optionalStringField(row, 'error_summary'),
    startedAt: optionalStringField(row, 'started_at'),
    updatedAt: stringField(row, 'updated_at'),
    completedAt: optionalStringField(row, 'completed_at'),
    deletedAt: optionalStringField(row, 'deleted_at'),
    deliveryStatus: optionalStringField(row, 'delivery_status') as ContinuationJob['deliveryStatus'],
  };
}

function validateCreateRequest(request: ContinuationCreateRequest): void {
  if (!request.idempotencyKey) throw new Error('Continuation idempotency key is required.');
  if (request.title.length > CONTINUATION_LIMITS.titleChars) {
    throw new Error(`Continuation title exceeds ${CONTINUATION_LIMITS.titleChars} characters.`);
  }
  assertJsonBytes('objective', request.objective, CONTINUATION_LIMITS.objectiveBytes);
  if (request.acceptanceCriteria.length > CONTINUATION_LIMITS.acceptanceCriteriaCount) {
    throw new Error('Continuation acceptance criteria count exceeds the configured limit.');
  }
  assertJsonBytes(
    'acceptance criteria',
    request.acceptanceCriteria,
    CONTINUATION_LIMITS.contextSnapshotBytes,
  );
  assertJsonBytes(
    'context snapshot',
    request.contextSnapshot,
    CONTINUATION_LIMITS.contextSnapshotBytes,
  );
  assertJsonBytes('required tools', request.requiredTools, CONTINUATION_LIMITS.objectiveBytes);
  assertJsonBytes('delivery route', request.route, CONTINUATION_LIMITS.contextSnapshotBytes);
  if (!Number.isInteger(request.maxSteps) || request.maxSteps < 1) {
    throw new Error('Continuation maxSteps must be a positive integer.');
  }
  if (!Number.isInteger(request.maxRetries) || request.maxRetries < 0) {
    throw new Error('Continuation maxRetries must be a non-negative integer.');
  }
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1) {
    throw new Error('Continuation timeoutSeconds must be a positive integer.');
  }
  if (!Number.isFinite(Date.parse(request.createdAt)) || !Number.isFinite(Date.parse(request.expiresAt))) {
    throw new Error('Continuation timestamps must be valid ISO timestamps.');
  }
}

function validateFinalResult(
  finalMessage: string,
  resultSummary: string | undefined,
  artifacts: string[],
): void {
  assertJsonBytes('final message', finalMessage, CONTINUATION_LIMITS.finalMessageBytes);
  if (resultSummary !== undefined) {
    assertJsonBytes('result summary', resultSummary, CONTINUATION_LIMITS.objectiveBytes);
  }
  if (artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Continuation result exceeds ${CONTINUATION_LIMITS.artifactCount} artifacts.`);
  }
  assertJsonBytes('result artifacts', artifacts, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function boundedFailure(failure: ContinuationFailure): ContinuationFailure {
  return {
    errorCode: failure.errorCode.slice(0, 128) || 'continuation_failed',
    errorSummary: truncateUtf8(failure.errorSummary, CONTINUATION_LIMITS.objectiveBytes),
    retryable: failure.retryable,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  const suffix = '...';
  const buffer = Buffer.from(value, 'utf-8').subarray(0, maxBytes - suffix.length);
  return `${buffer.toString('utf-8').replace(/\uFFFD+$/u, '')}${suffix}`;
}

function assertJsonBytes(name: string, value: unknown, limit: number): void {
  const bytes = Buffer.byteLength(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf-8',
  );
  if (bytes > limit) throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
}

function makeId(prefix: 'job' | 'att' | 'out'): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function deliveryIdempotencyKey(jobId: string): string {
  return `ct_${createHash('sha256').update(jobId).digest('hex').slice(0, 32)}`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function emptyRoute(): ContinuationDeliveryRoute {
  return {
    kind: 'message_thread',
    conversationId: '',
    sourceMessageId: '',
  };
}

function parseJson<T>(value: SqlRow[string] | undefined, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringField(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Invalid continuation database field: ${field}.`);
  return value;
}

function optionalStringField(row: SqlRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Invalid continuation database number field: ${field}.`);
  }
  return Number(value);
}

function assertOneChange(changes: number | bigint, jobId: string): void {
  if (Number(changes) !== 1) throw staleClaimError(jobId);
}

function staleClaimError(jobId: string): Error {
  return new Error(`Stale continuation claim for ${jobId}.`);
}
