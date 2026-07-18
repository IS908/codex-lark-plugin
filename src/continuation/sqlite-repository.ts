import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTINUATION_CONTRACT_ID_PATTERN,
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  partialOutcomeFromCheckpoint,
  retryDelayMs,
  type AsyncTaskContract,
  type AsyncTaskFactSnapshot,
  type ContinuationClaim,
  type ContinuationCheckpoint,
  type ContinuationCleanupResult,
  type ContinuationCreateRequest,
  type ContinuationDeliveryClaim,
  type ContinuationDeliveryRecord,
  type ContinuationDeliveryResult,
  type ContinuationDeliveryRoute,
  type ContinuationExecutionResult,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationPermissionEnvelope,
  type ContinuationStatus,
  type ContinuationStepOutcome,
  type ContinuationToolCallDecision,
  type ContinuationToolCallRecovery,
  type ContinuationToolRequest,
  type ContinuationToolResult,
} from '../domain/continuation.js';
import type { ContinuationInputStorePort, ContinuationRepository } from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { ContinuationInputStore, continuationJobId } from './input-store.js';
import { redactContinuationText } from './redaction.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

interface SqliteContinuationRepositoryOptions {
  databasePath: string;
  artifactsDir: string;
  inputsDir?: string;
  inputStore?: ContinuationInputStorePort;
  jitter?: () => number;
}

const ATTEMPT_BUDGET_SCHEMA_VERSION = 4;
const DELIVERY_OUTBOX_SCHEMA_VERSION = 5;
const RETENTION_SCHEMA_VERSION = 6;
const SCHEMA_VERSION = 7;
const DELIVERY_LEASE_MS = 30_000;
const PROGRESS_PAYLOAD_MAX_CHARS = 4_000;
const EMPTY_CHECKPOINT = {
  summary: '',
  completedSteps: [],
  remainingSteps: [],
  constraints: [],
  decisions: [],
  references: [],
};
const EMPTY_PERMISSION_ENVELOPE: ContinuationPermissionEnvelope = {
  profile: 'bounded',
  filesystem: { root: '', mode: 'read-only', requestedPaths: [] },
  hostTools: [],
  network: 'none',
  externalSideEffects: 'denied',
  approval: { mode: 'never' },
};

export class SqliteContinuationRepository implements ContinuationRepository {
  private readonly jobMutationTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly database: DatabaseSync,
    private readonly artifacts: ContinuationArtifactStore,
    private readonly inputs: ContinuationInputStorePort,
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
      const inputs = options.inputStore ?? new ContinuationInputStore(
        options.inputsDir ?? path.join(path.dirname(path.resolve(options.artifactsDir)), 'inputs'),
      );
      await inputs.ensureRoot();
      const repository = new SqliteContinuationRepository(
        database,
        artifacts,
        inputs,
        options.jitter ?? Math.random,
      );
      await repository.initialize();
      const knownJobs = new Set(repository.database.prepare(
        'SELECT job_id FROM continuation_jobs',
      ).all().map((row) => stringField(row, 'job_id')));
      await inputs.cleanupOrphans(knownJobs);
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
        source_facts_json TEXT NOT NULL,
        task_contract_json TEXT NOT NULL,
        required_tools_json TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        model TEXT,
        parent_session_id TEXT,
        max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
        max_retries INTEGER NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        row_version INTEGER NOT NULL CHECK(row_version >= 1),
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'waiting_retry', 'cancel_requested',
          'completed', 'partial', 'blocked', 'failed', 'cancelled'
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
        deleted_at TEXT,
        retain INTEGER NOT NULL DEFAULT 0 CHECK(retain IN (0, 1))
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
          'continue', 'completed', 'partial', 'failed', 'blocked', 'error', 'cancelled'
        )),
        error_code TEXT,
        error_summary TEXT,
        UNIQUE(job_id, ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS continuation_outbox (
        outbox_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
        event_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('progress', 'terminal')),
        attempt_id TEXT REFERENCES continuation_attempts(attempt_id),
        route_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'sending', 'delivered', 'delivery_unknown', 'failed', 'superseded'
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
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, event_key),
        CHECK(
          (kind = 'terminal' AND event_key = 'terminal' AND attempt_id IS NULL)
          OR
          (kind = 'progress' AND event_key = 'progress:' || attempt_id AND attempt_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS continuation_outbox_due_idx
        ON continuation_outbox(status, kind, next_attempt_at, created_at);

      ${toolCallSchemaSql()}
      PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
    if (existingVersion === 1) this.transaction(() => {
      this.database.exec(`
        ${toolCallSchemaSql()}
        PRAGMA user_version = 2;
      `);
    });
    if (existingVersion === 1 || existingVersion === 2) this.transaction(() => {
      this.database.exec(`
        ALTER TABLE continuation_jobs
        ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';
      `);
      const rows = this.database.prepare(`
        SELECT job_id, working_directory, required_tools_json
        FROM continuation_jobs
      `).all();
      const update = this.database.prepare(`
        UPDATE continuation_jobs SET permissions_json = ? WHERE job_id = ?
      `);
      for (const row of rows) {
        const workingDirectory = stringField(row, 'working_directory');
        const requiredTools = parseJson<string[]>(row.required_tools_json, []);
        update.run(JSON.stringify({
          profile: 'bounded',
          filesystem: {
            root: workingDirectory,
            mode: 'workspace-write',
            requestedPaths: [],
          },
          hostTools: requiredTools,
          network: 'none',
          externalSideEffects: 'denied',
          approval: { mode: 'never' },
        } satisfies ContinuationPermissionEnvelope), stringField(row, 'job_id'));
      }
      this.database.exec('PRAGMA user_version = 3;');
    });
    if (existingVersion >= 1 && existingVersion <= 3) {
      this.migrateAttemptBudgetSchema();
    }
    if (Number(this.scalar('PRAGMA user_version')) === ATTEMPT_BUDGET_SCHEMA_VERSION) {
      this.migrateDeliveryOutboxSchema();
    }
    if (Number(this.scalar('PRAGMA user_version')) === DELIVERY_OUTBOX_SCHEMA_VERSION) {
      this.migrateRetentionSchema();
    }
    if (Number(this.scalar('PRAGMA user_version')) === RETENTION_SCHEMA_VERSION) {
      this.migrateAsyncTaskFactsSchema();
    }
    await this.healthCheck();
  }

  private migrateAttemptBudgetSchema(): void {
    const columns = this.database.prepare('PRAGMA table_info(continuation_jobs)').all();
    if (columns.some((column) => stringField(column, 'name') === 'max_attempts')) {
      this.transaction(() => this.database.exec(
        `PRAGMA user_version = ${ATTEMPT_BUDGET_SCHEMA_VERSION};`,
      ));
      return;
    }

    this.database.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.transaction(() => this.database.exec(`
        CREATE TABLE continuation_jobs_v4 (
          job_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          retry_of_job_id TEXT REFERENCES continuation_jobs_v4(job_id),
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
          permissions_json TEXT NOT NULL,
          model TEXT,
          parent_session_id TEXT,
          max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
          max_retries INTEGER NOT NULL,
          timeout_seconds INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          row_version INTEGER NOT NULL CHECK(row_version >= 1),
          status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'waiting_retry', 'cancel_requested',
            'completed', 'partial', 'blocked', 'failed', 'cancelled'
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

        CREATE TABLE continuation_attempts_v4 (
          attempt_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES continuation_jobs_v4(job_id),
          ordinal INTEGER NOT NULL,
          worker_id TEXT NOT NULL,
          execution_session_id TEXT,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT CHECK(outcome IS NULL OR outcome IN (
            'continue', 'completed', 'partial', 'failed', 'blocked', 'error', 'cancelled'
          )),
          error_code TEXT,
          error_summary TEXT,
          UNIQUE(job_id, ordinal)
        ) STRICT;

        INSERT INTO continuation_jobs_v4 (
          job_id, idempotency_key, retry_of_job_id, creator_open_id, origin_kind,
          route_json, source_message_id, source_thread_id, title, objective,
          acceptance_criteria_json, context_snapshot_json, required_tools_json,
          working_directory, permissions_json, model, parent_session_id,
          max_attempts, max_retries, timeout_seconds, created_at, expires_at,
          row_version, status, execution_session_id, checkpoint_json, step_count,
          failure_count, next_run_at, lease_owner, lease_expires_at, heartbeat_at,
          result_summary, result_artifacts_json, error_code, error_summary,
          started_at, updated_at, completed_at, deleted_at
        )
        SELECT
          job_id, idempotency_key, retry_of_job_id, creator_open_id, origin_kind,
          route_json, source_message_id, source_thread_id, title, objective,
          acceptance_criteria_json, context_snapshot_json, required_tools_json,
          working_directory, permissions_json, model, parent_session_id,
          MIN(MAX(max_steps, 1), 5), max_retries, timeout_seconds, created_at, expires_at,
          row_version, status, execution_session_id, checkpoint_json, step_count,
          failure_count, next_run_at, lease_owner, lease_expires_at, heartbeat_at,
          result_summary, result_artifacts_json, error_code, error_summary,
          started_at, updated_at, completed_at, deleted_at
        FROM continuation_jobs;

        INSERT INTO continuation_attempts_v4 (
          attempt_id, job_id, ordinal, worker_id, execution_session_id, started_at,
          heartbeat_at, finished_at, outcome, error_code, error_summary
        )
        SELECT
          attempt_id, job_id, ordinal, worker_id, execution_session_id, started_at,
          heartbeat_at, finished_at, outcome, error_code, error_summary
        FROM continuation_attempts;

        DROP TABLE continuation_attempts;
        DROP TABLE continuation_jobs;
        ALTER TABLE continuation_jobs_v4 RENAME TO continuation_jobs;
        ALTER TABLE continuation_attempts_v4 RENAME TO continuation_attempts;

        CREATE INDEX continuation_jobs_due_idx
          ON continuation_jobs(status, next_run_at, created_at)
          WHERE deleted_at IS NULL;
        CREATE INDEX continuation_jobs_creator_idx
          ON continuation_jobs(creator_open_id, created_at DESC)
          WHERE deleted_at IS NULL;
        PRAGMA user_version = ${ATTEMPT_BUDGET_SCHEMA_VERSION};
      `));
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON;');
    }
    const violations = this.database.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error('Continuation database migration failed foreign-key validation.');
    }
  }

  private migrateDeliveryOutboxSchema(): void {
    const columns = this.database.prepare('PRAGMA table_info(continuation_outbox)').all();
    if (columns.some((column) => stringField(column, 'name') === 'event_key')) {
      this.transaction(() => this.database.exec(
        `PRAGMA user_version = ${DELIVERY_OUTBOX_SCHEMA_VERSION};`,
      ));
      return;
    }

    this.database.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.transaction(() => this.database.exec(`
        CREATE TABLE continuation_outbox_v5 (
          outbox_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
          event_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('progress', 'terminal')),
          attempt_id TEXT REFERENCES continuation_attempts(attempt_id),
          route_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'sending', 'delivered', 'delivery_unknown', 'failed', 'superseded'
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
          updated_at TEXT NOT NULL,
          UNIQUE(job_id, event_key),
          CHECK(
            (kind = 'terminal' AND event_key = 'terminal' AND attempt_id IS NULL)
            OR
            (kind = 'progress' AND event_key = 'progress:' || attempt_id AND attempt_id IS NOT NULL)
          )
        ) STRICT;

        INSERT INTO continuation_outbox_v5 (
          outbox_id, job_id, event_key, kind, attempt_id, route_json,
          idempotency_key, payload, status, attempt_count, next_attempt_at,
          worker_id, lease_expires_at, first_attempt_at, last_attempt_at,
          message_id, error_code, error_summary, created_at, updated_at
        )
        SELECT
          outbox_id, job_id, 'terminal', 'terminal', NULL, route_json,
          idempotency_key, payload, status, attempt_count, next_attempt_at,
          worker_id, lease_expires_at, first_attempt_at, last_attempt_at,
          message_id, error_code, error_summary, created_at, updated_at
        FROM continuation_outbox;

        DROP TABLE continuation_outbox;
        ALTER TABLE continuation_outbox_v5 RENAME TO continuation_outbox;
        CREATE INDEX continuation_outbox_due_idx
          ON continuation_outbox(status, kind, next_attempt_at, created_at);
        PRAGMA user_version = ${DELIVERY_OUTBOX_SCHEMA_VERSION};
      `));
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON;');
    }
    const violations = this.database.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error('Continuation outbox migration failed foreign-key validation.');
    }
  }

  private migrateRetentionSchema(): void {
    const columns = this.database.prepare('PRAGMA table_info(continuation_jobs)').all();
    if (columns.some((column) => stringField(column, 'name') === 'retain')) {
      this.transaction(() => this.database.exec(`PRAGMA user_version = ${RETENTION_SCHEMA_VERSION};`));
      return;
    }
    this.transaction(() => this.database.exec(`
      ALTER TABLE continuation_jobs
      ADD COLUMN retain INTEGER NOT NULL DEFAULT 0 CHECK(retain IN (0, 1));
      PRAGMA user_version = ${RETENTION_SCHEMA_VERSION};
    `));
  }

  private migrateAsyncTaskFactsSchema(): void {
    const columns = this.database.prepare('PRAGMA table_info(continuation_jobs)').all();
    if (!columns.some((column) => stringField(column, 'name') === 'source_facts_json')) {
      this.transaction(() => this.database.exec(`
        ALTER TABLE continuation_jobs ADD COLUMN source_facts_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE continuation_jobs ADD COLUMN task_contract_json TEXT NOT NULL DEFAULT '{}';
      `));
    }
    const rows = this.database.prepare(`${jobSelectSql()} ORDER BY j.created_at ASC`).all();
    const update = this.database.prepare(`
      UPDATE continuation_jobs
      SET source_facts_json = ?, task_contract_json = ?,
          title = ?, objective = ?, acceptance_criteria_json = ?, context_snapshot_json = ?
      WHERE job_id = ?
    `);
    this.transaction(() => {
      for (const row of rows) {
        const legacy = legacyFactsAndContract(row);
        update.run(
          JSON.stringify(legacy.sourceFacts),
          JSON.stringify(legacy.taskContract),
          legacy.taskContract.title,
          legacy.taskContract.objective,
          JSON.stringify(legacy.taskContract.acceptanceCriteria.map((criterion) => criterion.description)),
          JSON.stringify(legacy.taskContract.initialContext),
          stringField(row, 'job_id'),
        );
      }
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
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
    const jobId = continuationJobId(request.idempotencyKey);
    return this.serializeJobMutation(jobId, () => this.inputs.withCreationLock(jobId, async () => {
      const existing = this.readJobByIdempotencyKey(request.idempotencyKey);
      if (existing) return { job: existing, created: false };
      const occupiedJobId = this.readJobBy('j.job_id = ?', jobId);
      if (occupiedJobId) {
        throw new Error('Continuation idempotency conflict: the deterministic Job ID is already retired or owned by another request.');
      }
      const requestFingerprint = createRequestFingerprint(request);
      const installation = await this.inputs.install(
        jobId,
        request.sourceInputs,
        requestFingerprint,
      );
      const persisted = projectCreateRequest(request, installation.artifacts);
      try {
        const inserted = this.database.prepare(`
          INSERT OR IGNORE INTO continuation_jobs (
            job_id, idempotency_key, retry_of_job_id, creator_open_id, origin_kind, route_json,
            source_message_id, source_thread_id, title, objective,
            acceptance_criteria_json, context_snapshot_json, source_facts_json,
            task_contract_json, required_tools_json, working_directory, permissions_json,
            model, parent_session_id, max_attempts, max_retries, timeout_seconds,
            created_at, expires_at, row_version, status, step_count, failure_count,
            next_run_at, result_artifacts_json, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            1, 'queued', 0, 0, ?, '[]', ?
          )
        `).run(
          jobId,
          persisted.idempotencyKey,
          persisted.retryOfJobId ?? null,
          persisted.creatorOpenId,
          persisted.route.kind,
          JSON.stringify(persisted.route),
          persisted.sourceMessageId,
          persisted.sourceThreadId ?? null,
          persisted.title,
          persisted.objective,
          JSON.stringify(persisted.acceptanceCriteria),
          JSON.stringify(persisted.contextSnapshot),
          JSON.stringify(persisted.sourceFacts),
          JSON.stringify(persisted.taskContract),
          JSON.stringify(persisted.requiredTools),
          persisted.workingDirectory,
          JSON.stringify(persisted.permissions),
          persisted.model ?? null,
          persisted.parentSessionId ?? null,
          persisted.maxAttempts,
          persisted.maxRetries,
          persisted.timeoutSeconds,
          persisted.createdAt,
          persisted.expiresAt,
          persisted.createdAt,
          persisted.createdAt,
        );
        const created = Number(inserted.changes) === 1;
        const job = created
          ? await this.get(jobId)
          : this.readJobByIdempotencyKey(request.idempotencyKey);
        if (!job) {
          throw new Error('Continuation create conflicted with an unrelated deterministic Job ID.');
        }
        return { job, created };
      } catch (error) {
        if (installation.installed && this.canConfirmJobAbsent(jobId, request.idempotencyKey)) {
          await this.inputs.remove(jobId).catch(() => {});
        }
        throw error;
      }
    }));
  }

  async get(jobId: string): Promise<ContinuationJob | null> {
    const job = this.readJobBy('j.job_id = ?', jobId);
    if (!job) return null;
    return { ...job, deliveryEvents: this.readDeliveryEvents(jobId) };
  }

  async listByCreator(
    creatorOpenId: string,
    limit: number,
    statuses: ContinuationStatus[] = [],
  ): Promise<ContinuationJob[]> {
    return this.listJobs('j.creator_open_id = ?', creatorOpenId, limit, statuses);
  }

  async listAll(limit: number, statuses: ContinuationStatus[] = []): Promise<ContinuationJob[]> {
    return this.listJobs('1 = 1', undefined, limit, statuses);
  }

  async claimDue(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<ContinuationClaim | null> {
    this.transaction(() => this.finishUnclaimedAttemptBudgetExhausted(now));
    while (true) {
      const selected = this.selectDueCandidate(now);
      if (!selected) return null;
      const verification = await this.inputs.verify(
        selected.jobId,
        selected.sourceFacts.inputs,
      );
      if (!verification.ok) {
        this.transaction(() => {
          const update = this.database.prepare(`
            UPDATE continuation_jobs
            SET status = 'failed', error_code = 'continuation_input_integrity_failed',
                error_summary = 'A managed continuation input failed integrity verification.',
                completed_at = ?, updated_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1
            WHERE job_id = ? AND row_version = ?
              AND status IN ('queued', 'waiting_retry')
              AND deleted_at IS NULL AND next_run_at <= ? AND expires_at > ?
          `).run(now, now, selected.jobId, selected.rowVersion, now, now);
          if (Number(update.changes) === 1) {
            this.insertTerminalOutbox(
              selected,
              `Task failed: ${selected.jobId}\nA managed task input failed integrity verification.`,
              now,
            );
          }
        });
        continue;
      }

      const claim = this.transaction(() => {
        const update = this.database.prepare(`
          UPDATE continuation_jobs
          SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?, row_version = row_version + 1
          WHERE job_id = ? AND row_version = ?
            AND status IN ('queued', 'waiting_retry')
            AND deleted_at IS NULL AND next_run_at <= ? AND expires_at > ?
            AND (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = continuation_jobs.job_id) < max_attempts
            AND NOT EXISTS (
              SELECT 1 FROM continuation_outbox progress
              WHERE progress.job_id = continuation_jobs.job_id
                AND progress.kind = 'progress'
                AND (
                  progress.status = 'sending'
                  OR (progress.status = 'pending' AND progress.next_attempt_at <= ?)
                )
            )
        `).run(
          workerId,
          leaseExpiresAt,
          now,
          now,
          now,
          selected.jobId,
          selected.rowVersion,
          now,
          now,
          now,
        );
        if (Number(update.changes) !== 1) return null;
        const ordinal = Number(this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
          FROM continuation_attempts WHERE job_id = ?
        `).get(selected.jobId)?.ordinal ?? 1);
        const attemptId = makeId('att');
        this.database.prepare(`
          INSERT INTO continuation_attempts (
            attempt_id, job_id, ordinal, worker_id, started_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(attemptId, selected.jobId, ordinal, workerId, now, now);
        const job = this.readJobBy('j.job_id = ?', selected.jobId);
        if (!job) throw new Error(`Claimed continuation job ${selected.jobId} disappeared.`);
        return {
          job,
          workerId,
          claimedRowVersion: job.rowVersion,
          attempt: {
            attemptId,
            jobId: selected.jobId,
            ordinal,
            workerId,
            executionSessionId: job.executionSessionId,
            startedAt: now,
            heartbeatAt: now,
          },
        } satisfies ContinuationClaim;
      });
      if (claim) return claim;
    }
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

  async beginToolCall(
    claim: ContinuationClaim,
    request: ContinuationToolRequest,
    now: string,
  ): Promise<ContinuationToolCallDecision> {
    validateToolRequest(request);
    return this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      const requestHash = toolRequestHash(request);
      const existing = this.database.prepare(`
        SELECT call_id, tool_name, request_hash, status, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_index = ?
      `).get(current.jobId, current.stepCount);
      if (existing) {
        const callId = stringField(existing, 'call_id');
        if (
          stringField(existing, 'tool_name') !== request.tool
          || stringField(existing, 'request_hash') !== requestHash
        ) {
          return { status: 'conflict', callId };
        }
        if (stringField(existing, 'status') === 'completed') {
          return {
            status: 'replay',
            callId,
            result: parseToolResult(existing.result_json),
          };
        }
        return { status: 'unknown', callId };
      }

      const callId = toolCallId(current.jobId, current.stepCount);
      this.database.prepare(`
        INSERT INTO continuation_tool_calls (
          call_id, job_id, step_index, attempt_id, tool_name, request_hash,
          status, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        callId,
        current.jobId,
        current.stepCount,
        claim.attempt.attemptId,
        request.tool,
        requestHash,
        now,
        now,
      );
      return { status: 'execute', callId };
    });
  }

  async inspectToolCall(
    claim: ContinuationClaim,
  ): Promise<ContinuationToolCallRecovery | null> {
    return this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      const row = this.database.prepare(`
        SELECT tool_name, status, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_index = ?
      `).get(current.jobId, current.stepCount);
      if (!row) return null;
      const tool = stringField(row, 'tool_name');
      if (stringField(row, 'status') === 'completed') {
        return { status: 'completed', tool, result: parseToolResult(row.result_json) };
      }
      return { status: 'unknown', tool };
    });
  }

  async completeToolCall(
    claim: ContinuationClaim,
    callId: string,
    result: ContinuationToolResult,
    now: string,
  ): Promise<void> {
    validateToolResult(result);
    this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      const update = this.database.prepare(`
        UPDATE continuation_tool_calls
        SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
        WHERE call_id = ? AND job_id = ? AND step_index = ? AND status = 'running'
      `).run(
        JSON.stringify(result),
        now,
        now,
        callId,
        current.jobId,
        current.stepCount,
      );
      assertOneChange(update.changes, current.jobId);
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
        if (claim.attempt.ordinal >= current.maxAttempts) {
          this.finishPartial(
            claim,
            current,
            partialOutcomeFromCheckpoint(outcome.checkpoint, outcome.nextStep),
            now,
            executionSessionId,
            'attempt_budget_exhausted',
            outcome.checkpoint,
          );
          return;
        }
        const stepCount = current.stepCount + 1;
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
        this.insertProgressOutbox(current, claim, outcome, now);
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

      if (outcome.outcome === 'partial') {
        this.finishPartial(claim, current, outcome, now, executionSessionId);
        return;
      }

      if (outcome.outcome === 'blocked') {
        this.finishBlocked(claim, current, outcome, now, executionSessionId);
        return;
      }

      this.finishFailure(
        claim,
        current,
        {
          errorCode: outcome.errorCode,
          errorSummary: outcome.errorSummary,
          retryable: outcome.retryable,
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
        if (
          failureCount <= current.maxRetries
          && (current.attemptCount ?? 0) < current.maxAttempts
          && current.expiresAt > now
        ) {
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

  async expireOverdue(now: string): Promise<number> {
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT job_id
        FROM continuation_jobs
        WHERE status IN ('queued', 'waiting_retry')
          AND expires_at <= ?
          AND deleted_at IS NULL
      `).all(now);
      let expired = 0;
      for (const row of rows) {
        const jobId = stringField(row, 'job_id');
        const current = this.readJobBy('j.job_id = ?', jobId);
        if (!current) continue;
        const update = this.database.prepare(`
          UPDATE continuation_jobs
          SET status = 'failed', error_code = 'continuation_expired',
              error_summary = 'The continuation reached its maximum age.',
              completed_at = ?, updated_at = ?, row_version = row_version + 1
          WHERE job_id = ? AND status IN ('queued', 'waiting_retry') AND expires_at <= ?
        `).run(now, now, jobId, now);
        if (Number(update.changes) !== 1) continue;
        expired += 1;
        this.insertTerminalOutbox(
          current,
          `Task failed: ${jobId}\nThe continuation reached its maximum age.`,
          now,
        );
      }
      return expired;
    });
  }

  async cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob> {
    const source = await this.get(jobId);
    if (!source || !isContinuationTerminal(source.status) || source.deletedAt) {
      throw new Error(`Continuation ${jobId} is not an available terminal job.`);
    }
    const lifetimeMs = Math.max(1, Date.parse(source.expiresAt) - Date.parse(source.createdAt));
    const idempotencyKey = `manual-retry:${jobId}:${requestId}`;
    const verification = await this.inputs.verify(source.jobId, source.sourceFacts.inputs);
    if (!verification.ok) {
      throw new Error('Continuation input integrity check failed; retry input copy was not created.');
    }
    const retryRequest: ContinuationCreateRequest = {
      idempotencyKey,
      retryOfJobId: jobId,
      creatorOpenId: source.creatorOpenId,
      route: source.route,
      sourceMessageId: source.sourceMessageId,
      sourceThreadId: source.sourceThreadId,
      title: source.title,
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria,
      contextSnapshot: source.contextSnapshot,
      sourceFacts: {
        ...source.sourceFacts,
        inputs: [],
        model: source.model ?? null,
      },
      taskContract: source.taskContract,
      sourceInputs: source.sourceFacts.inputs.map((input) => ({
        sourcePath: this.inputs.resolve(source.jobId, input.relativePath),
        fileName: input.fileName,
        kind: input.kind,
      })),
      requiredTools: source.requiredTools,
      workingDirectory: source.workingDirectory,
      permissions: source.permissions,
      model: source.model,
      parentSessionId: source.parentSessionId,
      maxAttempts: source.maxAttempts,
      maxRetries: source.maxRetries,
      timeoutSeconds: source.timeoutSeconds,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + lifetimeMs).toISOString(),
    };
    const { job } = await this.create(retryRequest);
    return job;
  }

  async redactTerminal(jobId: string, now: string): Promise<boolean> {
    return this.serializeJobMutation(jobId, () => this.redactTerminalInternal(jobId, now));
  }

  async setRetained(jobId: string, retained: boolean, now: string): Promise<boolean> {
    return this.serializeJobMutation(jobId, () => {
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET retain = ?, updated_at = ?, row_version = row_version + 1
        WHERE job_id = ? AND deleted_at IS NULL
      `).run(retained ? 1 : 0, now, jobId);
      return Number(update.changes) === 1;
    });
  }

  private async redactTerminalInternal(
    jobId: string,
    now: string,
    automaticRetentionCutoff?: string,
  ): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current || !isContinuationTerminal(current.status) || current.deletedAt) return false;
    if (
      automaticRetentionCutoff
      && (
        current.retained
        || current.deliveryStatus !== 'delivered'
        || !current.completedAt
        || current.completedAt >= automaticRetentionCutoff
      )
    ) {
      return false;
    }
    await this.artifacts.remove(jobId);
    await this.inputs.remove(jobId);
    return this.transaction(() => {
      const automaticGate = automaticRetentionCutoff
        ? `AND retain = 0 AND completed_at < ? AND EXISTS (
            SELECT 1 FROM continuation_outbox terminal
            WHERE terminal.job_id = continuation_jobs.job_id
              AND terminal.kind = 'terminal' AND terminal.status = 'delivered'
          )`
        : '';
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET idempotency_key = ?, origin_kind = 'message_thread', route_json = ?,
            source_message_id = '', source_thread_id = NULL,
            title = '', objective = '', acceptance_criteria_json = '[]',
            context_snapshot_json = ?, source_facts_json = ?, task_contract_json = ?,
            required_tools_json = '[]', working_directory = '',
            permissions_json = ?,
            model = NULL, parent_session_id = NULL, execution_session_id = NULL,
            checkpoint_json = NULL, result_summary = NULL, result_artifacts_json = '[]',
            error_summary = NULL, deleted_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE job_id = ? AND status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled')
          AND deleted_at IS NULL ${automaticGate}
      `).run(
        `redacted:${jobId}`,
        JSON.stringify(emptyRoute()),
        JSON.stringify(EMPTY_CHECKPOINT),
        JSON.stringify(redactedLegacyFacts()),
        JSON.stringify(redactedLegacyContract()),
        JSON.stringify(EMPTY_PERMISSION_ENVELOPE),
        now,
        now,
        jobId,
        ...(automaticRetentionCutoff ? [automaticRetentionCutoff] : []),
      );
      if (Number(update.changes) !== 1) return false;
      this.database.prepare(`
        DELETE FROM continuation_outbox WHERE job_id = ? AND kind = 'progress'
      `).run(jobId);
      this.database.prepare(`
        DELETE FROM continuation_tool_calls WHERE job_id = ?
      `).run(jobId);
      this.database.prepare(`
        DELETE FROM continuation_attempts WHERE job_id = ?
      `).run(jobId);
      this.database.prepare(`
        UPDATE continuation_outbox
        SET route_json = ?, payload = '', worker_id = NULL, lease_expires_at = NULL,
            error_summary = NULL,
            status = CASE
              WHEN status IN ('delivered', 'delivery_unknown') THEN status
              WHEN status = 'sending' THEN 'delivery_unknown'
              ELSE 'superseded'
            END,
            updated_at = ?
        WHERE job_id = ? AND kind = 'terminal'
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
          AND (
            kind = 'terminal'
            OR NOT EXISTS (
              SELECT 1 FROM continuation_outbox terminal
              WHERE terminal.job_id = continuation_outbox.job_id
                AND terminal.kind = 'terminal'
            )
          )
        ORDER BY CASE kind WHEN 'terminal' THEN 0 ELSE 1 END,
                 next_attempt_at ASC, created_at ASC
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
      const terminalExists = claim.kind === 'progress' && Boolean(this.database.prepare(`
        SELECT 1 FROM continuation_outbox
        WHERE job_id = ? AND kind = 'terminal'
        LIMIT 1
      `).get(claim.jobId));
      if (
        terminalExists
        && (
          result.status === 'failed'
          || (result.status === 'retry' && result.errorCode === 'lark_pre_send_unavailable')
        )
      ) {
        const superseded = this.database.prepare(`
          UPDATE continuation_outbox
          SET status = 'superseded', worker_id = NULL, lease_expires_at = NULL,
              error_code = NULL, error_summary = NULL, updated_at = ?
          WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
        `).run(now, claim.outboxId, claim.workerId);
        if (Number(superseded.changes) !== 1) {
          throw new Error(`Stale continuation delivery claim for ${claim.outboxId}.`);
        }
        return;
      }
      if (terminalExists && result.status === 'retry') {
        result = {
          status: 'delivery_unknown',
          errorCode: result.errorCode,
          errorSummary: result.errorSummary,
        };
      }
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
        const resetKnownPreSendAttempt = claim.attemptCount === 1
          && result.errorCode === 'lark_pre_send_unavailable';
        update = this.database.prepare(`
          UPDATE continuation_outbox
          SET status = 'pending', next_attempt_at = ?, worker_id = NULL, lease_expires_at = NULL,
              attempt_count = CASE WHEN ? THEN 0 ELSE attempt_count END,
              first_attempt_at = CASE WHEN ? THEN NULL ELSE first_attempt_at END,
              last_attempt_at = CASE WHEN ? THEN NULL ELSE last_attempt_at END,
              error_code = ?, error_summary = ?, updated_at = ?
          WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
        `).run(
          nextAttemptAt,
          resetKnownPreSendAttempt ? 1 : 0,
          resetKnownPreSendAttempt ? 1 : 0,
          resetKnownPreSendAttempt ? 1 : 0,
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

  async purgeExpired(retainAfter: string, now: string): Promise<ContinuationCleanupResult[]> {
    const rows = this.database.prepare(`
      SELECT j.job_id, j.creator_open_id, j.status, j.completed_at
      FROM continuation_jobs j
      WHERE j.status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled')
        AND j.completed_at IS NOT NULL
        AND j.completed_at < ?
        AND j.deleted_at IS NULL
        AND j.retain = 0
        AND EXISTS (
          SELECT 1 FROM continuation_outbox terminal
          WHERE terminal.job_id = j.job_id
            AND terminal.kind = 'terminal' AND terminal.status = 'delivered'
        )
      ORDER BY j.completed_at ASC
    `).all(retainAfter);
    const results: ContinuationCleanupResult[] = [];
    for (const row of rows) {
      const jobId = stringField(row, 'job_id');
      const base = {
        jobId,
        creatorOpenId: stringField(row, 'creator_open_id'),
        status: stringField(row, 'status') as ContinuationCleanupResult['status'],
        completedAt: stringField(row, 'completed_at'),
      };
      try {
        if (await this.serializeJobMutation(
          jobId,
          () => this.redactTerminalInternal(jobId, now, retainAfter),
        )) {
          results.push({ ...base, result: 'cleaned' });
        }
      } catch (error) {
        results.push({
          ...base,
          result: 'error',
          errorSummary: cleanupErrorSummary(error),
        });
      }
    }
    return results;
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

  private async serializeJobMutation<T>(jobId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.jobMutationTails.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.jobMutationTails.set(jobId, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.jobMutationTails.get(jobId) === tail) this.jobMutationTails.delete(jobId);
    }
  }

  private canConfirmJobAbsent(jobId: string, idempotencyKey: string): boolean {
    try {
      return !this.database.prepare(`
        SELECT 1 FROM continuation_jobs WHERE job_id = ? OR idempotency_key = ? LIMIT 1
      `).get(jobId, idempotencyKey);
    } catch {
      // On an uncertain database outcome, preserve the installed tree for startup reconciliation.
      return false;
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

  private finishUnclaimedAttemptBudgetExhausted(now: string): void {
    const rows = this.database.prepare(`
      SELECT j.job_id
      FROM continuation_jobs j
      WHERE j.status IN ('queued', 'waiting_retry')
        AND j.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = j.job_id) >= j.max_attempts
    `).all();
    for (const row of rows) {
      const jobId = stringField(row, 'job_id');
      const current = this.readJobBy('j.job_id = ?', jobId);
      if (!current) continue;
      const checkpoint = current.checkpoint ?? current.contextSnapshot;
      const partial = partialOutcomeFromCheckpoint(
        checkpoint,
        checkpoint.remainingSteps[0] ?? 'Review the partial result.',
      );
      validatePartialResult(partial);
      const update = this.database.prepare(`
        UPDATE continuation_jobs
        SET status = 'partial', result_summary = ?, result_artifacts_json = ?,
            error_code = 'attempt_budget_exhausted',
            error_summary = 'The continuation exhausted its attempt budget.',
            completed_at = ?, updated_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1
        WHERE job_id = ? AND status IN ('queued', 'waiting_retry')
      `).run(
        partialResultSummary(partial),
        JSON.stringify(partial.artifacts),
        now,
        now,
        jobId,
      );
      if (Number(update.changes) !== 1) continue;
      this.insertTerminalOutbox(current, renderPartialPayload(jobId, partial), now);
    }
  }

  private finishPartial(
    claim: ContinuationClaim,
    current: ContinuationJob,
    outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
    now: string,
    executionSessionId?: string,
    errorCode = 'partial_completion',
    checkpoint?: ContinuationCheckpoint,
  ): void {
    validatePartialResult(outcome);
    const update = this.database.prepare(`
      UPDATE continuation_jobs
      SET status = 'partial', execution_session_id = ?, checkpoint_json = ?,
          step_count = step_count + 1, result_summary = ?, result_artifacts_json = ?,
          error_code = ?, error_summary = 'The continuation completed with a partial result.',
          completed_at = ?, updated_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1
      WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
    `).run(
      executionSessionId ?? null,
      checkpoint ? JSON.stringify(checkpoint) : current.checkpoint ? JSON.stringify(current.checkpoint) : null,
      partialResultSummary(outcome),
      JSON.stringify(outcome.artifacts),
      errorCode,
      now,
      now,
      current.jobId,
      claim.workerId,
      claim.claimedRowVersion,
    );
    assertOneChange(update.changes, current.jobId);
    this.finishAttempt(claim, now, 'partial', executionSessionId);
    this.insertTerminalOutbox(current, renderPartialPayload(current.jobId, outcome), now);
  }

  private finishBlocked(
    claim: ContinuationClaim,
    current: ContinuationJob,
    outcome: Extract<ContinuationStepOutcome, { outcome: 'blocked' }>,
    now: string,
    executionSessionId?: string,
  ): void {
    assertJsonBytes('blocked result', outcome, CONTINUATION_LIMITS.finalMessageBytes);
    const update = this.database.prepare(`
      UPDATE continuation_jobs
      SET status = 'blocked', execution_session_id = ?, step_count = step_count + 1,
          result_summary = ?, error_code = ?, error_summary = ?, completed_at = ?,
          updated_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          heartbeat_at = NULL, row_version = row_version + 1
      WHERE job_id = ? AND status = 'running' AND lease_owner = ? AND row_version = ?
    `).run(
      executionSessionId ?? null,
      outcome.errorSummary,
      outcome.errorCode,
      outcome.errorSummary,
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
      'blocked',
      executionSessionId,
      { errorCode: outcome.errorCode, errorSummary: outcome.errorSummary, retryable: false },
    );
    this.insertTerminalOutbox(current, renderBlockedPayload(current.jobId, outcome), now);
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
    if (
      failure.retryable
      && failureCount <= current.maxRetries
      && claim.attempt.ordinal < current.maxAttempts
      && current.expiresAt > now
    ) {
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
    outcome: 'continue' | 'completed' | 'partial' | 'failed' | 'blocked' | 'cancelled',
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
      UPDATE continuation_outbox
      SET status = 'superseded', worker_id = NULL, lease_expires_at = NULL,
          error_code = NULL, error_summary = NULL, updated_at = ?
      WHERE job_id = ? AND kind = 'progress'
        AND (
          status IN ('pending', 'failed')
          OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `).run(now, job.jobId, now);
    this.database.prepare(`
      INSERT INTO continuation_outbox (
        outbox_id, job_id, event_key, kind, attempt_id,
        route_json, idempotency_key, payload, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'terminal', 'terminal', NULL, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(job_id, event_key) DO NOTHING
    `).run(
      makeId('out'),
      job.jobId,
      JSON.stringify(job.route),
      deliveryIdempotencyKey(job.jobId, 'terminal'),
      payload,
      now,
      now,
      now,
    );
  }

  private insertProgressOutbox(
    job: ContinuationJob,
    claim: ContinuationClaim,
    outcome: Extract<ContinuationStepOutcome, { outcome: 'continue' }>,
    now: string,
  ): void {
    const eventKey = `progress:${claim.attempt.attemptId}`;
    this.database.prepare(`
      INSERT INTO continuation_outbox (
        outbox_id, job_id, event_key, kind, attempt_id,
        route_json, idempotency_key, payload, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'progress', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(job_id, event_key) DO NOTHING
    `).run(
      makeId('out'),
      job.jobId,
      eventKey,
      claim.attempt.attemptId,
      JSON.stringify(job.route),
      deliveryIdempotencyKey(job.jobId, eventKey),
      renderProgressPayload(job, claim, outcome),
      now,
      now,
      now,
    );
  }

  private readJobByIdempotencyKey(idempotencyKey: string): ContinuationJob | null {
    return this.readJobBy('j.idempotency_key = ?', idempotencyKey);
  }

  private selectDueCandidate(now: string): ContinuationJob | null {
    const row = this.database.prepare(`
      ${jobSelectSql()}
      WHERE j.status IN ('queued', 'waiting_retry')
        AND j.deleted_at IS NULL
        AND j.next_run_at <= ?
        AND j.expires_at > ?
        AND (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = j.job_id) < j.max_attempts
        AND NOT EXISTS (
          SELECT 1 FROM continuation_outbox progress
          WHERE progress.job_id = j.job_id
            AND progress.kind = 'progress'
            AND (
              progress.status = 'sending'
              OR (progress.status = 'pending' AND progress.next_attempt_at <= ?)
            )
        )
      ORDER BY j.next_run_at ASC, j.created_at ASC
      LIMIT 1
    `).get(now, now, now);
    return row ? mapJob(row) : null;
  }

  private readJobBy(predicate: string, value: string): ContinuationJob | null {
    const row = this.database.prepare(`${jobSelectSql()} WHERE ${predicate}`).get(value);
    return row ? mapJob(row) : null;
  }

  private listJobs(
    predicate: string,
    value: string | undefined,
    limit: number,
    statuses: ContinuationStatus[],
  ): ContinuationJob[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const uniqueStatuses = [...new Set(statuses)];
    const statusClause = uniqueStatuses.length > 0
      ? `AND j.status IN (${uniqueStatuses.map(() => '?').join(', ')})`
      : '';
    const statement = this.database.prepare(`
      ${jobSelectSql()}
      WHERE (${predicate}) AND j.deleted_at IS NULL ${statusClause}
      ORDER BY j.created_at DESC
      LIMIT ?
    `);
    const bindings = [
      ...(value === undefined ? [] : [value]),
      ...uniqueStatuses,
      boundedLimit,
    ];
    const rows = statement.all(...bindings);
    return rows.map(mapJob);
  }

  private readDeliveryClaim(outboxId: string, workerId: string): ContinuationDeliveryClaim {
    const row = this.database.prepare(`
      SELECT outbox_id, job_id, event_key, kind, attempt_id, worker_id,
             route_json, idempotency_key, payload,
             status, attempt_count, first_attempt_at, last_attempt_at,
             error_code, error_summary
      FROM continuation_outbox
      WHERE outbox_id = ? AND status = 'sending' AND worker_id = ?
    `).get(outboxId, workerId);
    if (!row) throw new Error(`Continuation delivery claim ${outboxId} disappeared.`);
    return {
      outboxId: stringField(row, 'outbox_id'),
      jobId: stringField(row, 'job_id'),
      eventKey: stringField(row, 'event_key'),
      kind: stringField(row, 'kind') as ContinuationDeliveryClaim['kind'],
      attemptId: optionalStringField(row, 'attempt_id'),
      workerId: stringField(row, 'worker_id'),
      route: parseJson<ContinuationDeliveryRoute>(row.route_json, emptyRoute()),
      idempotencyKey: stringField(row, 'idempotency_key'),
      payload: stringField(row, 'payload'),
      status: 'sending',
      attemptCount: numberField(row, 'attempt_count'),
      firstAttemptAt: optionalStringField(row, 'first_attempt_at'),
      lastAttemptAt: optionalStringField(row, 'last_attempt_at'),
      lastErrorCode: optionalStringField(row, 'error_code'),
      lastErrorSummary: optionalStringField(row, 'error_summary'),
    };
  }

  private readDeliveryEvents(jobId: string): ContinuationDeliveryRecord[] {
    return this.database.prepare(`
      SELECT event_key, kind, attempt_id, status, attempt_count,
             first_attempt_at, last_attempt_at, error_code, error_summary,
             created_at, updated_at
      FROM continuation_outbox
      WHERE job_id = ?
      ORDER BY CASE kind WHEN 'terminal' THEN 0 ELSE 1 END, created_at ASC
    `).all(jobId).map((row) => ({
      eventKey: stringField(row, 'event_key'),
      kind: stringField(row, 'kind') as ContinuationDeliveryRecord['kind'],
      attemptId: optionalStringField(row, 'attempt_id'),
      status: stringField(row, 'status') as ContinuationDeliveryRecord['status'],
      attemptCount: numberField(row, 'attempt_count'),
      firstAttemptAt: optionalStringField(row, 'first_attempt_at'),
      lastAttemptAt: optionalStringField(row, 'last_attempt_at'),
      lastErrorCode: optionalStringField(row, 'error_code'),
      lastErrorSummary: optionalStringField(row, 'error_summary'),
      createdAt: stringField(row, 'created_at'),
      updatedAt: stringField(row, 'updated_at'),
    }));
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
    SELECT j.*,
           (SELECT o.status FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'terminal'
            LIMIT 1) AS delivery_status,
           (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = j.job_id) AS attempt_count
    FROM continuation_jobs j
  `;
}

function toolCallSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS continuation_tool_calls (
      call_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      step_index INTEGER NOT NULL CHECK(step_index >= 0),
      attempt_id TEXT NOT NULL REFERENCES continuation_attempts(attempt_id),
      tool_name TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed')),
      result_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, step_index)
    ) STRICT;
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
    sourceFacts: parseJson<AsyncTaskFactSnapshot>(row.source_facts_json, redactedLegacyFacts()),
    taskContract: parseJson<AsyncTaskContract>(row.task_contract_json, redactedLegacyContract()),
    requiredTools: parseJson<string[]>(row.required_tools_json, []),
    workingDirectory: stringField(row, 'working_directory'),
    permissions: parsePermissionEnvelope(row.permissions_json),
    model: optionalStringField(row, 'model'),
    parentSessionId: optionalStringField(row, 'parent_session_id'),
    maxAttempts: numberField(row, 'max_attempts'),
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
    attemptCount: numberField(row, 'attempt_count'),
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
    retained: numberField(row, 'retain') === 1,
    deliveryStatus: optionalStringField(row, 'delivery_status') as ContinuationJob['deliveryStatus'],
  };
}

function projectCreateRequest(
  request: ContinuationCreateRequest,
  inputs: AsyncTaskFactSnapshot['inputs'],
): ContinuationCreateRequest {
  const taskContract: AsyncTaskContract = {
    ...request.taskContract,
    title: redactContinuationText(request.taskContract.title),
    objective: redactContinuationText(request.taskContract.objective),
    deliverables: request.taskContract.deliverables.map((deliverable) => ({
      ...deliverable,
      description: redactContinuationText(deliverable.description),
    })),
    acceptanceCriteria: request.taskContract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      description: redactContinuationText(criterion.description),
      deliverableIds: [...criterion.deliverableIds],
    })),
    verificationRequirements: request.taskContract.verificationRequirements.map((requirement) => ({
      ...requirement,
      description: redactContinuationText(requirement.description),
    })),
    initialContext: redactCheckpoint(request.taskContract.initialContext),
  };
  const sourceFacts: AsyncTaskFactSnapshot = {
    ...request.sourceFacts,
    originalUserText: request.sourceFacts.originalUserText === null
      ? null
      : redactContinuationText(request.sourceFacts.originalUserText),
    quotedMessageText: request.sourceFacts.quotedMessageText === null
      ? null
      : redactContinuationText(request.sourceFacts.quotedMessageText),
    route: request.route,
    creatorOpenId: request.creatorOpenId,
    sourceMessageId: request.sourceMessageId,
    ...(request.sourceThreadId ? { sourceThreadId: request.sourceThreadId } : {}),
    inputs: inputs.map((input) => ({ ...input })),
    workingDirectory: request.workingDirectory,
    model: request.model ?? null,
    permissions: request.permissions,
  };
  return {
    ...request,
    title: taskContract.title,
    objective: taskContract.objective,
    acceptanceCriteria: taskContract.acceptanceCriteria.map((criterion) => criterion.description),
    contextSnapshot: taskContract.initialContext,
    sourceFacts,
    taskContract,
  };
}

function createRequestFingerprint(request: ContinuationCreateRequest): string {
  const sourceInputDescriptors = request.sourceInputs.map((input) => ({
    kind: input.kind,
    fileName: input.fileName,
  }));
  return createHash('sha256').update(JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    retryOfJobId: request.retryOfJobId ?? null,
    creatorOpenId: request.creatorOpenId,
    route: request.route,
    sourceMessageId: request.sourceMessageId,
    sourceThreadId: request.sourceThreadId ?? null,
    sourceFacts: { ...request.sourceFacts, inputs: [] },
    taskContract: request.taskContract,
    sourceInputDescriptors,
    requiredTools: request.requiredTools,
    workingDirectory: request.workingDirectory,
    permissions: request.permissions,
    model: request.model ?? null,
    parentSessionId: request.parentSessionId ?? null,
    maxAttempts: request.maxAttempts,
    maxRetries: request.maxRetries,
    timeoutSeconds: request.timeoutSeconds,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  })).digest('hex');
}

function redactCheckpoint(checkpoint: ContinuationCheckpoint): ContinuationCheckpoint {
  return {
    summary: redactContinuationText(checkpoint.summary),
    completedSteps: checkpoint.completedSteps.map(redactContinuationText),
    remainingSteps: checkpoint.remainingSteps.map(redactContinuationText),
    constraints: checkpoint.constraints.map(redactContinuationText),
    decisions: checkpoint.decisions.map(redactContinuationText),
    references: checkpoint.references.map(redactContinuationText),
  };
}

function legacyFactsAndContract(row: SqlRow): {
  sourceFacts: AsyncTaskFactSnapshot;
  taskContract: AsyncTaskContract;
} {
  const route = parseJson<ContinuationDeliveryRoute>(row.route_json, emptyRoute());
  const permissions = parsePermissionEnvelope(row.permissions_json);
  const criteria = parseJson<string[]>(row.acceptance_criteria_json, []);
  const initialContext = parseJson<ContinuationCheckpoint>(row.context_snapshot_json, EMPTY_CHECKPOINT);
  return {
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'legacy_unavailable',
      originalUserText: null,
      quotedMessageText: null,
      creatorOpenId: stringField(row, 'creator_open_id'),
      chatId: route.kind === 'message_thread'
        ? route.conversationId
        : `doc:${route.documentToken}`,
      chatType: route.kind === 'comment_thread' ? 'doc_comment' : '',
      route,
      sourceMessageId: stringField(row, 'source_message_id'),
      sourceThreadId: optionalStringField(row, 'source_thread_id'),
      sourceMessageType: null,
      sourceTimestamp: null,
      inputs: [],
      workingDirectory: stringField(row, 'working_directory'),
      model: optionalStringField(row, 'model') ?? null,
      permissions,
    },
    taskContract: {
      schemaVersion: 1,
      title: stringField(row, 'title'),
      objective: stringField(row, 'objective'),
      deliverables: [],
      acceptanceCriteria: criteria.map((description, index) => ({
        id: legacyCriterionId(description, index),
        description,
        deliverableIds: [],
      })),
      verificationRequirements: [],
      initialContext,
    },
  };
}

function legacyCriterionId(description: string, index: number): string {
  return `criterion_${index + 1}_${createHash('sha256').update(description).digest('hex').slice(0, 12)}`;
}

function redactedLegacyFacts(): AsyncTaskFactSnapshot {
  return {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    quotedMessageText: null,
    creatorOpenId: '',
    chatId: '',
    chatType: '',
    route: emptyRoute(),
    sourceMessageId: '',
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: '',
    model: null,
    permissions: EMPTY_PERMISSION_ENVELOPE,
  };
}

function redactedLegacyContract(): AsyncTaskContract {
  return {
    schemaVersion: 1,
    title: '',
    objective: '',
    deliverables: [],
    acceptanceCriteria: [],
    verificationRequirements: [],
    initialContext: EMPTY_CHECKPOINT,
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
  validatePermissionEnvelope(request.permissions, true);
  if (!sameStringSet(request.permissions.hostTools, request.requiredTools)) {
    throw new Error('Continuation permission host tools must match required tools.');
  }
  assertJsonBytes('permission envelope', request.permissions, CONTINUATION_LIMITS.contextSnapshotBytes);
  assertJsonBytes('delivery route', request.route, CONTINUATION_LIMITS.contextSnapshotBytes);
  validateTaskContract(request.taskContract);
  if (request.sourceFacts.schemaVersion !== 1) {
    throw new Error('Continuation source facts schema version is invalid.');
  }
  if (request.sourceFacts.provenance !== 'captured' && request.sourceFacts.provenance !== 'legacy_unavailable') {
    throw new Error('Continuation source facts provenance is invalid.');
  }
  assertJsonBytes('source facts', request.sourceFacts, CONTINUATION_LIMITS.contextSnapshotBytes);
  assertJsonBytes('source inputs', request.sourceInputs.map((input) => ({
    kind: input.kind,
    fileName: input.fileName,
  })), CONTINUATION_LIMITS.contextSnapshotBytes);
  if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 20) {
    throw new Error('Continuation maxAttempts must be an integer between 1 and 20.');
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

function validateTaskContract(contract: AsyncTaskContract): void {
  if (contract.schemaVersion !== 1) throw new Error('Continuation task contract schema version is invalid.');
  if (contract.deliverables.length > CONTINUATION_LIMITS.deliverableCount) {
    throw new Error('Continuation deliverable count exceeds the configured limit.');
  }
  if (contract.acceptanceCriteria.length > CONTINUATION_LIMITS.acceptanceCriteriaCount) {
    throw new Error('Continuation acceptance criteria count exceeds the configured limit.');
  }
  if (contract.verificationRequirements.length > CONTINUATION_LIMITS.verificationRequirementCount) {
    throw new Error('Continuation verification requirement count exceeds the configured limit.');
  }
  const validateIds = (label: string, entries: Array<{ id: string }>): Set<string> => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!CONTINUATION_CONTRACT_ID_PATTERN.test(entry.id)) {
        throw new Error(`Continuation ${label} id is invalid.`);
      }
      if (ids.has(entry.id)) throw new Error(`Continuation ${label} ids must be unique.`);
      ids.add(entry.id);
    }
    return ids;
  };
  const deliverableIds = validateIds('deliverable', contract.deliverables);
  validateIds('acceptance criterion', contract.acceptanceCriteria);
  validateIds('verification requirement', contract.verificationRequirements);
  for (const criterion of contract.acceptanceCriteria) {
    for (const deliverableId of criterion.deliverableIds) {
      if (!deliverableIds.has(deliverableId)) {
        throw new Error(`Continuation acceptance criterion references unknown deliverable ${deliverableId}.`);
      }
    }
  }
  assertJsonBytes('task contract', contract, CONTINUATION_LIMITS.contextSnapshotBytes);
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

function validatePartialResult(
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
): void {
  assertJsonBytes('partial result', outcome, CONTINUATION_LIMITS.finalMessageBytes);
  if (outcome.artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Continuation result exceeds ${CONTINUATION_LIMITS.artifactCount} artifacts.`);
  }
}

function partialResultSummary(
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
): string {
  return outcome.keyFindings[0]
    ?? outcome.completedWork[0]
    ?? 'The task produced a partial result.';
}

function renderPartialPayload(
  jobId: string,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
): string {
  return [
    `Task partially completed: ${jobId}`,
    renderResultSection('Completed work', outcome.completedWork),
    renderResultSection('Key findings', outcome.keyFindings),
    renderResultSection('Remaining work', outcome.unperformedWork),
    renderResultSection('Risks', outcome.risks),
    renderResultSection('Next steps', outcome.nextSteps),
  ].filter(Boolean).join('\n');
}

function renderBlockedPayload(
  jobId: string,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'blocked' }>,
): string {
  return [
    `Task blocked: ${jobId}`,
    `Reason: ${outcome.errorSummary}`,
    `Required capability: ${outcome.requiredCapability}`,
    renderResultSection('Completed work', outcome.completedWork),
    renderResultSection('Remaining work', outcome.unperformedWork),
  ].filter(Boolean).join('\n');
}

function renderProgressPayload(
  job: ContinuationJob,
  claim: ContinuationClaim,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'continue' }>,
): string {
  const payload = [
    `Task progress: ${job.jobId} (${claim.attempt.attemptId})`,
    `Attempt: ${claim.attempt.ordinal} / ${job.maxAttempts}`,
    renderResultSection('Completed work', boundedProgressValues(outcome.checkpoint.completedSteps)),
    renderResultSection('Key findings', boundedProgressValues(
      outcome.checkpoint.summary ? [outcome.checkpoint.summary] : [],
    )),
    renderResultSection('Remaining work', boundedProgressValues(outcome.checkpoint.remainingSteps)),
    `Next attempt: ${truncateCharacters(outcome.nextStep.trim(), 500)}`,
  ].filter(Boolean).join('\n');
  return truncateCharacters(payload, PROGRESS_PAYLOAD_MAX_CHARS);
}

function boundedProgressValues(values: string[]): string[] {
  return uniqueNonEmpty(values).slice(0, 3).map((value) => truncateCharacters(value, 500));
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, Math.max(0, maxCharacters - 3)).join('').trimEnd()}...`;
}

function cleanupErrorSummary(error: unknown): string {
  const summary = error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'Unknown continuation cleanup error.';
  return truncateCharacters(summary.replace(/[\r\n\t]+/g, ' '), 500);
}

function renderResultSection(title: string, values: string[]): string {
  const filtered = uniqueNonEmpty(values);
  return filtered.length > 0 ? `${title}:\n${filtered.map((value) => `- ${value}`).join('\n')}` : '';
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validateToolRequest(request: ContinuationToolRequest): void {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(request.tool)) {
    throw new Error('Continuation local CLI tool name is invalid.');
  }
  if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
    throw new Error('Continuation local CLI tool args must be strings.');
  }
  assertJsonBytes('tool request', request, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validateToolResult(result: ContinuationToolResult): void {
  if (typeof result.ok !== 'boolean' || typeof result.message !== 'string') {
    throw new Error('Continuation local CLI tool result is invalid.');
  }
  assertJsonBytes('tool result', result, CONTINUATION_LIMITS.toolResultBytes);
}

function parseToolResult(value: SqlRow[string] | undefined): ContinuationToolResult {
  const parsed = parseJson<unknown>(value, null);
  if (
    !parsed
    || typeof parsed !== 'object'
    || typeof (parsed as { ok?: unknown }).ok !== 'boolean'
    || typeof (parsed as { message?: unknown }).message !== 'string'
  ) {
    throw new Error('Invalid continuation tool result in database.');
  }
  return parsed as ContinuationToolResult;
}

function parsePermissionEnvelope(value: SqlRow[string] | undefined): ContinuationPermissionEnvelope {
  const parsed = parseJson<unknown>(value, null);
  const normalized = normalizePermissionEnvelope(parsed);
  validatePermissionEnvelope(normalized, false);
  return normalized;
}

function normalizePermissionEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  const rawFilesystem = envelope.filesystem;
  if (!rawFilesystem || typeof rawFilesystem !== 'object' || Array.isArray(rawFilesystem)) {
    return value;
  }
  const filesystem = rawFilesystem as Record<string, unknown>;
  return {
    ...envelope,
    profile: envelope.profile ?? 'bounded',
    filesystem: {
      ...filesystem,
      requestedPaths: filesystem.requestedPaths ?? [],
    },
    externalSideEffects: envelope.externalSideEffects ?? 'denied',
  };
}

function validatePermissionEnvelope(
  value: unknown,
  requireAbsoluteRoot: boolean,
): asserts value is ContinuationPermissionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Continuation permission envelope is invalid.');
  }
  const envelope = value as Partial<ContinuationPermissionEnvelope>;
  const filesystem = envelope.filesystem;
  const approval = envelope.approval;
  const requestedPaths = filesystem?.requestedPaths;
  if (
    (envelope.profile !== 'bounded' && envelope.profile !== 'trusted_personal_workspace')
    || !filesystem
    || typeof filesystem.root !== 'string'
    || (requireAbsoluteRoot && !path.isAbsolute(filesystem.root))
    || (filesystem.mode !== 'read-only' && filesystem.mode !== 'workspace-write')
    || !Array.isArray(requestedPaths)
    || requestedPaths.length > CONTINUATION_LIMITS.requestedPathCount
    || !requestedPaths.every((requestedPath) =>
      typeof requestedPath === 'string' && path.isAbsolute(requestedPath))
    || !Array.isArray(envelope.hostTools)
    || !envelope.hostTools.every((tool) => typeof tool === 'string' && tool.length > 0)
    || (envelope.network !== 'none' && envelope.network !== 'enabled')
    || (envelope.externalSideEffects !== 'denied' && envelope.externalSideEffects !== 'allowed')
    || !approval
    || (approval.mode !== 'never' && approval.mode !== 'interactive')
  ) {
    throw new Error('Continuation permission envelope is invalid.');
  }
  if (
    (envelope.profile === 'bounded'
      && (envelope.network !== 'none'
        || envelope.externalSideEffects !== 'denied'))
    || (envelope.profile === 'trusted_personal_workspace'
      && (requestedPaths.length === 0
        || envelope.network !== 'enabled'
        || envelope.externalSideEffects !== 'allowed'))
  ) {
    throw new Error('Continuation permission envelope profile is inconsistent.');
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
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

function deliveryIdempotencyKey(jobId: string, eventKey: string): string {
  return `ct_${createHash('sha256')
    .update(`${jobId}\0${eventKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function toolCallId(jobId: string, stepIndex: number): string {
  return `call_${createHash('sha256')
    .update(`${jobId}\0${stepIndex}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function toolRequestHash(request: ContinuationToolRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
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
