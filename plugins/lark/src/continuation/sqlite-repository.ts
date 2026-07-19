import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  CONTINUATION_CONTRACT_ID_PATTERN,
  CONTINUATION_LIMITS,
  continuationArtifactStatus,
  isContinuationTerminal,
  partialOutcomeFromCheckpoint,
  retryDelayMs,
  type AsyncTaskContract,
  type AsyncTaskFactSnapshot,
  type ContinuationClaim,
  type ContinuationAttemptDelta,
  type ContinuationCheckpoint,
  type ContinuationCheckpointV2,
  type ContinuationCleanupResult,
  type ContinuationCreateRequest,
  type ContinuationDeliveryClaim,
  type ContinuationDeliveryRecord,
  type ContinuationDeliveryResult,
  type ContinuationDeliveryRoute,
  type ContinuationExecutionResult,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationPendingInterruptRoute,
  type ContinuationPermissionEnvelope,
  type ContinuationRecoveryState,
  type ContinuationStatus,
  type ContinuationStepOutcome,
  type ContinuationToolCallDecision,
  type ContinuationToolCallRecovery,
  type ContinuationToolRequest,
  type ContinuationToolResult,
  type ContinuationVerificationVerdict,
} from '../domain/continuation.js';
import {
  createAttemptDelta,
  evaluateContinuationProgress,
  rejectedAttemptDelta,
} from './progress-policy.js';
import { ContinuationVerifier } from './verifier.js';
import type {
  ContinuationClaimMutationResult,
  ContinuationInputStorePort,
  ContinuationInputVerification,
  ContinuationPreparedTransition,
  ContinuationRepository,
} from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import {
  continuationJobId,
  continuationRetryIdempotencyKey,
  continuationRetryJobId,
} from './idempotency.js';
import { ContinuationInputStore } from './input-store.js';
import { redactContinuationText } from './redaction.js';
import type {
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunTransition,
} from '../domain/durable-run.js';
import { SqliteDurableRunRepository } from '../durable-run/sqlite-repository.js';
import {
  asyncTaskDurableCreateRequestFromJob,
  asyncTaskStateEnvelopeFromJob,
  continuationClaimFromDurable,
  continuationDeliveryClaimFromDurable,
  parseTrustedAsyncTaskInputJob,
  validateAsyncTaskPersistedRun,
} from './async-task-kernel-adapter.js';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  installContinuationCompatibilitySchema,
  migrateSqliteToDurableV10,
} from '../durable-run/sqlite-migrations.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

interface SqliteContinuationRepositoryOptions {
  databasePath: string;
  artifactsDir: string;
  artifactStore?: ContinuationArtifactStore;
  inputsDir?: string;
  inputStore?: ContinuationInputStorePort;
  jitter?: () => number;
}

type DueCandidateSelection =
  | { kind: 'job'; job: ContinuationJob }
  | null;

const OUTCOME_DRIVEN_SCHEMA_VERSION = 8;
const SCHEMA_VERSION = DURABLE_RUN_SCHEMA_VERSION;
const ASYNC_TASK_FACTS_MIGRATION_VERSION = 70;
const DELIVERY_LEASE_MS = 30_000;
const PROGRESS_PAYLOAD_MAX_CHARS = 4_000;
const MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT = 2;
const MAX_TOTAL_RECOVERY_ATTEMPTS = 4;
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

class LegacyPersistedRowError extends Error {}
class LegacyRouteProjectionError extends LegacyPersistedRowError {}

export class SqliteContinuationRepository implements ContinuationRepository {
  private readonly jobMutationTails = new Map<string, Promise<void>>();
  private readonly activeDurableClaims = new Map<string, import('../domain/durable-run.js').DurableRunClaim>();
  private readonly verifier: ContinuationVerifier;
  readonly durableRuns: SqliteDurableRunRepository;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly artifacts: ContinuationArtifactStore,
    private readonly inputs: ContinuationInputStorePort,
    private readonly jitter: () => number,
  ) {
    this.verifier = new ContinuationVerifier(artifacts);
    this.durableRuns = SqliteDurableRunRepository.attach(database);
  }

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
      const artifacts = options.artifactStore ?? new ContinuationArtifactStore(options.artifactsDir);
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
      await repository.reconcileStorageOrphans();
      return repository;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async initialize(): Promise<void> {
    const existingVersion = Number(this.scalar('PRAGMA user_version'));
    if (
      existingVersion > SCHEMA_VERSION
      && existingVersion !== ASYNC_TASK_FACTS_MIGRATION_VERSION
    ) {
      throw new Error(
        `Unsupported continuation database schema version ${existingVersion}; expected at most ${SCHEMA_VERSION}.`,
      );
    }
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    await retrySqliteBusy(() => this.database.exec('PRAGMA journal_mode = WAL;'), 5_000);
    this.database.exec('PRAGMA synchronous = NORMAL;');
    await retrySqliteBusy(() => {
      migrateSqliteToDurableV10(this.database);
      installContinuationCompatibilitySchema(this.database);
    }, 5_000);
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
    const jobId = continuationJobId(request.idempotencyKey);
    const existing = await this.readRecoveringJobBy('j.idempotency_key = ?', request.idempotencyKey);
    if (existing) return { job: existing, created: false };
    return this.serializeJobMutation(jobId, () => this.inputs.withCreationLock(jobId, async () => {
      const existing = await this.readRecoveringJobBy(
        'j.idempotency_key = ?',
        request.idempotencyKey,
        true,
      );
      if (existing) return { job: existing, created: false };
      const occupiedJobId = await this.readRecoveringJobBy('j.job_id = ?', jobId, true);
      if (occupiedJobId) {
        throw new Error('Continuation idempotency conflict: the deterministic Job ID is already retired or owned by another request.');
      }
      if (
        request.retryOfJobId
        && !this.database.prepare(`
          SELECT 1 FROM durable_runs
          WHERE run_id = ? AND workload_kind = 'async_task'
        `).get(request.retryOfJobId)
      ) {
        throw new Error('Continuation retry source does not exist.');
      }
      const requestFingerprint = createRequestFingerprint(request);
      const installation = await this.inputs.install(
        jobId,
        request.sourceInputs,
        requestFingerprint,
      );
      const persisted = projectCreateRequest(request, installation.artifacts);
      let artifactsInstalled = false;
      try {
        if (persisted.resumeCheckpoint) {
          artifactsInstalled = await this.artifacts.copyVerified(
            persisted.resumeArtifactSourceJobId!,
            jobId,
            persisted.resumeCheckpoint.artifacts,
          );
        }
        const initialJob = continuationJobForCreate(jobId, persisted);
        const durable = await this.durableRuns.create(
          asyncTaskDurableCreateRequestFromJob(initialJob),
        );
        const created = durable.created;
        const job = created
          ? await this.readRecoveringJobBy('j.job_id = ?', jobId, true)
          : await this.readRecoveringJobBy(
            'j.idempotency_key = ?',
            request.idempotencyKey,
            true,
          );
        if (!job) {
          throw new Error('Continuation create conflicted with an unrelated deterministic Job ID.');
        }
        return { job, created };
      } catch (error) {
        if (installation.installed && this.canConfirmJobAbsent(jobId, request.idempotencyKey)) {
          await this.inputs.remove(jobId).catch(() => {});
        }
        if (artifactsInstalled && this.canConfirmJobAbsent(jobId, request.idempotencyKey)) {
          await this.artifacts.remove(jobId).catch(() => {});
        }
        throw error;
      }
    }));
  }

  async get(jobId: string): Promise<ContinuationJob | null> {
    const job = await this.readRecoveringJobBy('j.job_id = ?', jobId);
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
    while (true) {
      const durableClaim = await this.durableRuns.claimDue(
        ['async_task'],
        workerId,
        now,
        leaseExpiresAt,
        validateAsyncTaskPersistedRun,
      );
      if (!durableClaim) return null;
      let claim: ContinuationClaim;
      try {
        claim = continuationClaimFromDurable(durableClaim);
      } catch {
        await this.durableRuns.commitTransition(durableClaim, {
          status: 'failed',
          stateVersion: durableClaim.run.stateVersion,
          state: durableClaim.run.state,
          errorCode: 'continuation_persisted_state_invalid',
          errorSummary: 'Stored task state failed integrity validation.',
        }, now);
        continue;
      }
      let verification: ContinuationInputVerification;
      try {
        verification = await this.inputs.verify(
          claim.job.jobId,
          claim.job.sourceFacts.inputs,
        );
      } catch {
        verification = { ok: false, reason: 'invalid' };
      }
      if (!verification.ok) {
        const prepared = await this.prepareFailureTransition(claim, {
          errorCode: 'continuation_input_integrity_failed',
          errorSummary: 'A managed continuation input failed integrity verification.',
          retryable: false,
        }, now);
        await this.durableRuns.commitTransition(
          durableClaim,
          prepared.transition,
          prepared.commitAt,
        );
        continue;
      }
      const latest = await this.durableRuns.get(claim.job.jobId);
      if (latest?.status === 'cancel_requested') {
        const prepared = await this.prepareCancellationTransition(claim, now);
        await this.durableRuns.commitTransition(
          durableClaim,
          prepared.transition,
          prepared.commitAt,
        );
        continue;
      }
      if (
        !latest
        || latest.status !== 'running'
        || latest.rowVersion !== claim.claimedRowVersion
      ) continue;
      this.activeDurableClaims.set(durableClaimKey(claim.job.jobId, workerId), durableClaim);
      return claim;
    }
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const claim = this.activeDurableClaims.get(durableClaimKey(jobId, workerId));
    if (!claim) return false;
    const alive = await this.durableRuns.heartbeat(claim, now, leaseExpiresAt);
    if (!alive) this.forgetActiveDurableClaim(claim);
    return alive;
  }

  async markExecutionStarted(
    claim: ContinuationClaim,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    if (!claim.durableClaim || !claimProjectionMatches(claim)) return 'stale';
    const result = await this.durableRuns.markExecutionStarted(claim.durableClaim, now);
    if (result === 'stale') this.forgetActiveDurableClaim(claim.durableClaim);
    return result;
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
      const stepId = continuationStepId(current);
      const running = this.database.prepare(`
        SELECT call_id, tool_name, request_hash, status, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_id = ? AND status = 'running'
      `).get(current.jobId, stepId);
      if (running) {
        return { status: 'unknown', callId: stringField(running, 'call_id') };
      }
      const existing = this.database.prepare(`
        SELECT call_id, tool_name, request_hash, status, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_id = ? AND request_hash = ?
      `).get(current.jobId, stepId, requestHash);
      if (existing) {
        const callId = stringField(existing, 'call_id');
        if (stringField(existing, 'status') === 'completed') {
          const result = parseToolResult(existing.result_json);
          if (!result.ok && result.failure && canReexecuteSameToolRequest(current, result.failure)) {
            const reopened = this.database.prepare(`
              UPDATE durable_operation_receipts
              SET status = 'running', attempt_id = ?, result_json = NULL,
                  completed_at = NULL, started_at = ?, updated_at = ?
              WHERE receipt_id = ? AND run_id = ? AND status = 'completed'
            `).run(claim.attempt.attemptId, now, now, callId, current.jobId);
            assertOneChange(reopened.changes, current.jobId);
            return { status: 'execute', callId };
          }
          return {
            status: 'replay',
            callId,
            result,
          };
        }
        return { status: 'unknown', callId };
      }

      const completedForStep = this.database.prepare(`
        SELECT call_id, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_id = ? AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1
      `).get(current.jobId, stepId);
      if (completedForStep) {
        const prior = parseToolResult(completedForStep.result_json);
        if (
          prior.ok
          || !prior.failure
          || !canReplaceCompletedToolFailure(current, prior.failure)
        ) return { status: 'conflict', callId: stringField(completedForStep, 'call_id') };
      }

      const callId = toolCallId(current.jobId, stepId, requestHash);
      this.database.prepare(`
        INSERT INTO durable_operation_receipts (
          receipt_id, run_id, attempt_id, operation_key, operation_name,
          request_hash, operation_risk, status, started_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', 'running', ?, ?, ?)
      `).run(
        callId,
        current.jobId,
        claim.attempt.attemptId,
        stepId,
        request.tool,
        requestHash,
        now,
        now,
        JSON.stringify({ stepIndex: current.stepCount, stepId }),
      );
      return { status: 'execute', callId };
    });
  }

  async inspectToolCall(
    claim: ContinuationClaim,
  ): Promise<ContinuationToolCallRecovery | null> {
    return this.transaction(() => {
      const current = this.assertActiveClaim(claim);
      const stepId = continuationStepId(current);
      const row = this.database.prepare(`
        SELECT tool_name, status, result_json
        FROM continuation_tool_calls
        WHERE job_id = ? AND step_id = ?
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1
      `).get(current.jobId, stepId);
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
        UPDATE durable_operation_receipts
        SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
        WHERE receipt_id = ? AND run_id = ? AND operation_key = ? AND status = 'running'
      `).run(
        JSON.stringify(result),
        now,
        now,
        callId,
        current.jobId,
        continuationStepId(current),
      );
      assertOneChange(update.changes, current.jobId);
    });
  }

  async verifyClaimInputs(claim: ContinuationClaim): Promise<ContinuationInputVerification> {
    try {
      return await this.inputs.verify(claim.job.jobId, claim.job.sourceFacts.inputs);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  async completeStep(
    claim: ContinuationClaim,
    result: ContinuationExecutionResult,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    if (!claim.durableClaim || !claimProjectionMatches(claim)) return 'stale';
    const current = await this.durableRuns.get(claim.job.jobId);
    if (
      !current
      || current.status !== 'running'
      || current.rowVersion !== claim.claimedRowVersion
      || claim.durableClaim.attempt.leaseExpiresAt <= now
    ) {
      this.forgetActiveDurableClaim(claim.durableClaim);
      return 'stale';
    }
    const prepared = await this.prepareStepTransition(claim, result, now);
    const committed = await this.durableRuns.commitTransition(
      claim.durableClaim,
      prepared.transition,
      prepared.commitAt,
    );
    this.forgetActiveDurableClaim(claim.durableClaim);
    return committed;
  }

  async prepareStepTransition(
    claim: ContinuationClaim,
    result: ContinuationExecutionResult,
    now: string,
  ): Promise<ContinuationPreparedTransition> {
    const leaseCheckStartedAt = process.hrtime.bigint();
    const current = claim.job;
    const candidate = result.outcome.checkpoint;
    assertJsonBytes('checkpoint', candidate, CONTINUATION_LIMITS.checkpointBytes);
    const previous = current.checkpoint ?? null;
    const rawVerification = await this.verifier.verify({
      job: current,
      previous,
      candidate,
      requestedOutcome: result.outcome.outcome,
      ...('artifacts' in result.outcome ? { resultArtifacts: result.outcome.artifacts } : {}),
    });
    const progress = result.outcome.outcome === 'continue' || result.outcome.outcome === 'completed'
      ? evaluateContinuationProgress({
          previous,
          candidate,
          requestedOutcome: result.outcome.outcome,
          verification: rawVerification,
          budget: {
            attemptOrdinal: claim.attempt.ordinal,
            maxAttempts: current.maxAttempts,
            noProgressCount: current.noProgressCount,
            maxNoProgressAttempts: 2,
          },
        })
      : null;
    const candidateDelta = progress?.delta ?? createAttemptDelta(previous, candidate);
    const delta = rawVerification.status === 'accepted'
      ? candidateDelta
      : rejectedAttemptDelta(candidateDelta);
    const verification: ContinuationVerificationVerdict = (
      rawVerification.status === 'accepted' && progress?.decision === 'recover'
    )
      ? {
          status: 'revision_required',
          findings: ['A continue outcome requires one concrete next action.'],
        }
      : rawVerification;
    return {
      transition: buildContinuationStepTransition({
        claim,
        current,
        result,
        now,
        progress,
        delta,
        verification,
        rawVerification,
        jitter: this.jitter,
      }),
      commitAt: timestampAfterElapsed(now, leaseCheckStartedAt),
    };
  }

  async failAttempt(
    claim: ContinuationClaim,
    failure: ContinuationFailure,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    if (!claim.durableClaim || !claimProjectionMatches(claim)) return 'stale';
    const current = await this.durableRuns.get(claim.job.jobId);
    if (
      !current
      || current.status !== 'running'
      || current.rowVersion !== claim.claimedRowVersion
      || claim.durableClaim.attempt.leaseExpiresAt <= now
    ) {
      this.forgetActiveDurableClaim(claim.durableClaim);
      return 'stale';
    }
    const prepared = await this.prepareFailureTransition(claim, failure, now);
    const committed = await this.durableRuns.failAttempt(
      claim.durableClaim,
      durableFailureForContinuationFailure(claim, failure),
      prepared.commitAt,
      prepared.transition,
    );
    this.forgetActiveDurableClaim(claim.durableClaim);
    return committed;
  }

  async prepareFailureTransition(
    claim: ContinuationClaim,
    failure: ContinuationFailure,
    now: string,
  ): Promise<ContinuationPreparedTransition> {
    return {
      transition: buildContinuationFailureTransition(
        claim,
        claim.job,
        failure,
        now,
        this.jitter,
      ),
      commitAt: now,
    };
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
        const next = continuationJobForCommandState(
          current,
          'cancel_requested',
          current.rowVersion,
          now,
        );
        const update = this.database.prepare(`
          UPDATE durable_runs
          SET status = 'cancel_requested', state_version = 1, state_json = ?, updated_at = ?
          WHERE run_id = ? AND workload_kind = 'async_task'
            AND status = 'running' AND row_version = ? AND deleted_at IS NULL
        `).run(
          JSON.stringify(asyncTaskStateEnvelopeFromJob(next)),
          now,
          jobId,
          current.rowVersion,
        );
        return Number(update.changes) === 1 ? 'cancel_requested' : 'terminal';
      }

      const next = continuationJobForCommandState(
        current,
        'cancelled',
        current.rowVersion + 1,
        now,
      );
      const update = this.database.prepare(`
        UPDATE durable_runs
        SET status = 'cancelled', state_version = 1, state_json = ?, completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
            row_version = row_version + 1
        WHERE run_id = ? AND workload_kind = 'async_task'
          AND status IN ('queued', 'waiting_retry', 'recovering', 'waiting_user')
          AND row_version = ? AND deleted_at IS NULL
      `).run(
        JSON.stringify(asyncTaskStateEnvelopeFromJob(next)),
        now,
        now,
        jobId,
        current.rowVersion,
      );
      if (Number(update.changes) !== 1) return 'terminal';
      this.insertTerminalOutbox(
        current,
        `Task cancelled: ${jobId}\nThe background task was cancelled.`,
        now,
      );
      return 'cancelled';
    });
  }

  async completeCancellation(
    claim: ContinuationClaim,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    if (!claim.durableClaim || !claimProjectionMatches(claim)) return 'stale';
    const prepared = await this.prepareCancellationTransition(claim, now);
    const committed = await this.durableRuns.commitTransition(
      claim.durableClaim,
      prepared.transition,
      prepared.commitAt,
    );
    this.forgetActiveDurableClaim(claim.durableClaim);
    return committed;
  }

  async prepareCancellationTransition(
    claim: ContinuationClaim,
    now: string,
  ): Promise<ContinuationPreparedTransition> {
    return {
      transition: continuationDurableTransition(
        claim,
        claim.job,
        'cancelled',
        {},
        now,
        {
          executionSessionId: claim.job.executionSessionId,
          attemptOutcome: 'cancelled',
          deliveries: [continuationTerminalDelivery(
            claim.job,
            `Task cancelled: ${claim.job.jobId}\nThe background task was cancelled.`,
            now,
          )],
          supersedeDeliveryKinds: ['progress', 'interrupt'],
        },
      ),
      commitAt: now,
    };
  }

  async recoverExpiredLeases(now: string): Promise<DurableRunInterruptedAttempt[]> {
    const interrupted = await this.durableRuns.recoverExpiredLeases(
      ['async_task'],
      now,
      validateAsyncTaskPersistedRun,
    );
    const valid: DurableRunInterruptedAttempt[] = [];
    for (const attempt of interrupted) {
      this.forgetActiveDurableClaim(attempt.claim);
      try {
        continuationClaimFromDurable(attempt.claim);
        valid.push(attempt);
      } catch {
        await this.durableRuns.commitTransition(attempt.claim, {
          status: 'failed',
          stateVersion: attempt.claim.run.stateVersion,
          state: attempt.claim.run.state,
          errorCode: 'continuation_persisted_state_invalid',
          errorSummary: 'Stored task state failed integrity validation.',
        }, now);
      }
    }
    return valid;
  }

  async commitDurableTransition(
    claim: import('../domain/durable-run.js').DurableRunClaim,
    transition: import('../domain/durable-run.js').DurableRunTransition,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    const committed = await this.durableRuns.commitTransition(claim, transition, now);
    this.forgetActiveDurableClaim(claim);
    return committed;
  }

  async expireOverdue(now: string): Promise<number> {
    const corruptJobIds: string[] = [];
    let expiredCount = this.transaction(() => {
      const rows = this.database.prepare(`
        ${jobSelectSql()}
        WHERE j.status IN ('queued', 'waiting_retry', 'recovering', 'waiting_user', 'running')
          AND j.expires_at <= ?
          AND j.deleted_at IS NULL
      `).all(now);
      let expired = 0;
      for (const row of rows) {
        const jobId = stringField(row, 'job_id');
        let current: ContinuationJob;
        try {
          current = mapJob(row);
        } catch {
          corruptJobIds.push(jobId);
          continue;
        }
        const expiredJob = continuationJobForCommandState(
          current,
          'failed',
          current.rowVersion + 1,
          now,
        );
        expiredJob.errorCode = 'continuation_expired';
        expiredJob.errorSummary = 'The continuation reached its maximum age.';
        const update = this.database.prepare(`
          UPDATE durable_runs
          SET status = 'failed', state_version = 1, state_json = ?,
              error_code = 'continuation_expired',
              error_summary = 'The continuation reached its maximum age.',
              completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = NULL, updated_at = ?, row_version = row_version + 1
          WHERE run_id = ? AND workload_kind = 'async_task'
            AND status IN ('queued', 'waiting_retry', 'recovering', 'waiting_user', 'running')
            AND expires_at <= ? AND row_version = ?
        `).run(
          JSON.stringify(asyncTaskStateEnvelopeFromJob(expiredJob)),
          now,
          now,
          jobId,
          now,
          current.rowVersion,
        );
        if (Number(update.changes) !== 1) continue;
        if (current.status === 'running') {
          this.database.prepare(`
            UPDATE durable_attempts
            SET finished_at = ?, heartbeat_at = ?, outcome = 'failed',
                error_code = 'continuation_expired',
                error_summary = 'The continuation reached its maximum age.',
                recovery_pending = 0
            WHERE run_id = ? AND finished_at IS NULL
          `).run(now, now, jobId);
          this.forgetActiveDurableClaimsForRun(jobId);
        }
        expired += 1;
        this.insertTerminalOutbox(
          current,
          `Task failed: ${jobId}\nThe continuation reached its maximum age.`,
          now,
        );
      }
      return expired;
    });
    for (const jobId of corruptJobIds) {
      if (await this.recoverCorruptJobStorage(jobId, now, false)) expiredCount += 1;
    }
    return expiredCount;
  }

  async cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob> {
    const idempotencyKey = continuationRetryIdempotencyKey(jobId, requestId);
    const existing = await this.get(continuationRetryJobId(jobId, requestId));
    if (existing && !existing.deletedAt) {
      if (existing.idempotencyKey !== idempotencyKey || existing.retryOfJobId !== jobId) {
        throw new Error('Continuation retry idempotency conflicts with an unrelated Job.');
      }
      return existing;
    }
    const source = await this.get(jobId);
    if (!source || !isContinuationTerminal(source.status) || source.deletedAt) {
      throw new Error(`Continuation ${jobId} is not an available terminal job.`);
    }
    if (source.errorCode === 'continuation_persisted_state_invalid') {
      throw new Error('Continuation retry is unavailable because stored task state failed integrity validation.');
    }
    const lifetimeMs = Math.max(1, Date.parse(source.expiresAt) - Date.parse(source.createdAt));
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
        expectedSha256: input.sha256,
        expectedSizeBytes: input.sizeBytes,
      })),
      ...(source.checkpoint ? {
        resumeCheckpoint: source.checkpoint,
        ...(source.checkpoint.artifacts.length > 0
          ? { resumeArtifactSourceJobId: source.jobId }
          : {}),
      } : {}),
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
    return this.serializeJobMutation(jobId, () => this.inputs.withCreationLock(
      jobId,
      () => this.redactTerminalInternal(jobId, now),
    ));
  }

  async setRetained(jobId: string, retained: boolean, now: string): Promise<boolean> {
    return this.serializeJobMutation(jobId, () => {
      const current = this.readJobBy('j.job_id = ?', jobId);
      if (!current || current.deletedAt) return false;
      const next: ContinuationJob = {
        ...continuationJobForCommandState(
          current,
          current.status,
          current.rowVersion + 1,
          now,
        ),
        retained,
      };
      const update = this.database.prepare(`
        UPDATE durable_runs
        SET retained = ?, state_version = 1, state_json = ?,
            updated_at = ?, row_version = row_version + 1
        WHERE run_id = ? AND workload_kind = 'async_task'
          AND row_version = ? AND deleted_at IS NULL
      `).run(
        retained ? 1 : 0,
        JSON.stringify(asyncTaskStateEnvelopeFromJob(next)),
        now,
        jobId,
        current.rowVersion,
      );
      return Number(update.changes) === 1;
    });
  }

  private async redactTerminalInternal(
    jobId: string,
    now: string,
    automaticRetentionCutoff?: string,
  ): Promise<boolean> {
    const recovered = await this.readRecoveringJobBy('j.job_id = ?', jobId, true);
    const current = recovered
      ? { ...recovered, deliveryEvents: this.readDeliveryEvents(jobId) }
      : null;
    if (!current || !isContinuationTerminal(current.status) || current.deletedAt) return false;
    if (
      automaticRetentionCutoff
      && (
        current.retained
        || (
          current.errorCode !== 'continuation_persisted_state_invalid'
          && current.deliveryStatus !== 'delivered'
          && !current.deliveryEvents?.some((event) =>
            event.kind === 'terminal'
            && event.status === 'failed'
            && event.lastErrorCode === 'continuation_delivery_route_invalid')
        )
        || !current.completedAt
        || current.completedAt >= automaticRetentionCutoff
      )
    ) {
      return false;
    }
    const quarantines: RedactionQuarantines = { artifact: null, input: null };
    let committed = false;
    let restoreAttempted = false;
    try {
      quarantines.artifact = await this.artifacts.quarantine(jobId);
      quarantines.input = await this.inputs.quarantine(jobId);
      const redacted = this.transaction(() => {
        const redactedJob: ContinuationJob = {
          ...continuationJobForCommandState(
            current,
            current.status,
            current.rowVersion + 1,
            now,
          ),
          idempotencyKey: `redacted:${jobId}`,
          route: emptyRoute(),
          sourceMessageId: '',
          title: '',
          objective: '',
          acceptanceCriteria: [],
          contextSnapshot: EMPTY_CHECKPOINT,
          sourceFacts: redactedLegacyFacts(),
          taskContract: redactedLegacyContract(),
          requiredTools: [],
          workingDirectory: '',
          permissions: EMPTY_PERMISSION_ENVELOPE,
          resultArtifacts: [],
          completedAt: current.completedAt ?? now,
          deletedAt: now,
        };
        delete redactedJob.sourceThreadId;
        delete redactedJob.model;
        delete redactedJob.parentSessionId;
        delete redactedJob.executionSessionId;
        delete redactedJob.checkpoint;
        delete redactedJob.resultSummary;
        delete redactedJob.errorSummary;
        const automaticGate = automaticRetentionCutoff
          ? `AND retained = 0 AND completed_at < ? AND (
            error_code = 'continuation_persisted_state_invalid'
            OR EXISTS (
              SELECT 1 FROM durable_outbox terminal
              WHERE terminal.run_id = durable_runs.run_id
                AND terminal.kind = 'terminal'
                AND (
                  terminal.status = 'sent'
                  OR (
                    terminal.status = 'failed'
                    AND terminal.error_code = 'continuation_delivery_route_invalid'
                  )
                )
            )
          )`
          : '';
        const update = this.database.prepare(`
          UPDATE durable_runs
          SET idempotency_key = ?, input_version = 1, input_json = ?,
              state_version = 1, state_json = ?, route_json = ?,
              error_summary = NULL, deleted_at = ?, updated_at = ?,
              row_version = row_version + 1
          WHERE run_id = ? AND workload_kind = 'async_task'
            AND status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled')
            AND row_version = ? AND deleted_at IS NULL ${automaticGate}
        `).run(
          redactedJob.idempotencyKey,
          JSON.stringify({ schemaVersion: 1, job: redactedJob }),
          JSON.stringify(asyncTaskStateEnvelopeFromJob(redactedJob)),
          JSON.stringify(emptyRoute()),
          now,
          now,
          jobId,
          current.rowVersion,
          ...(automaticRetentionCutoff ? [automaticRetentionCutoff] : []),
        );
        if (Number(update.changes) !== 1) return false;
        this.database.prepare(`
          DELETE FROM durable_outbox WHERE run_id = ? AND kind <> 'terminal'
        `).run(jobId);
        this.database.prepare(`
          DELETE FROM durable_interrupts WHERE run_id = ?
        `).run(jobId);
        this.database.prepare(`
          DELETE FROM durable_operation_receipts WHERE run_id = ?
        `).run(jobId);
        this.database.prepare(`
          DELETE FROM durable_attempts WHERE run_id = ?
        `).run(jobId);
        this.database.prepare(`
          UPDATE durable_outbox
          SET route_json = ?, payload_json = ?, worker_id = NULL, lease_expires_at = NULL,
              error_summary = NULL,
              status = CASE
                WHEN status IN ('sent', 'unknown') THEN status
                WHEN status = 'sending' THEN 'unknown'
                ELSE 'superseded'
              END,
              updated_at = ?
          WHERE run_id = ? AND kind = 'terminal'
        `).run(JSON.stringify(emptyRoute()), JSON.stringify(''), now, jobId);
        return true;
      });
      if (!redacted) {
        restoreAttempted = true;
        const restoreErrors = await restoreRedactionQuarantines(
          jobId,
          quarantines,
          this.artifacts,
          this.inputs,
        );
        if (restoreErrors.length > 0) {
          throw new AggregateError(
            restoreErrors,
            'Continuation redaction was not committed and quarantined data could not be restored.',
          );
        }
        return false;
      }
      committed = true;
      const discardErrors = await discardRedactionQuarantines(
        jobId,
        quarantines,
        this.artifacts,
        this.inputs,
      );
      if (discardErrors.length > 0) {
        throw new AggregateError(
          discardErrors,
          'Continuation redaction committed, but quarantined data cleanup is incomplete.',
        );
      }
      return true;
    } catch (error) {
      if (!committed && !restoreAttempted) {
        const restoreErrors = await restoreRedactionQuarantines(
          jobId,
          quarantines,
          this.artifacts,
          this.inputs,
        );
        if (restoreErrors.length > 0) {
          throw new AggregateError(
            [error, ...restoreErrors],
            'Continuation redaction failed and quarantined data could not be restored.',
          );
        }
      }
      throw error;
    }
  }

  async claimPendingDelivery(
    workerId: string,
    now: string,
  ): Promise<ContinuationDeliveryClaim | null> {
    while (true) {
      const claim = await this.durableRuns.claimDelivery(['async_task'], workerId, now);
      if (!claim) return null;
      const job = await this.get(claim.runId);
      if (!job || !isDeepStrictEqual(claim.route, job.route)) {
        await this.durableRuns.commitDelivery(claim, {
          status: 'failed',
          errorCode: 'continuation_delivery_route_invalid',
          errorSummary: 'Stored delivery route does not match its Async Task route.',
        }, now);
        continue;
      }
      return continuationDeliveryClaimFromDurable(claim);
    }
  }

  async markDeliveryResult(
    claim: ContinuationDeliveryClaim,
    result: ContinuationDeliveryResult,
    now: string,
  ): Promise<void> {
    if (!claim.durableClaim) {
      throw new Error(`Stale continuation delivery claim for ${claim.outboxId}.`);
    }
    const prepared = await this.prepareDeliveryResult(claim, result, now);
    const committed = await this.durableRuns.commitDelivery(claim.durableClaim, prepared, now);
    if (committed === 'stale') {
      throw new Error(`Stale continuation delivery claim for ${claim.outboxId}.`);
    }
  }

  async prepareDeliveryResult(
    claim: ContinuationDeliveryClaim,
    result: ContinuationDeliveryResult,
    now: string,
  ): Promise<DurableRunDeliveryResult> {
    if (result.status === 'delivered') {
      return { status: 'sent', messageId: result.messageId };
    }
    if (result.status === 'delivery_unknown') {
      return {
        status: 'unknown',
        errorCode: result.errorCode,
        errorSummary: result.errorSummary,
      };
    }
    if (result.status === 'failed') {
      return {
        status: 'failed',
        errorCode: result.errorCode,
        errorSummary: result.errorSummary,
        ...(claim.kind === 'terminal' ? {} : { terminalConflict: 'superseded' as const }),
      };
    }
    const resetAttemptCount = claim.attemptCount === 1
      && result.errorCode === 'lark_pre_send_unavailable';
    return {
      status: 'retry',
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
      retryAt: addMilliseconds(
        now,
        retryDelayMs(Math.max(1, claim.attemptCount), this.jitter()),
      ),
      ...(resetAttemptCount ? { resetAttemptCount: true } : {}),
      ...(claim.kind === 'terminal'
        ? {}
        : {
            terminalConflict: resetAttemptCount
              ? 'superseded' as const
              : 'unknown' as const,
          }),
    };
  }

  async listPendingInterrupts(): Promise<ContinuationPendingInterruptRoute[]> {
    return this.database.prepare(`
      SELECT i.interrupt_id, i.job_id, j.route_json, o.message_id
      FROM continuation_interrupts i
      JOIN continuation_jobs j ON j.job_id = i.job_id
      JOIN continuation_outbox o
        ON o.job_id = i.job_id AND o.event_key = 'interrupt:' || i.interrupt_id
      WHERE i.status = 'pending' AND j.status = 'waiting_user'
        AND j.deleted_at IS NULL AND o.status = 'delivered' AND o.message_id IS NOT NULL
      ORDER BY i.created_at ASC
    `).all().map(mapPendingInterruptRoute);
  }

  async findPendingInterruptByDeliveryMessage(
    messageId: string,
  ): Promise<ContinuationPendingInterruptRoute | null> {
    if (!messageId) return null;
    const row = this.database.prepare(`
      SELECT i.interrupt_id, i.job_id, j.route_json, o.message_id
      FROM continuation_interrupts i
      JOIN continuation_jobs j ON j.job_id = i.job_id
      JOIN continuation_outbox o
        ON o.job_id = i.job_id AND o.event_key = 'interrupt:' || i.interrupt_id
      WHERE i.status = 'pending' AND j.status = 'waiting_user'
        AND j.deleted_at IS NULL AND o.status = 'delivered' AND o.message_id = ?
      LIMIT 1
    `).get(messageId);
    return row ? mapPendingInterruptRoute(row) : null;
  }

  async findPendingInterrupt(
    jobId: string,
    interruptId: string,
  ): Promise<ContinuationPendingInterruptRoute | null> {
    const row = this.database.prepare(`
      SELECT i.interrupt_id, i.job_id, j.route_json, o.message_id
      FROM continuation_interrupts i
      JOIN continuation_jobs j ON j.job_id = i.job_id
      JOIN continuation_outbox o
        ON o.job_id = i.job_id AND o.event_key = 'interrupt:' || i.interrupt_id
      WHERE i.interrupt_id = ? AND i.job_id = ? AND i.status = 'pending'
        AND j.status = 'waiting_user' AND j.deleted_at IS NULL
      LIMIT 1
    `).get(interruptId, jobId);
    return row ? mapPendingInterruptRoute(row) : null;
  }

  async resumeWaitingUser(
    jobId: string,
    interruptId: string,
    input: string,
    now: string,
  ): Promise<'resumed' | 'stale' | 'missing'> {
    const normalizedInput = redactContinuationText(input).trim();
    if (!normalizedInput || Array.from(normalizedInput).length > CONTINUATION_LIMITS.resumeInputChars) {
      throw new Error(`Continuation resume input must be 1-${CONTINUATION_LIMITS.resumeInputChars} characters.`);
    }
    return this.transaction(() => {
      const schemaVersion = Number(this.scalar('PRAGMA user_version'));
      const row = this.database.prepare(
        `${jobSelectSql(
          schemaVersion >= OUTCOME_DRIVEN_SCHEMA_VERSION,
          schemaVersion >= SCHEMA_VERSION,
        )} WHERE j.job_id = ?`,
      ).get(jobId);
      if (!row) return 'missing';
      const current = mapJob(row);
      if (
        current.status !== 'waiting_user'
        || current.currentInterrupt?.interruptId !== interruptId
        || current.currentInterrupt.status === 'resolved'
        || !current.recovery
      ) return 'stale';
      const recovery: ContinuationRecoveryState = {
        ...current.recovery,
        lastDecision: 'retry',
        userInput: normalizedInput,
      };
      assertJsonBytes('recovery state', recovery, CONTINUATION_LIMITS.contextSnapshotBytes);
      const interrupt = this.database.prepare(`
        UPDATE durable_interrupts
        SET status = 'resolved', response_text = ?, resolved_at = ?
        WHERE interrupt_id = ? AND run_id = ? AND status = 'pending'
      `).run(normalizedInput, now, interruptId, jobId);
      if (Number(interrupt.changes) !== 1) return 'stale';
      const next: ContinuationJob = {
        ...continuationJobForCommandState(
          current,
          'recovering',
          current.rowVersion + 1,
          now,
        ),
        recovery,
        nextRunAt: now,
      };
      const update = this.database.prepare(`
        UPDATE durable_runs
        SET status = 'recovering', state_version = 1, state_json = ?, next_run_at = ?,
            updated_at = ?, row_version = row_version + 1
        WHERE run_id = ? AND workload_kind = 'async_task'
          AND status = 'waiting_user' AND row_version = ?
      `).run(
        JSON.stringify(asyncTaskStateEnvelopeFromJob(next)),
        now,
        now,
        jobId,
        current.rowVersion,
      );
      if (Number(update.changes) !== 1) throw new Error(`Stale continuation resume for ${jobId}.`);
      this.database.prepare(`
        UPDATE durable_outbox
        SET status = 'superseded', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE run_id = ? AND event_key = ? AND status IN ('pending', 'failed')
      `).run(now, jobId, `interrupt:${interruptId}`);
      return 'resumed';
    });
  }

  async purgeExpired(retainAfter: string, now: string): Promise<ContinuationCleanupResult[]> {
    await this.reconcileStorageOrphans();
    const rows = this.database.prepare(`
      SELECT j.job_id, j.creator_open_id, j.status, j.completed_at
      FROM continuation_jobs j
      WHERE j.status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled')
        AND j.completed_at IS NOT NULL
        AND j.completed_at < ?
        AND j.deleted_at IS NULL
        AND j.retain = 0
        AND (
          j.error_code = 'continuation_persisted_state_invalid'
          OR EXISTS (
            SELECT 1 FROM continuation_outbox terminal
            WHERE terminal.job_id = j.job_id
              AND terminal.kind = 'terminal'
              AND (
                terminal.status = 'delivered'
                OR (
                  terminal.status = 'failed'
                  AND terminal.error_code = 'continuation_delivery_route_invalid'
                )
              )
          )
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
          () => this.inputs.withCreationLock(
            jobId,
            () => this.redactTerminalInternal(jobId, now, retainAfter),
          ),
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
    this.activeDurableClaims.clear();
    this.database.close();
  }

  private forgetActiveDurableClaim(
    claim: import('../domain/durable-run.js').DurableRunClaim,
  ): void {
    const key = durableClaimKey(claim.run.runId, claim.workerId);
    if (this.activeDurableClaims.get(key)?.attempt.attemptId === claim.attempt.attemptId) {
      this.activeDurableClaims.delete(key);
    }
  }

  private forgetActiveDurableClaimsForRun(runId: string): void {
    for (const [key, claim] of this.activeDurableClaims) {
      if (claim.run.runId === runId) this.activeDurableClaims.delete(key);
    }
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

  private async reconcileStorageOrphans(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT job_id, error_code
      FROM continuation_jobs
      WHERE deleted_at IS NULL
    `).all();
    const corruptJobIds = rows
      .filter((row) => optionalStringField(row, 'error_code') === 'continuation_persisted_state_invalid')
      .map((row) => stringField(row, 'job_id'));
    const knownJobs = new Set(rows.map((row) => stringField(row, 'job_id')));
    const isJobKnown = (jobId: string): boolean => Boolean(this.database.prepare(`
      SELECT 1 FROM continuation_jobs
      WHERE job_id = ? AND deleted_at IS NULL
        AND (error_code IS NULL OR error_code <> 'continuation_persisted_state_invalid')
    `).get(jobId));
    const nowMs = Date.now();
    for (const jobId of corruptJobIds) {
      await this.recoverCorruptJobStorage(jobId, new Date(nowMs).toISOString(), false);
    }
    const results = await Promise.allSettled([
      this.artifacts.cleanupOrphans(
        knownJobs,
        nowMs,
        isJobKnown,
        (jobId, operation) => this.inputs.withCreationLock(jobId, operation),
      ),
      this.inputs.cleanupOrphans(knownJobs, nowMs, isJobKnown),
    ]);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Continuation storage reconciliation failed.');
    }
  }

  private async cleanupCorruptStorageLocked(jobId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.inputs.remove(jobId),
      this.artifacts.remove(jobId),
    ]);
    const cleanupPending = results.some((result) => result.status === 'rejected');
    const errorSummary = cleanupPending
      ? 'Stored task state failed integrity validation. Associated storage cleanup is pending.'
      : 'Stored task state failed integrity validation.';
    this.database.prepare(`
      UPDATE durable_runs
      SET error_summary = ?, updated_at = ?, row_version = row_version + 1
      WHERE run_id = ? AND workload_kind = 'async_task'
        AND error_code = 'continuation_persisted_state_invalid'
        AND error_summary <> ?
    `).run(errorSummary, new Date().toISOString(), jobId, errorSummary);
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
    if (!claimProjectionMatches(claim)) throw staleClaimError(claim.job.jobId);
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

  private insertTerminalOutbox(job: ContinuationJob, payload: string, now: string): void {
    this.insertTerminalOutboxFromRoute(
      job.jobId,
      JSON.stringify(job.route),
      payload,
      now,
    );
  }

  private insertTerminalOutboxFromRoute(
    jobId: string,
    routeJson: string,
    payload: string,
    now: string,
  ): void {
    this.database.prepare(`
      UPDATE durable_outbox
      SET status = 'superseded', worker_id = NULL, lease_expires_at = NULL,
          error_code = NULL, error_summary = NULL, updated_at = ?
      WHERE run_id = ? AND kind IN ('progress', 'interrupt')
        AND (
          status IN ('pending', 'failed')
          OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `).run(now, jobId, now);
    this.database.prepare(`
      INSERT OR IGNORE INTO durable_outbox (
        outbox_id, run_id, event_key, kind, attempt_id,
        route_json, idempotency_key, payload_json, metadata_json, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'terminal', 'terminal', NULL, ?, ?, ?, '{}', 'pending', 0, ?, ?, ?)
    `).run(
      makeId('out'),
      jobId,
      routeJson,
      deliveryIdempotencyKey(jobId, 'terminal'),
      JSON.stringify(payload),
      now,
      now,
      now,
    );
  }

  private trustedInputJobForCorruptRun(jobId: string): ContinuationJob | null {
    const row = this.database.prepare(`
      SELECT input_version, input_json, idempotency_key, actor_open_id, route_json
      FROM durable_runs
      WHERE run_id = ? AND workload_kind = 'async_task'
    `).get(jobId);
    if (!row) return null;
    try {
      const route = parseTrustedJson(row.route_json, 'durable_runs.route_json');
      const job = parseTrustedAsyncTaskInputJob(
        parseTrustedJson(row.input_json, 'durable_runs.input_json'),
        numberField(row, 'input_version'),
      );
      if (
        job.jobId !== jobId
        || job.idempotencyKey !== stringField(row, 'idempotency_key')
        || job.creatorOpenId !== stringField(row, 'actor_open_id')
        || !isDeepStrictEqual(job.route, route)
      ) return null;
      return job;
    } catch {
      return null;
    }
  }

  private sanitizeCorruptJob(row: SqlRow, now: string, dueOnly: boolean): string | null {
    const jobId = stringField(row, 'job_id');
    const rowVersion = numberField(row, 'row_version');
    const trustedInput = this.trustedInputJobForCorruptRun(jobId);
    const trustedRoute = optionalStringField(row, 'deleted_at')
      ? null
      : trustedInput?.route ?? trustedRouteFromCorruptRow(row);
    const tombstoneRoute = trustedRoute ?? emptyRoute();
    const tombstoneSourceMessageId = trustedRoute
      ? trustedInput?.sourceMessageId ?? stringField(row, 'source_message_id')
      : '';
    const tombstoneSourceThreadId = trustedRoute
      ? trustedInput?.sourceThreadId ?? optionalStringField(row, 'source_thread_id')
      : undefined;
    const tombstoneFacts = corruptTombstoneFacts(
      row,
      tombstoneRoute,
      tombstoneSourceMessageId,
      tombstoneSourceThreadId,
    );
    const tombstoneContract = corruptTombstoneContract();
    const tombstoneJob: ContinuationJob = {
      jobId,
      idempotencyKey: stringField(row, 'idempotency_key'),
      ...(optionalStringField(row, 'retry_of_job_id')
        ? { retryOfJobId: optionalStringField(row, 'retry_of_job_id') }
        : {}),
      creatorOpenId: stringField(row, 'creator_open_id'),
      route: tombstoneRoute,
      sourceMessageId: tombstoneSourceMessageId,
      ...(tombstoneSourceThreadId ? { sourceThreadId: tombstoneSourceThreadId } : {}),
      title: tombstoneContract.title,
      objective: tombstoneContract.objective,
      acceptanceCriteria: [],
      contextSnapshot: EMPTY_CHECKPOINT,
      sourceFacts: tombstoneFacts,
      taskContract: tombstoneContract,
      requiredTools: [],
      workingDirectory: '',
      permissions: EMPTY_PERMISSION_ENVELOPE,
      maxAttempts: numberField(row, 'max_attempts'),
      maxRetries: 0,
      timeoutSeconds: 1,
      createdAt: stringField(row, 'created_at'),
      expiresAt: stringField(row, 'expires_at'),
      rowVersion: rowVersion + 1,
      status: 'failed',
      recoveryTotalCount: 0,
      recoveryFingerprintCounts: {},
      noProgressCount: 0,
      attemptCount: numberField(row, 'attempt_count'),
      stepCount: 0,
      failureCount: 0,
      nextRunAt: stringField(row, 'next_run_at'),
      resultArtifacts: [],
      errorCode: 'continuation_persisted_state_invalid',
      errorSummary: 'Stored task state failed integrity validation.',
      updatedAt: now,
      completedAt: optionalStringField(row, 'completed_at') ?? now,
      retained: false,
    };
    const dueClause = dueOnly
      ? `AND status IN ('queued', 'waiting_retry', 'recovering')
         AND deleted_at IS NULL AND next_run_at <= ? AND expires_at > ?`
      : '';
    const update = this.database.prepare(`
      UPDATE durable_runs
      SET status = 'failed', input_version = 1, input_json = ?,
          state_version = 1, state_json = ?, route_json = ?,
          error_code = 'continuation_persisted_state_invalid',
          error_summary = 'Stored task state failed integrity validation.', retained = 0,
          completed_at = COALESCE(completed_at, ?), updated_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1
      WHERE run_id = ? AND workload_kind = 'async_task' AND row_version = ?
        ${dueClause}
    `).run(
      JSON.stringify({ schemaVersion: 1, job: tombstoneJob }),
      JSON.stringify(asyncTaskStateEnvelopeFromJob(tombstoneJob)),
      JSON.stringify(tombstoneRoute),
      now,
      now,
      jobId,
      rowVersion,
      ...(dueOnly ? [now, now] : []),
    );
    if (Number(update.changes) !== 1) return null;
    this.database.prepare(`
      UPDATE durable_attempts
      SET finished_at = ?, heartbeat_at = ?, outcome = 'error',
          error_code = 'continuation_persisted_state_invalid',
          error_summary = 'Stored task state failed integrity validation.',
          recovery_pending = 0
      WHERE run_id = ? AND finished_at IS NULL
    `).run(now, now, jobId);
    const genericPayload = `Task failed: ${jobId}\nStored task state failed integrity validation.`;
    this.database.prepare(`
      UPDATE durable_outbox
      SET route_json = ?,
          payload_json = CASE WHEN kind = 'terminal' AND ? = 1 THEN ? ELSE json_quote('') END,
          worker_id = NULL, lease_expires_at = NULL,
          status = CASE
            WHEN status = 'sent' THEN 'sent'
            WHEN status IN ('sending', 'unknown') THEN 'unknown'
            WHEN kind = 'terminal' AND ? = 1 AND status = 'pending' THEN 'pending'
            WHEN kind = 'terminal' THEN 'failed'
            ELSE 'superseded'
          END,
          error_code = CASE
            WHEN status IN ('sent', 'unknown') THEN error_code
            WHEN status = 'sending' THEN 'continuation_delivery_outcome_unknown'
            WHEN kind = 'terminal' AND ? = 1 AND status = 'pending' THEN NULL
            ELSE 'continuation_persisted_state_invalid'
          END,
          error_summary = CASE
            WHEN status = 'sent' THEN error_summary
            WHEN status IN ('sending', 'unknown')
              THEN 'The delivery outcome is unknown after stored task state failed validation.'
            WHEN kind = 'terminal' AND ? = 1 AND status = 'pending' THEN NULL
            ELSE 'Stored task state failed integrity validation.'
          END,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify(tombstoneRoute),
      trustedRoute ? 1 : 0,
      JSON.stringify(genericPayload),
      trustedRoute ? 1 : 0,
      trustedRoute ? 1 : 0,
      trustedRoute ? 1 : 0,
      now,
      jobId,
    );
    if (trustedRoute) {
      this.insertTerminalOutboxFromRoute(
        jobId,
        JSON.stringify(trustedRoute),
        genericPayload,
        now,
      );
    }
    return jobId;
  }

  private readJobBy(predicate: string, value: string): ContinuationJob | null {
    const row = this.database.prepare(`${jobSelectSql()} WHERE ${predicate}`).get(value);
    return row ? mapJob(row) : null;
  }

  private async readRecoveringJobBy(
    predicate: string,
    value: string,
    storageLockHeld = false,
  ): Promise<ContinuationJob | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = this.database.prepare(`${jobSelectSql()} WHERE ${predicate}`).get(value);
      if (!row) return null;
      try {
        const job = mapJob(row);
        if (job.errorCode === 'continuation_persisted_state_invalid') {
          await this.recoverCorruptJobStorage(
            job.jobId,
            new Date().toISOString(),
            false,
            storageLockHeld,
          );
        } else {
          return job;
        }
      } catch (error) {
        lastError = error;
        await this.recoverCorruptJobStorage(
          stringField(row, 'job_id'),
          new Date().toISOString(),
          false,
          storageLockHeld,
        );
      }
      const refreshed = this.database.prepare(`${jobSelectSql()} WHERE ${predicate}`).get(value);
      if (!refreshed) return null;
      try {
        return mapJob(refreshed);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Continuation persisted state could not be recovered.');
  }

  private async recoverCorruptJobStorage(
    jobId: string,
    now: string,
    dueOnly: boolean,
    storageLockHeld = false,
  ): Promise<boolean> {
    return this.withJobStorageLock(jobId, storageLockHeld, async () => {
      const schemaVersion = Number(this.scalar('PRAGMA user_version'));
      const row = this.database.prepare(
        `${jobSelectSql(
          schemaVersion >= OUTCOME_DRIVEN_SCHEMA_VERSION,
          schemaVersion >= SCHEMA_VERSION,
        )} WHERE j.job_id = ?`,
      ).get(jobId);
      if (!row) return false;
      try {
        const current = mapJob(row);
        if (current.errorCode !== 'continuation_persisted_state_invalid') return false;
      } catch {
        const sanitizedJobId = this.transaction(() => this.sanitizeCorruptJob(
          row,
          now,
          dueOnly,
        ));
        if (!sanitizedJobId) return false;
      }
      await this.cleanupCorruptStorageLocked(jobId);
      return true;
    });
  }

  private async withJobStorageLock<T>(
    jobId: string,
    storageLockHeld: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (storageLockHeld) return operation();
    return this.serializeJobMutation(
      jobId,
      () => this.inputs.withCreationLock(jobId, operation),
    );
  }

  private async listJobs(
    predicate: string,
    value: string | undefined,
    limit: number,
    statuses: ContinuationStatus[],
  ): Promise<ContinuationJob[]> {
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
    const jobs: ContinuationJob[] = [];
    for (const row of rows) {
      const job = await this.readRecoveringJobBy('j.job_id = ?', stringField(row, 'job_id'));
      if (
        job
        && !job.deletedAt
        && (uniqueStatuses.length === 0 || uniqueStatuses.includes(job.status))
      ) jobs.push(job);
    }
    return jobs;
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
    const route = parseTrustedJson(row.route_json, 'continuation_outbox.route_json');
    if (!isDeliveryRoute(route)) throw new Error('Continuation outbox delivery route is invalid.');
    return {
      outboxId: stringField(row, 'outbox_id'),
      jobId: stringField(row, 'job_id'),
      eventKey: stringField(row, 'event_key'),
      kind: stringField(row, 'kind') as ContinuationDeliveryClaim['kind'],
      attemptId: optionalStringField(row, 'attempt_id'),
      ...(stringField(row, 'kind') === 'interrupt'
        ? { interruptId: stringField(row, 'event_key').slice('interrupt:'.length) }
        : {}),
      workerId: stringField(row, 'worker_id'),
      route,
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

function jobSelectSql(includeOutcomeState = true, includeInterruptState = includeOutcomeState): string {
  const outcomeState = includeOutcomeState
    ? `(SELECT a.delta_json FROM continuation_attempts a
            WHERE a.job_id = j.job_id AND a.finished_at IS NOT NULL AND a.delta_json IS NOT NULL
            ORDER BY a.ordinal DESC LIMIT 1) AS last_delta_json,
           (SELECT a.verification_json FROM continuation_attempts a
            WHERE a.job_id = j.job_id AND a.finished_at IS NOT NULL AND a.verification_json IS NOT NULL
            ORDER BY a.ordinal DESC LIMIT 1) AS last_verification_json`
    : `0 AS no_progress_count, NULL AS last_delta_json, NULL AS last_verification_json`;
  const interruptState = includeInterruptState
    ? `(SELECT i.interrupt_id FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_id,
           (SELECT i.attempt_id FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_attempt_id,
           (SELECT i.status FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_status,
           (SELECT i.prompt FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_prompt,
           (SELECT i.response_text FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_response,
           (SELECT i.created_at FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_created_at,
           (SELECT i.resolved_at FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_resolved_at,
           (SELECT o.message_id FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'interrupt'
            ORDER BY o.created_at DESC LIMIT 1) AS current_interrupt_message_id,
           (SELECT o.updated_at FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'interrupt' AND o.status = 'delivered'
            ORDER BY o.created_at DESC LIMIT 1) AS current_interrupt_delivered_at`
    : `NULL AS current_interrupt_id, NULL AS current_interrupt_attempt_id,
       NULL AS current_interrupt_status, NULL AS current_interrupt_prompt,
       NULL AS current_interrupt_response, NULL AS current_interrupt_created_at,
       NULL AS current_interrupt_resolved_at, NULL AS current_interrupt_message_id,
       NULL AS current_interrupt_delivered_at`;
  return `
    SELECT j.*,
           (SELECT o.status FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'terminal'
            LIMIT 1) AS delivery_status,
           (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = j.job_id) AS attempt_count,
           ${interruptState},
           ${outcomeState}
    FROM continuation_jobs j
  `;
}

function mapPendingInterruptRoute(row: SqlRow): ContinuationPendingInterruptRoute {
  const route = parseTrustedJson(row.route_json, 'continuation interrupt route');
  if (!isDeliveryRoute(route)) throw new Error('Continuation interrupt route is invalid.');
  return {
    interruptId: stringField(row, 'interrupt_id'),
    jobId: stringField(row, 'job_id'),
    route,
    deliveredMessageId: optionalStringField(row, 'message_id'),
  };
}

function mapJob(row: SqlRow): ContinuationJob {
  const routeValue = parseTrustedJson(row.route_json, 'route_json');
  if (!isDeliveryRoute(routeValue)) throw new Error('Continuation delivery route is invalid.');
  const sourceFactsValue = parseTrustedJson(row.source_facts_json, 'source_facts_json');
  validateSourceFacts(sourceFactsValue);
  const taskContractValue = parseTrustedJson(row.task_contract_json, 'task_contract_json');
  validateTaskContract(taskContractValue, sourceFactsValue.provenance === 'captured');
  const creatorOpenId = stringField(row, 'creator_open_id');
  const sourceMessageId = stringField(row, 'source_message_id');
  const sourceThreadId = optionalStringField(row, 'source_thread_id');
  const title = stringField(row, 'title');
  const objective = stringField(row, 'objective');
  const acceptanceCriteria = parseTrustedStringArray(
    row.acceptance_criteria_json,
    'acceptance_criteria_json',
  );
  const contextSnapshot = parseTrustedCheckpoint(
    row.context_snapshot_json,
    'context_snapshot_json',
  );
  const workingDirectory = stringField(row, 'working_directory');
  const permissions = parsePermissionEnvelope(row.permissions_json);
  const requiredTools = parseTrustedStringArray(row.required_tools_json, 'required_tools_json');
  if (!sameStringSet(requiredTools, permissions.hostTools)) {
    throw new Error('Continuation persisted host tools are inconsistent.');
  }
  const model = optionalStringField(row, 'model');
  const recovery = row.recovery_json
    ? parseTrustedRecoveryState(row.recovery_json, 'recovery_json')
    : undefined;
  const recoveryFingerprintCounts = row.recovery_fingerprint_counts_json === undefined
    ? {}
    : parseTrustedCountRecord(
        row.recovery_fingerprint_counts_json,
        'recovery_fingerprint_counts_json',
      );
  const interruptId = optionalStringField(row, 'current_interrupt_id');
  validatePersistedFactProjection(row, {
    route: routeValue,
    sourceFacts: sourceFactsValue,
    taskContract: taskContractValue,
    creatorOpenId,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    workingDirectory,
    permissions,
    model,
  });
  return {
    jobId: stringField(row, 'job_id'),
    idempotencyKey: stringField(row, 'idempotency_key'),
    retryOfJobId: optionalStringField(row, 'retry_of_job_id'),
    creatorOpenId,
    route: routeValue,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    sourceFacts: sourceFactsValue,
    taskContract: taskContractValue,
    requiredTools,
    workingDirectory,
    permissions,
    model,
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
      ? parseTrustedCheckpointV2(row.checkpoint_json, 'checkpoint_json')
      : undefined,
    lastAttemptDelta: row.last_delta_json
      ? parseTrustedAttemptDelta(row.last_delta_json, 'last_delta_json')
      : undefined,
    lastVerification: row.last_verification_json
      ? parseTrustedVerification(row.last_verification_json, 'last_verification_json')
      : undefined,
    recovery,
    recoveryTotalCount: row.recovery_total_count === undefined
      ? 0
      : numberField(row, 'recovery_total_count'),
    recoveryFingerprintCounts,
    currentInterrupt: interruptId ? {
      interruptId,
      jobId: stringField(row, 'job_id'),
      attemptId: stringField(row, 'current_interrupt_attempt_id'),
      status: optionalStringField(row, 'current_interrupt_status') === 'resolved'
        ? 'resolved'
        : optionalStringField(row, 'current_interrupt_message_id')
          ? 'delivered'
          : 'pending',
      prompt: stringField(row, 'current_interrupt_prompt'),
      deliveredMessageId: optionalStringField(row, 'current_interrupt_message_id'),
      responseText: optionalStringField(row, 'current_interrupt_response'),
      createdAt: stringField(row, 'current_interrupt_created_at'),
      deliveredAt: optionalStringField(row, 'current_interrupt_delivered_at'),
      resolvedAt: optionalStringField(row, 'current_interrupt_resolved_at'),
    } : undefined,
    noProgressCount: numberField(row, 'no_progress_count'),
    attemptCount: numberField(row, 'attempt_count'),
    stepCount: numberField(row, 'step_count'),
    failureCount: numberField(row, 'failure_count'),
    nextRunAt: stringField(row, 'next_run_at'),
    leaseOwner: optionalStringField(row, 'lease_owner'),
    leaseExpiresAt: optionalStringField(row, 'lease_expires_at'),
    heartbeatAt: optionalStringField(row, 'heartbeat_at'),
    resultSummary: optionalStringField(row, 'result_summary'),
    resultArtifacts: parseTrustedResultArtifacts(
      row.result_artifacts_json,
      'result_artifacts_json',
    ),
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

function validatePersistedFactProjection(
  row: SqlRow,
  value: {
    route: ContinuationDeliveryRoute;
    sourceFacts: AsyncTaskFactSnapshot;
    taskContract: AsyncTaskContract;
    creatorOpenId: string;
    sourceMessageId: string;
    sourceThreadId: string | undefined;
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    contextSnapshot: ContinuationCheckpoint;
    workingDirectory: string;
    permissions: ContinuationPermissionEnvelope;
    model: string | undefined;
  },
): void {
  const {
    route,
    sourceFacts,
    taskContract,
    creatorOpenId,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    workingDirectory,
    permissions,
    model,
  } = value;
  const expectedChatId = route.kind === 'message_thread'
    ? route.conversationId
    : `doc:${route.documentToken}`;
  if (
    stringField(row, 'origin_kind') !== route.kind
    || !isDeepStrictEqual(route, sourceFacts.route)
    || sourceFacts.sourceMessageId !== sourceMessageId
    || sourceFacts.sourceThreadId !== sourceThreadId
    || sourceFacts.chatId !== expectedChatId
    || sourceFacts.workingDirectory !== workingDirectory
    || sourceFacts.model !== (model ?? null)
    || !isDeepStrictEqual(sourceFacts.permissions, permissions)
    || taskContract.title !== title
    || taskContract.objective !== objective
    || !isDeepStrictEqual(
      taskContract.acceptanceCriteria.map((criterion) => criterion.description),
      acceptanceCriteria,
    )
    || !isDeepStrictEqual(taskContract.initialContext, contextSnapshot)
    || (route.kind === 'message_thread' && route.sourceMessageId !== sourceMessageId)
    || !routeMatchesSourceThread(route, sourceThreadId)
    || (sourceFacts.provenance === 'captured' && sourceFacts.creatorOpenId !== creatorOpenId)
  ) {
    throw new Error('Continuation persisted facts and execution projection are inconsistent.');
  }
}

function projectCreateRequest(
  request: ContinuationCreateRequest,
  inputs: AsyncTaskFactSnapshot['inputs'],
): ContinuationCreateRequest {
  const taskContract: AsyncTaskContract = {
    schemaVersion: 1,
    title: redactContinuationText(request.taskContract.title),
    objective: redactContinuationText(request.taskContract.objective),
    deliverables: request.taskContract.deliverables.map((deliverable) => ({
      id: deliverable.id,
      description: redactContinuationText(deliverable.description),
      required: deliverable.required,
    })),
    acceptanceCriteria: request.taskContract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: redactContinuationText(criterion.description),
      deliverableIds: [...criterion.deliverableIds],
    })),
    verificationRequirements: request.taskContract.verificationRequirements.map((requirement) => ({
      id: requirement.id,
      description: redactContinuationText(requirement.description),
      kind: requirement.kind,
    })),
    initialContext: redactCheckpoint(request.taskContract.initialContext),
  };
  const sourceFacts: AsyncTaskFactSnapshot = {
    schemaVersion: 1,
    provenance: request.sourceFacts.provenance,
    originalUserText: request.sourceFacts.originalUserText === null
      ? null
      : redactContinuationText(request.sourceFacts.originalUserText),
    sourceContextText: request.sourceFacts.sourceContextText === null
      ? null
      : redactContinuationText(request.sourceFacts.sourceContextText),
    quotedMessageText: request.sourceFacts.quotedMessageText === null
      ? null
      : redactContinuationText(request.sourceFacts.quotedMessageText),
    route: request.route,
    creatorOpenId: request.creatorOpenId,
    chatId: request.sourceFacts.chatId,
    chatType: request.sourceFacts.chatType,
    sourceMessageId: request.sourceMessageId,
    ...(request.sourceThreadId ? { sourceThreadId: request.sourceThreadId } : {}),
    sourceMessageType: request.sourceFacts.sourceMessageType,
    sourceTimestamp: request.sourceFacts.sourceTimestamp,
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

function continuationJobForCreate(
  jobId: string,
  request: ContinuationCreateRequest,
): ContinuationJob {
  const {
    sourceInputs: _sourceInputs,
    resumeCheckpoint,
    resumeArtifactSourceJobId: _resumeArtifactSourceJobId,
    ...persisted
  } = request;
  return {
    ...persisted,
    jobId,
    rowVersion: 1,
    status: 'queued',
    ...(resumeCheckpoint ? { checkpoint: resumeCheckpoint } : {}),
    recoveryTotalCount: 0,
    recoveryFingerprintCounts: {},
    noProgressCount: 0,
    attemptCount: 0,
    stepCount: 0,
    failureCount: 0,
    nextRunAt: request.createdAt,
    resultArtifacts: [],
    updatedAt: request.createdAt,
    retained: false,
  };
}

function createRequestFingerprint(request: ContinuationCreateRequest): string {
  const sourceInputDescriptors = request.sourceInputs.map((input) => ({
    kind: input.kind,
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
    resumeCheckpoint: request.resumeCheckpoint ?? null,
    resumeArtifactSourceJobId: request.resumeArtifactSourceJobId ?? null,
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

function legacyFactsAndContract(row: SqlRow): ReturnType<typeof parseLegacyFactsAndContract> {
  try {
    return parseLegacyFactsAndContract(row);
  } catch (error) {
    if (error instanceof LegacyPersistedRowError) throw error;
    throw new LegacyPersistedRowError('Legacy continuation row is malformed.', { cause: error });
  }
}

function parseLegacyFactsAndContract(row: SqlRow): {
  route: ContinuationDeliveryRoute;
  sourceFacts: AsyncTaskFactSnapshot;
  taskContract: AsyncTaskContract;
} {
  const rawRoute = parseTrustedJson(row.route_json, 'route_json');
  if (!isDeliveryRoute(rawRoute)) throw new Error('Continuation delivery route is invalid.');
  const persistedSourceThreadId = optionalStringField(row, 'source_thread_id');
  if (
    rawRoute.kind === 'message_thread'
    && rawRoute.threadId !== undefined
    && persistedSourceThreadId !== undefined
    && rawRoute.threadId !== persistedSourceThreadId
  ) {
    throw new LegacyRouteProjectionError('Legacy message route conflicts with source_thread_id.');
  }
  if (
    rawRoute.kind === 'comment_thread'
    && persistedSourceThreadId !== undefined
    && rawRoute.commentId !== persistedSourceThreadId
  ) {
    throw new LegacyRouteProjectionError('Legacy comment route conflicts with source_thread_id.');
  }
  const sourceThreadId = rawRoute.kind === 'comment_thread'
    ? rawRoute.commentId
    : persistedSourceThreadId ?? rawRoute.threadId;
  const route: ContinuationDeliveryRoute = rawRoute.kind === 'message_thread'
    ? {
        ...rawRoute,
        ...(sourceThreadId ? { threadId: sourceThreadId } : {}),
      }
    : rawRoute;
  const permissions = parsePermissionEnvelope(row.permissions_json);
  const criteria = parseTrustedStringArray(row.acceptance_criteria_json, 'acceptance_criteria_json');
  const initialContext = parseTrustedCheckpoint(row.context_snapshot_json, 'context_snapshot_json');
  return {
    route,
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'legacy_unavailable',
      originalUserText: null,
      sourceContextText: null,
      quotedMessageText: null,
      creatorOpenId: stringField(row, 'creator_open_id'),
      chatId: route.kind === 'message_thread'
        ? route.conversationId
        : `doc:${route.documentToken}`,
      chatType: route.kind === 'comment_thread' ? 'doc_comment' : '',
      route,
      sourceMessageId: stringField(row, 'source_message_id'),
      ...(sourceThreadId ? { sourceThreadId } : {}),
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
    sourceContextText: null,
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

function trustedRouteFromCorruptRow(row: SqlRow): ContinuationDeliveryRoute | null {
  try {
    const route = parseTrustedJson(row.route_json, 'route_json');
    const rawFacts = parseTrustedJson(row.source_facts_json, 'source_facts_json');
    if (!isDeliveryRoute(route) || !isRecord(rawFacts) || !isDeliveryRoute(rawFacts.route)) {
      return null;
    }
    const sourceMessageId = stringField(row, 'source_message_id');
    const sourceThreadId = optionalStringField(row, 'source_thread_id');
    const expectedChatId = route.kind === 'message_thread'
      ? route.conversationId
      : `doc:${route.documentToken}`;
    if (
      stringField(row, 'origin_kind') !== route.kind
      || !isDeepStrictEqual(route, rawFacts.route)
      || rawFacts.sourceMessageId !== sourceMessageId
      || rawFacts.sourceThreadId !== sourceThreadId
      || rawFacts.chatId !== expectedChatId
      || (route.kind === 'message_thread' && route.sourceMessageId !== sourceMessageId)
      || !routeMatchesSourceThread(route, sourceThreadId)
    ) return null;
    return route;
  } catch {
    return null;
  }
}

function trustedOutboxRoute(row: SqlRow): boolean {
  try {
    const outboxRoute = parseTrustedJson(row.route_json, 'continuation_outbox.route_json');
    const jobRoute = parseTrustedJson(row.job_route_json, 'continuation_jobs.route_json');
    const rawFacts = parseTrustedJson(
      row.job_source_facts_json,
      'continuation_jobs.source_facts_json',
    );
    if (
      !isDeliveryRoute(outboxRoute)
      || !isDeliveryRoute(jobRoute)
      || !isRecord(rawFacts)
      || !isDeliveryRoute(rawFacts.route)
    ) return false;
    const sourceMessageId = stringField(row, 'job_source_message_id');
    const sourceThreadId = optionalStringField(row, 'job_source_thread_id');
    const expectedChatId = jobRoute.kind === 'message_thread'
      ? jobRoute.conversationId
      : `doc:${jobRoute.documentToken}`;
    return stringField(row, 'job_origin_kind') === jobRoute.kind
      && isDeepStrictEqual(outboxRoute, jobRoute)
      && isDeepStrictEqual(jobRoute, rawFacts.route)
      && rawFacts.sourceMessageId === sourceMessageId
      && rawFacts.sourceThreadId === sourceThreadId
      && rawFacts.chatId === expectedChatId
      && (jobRoute.kind !== 'message_thread' || jobRoute.sourceMessageId === sourceMessageId)
      && routeMatchesSourceThread(jobRoute, sourceThreadId);
  } catch {
    return false;
  }
}

function corruptTombstoneFacts(
  row: SqlRow,
  route: ContinuationDeliveryRoute,
  sourceMessageId: string,
  sourceThreadId: string | undefined,
): AsyncTaskFactSnapshot {
  return {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: stringField(row, 'creator_open_id'),
    chatId: route.kind === 'message_thread'
      ? route.conversationId
      : `doc:${route.documentToken}`,
    chatType: route.kind === 'comment_thread' ? 'doc_comment' : '',
    route,
    sourceMessageId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: '',
    model: null,
    permissions: EMPTY_PERMISSION_ENVELOPE,
  };
}

function corruptTombstoneContract(): AsyncTaskContract {
  return {
    schemaVersion: 1,
    title: 'Unavailable task state',
    objective: 'Stored task state failed integrity validation.',
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
  assertUtf8Bytes('objective', request.objective, CONTINUATION_LIMITS.objectiveBytes);
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
  if (!isDeliveryRoute(request.route)) throw new Error('Continuation delivery route is invalid.');
  if (!routeMatchesSourceThread(request.route, request.sourceThreadId)) {
    throw new Error('Continuation delivery route does not match the source thread.');
  }
  assertJsonBytes('delivery route', request.route, CONTINUATION_LIMITS.contextSnapshotBytes);
  validateSourceFacts(request.sourceFacts);
  validateTaskContract(request.taskContract, request.sourceFacts.provenance === 'captured');
  assertJsonBytes('source inputs', request.sourceInputs.map((input) => ({
    kind: input.kind,
    fileName: input.fileName,
  })), CONTINUATION_LIMITS.contextSnapshotBytes);
  if (request.resumeCheckpoint && !isCheckpointV2(request.resumeCheckpoint)) {
    throw new Error('Continuation resume checkpoint is invalid.');
  }
  if (request.resumeCheckpoint?.artifacts.length && !request.resumeArtifactSourceJobId) {
    throw new Error('Continuation resume artifacts require a source Job ID.');
  }
  if (request.resumeArtifactSourceJobId && !request.resumeCheckpoint?.artifacts.length) {
    throw new Error('Continuation resume artifact source is not needed without checkpoint artifacts.');
  }
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

function validateTaskContract(
  value: unknown,
  requireRequirements = false,
): asserts value is AsyncTaskContract {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'title',
    'objective',
    'deliverables',
    'acceptanceCriteria',
    'verificationRequirements',
    'initialContext',
  ])) throw new Error('Continuation task contract is invalid.');
  const contract = value as Partial<AsyncTaskContract>;
  if (
    typeof contract.title !== 'string'
    || typeof contract.objective !== 'string'
    || !Array.isArray(contract.deliverables)
    || !Array.isArray(contract.acceptanceCriteria)
    || !Array.isArray(contract.verificationRequirements)
    || !isCheckpoint(contract.initialContext)
    || !contract.deliverables.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'required'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && typeof entry.required === 'boolean')
    || !contract.acceptanceCriteria.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'deliverableIds'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && Array.isArray(entry.deliverableIds)
      && entry.deliverableIds.every((id) => typeof id === 'string'))
    || !contract.verificationRequirements.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'kind'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && (entry.kind === 'artifact_exists'
        || entry.kind === 'artifact_sha256'
        || entry.kind === 'evidence_reference'))
  ) {
    throw new Error('Continuation task contract is invalid.');
  }
  if (contract.schemaVersion !== 1) throw new Error('Continuation task contract schema version is invalid.');
  if (
    requireRequirements
    && (
      contract.title.trim().length === 0
      || contract.objective.trim().length === 0
      || contract.deliverables.length === 0
      || !contract.deliverables.some((deliverable) => deliverable.required)
      || contract.deliverables.some((deliverable) => deliverable.description.trim().length === 0)
      || contract.acceptanceCriteria.length === 0
      || contract.acceptanceCriteria.some((criterion) =>
        criterion.description.trim().length === 0 || criterion.deliverableIds.length === 0)
      || contract.verificationRequirements.length === 0
      || contract.verificationRequirements.some((requirement) =>
        requirement.description.trim().length === 0)
    )
  ) {
    throw new Error('Captured continuation task contract requirements must not be empty.');
  }
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
      if (redactContinuationText(entry.id) !== entry.id) {
        throw new Error(`Continuation ${label} id must not contain a credential-shaped value.`);
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

function validateSourceFacts(value: unknown): asserts value is AsyncTaskFactSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'provenance',
    'originalUserText',
    'sourceContextText',
    'quotedMessageText',
    'creatorOpenId',
    'chatId',
    'chatType',
    'route',
    'sourceMessageId',
    'sourceThreadId',
    'sourceMessageType',
    'sourceTimestamp',
    'inputs',
    'workingDirectory',
    'model',
    'permissions',
  ])) throw new Error('Continuation source facts are invalid.');
  const facts = value as Partial<AsyncTaskFactSnapshot>;
  if (
    facts.schemaVersion !== 1
    || (facts.provenance !== 'captured' && facts.provenance !== 'legacy_unavailable')
    || !isNullableString(facts.originalUserText)
    || !isNullableString(facts.sourceContextText)
    || !isNullableString(facts.quotedMessageText)
    || typeof facts.creatorOpenId !== 'string'
    || typeof facts.chatId !== 'string'
    || typeof facts.chatType !== 'string'
    || !isDeliveryRoute(facts.route)
    || typeof facts.sourceMessageId !== 'string'
    || (facts.sourceThreadId !== undefined && typeof facts.sourceThreadId !== 'string')
    || !isNullableString(facts.sourceMessageType)
    || !isNullableString(facts.sourceTimestamp)
    || !Array.isArray(facts.inputs)
    || !facts.inputs.every(isManagedInputArtifact)
    || typeof facts.workingDirectory !== 'string'
    || !isNullableString(facts.model)
  ) {
    throw new Error('Continuation source facts are invalid.');
  }
  validateManagedInputArtifacts(facts.inputs);
  validatePermissionEnvelope(facts.permissions, false);
  assertJsonBytes('source facts', facts, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validateManagedInputArtifacts(
  inputs: AsyncTaskFactSnapshot['inputs'],
): void {
  if (inputs.length > CONTINUATION_LIMITS.inputFileCount) {
    throw new Error('Continuation persisted input file count is invalid.');
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const input of inputs) {
    if (ids.has(input.id) || paths.has(input.relativePath)) {
      throw new Error('Continuation persisted input identities must be unique.');
    }
    ids.add(input.id);
    paths.add(input.relativePath);
    if (input.sizeBytes > CONTINUATION_LIMITS.inputBytesPerFile) {
      throw new Error('Continuation persisted input file size is invalid.');
    }
    totalBytes += input.sizeBytes;
    if (totalBytes > CONTINUATION_LIMITS.managedInputBytesPerJob) {
      throw new Error('Continuation persisted input total size is invalid.');
    }
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
  reason = 'The continuation completed with a partial result.',
): string {
  return [
    `Task partially completed: ${jobId}`,
    `Reason: ${reason}`,
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
  recovery?: ContinuationRecoveryState,
): string {
  return [
    `Task blocked: ${jobId}`,
    `Reason: ${outcome.errorSummary}`,
    `Required capability: ${outcome.requiredCapability}`,
    recovery ? `Failed step: ${recovery.failure.failedStep}` : '',
    recovery ? `Failure category: ${recovery.failure.category}` : '',
    recovery
      ? `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`
      : '',
    recovery ? `Diagnostic: ${recovery.failure.diagnostic}` : '',
    renderResultSection('Completed work', outcome.completedWork),
    renderResultSection('Remaining work', outcome.unperformedWork),
  ].filter(Boolean).join('\n');
}

function renderFailedPayload(
  jobId: string,
  errorSummary: string,
  recovery?: ContinuationRecoveryState,
): string {
  return [
    `Task failed: ${jobId}`,
    `Reason: ${errorSummary}`,
    recovery ? `Failed step: ${recovery.failure.failedStep}` : '',
    recovery ? `Failure category: ${recovery.failure.category}` : '',
    recovery
      ? `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`
      : '',
    recovery ? `Diagnostic: ${recovery.failure.diagnostic}` : '',
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
    renderResultSection('Completed work', boundedProgressValues(outcome.checkpoint.completedStepIds)),
    renderResultSection('Key findings', boundedProgressValues(
      outcome.checkpoint.summary ? [outcome.checkpoint.summary] : [],
    )),
    renderResultSection(
      'Remaining work',
      boundedProgressValues(outcome.checkpoint.remainingSteps.map((step) => step.description)),
    ),
    outcome.checkpoint.nextAction
      ? `Next attempt: ${truncateCharacters(outcome.checkpoint.nextAction.description.trim(), 500)}`
      : '',
  ].filter(Boolean).join('\n');
  return truncateCharacters(payload, PROGRESS_PAYLOAD_MAX_CHARS);
}

function attemptBudgetTerminalReason(
  job: ContinuationJob,
  checkpoint: ContinuationCheckpointV2,
): { errorCode: string; errorSummary: string } {
  const artifactStatus = continuationArtifactStatus({ ...job, checkpoint });
  if (artifactStatus === 'not_started' || artifactStatus === 'creating') {
    return {
      errorCode: 'attempts_exhausted_artifact_not_started',
      errorSummary: 'The execution budget was exhausted before a required user-facing artifact was ready.',
    };
  }
  if (artifactStatus === 'created') {
    return {
      errorCode: 'attempts_exhausted_artifact_unverified',
      errorSummary: 'The execution budget was exhausted after artifact creation but before all required verification completed.',
    };
  }
  return {
    errorCode: 'attempts_exhausted_acceptance_incomplete',
    errorSummary: 'The execution budget was exhausted with one or more acceptance criteria still incomplete.',
  };
}

function renderInterruptPayload(
  job: ContinuationJob,
  claim: ContinuationClaim,
  interruptId: string,
  prompt: string,
  failure: DurableRunFailure,
  recovery: ContinuationRecoveryState,
  checkpoint: ContinuationCheckpointV2,
): string {
  return [
    `Task waiting for input: ${job.jobId} (${interruptId})`,
    `Attempt: ${claim.attempt.ordinal} / ${job.maxAttempts}`,
    `Failed step: ${failure.failedStep}`,
    `Failure category: ${failure.category}`,
    `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`,
    `Diagnostic: ${failure.diagnostic}`,
    `Action needed: ${prompt}`,
    renderResultSection('Completed work', boundedProgressValues(checkpoint.completedStepIds)),
    `Resume: /task resume ${job.jobId} <input>`,
  ].filter(Boolean).join('\n');
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
  if (result.failure !== undefined && !isDurableRunFailure(result.failure)) {
    throw new Error('Continuation local CLI tool failure is invalid.');
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
  if (
    (parsed as { failure?: unknown }).failure !== undefined
    && !isDurableRunFailure((parsed as { failure?: unknown }).failure)
  ) throw new Error('Invalid continuation tool failure in database.');
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
  if (!hasExactKeys(value as Record<string, unknown>, [
    'profile',
    'filesystem',
    'hostTools',
    'network',
    'externalSideEffects',
    'approval',
  ])) throw new Error('Continuation permission envelope is invalid.');
  const envelope = value as Partial<ContinuationPermissionEnvelope>;
  const filesystem = envelope.filesystem;
  const approval = envelope.approval;
  const requestedPaths = filesystem?.requestedPaths;
  if (
    (envelope.profile !== 'bounded' && envelope.profile !== 'trusted_personal_workspace')
    || !filesystem
    || !hasExactKeys(filesystem as unknown as Record<string, unknown>, [
      'root', 'mode', 'requestedPaths',
    ])
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
    || !hasExactKeys(approval as unknown as Record<string, unknown>, ['mode'])
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

interface RedactionQuarantines {
  artifact: string | null;
  input: string | null;
}

async function restoreRedactionQuarantines(
  jobId: string,
  quarantines: RedactionQuarantines,
  artifacts: ContinuationArtifactStore,
  inputs: ContinuationInputStorePort,
): Promise<unknown[]> {
  const operations: Promise<void>[] = [];
  if (quarantines.artifact) {
    operations.push(artifacts.restoreQuarantine(jobId, quarantines.artifact));
  }
  if (quarantines.input) {
    operations.push(inputs.restoreQuarantine(jobId, quarantines.input));
  }
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

async function discardRedactionQuarantines(
  jobId: string,
  quarantines: RedactionQuarantines,
  artifacts: ContinuationArtifactStore,
  inputs: ContinuationInputStorePort,
): Promise<unknown[]> {
  const operations: Promise<void>[] = [];
  if (quarantines.artifact) {
    operations.push(artifacts.discardQuarantine(jobId, quarantines.artifact));
  }
  if (quarantines.input) {
    operations.push(inputs.discardQuarantine(jobId, quarantines.input));
  }
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function boundedFailure(failure: ContinuationFailure): ContinuationFailure {
  return {
    errorCode: failure.errorCode.slice(0, 128) || 'continuation_failed',
    errorSummary: truncateUtf8(failure.errorSummary, CONTINUATION_LIMITS.objectiveBytes),
    retryable: failure.retryable,
  };
}

function boundedDurableRunFailure(failure: DurableRunFailure): DurableRunFailure {
  const bounded: DurableRunFailure = {
    category: failure.category,
    retrySafety: failure.retrySafety,
    capabilityAvailable: failure.capabilityAvailable,
    operationRisk: failure.operationRisk,
    hints: failure.hints.slice(0, 8).map((hint) => truncateCharacters(
      redactContinuationText(hint),
      500,
    )),
    failedStep: truncateCharacters(failure.failedStep, 80),
    diagnostic: truncateCharacters(redactContinuationText(failure.diagnostic), 1_000),
    fingerprint: failure.fingerprint.slice(0, 128),
  };
  if (!bounded.fingerprint || !bounded.failedStep) {
    throw new Error('Continuation durable failure identity is invalid.');
  }
  assertJsonBytes('durable failure', bounded, CONTINUATION_LIMITS.contextSnapshotBytes);
  return bounded;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  const suffix = '...';
  const buffer = Buffer.from(value, 'utf-8').subarray(0, maxBytes - suffix.length);
  return `${buffer.toString('utf-8').replace(/\uFFFD+$/u, '')}${suffix}`;
}

function assertJsonBytes(name: string, value: unknown, limit: number): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error(`Continuation ${name} is not serializable.`);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > limit) throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
}

function assertUtf8Bytes(name: string, value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf-8') > limit) {
    throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
  }
}

function makeId(prefix: 'job' | 'att' | 'out' | 'int'): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function deliveryIdempotencyKey(jobId: string, eventKey: string): string {
  return `ct_${createHash('sha256')
    .update(`${jobId}\0${eventKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function toolCallId(jobId: string, stepId: string, requestHash: string): string {
  return `call_${createHash('sha256')
    .update(`${jobId}\0${stepId}\0${requestHash}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function continuationStepId(job: ContinuationJob): string {
  return job.checkpoint?.nextAction?.id
    ?? job.checkpoint?.currentStepId
    ?? 'initial-step';
}

function canReexecuteSameToolRequest(
  job: ContinuationJob,
  failure: DurableRunFailure,
): boolean {
  const userResolvedAccess = Boolean(
    job.recovery?.userInput
    && ['authentication_required', 'permission_required'].includes(failure.category),
  );
  const boundedAutomaticRetry = Boolean(
    job.recovery?.lastDecision === 'retry'
    && job.recovery.failure.fingerprint === failure.fingerprint
    && failure.retrySafety === 'safe'
    && ['transient', 'unknown'].includes(failure.category),
  );
  return userResolvedAccess || boundedAutomaticRetry;
}

function canReplaceCompletedToolFailure(
  job: ContinuationJob,
  failure: DurableRunFailure,
): boolean {
  return (failure.category === 'invalid_invocation' && failure.retrySafety === 'safe')
    || canReexecuteSameToolRequest(job, failure);
}

function hasOpaqueExecutionEffects(job: ContinuationJob): boolean {
  return job.permissions.filesystem.mode === 'workspace-write'
    || job.permissions.network === 'enabled'
    || job.permissions.externalSideEffects === 'allowed';
}

function toolRequestHash(request: ContinuationToolRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function retrySqliteBusy(operation: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      operation();
      return;
    } catch (error) {
      const sqliteError = error as Error & { errcode?: number };
      if (
        Date.now() >= deadline
        || (sqliteError.errcode !== 5 && !/database is (?:locked|busy)/i.test(sqliteError.message))
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
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

function parseTrustedJson(value: SqlRow[string] | undefined, field: string): unknown {
  if (typeof value !== 'string') {
    throw new Error(`Invalid continuation database field: ${field}.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid trusted continuation JSON field: ${field}.`, { cause: error });
  }
}

function parseTrustedStringArray(
  value: SqlRow[string] | undefined,
  field: string,
): string[] {
  const parsed = parseTrustedJson(value, field);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid continuation string-array field: ${field}.`);
  }
  return parsed;
}

function parseTrustedCheckpoint(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationCheckpoint {
  const parsed = parseTrustedJson(value, field);
  if (!isCheckpoint(parsed)) throw new Error(`Invalid continuation checkpoint field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.checkpointBytes);
  return parsed;
}

function parseTrustedCheckpointV2(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationCheckpointV2 {
  const parsed = parseTrustedJson(value, field);
  const checkpoint = isCheckpoint(parsed) ? legacyCheckpointToV2(parsed) : parsed;
  if (!isCheckpointV2(checkpoint)) {
    throw new Error(`Invalid continuation V2 checkpoint field: ${field}.`);
  }
  assertJsonBytes(field, checkpoint, CONTINUATION_LIMITS.checkpointBytes);
  return checkpoint;
}

function parseTrustedAttemptDelta(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationAttemptDelta {
  const parsed = parseTrustedJson(value, field);
  if (!isAttemptDelta(parsed)) throw new Error(`Invalid continuation attempt delta field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.checkpointBytes);
  return parsed;
}

function parseTrustedVerification(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationVerificationVerdict {
  const parsed = parseTrustedJson(value, field);
  if (!isVerificationVerdict(parsed)) {
    throw new Error(`Invalid continuation verification field: ${field}.`);
  }
  return parsed;
}

function parseTrustedRecoveryState(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationRecoveryState {
  const parsed = parseTrustedJson(value, field);
  if (
    !isRecord(parsed)
    || !isDurableRunFailure(parsed.failure)
    || !Number.isInteger(parsed.fingerprintAttempts)
    || Number(parsed.fingerprintAttempts) < 1
    || !Number.isInteger(parsed.totalAttempts)
    || Number(parsed.totalAttempts) < 1
    || !['retry', 'wait_user', 'block', 'fail'].includes(String(parsed.lastDecision))
    || (parsed.userInput !== undefined && typeof parsed.userInput !== 'string')
  ) throw new Error(`Invalid continuation recovery field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.contextSnapshotBytes);
  return parsed as unknown as ContinuationRecoveryState;
}

function parseTrustedCountRecord(
  value: SqlRow[string] | undefined,
  field: string,
): Record<string, number> {
  const parsed = parseTrustedJson(value, field);
  if (
    !isRecord(parsed)
    || Object.entries(parsed).some(([key, count]) =>
      !key || !Number.isInteger(count) || Number(count) < 0)
  ) throw new Error(`Invalid continuation count record: ${field}.`);
  return parsed as Record<string, number>;
}

function isDurableRunFailure(value: unknown): value is DurableRunFailure {
  return isRecord(value)
    && ['invalid_invocation', 'transient', 'authentication_required', 'permission_required',
      'capability_unavailable', 'terminal', 'unknown'].includes(String(value.category))
    && ['safe', 'unsafe', 'unknown'].includes(String(value.retrySafety))
    && typeof value.capabilityAvailable === 'boolean'
    && ['pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown']
      .includes(String(value.operationRisk))
    && Array.isArray(value.hints)
    && value.hints.every((hint) => typeof hint === 'string')
    && typeof value.failedStep === 'string'
    && typeof value.diagnostic === 'string'
    && typeof value.fingerprint === 'string';
}

function parseTrustedResultArtifacts(
  value: SqlRow[string] | undefined,
  field: string,
): string[] {
  const artifacts = parseTrustedStringArray(value, field);
  if (artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Invalid continuation artifact count in field: ${field}.`);
  }
  assertJsonBytes(field, artifacts, CONTINUATION_LIMITS.contextSnapshotBytes);
  return artifacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCheckpoint(value: unknown): value is ContinuationCheckpoint {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'summary',
      'completedSteps',
      'remainingSteps',
      'constraints',
      'decisions',
      'references',
    ])
    || typeof value.summary !== 'string'
  ) return false;
  return ['completedSteps', 'remainingSteps', 'constraints', 'decisions', 'references']
    .every((field) => Array.isArray(value[field])
      && (value[field] as unknown[]).every((entry) => typeof entry === 'string'));
}

function legacyCheckpointToV2(value: ContinuationCheckpoint): ContinuationCheckpointV2 {
  const remainingSteps = value.remainingSteps.map((description, index) => ({
    id: `legacy-step-${index + 1}`,
    description,
  }));
  return {
    schemaVersion: 2,
    summary: value.summary,
    currentStepId: 'legacy-handoff',
    completedStepIds: [],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps,
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: value.constraints,
    decisions: value.decisions,
    nextAction: remainingSteps[0] ?? null,
    stopReason: 'Migrated from a legacy checkpoint without inventing completion evidence.',
  };
}

function checkpointFromInitialContext(value: ContinuationCheckpoint): ContinuationCheckpointV2 {
  return legacyCheckpointToV2(value);
}

function isCheckpointV2(value: unknown): value is ContinuationCheckpointV2 {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (
    typeof value.summary !== 'string'
    || typeof value.currentStepId !== 'string'
    || typeof value.stopReason !== 'string'
    || !isCheckpointStepOrNull(value.nextAction)
  ) return false;
  if (!['completedStepIds', 'completedCriterionIds', 'completedDeliverableIds', 'constraints', 'decisions']
    .every((field) => isStringArray(value[field]))) return false;
  if (!Array.isArray(value.remainingSteps) || !value.remainingSteps.every(isCheckpointStep)) return false;
  if (!Array.isArray(value.artifacts) || !value.artifacts.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.deliverableId === 'string'
    && typeof entry.path === 'string'
    && typeof entry.sha256 === 'string')) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.requirementId === 'string'
    && isStringArray(entry.criterionIds)
    && (entry.artifactId === undefined || typeof entry.artifactId === 'string')
    && (entry.reference === undefined || typeof entry.reference === 'string'))) return false;
  return Array.isArray(value.sideEffects) && value.sideEffects.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.description === 'string'
    && typeof entry.idempotencyKey === 'string');
}

function isCheckpointStep(value: unknown): value is ContinuationCheckpointV2['remainingSteps'][number] {
  return isRecord(value) && typeof value.id === 'string' && typeof value.description === 'string';
}

function isCheckpointStepOrNull(value: unknown): value is ContinuationCheckpointV2['nextAction'] {
  return value === null || isCheckpointStep(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAttemptDelta(value: unknown): value is ContinuationAttemptDelta {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.stepId === 'string'
    && typeof value.checkpointHash === 'string'
    && typeof value.materialHash === 'string'
    && typeof value.stateChanged === 'boolean'
    && ['newCompletedStepIds', 'newCompletedCriterionIds', 'newCompletedDeliverableIds',
      'newArtifactIds', 'newEvidenceIds', 'newSideEffectIds']
      .every((field) => isStringArray(value[field]))
    && (value.nextActionStepId === undefined || typeof value.nextActionStepId === 'string');
}

function isVerificationVerdict(value: unknown): value is ContinuationVerificationVerdict {
  return isRecord(value)
    && (value.status === 'accepted' || value.status === 'revision_required')
    && isStringArray(value.findings);
}

function isDeliveryRoute(value: unknown): value is ContinuationDeliveryRoute {
  if (!isRecord(value)) return false;
  if (value.kind === 'message_thread') {
    return hasExactKeys(value, ['kind', 'conversationId', 'sourceMessageId', 'threadId'])
      && typeof value.conversationId === 'string'
      && typeof value.sourceMessageId === 'string'
      && (value.threadId === undefined || typeof value.threadId === 'string');
  }
  return hasExactKeys(value, ['kind', 'documentToken', 'commentId', 'fileType'])
    && value.kind === 'comment_thread'
    && typeof value.documentToken === 'string'
    && typeof value.commentId === 'string'
    && typeof value.fileType === 'string';
}

function routeMatchesSourceThread(
  route: ContinuationDeliveryRoute,
  sourceThreadId: string | undefined,
): boolean {
  return route.kind === 'message_thread'
    ? route.threadId === sourceThreadId
    : route.commentId === sourceThreadId;
}

function isManagedInputArtifact(value: unknown): value is AsyncTaskFactSnapshot['inputs'][number] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'kind', 'fileName', 'relativePath', 'sha256', 'sizeBytes',
  ])) return false;
  return /^input_\d{3}$/.test(String(value.id ?? ''))
    && (value.kind === 'message_image' || value.kind === 'message_attachment')
    && typeof value.fileName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.fileName)
    && typeof value.relativePath === 'string'
    && value.relativePath === value.fileName
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.sizeBytes === 'number'
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0;
}

interface ContinuationStepTransitionInput {
  claim: ContinuationClaim;
  current: ContinuationJob;
  result: ContinuationExecutionResult;
  now: string;
  progress: ReturnType<typeof evaluateContinuationProgress> | null;
  delta: ContinuationAttemptDelta;
  verification: ContinuationVerificationVerdict;
  rawVerification: ContinuationVerificationVerdict;
  jitter: () => number;
}

interface ContinuationTransitionExtras {
  executionSessionId?: string;
  attemptOutcome: NonNullable<import('../domain/continuation.js').ContinuationAttempt['outcome']>;
  attemptError?: ContinuationFailure;
  attemptRecovery?: ContinuationRecoveryState;
  delta?: ContinuationAttemptDelta;
  verification?: ContinuationVerificationVerdict;
  failure?: DurableRunFailure;
  deliveries?: DurableRunTransition['deliveries'];
  interrupts?: DurableRunTransition['interrupts'];
  supersedeDeliveryKinds?: readonly string[];
}

function buildContinuationStepTransition(input: ContinuationStepTransitionInput): DurableRunTransition {
  const {
    claim,
    current,
    result,
    now,
    progress,
    delta,
    verification,
    rawVerification,
    jitter,
  } = input;
  const executionSessionId = result.executionSessionId === undefined
    ? current.executionSessionId
    : result.executionSessionId ?? undefined;
  const outcome = result.outcome;

  const transition = (
    status: ContinuationStatus,
    patch: Partial<ContinuationJob>,
    extras: ContinuationTransitionExtras,
  ): DurableRunTransition => continuationDurableTransition(
    claim,
    current,
    status,
    patch,
    now,
    extras,
  );

  const terminalFailure = (
    errorCode: string,
    errorSummary: string,
    options: {
      checkpoint?: ContinuationCheckpointV2;
      failureCount?: number;
      noProgressCount?: number;
      recoveryFailure?: DurableRunFailure;
      delta?: ContinuationAttemptDelta;
      verification?: ContinuationVerificationVerdict;
    } = {},
  ): DurableRunTransition => {
    const terminalRecovery = options.recoveryFailure
      ? continuationTerminalRecovery(current, options.recoveryFailure, 'fail')
      : null;
    return transition('failed', {
      executionSessionId,
      checkpoint: options.checkpoint ?? current.checkpoint,
      failureCount: options.failureCount ?? current.failureCount,
      noProgressCount: options.noProgressCount ?? current.noProgressCount,
      errorCode,
      errorSummary,
      ...(terminalRecovery ? {
        recovery: terminalRecovery.state,
        recoveryTotalCount: terminalRecovery.totalAttempts,
        recoveryFingerprintCounts: terminalRecovery.counts,
      } : {}),
    }, {
      executionSessionId,
      attemptOutcome: 'failed',
      attemptError: { errorCode, errorSummary, retryable: false },
      ...(terminalRecovery ? { attemptRecovery: terminalRecovery.state } : {}),
      ...(options.delta ? { delta: options.delta } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
      ...(options.recoveryFailure ? { failure: terminalRecovery!.state.failure } : {}),
      deliveries: [continuationTerminalDelivery(
        current,
        renderFailedPayload(current.jobId, errorSummary, terminalRecovery?.state),
        now,
      )],
      supersedeDeliveryKinds: ['progress', 'interrupt'],
    });
  };

  const partial = (
    partialOutcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
    errorCode = 'partial_completion',
    checkpoint: ContinuationCheckpointV2 | undefined = partialOutcome.checkpoint,
    errorSummary = 'The continuation completed with a partial result.',
  ): DurableRunTransition => {
    validatePartialResult(partialOutcome);
    return transition('partial', {
      executionSessionId,
      checkpoint: checkpoint ?? current.checkpoint,
      stepCount: current.stepCount + 1,
      resultSummary: partialResultSummary(partialOutcome),
      resultArtifacts: partialOutcome.artifacts,
      errorCode,
      errorSummary,
    }, {
      executionSessionId,
      attemptOutcome: 'partial',
      delta,
      verification,
      deliveries: [continuationTerminalDelivery(
        current,
        renderPartialPayload(current.jobId, partialOutcome, errorSummary),
        now,
      )],
      supersedeDeliveryKinds: ['progress', 'interrupt'],
    });
  };

  const recovery = (
    recoveryOutcome: Extract<ContinuationStepOutcome, { outcome: 'recovering' | 'waiting_user' }>,
  ): DurableRunTransition => {
    const failure = boundedDurableRunFailure(recoveryOutcome.failure);
    const counts = { ...current.recoveryFingerprintCounts };
    const fingerprintAttempts = (counts[failure.fingerprint] ?? 0) + 1;
    const totalAttempts = current.recoveryTotalCount + 1;
    if (
      fingerprintAttempts > MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT
      || totalAttempts > MAX_TOTAL_RECOVERY_ATTEMPTS
      || claim.attempt.ordinal >= current.maxAttempts
    ) {
      return terminalFailure(
        'continuation_recovery_budget_exhausted',
        'The bounded recovery budget was exhausted.',
        {
          checkpoint: recoveryOutcome.checkpoint,
          recoveryFailure: failure,
          delta,
          verification,
        },
      );
    }
    counts[failure.fingerprint] = fingerprintAttempts;
    const recoveryState: ContinuationRecoveryState = {
      failure,
      fingerprintAttempts,
      totalAttempts,
      lastDecision: recoveryOutcome.outcome === 'recovering' ? 'retry' : 'wait_user',
    };
    const errorCode = `continuation_${failure.category}`;
    const nextRunAt = recoveryOutcome.outcome === 'recovering'
      ? addMilliseconds(now, Math.max(0, recoveryOutcome.delaySeconds) * 1_000)
      : current.nextRunAt;
    let deliveries: DurableRunTransition['deliveries'];
    let interrupts: DurableRunTransition['interrupts'];
    if (recoveryOutcome.outcome === 'waiting_user') {
      const interruptId = continuationInterruptId(current.jobId, claim.attempt.attemptId, failure);
      const prompt = truncateCharacters(redactContinuationText(recoveryOutcome.prompt), 2_000);
      interrupts = [{
        interruptId,
        attemptId: claim.attempt.attemptId,
        prompt,
      }];
      deliveries = [continuationInterruptDelivery(
        current,
        claim,
        interruptId,
        prompt,
        failure,
        recoveryState,
        recoveryOutcome.checkpoint,
        now,
      )];
    }
    return transition(recoveryOutcome.outcome, {
      executionSessionId,
      checkpoint: recoveryOutcome.checkpoint,
      recovery: recoveryState,
      recoveryTotalCount: totalAttempts,
      recoveryFingerprintCounts: counts,
      nextRunAt,
      errorCode,
      errorSummary: recoveryOutcome.reason,
    }, {
      executionSessionId,
      attemptOutcome: recoveryOutcome.outcome,
      attemptError: {
        errorCode,
        errorSummary: recoveryOutcome.reason,
        retryable: recoveryOutcome.outcome === 'recovering',
      },
      attemptRecovery: recoveryState,
      delta,
      verification,
      failure,
      ...(deliveries ? { deliveries } : {}),
      ...(interrupts ? { interrupts } : {}),
    });
  };

  const verificationRecovery = (
    checkpoint: ContinuationCheckpointV2,
    findings: string[],
    noProgressCount: number,
  ): DurableRunTransition => {
    if (noProgressCount >= 2) {
      return terminalFailure(
        'continuation_stalled',
        'The continuation stopped after repeated attempts produced no verifiable progress.',
        { checkpoint, noProgressCount, delta, verification },
      );
    }
    if (claim.attempt.ordinal >= current.maxAttempts) {
      const reason = attemptBudgetTerminalReason(current, checkpoint);
      return partial(
        partialOutcomeFromCheckpoint(checkpoint),
        reason.errorCode,
        checkpoint,
        reason.errorSummary,
      );
    }
    const summary = findings
      .slice(0, 20)
      .map((finding) => truncateCharacters(finding, 500))
      .join(' ') || 'The checkpoint requires revision.';
    return transition('recovering', {
      executionSessionId,
      checkpoint,
      noProgressCount,
      stepCount: current.stepCount + 1,
      failureCount: 0,
      nextRunAt: now,
      errorCode: 'continuation_verification_failed',
      errorSummary: summary,
    }, {
      executionSessionId,
      attemptOutcome: 'continue',
      attemptError: {
        errorCode: 'continuation_verification_failed',
        errorSummary: summary,
        retryable: true,
      },
      delta,
      verification,
    });
  };

  if (rawVerification.status === 'revision_required') {
    return verificationRecovery(
      current.checkpoint ?? checkpointFromInitialContext(current.contextSnapshot),
      rawVerification.findings,
      delta.stateChanged ? 0 : current.noProgressCount + 1,
    );
  }
  if (outcome.outcome === 'recovering' || outcome.outcome === 'waiting_user') {
    return recovery(outcome);
  }
  if (outcome.outcome === 'continue') {
    if (!progress) throw new Error('Continuation progress evaluation is missing.');
    if (progress.decision === 'recover') {
      return verificationRecovery(
        outcome.checkpoint,
        ['A continue outcome requires one concrete next action.'],
        progress.noProgressCount,
      );
    }
    if (progress.decision === 'fail_stalled') {
      return terminalFailure(
        'continuation_stalled',
        'The continuation stopped after repeated attempts produced no verifiable progress.',
        {
          checkpoint: outcome.checkpoint,
          noProgressCount: progress.noProgressCount,
          delta,
          verification,
        },
      );
    }
    if (progress.decision === 'finish_partial') {
      const reason = attemptBudgetTerminalReason(current, outcome.checkpoint);
      return partial(
        partialOutcomeFromCheckpoint(outcome.checkpoint),
        reason.errorCode,
        outcome.checkpoint,
        reason.errorSummary,
      );
    }
    const nextRunAt = addMilliseconds(now, Math.max(0, outcome.resumeAfterSeconds ?? 0) * 1_000);
    return transition('waiting_retry', {
      executionSessionId,
      checkpoint: outcome.checkpoint,
      noProgressCount: progress.noProgressCount,
      stepCount: current.stepCount + 1,
      failureCount: 0,
      nextRunAt,
      recovery: undefined,
      errorCode: undefined,
      errorSummary: undefined,
    }, {
      executionSessionId,
      attemptOutcome: 'continue',
      delta,
      verification,
      deliveries: [continuationProgressDelivery(current, claim, outcome, now)],
    });
  }
  if (outcome.outcome === 'completed') {
    if (!progress || progress.decision !== 'complete') {
      throw new Error('Continuation completion evaluation is inconsistent.');
    }
    validateFinalResult(outcome.finalMessage, outcome.resultSummary, outcome.artifacts);
    return transition('completed', {
      executionSessionId,
      checkpoint: outcome.checkpoint,
      noProgressCount: progress.noProgressCount,
      stepCount: current.stepCount + 1,
      resultSummary: outcome.resultSummary,
      resultArtifacts: outcome.artifacts,
      recovery: undefined,
      errorCode: undefined,
      errorSummary: undefined,
    }, {
      executionSessionId,
      attemptOutcome: 'completed',
      delta,
      verification,
      deliveries: [continuationTerminalDelivery(
        current,
        `Task completed: ${current.jobId}\n${outcome.finalMessage}`,
        now,
      )],
      supersedeDeliveryKinds: ['progress', 'interrupt'],
    });
  }
  if (outcome.outcome === 'partial') return partial(outcome);
  if (outcome.outcome === 'blocked') {
    assertJsonBytes('blocked result', outcome, CONTINUATION_LIMITS.finalMessageBytes);
    const terminalRecovery = outcome.recoveryFailure
      ? continuationTerminalRecovery(current, outcome.recoveryFailure, 'block')
      : null;
    return transition('blocked', {
      executionSessionId,
      checkpoint: outcome.checkpoint,
      stepCount: current.stepCount + 1,
      resultSummary: outcome.errorSummary,
      errorCode: outcome.errorCode,
      errorSummary: outcome.errorSummary,
      ...(terminalRecovery ? {
        recovery: terminalRecovery.state,
        recoveryTotalCount: terminalRecovery.totalAttempts,
        recoveryFingerprintCounts: terminalRecovery.counts,
      } : {}),
    }, {
      executionSessionId,
      attemptOutcome: 'blocked',
      attemptError: {
        errorCode: outcome.errorCode,
        errorSummary: outcome.errorSummary,
        retryable: false,
      },
      ...(terminalRecovery ? { attemptRecovery: terminalRecovery.state } : {}),
      delta,
      verification,
      ...(terminalRecovery ? { failure: terminalRecovery.state.failure } : {}),
      deliveries: [continuationTerminalDelivery(
        current,
        renderBlockedPayload(current.jobId, outcome, terminalRecovery?.state),
        now,
      )],
      supersedeDeliveryKinds: ['progress', 'interrupt'],
    });
  }
  if (outcome.retryable && hasOpaqueExecutionEffects(current)) {
    const failedStep = outcome.checkpoint.currentStepId || continuationStepId(current);
    return recovery({
      outcome: 'waiting_user',
      checkpoint: outcome.checkpoint,
      failure: {
        category: 'unknown',
        retrySafety: 'unknown',
        capabilityAvailable: true,
        operationRisk: 'external_side_effect',
        hints: ['Confirm the effects of the failed step before resuming.'],
        failedStep,
        diagnostic: outcome.errorSummary,
        fingerprint: createHash('sha256')
          .update(`model-retryable\0${outcome.errorCode}\0${failedStep}`)
          .digest('hex')
          .slice(0, 32),
      },
      prompt: 'Confirm what the failed step changed, then resume with the observed result.',
      reason: 'The model requested a retry after opaque execution, so automatic replay is unsafe.',
    });
  }
  return buildContinuationFailureTransition(
    claim,
    current,
    {
      errorCode: outcome.errorCode,
      errorSummary: outcome.errorSummary,
      retryable: outcome.retryable,
    },
    now,
    jitter,
    {
      executionSessionId,
      checkpoint: outcome.checkpoint,
      recoveryFailure: outcome.recoveryFailure,
      delta,
      verification,
    },
  );
}

function buildContinuationFailureTransition(
  claim: ContinuationClaim,
  current: ContinuationJob,
  requestedFailure: ContinuationFailure,
  now: string,
  jitter: () => number,
  options: {
    executionSessionId?: string;
    checkpoint?: ContinuationCheckpointV2;
    recoveryFailure?: DurableRunFailure;
    delta?: ContinuationAttemptDelta;
    verification?: ContinuationVerificationVerdict;
  } = {},
): DurableRunTransition {
  const executionSessionId = options.executionSessionId ?? current.executionSessionId;
  if (
    requestedFailure.retryable
    && claim.durableClaim?.attempt.executionStartedAt
    && hasOpaqueExecutionEffects(current)
  ) {
    const failedStep = continuationStepId(current);
    return buildContinuationStepTransition({
      claim,
      current,
      result: {
        executionSessionId,
        outcome: {
          outcome: 'waiting_user',
          checkpoint: options.checkpoint
            ?? current.checkpoint
            ?? checkpointFromInitialContext(current.contextSnapshot),
          failure: {
            category: 'unknown',
            retrySafety: 'unknown',
            capabilityAvailable: true,
            operationRisk: 'external_side_effect',
            hints: ['Confirm the effects of the interrupted step before resuming.'],
            failedStep,
            diagnostic: requestedFailure.errorSummary,
            fingerprint: createHash('sha256')
              .update(`execution-unknown\0${requestedFailure.errorCode}\0${failedStep}`)
              .digest('hex')
              .slice(0, 32),
          },
          prompt: 'Confirm what the interrupted step changed, then resume with the observed result.',
          reason: 'The execution ended after an opaque operation started, so automatic replay is unsafe.',
        },
      },
      now,
      progress: null,
      delta: options.delta ?? createAttemptDelta(
        current.checkpoint ?? null,
        options.checkpoint ?? current.checkpoint ?? checkpointFromInitialContext(current.contextSnapshot),
      ),
      verification: options.verification ?? { status: 'accepted', findings: [] },
      rawVerification: options.verification ?? { status: 'accepted', findings: [] },
      jitter,
    });
  }
  const failure = boundedFailure(requestedFailure);
  const failureCount = current.failureCount + 1;
  if (
    failure.retryable
    && failureCount <= current.maxRetries
    && claim.attempt.ordinal < current.maxAttempts
    && current.expiresAt > now
  ) {
    return continuationDurableTransition(claim, current, 'waiting_retry', {
      executionSessionId,
      failureCount,
      checkpoint: options.checkpoint ?? current.checkpoint,
      nextRunAt: addMilliseconds(now, retryDelayMs(failureCount, jitter())),
      errorCode: failure.errorCode,
      errorSummary: failure.errorSummary,
    }, now, {
      executionSessionId,
      attemptOutcome: 'failed',
      attemptError: failure,
      ...(options.delta ? { delta: options.delta } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
    });
  }
  const terminalRecovery = options.recoveryFailure
    ? continuationTerminalRecovery(current, options.recoveryFailure, 'fail')
    : null;
  return continuationDurableTransition(claim, current, 'failed', {
    executionSessionId,
    failureCount,
    checkpoint: options.checkpoint ?? current.checkpoint,
    errorCode: failure.errorCode,
    errorSummary: failure.errorSummary,
    ...(terminalRecovery ? {
      recovery: terminalRecovery.state,
      recoveryTotalCount: terminalRecovery.totalAttempts,
      recoveryFingerprintCounts: terminalRecovery.counts,
    } : {}),
  }, now, {
    executionSessionId,
    attemptOutcome: 'failed',
    attemptError: { ...failure, retryable: false },
    ...(terminalRecovery ? { attemptRecovery: terminalRecovery.state } : {}),
    ...(options.delta ? { delta: options.delta } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
    ...(terminalRecovery ? { failure: terminalRecovery.state.failure } : {}),
    deliveries: [continuationTerminalDelivery(
      current,
      renderFailedPayload(current.jobId, failure.errorSummary, terminalRecovery?.state),
      now,
    )],
    supersedeDeliveryKinds: ['progress', 'interrupt'],
  });
}

function durableFailureForContinuationFailure(
  claim: ContinuationClaim,
  failure: ContinuationFailure,
): DurableRunFailure {
  const bounded = boundedFailure(failure);
  const failedStep = continuationStepId(claim.job);
  return {
    category: bounded.retryable ? 'transient' : 'terminal',
    retrySafety: bounded.retryable ? 'safe' : 'unsafe',
    capabilityAvailable: true,
    operationRisk: 'unknown',
    hints: [],
    failedStep,
    diagnostic: bounded.errorSummary,
    fingerprint: createHash('sha256')
      .update(`${bounded.errorCode}\0${failedStep}\0${bounded.errorSummary}`)
      .digest('hex')
      .slice(0, 32),
  };
}

function continuationDurableTransition(
  claim: ContinuationClaim,
  current: ContinuationJob,
  status: ContinuationStatus,
  patch: Partial<ContinuationJob>,
  now: string,
  extras: ContinuationTransitionExtras,
): DurableRunTransition {
  const job: ContinuationJob = {
    ...current,
    ...patch,
    status,
    rowVersion: claim.claimedRowVersion + 1,
    updatedAt: now,
    ...(isContinuationTerminal(status) ? { completedAt: now } : {}),
  };
  delete job.leaseOwner;
  delete job.leaseExpiresAt;
  delete job.heartbeatAt;
  delete job.deliveryStatus;
  delete job.deliveryEvents;
  delete job.currentInterrupt;
  const attemptMetadata = {
    ...(extras.attemptRecovery ? { recovery: extras.attemptRecovery } : {}),
    ...(extras.delta ? { stepId: extras.delta.stepId, delta: extras.delta } : {}),
    ...(extras.verification ? { verification: extras.verification } : {}),
  };
  return {
    status,
    stateVersion: 1,
    state: asyncTaskStateEnvelopeFromJob(job),
    ...((status === 'waiting_retry' || status === 'recovering')
      ? { nextRunAt: job.nextRunAt }
      : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.errorSummary ? { errorSummary: job.errorSummary } : {}),
    ...(extras.failure ? { failure: extras.failure } : {}),
    attempt: {
      outcome: extras.attemptOutcome,
      executionSessionId: extras.executionSessionId ?? null,
      ...(extras.attemptError ? {
        errorCode: extras.attemptError.errorCode,
        errorSummary: extras.attemptError.errorSummary,
      } : {}),
      metadata: attemptMetadata,
    },
    ...(extras.deliveries ? { deliveries: extras.deliveries } : {}),
    ...(extras.interrupts ? { interrupts: extras.interrupts } : {}),
    ...(extras.supersedeDeliveryKinds
      ? { supersedeDeliveryKinds: extras.supersedeDeliveryKinds }
      : {}),
  };
}

function continuationTerminalRecovery(
  current: ContinuationJob,
  requestedFailure: DurableRunFailure,
  lastDecision: Extract<ContinuationRecoveryState['lastDecision'], 'block' | 'fail'>,
): {
  state: ContinuationRecoveryState;
  totalAttempts: number;
  counts: Record<string, number>;
} {
  const failure = boundedDurableRunFailure(requestedFailure);
  const counts = { ...current.recoveryFingerprintCounts };
  const fingerprintAttempts = (counts[failure.fingerprint] ?? 0) + 1;
  const totalAttempts = current.recoveryTotalCount + 1;
  counts[failure.fingerprint] = fingerprintAttempts;
  const state: ContinuationRecoveryState = {
    failure,
    fingerprintAttempts,
    totalAttempts,
    lastDecision,
  };
  assertJsonBytes('recovery state', state, CONTINUATION_LIMITS.contextSnapshotBytes);
  return { state, totalAttempts, counts };
}

function continuationTerminalDelivery(
  job: ContinuationJob,
  payload: string,
  now: string,
): NonNullable<DurableRunTransition['deliveries']>[number] {
  return {
    outboxId: makeId('out'),
    eventKey: 'terminal',
    kind: 'terminal',
    attemptId: null,
    route: job.route,
    idempotencyKey: deliveryIdempotencyKey(job.jobId, 'terminal'),
    payload,
    createdAt: now,
    nextAttemptAt: now,
  };
}

function continuationProgressDelivery(
  job: ContinuationJob,
  claim: ContinuationClaim,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'continue' }>,
  now: string,
): NonNullable<DurableRunTransition['deliveries']>[number] {
  const eventKey = `progress:${claim.attempt.attemptId}`;
  return {
    outboxId: makeId('out'),
    eventKey,
    kind: 'progress',
    attemptId: claim.attempt.attemptId,
    route: job.route,
    idempotencyKey: deliveryIdempotencyKey(job.jobId, eventKey),
    payload: renderProgressPayload(job, claim, outcome),
    metadata: { blocksRun: true },
    createdAt: now,
    nextAttemptAt: now,
  };
}

function continuationInterruptId(
  jobId: string,
  attemptId: string,
  failure: DurableRunFailure,
): string {
  return `int_${createHash('sha256')
    .update(`${jobId}\0${attemptId}\0${failure.fingerprint}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function continuationInterruptDelivery(
  job: ContinuationJob,
  claim: ContinuationClaim,
  interruptId: string,
  prompt: string,
  failure: DurableRunFailure,
  recovery: ContinuationRecoveryState,
  checkpoint: ContinuationCheckpointV2,
  now: string,
): NonNullable<DurableRunTransition['deliveries']>[number] {
  const eventKey = `interrupt:${interruptId}`;
  return {
    outboxId: makeId('out'),
    eventKey,
    kind: 'interrupt',
    attemptId: claim.attempt.attemptId,
    route: job.route,
    idempotencyKey: deliveryIdempotencyKey(job.jobId, eventKey),
    payload: renderInterruptPayload(
      job,
      claim,
      interruptId,
      prompt,
      failure,
      recovery,
      checkpoint,
    ),
    createdAt: now,
    nextAttemptAt: now,
  };
}

function durableClaimKey(jobId: string, workerId: string): string {
  return `${jobId}\0${workerId}`;
}

function continuationJobAfterBaseTransition(
  job: ContinuationJob,
  update: {
    status: ContinuationStatus;
    now: string;
    rowVersion: number;
    errorCode?: string;
    errorSummary?: string;
  },
): ContinuationJob {
  const next: ContinuationJob = {
    ...job,
    status: update.status,
    rowVersion: update.rowVersion,
    updatedAt: update.now,
    ...(isContinuationTerminal(update.status) ? { completedAt: update.now } : {}),
    ...(update.errorCode ? { errorCode: update.errorCode } : {}),
    ...(update.errorSummary ? { errorSummary: update.errorSummary } : {}),
  };
  delete next.leaseOwner;
  delete next.leaseExpiresAt;
  delete next.heartbeatAt;
  return next;
}

function continuationJobForCommandState(
  current: ContinuationJob,
  status: ContinuationStatus,
  rowVersion: number,
  now: string,
): ContinuationJob {
  const next: ContinuationJob = {
    ...current,
    status,
    rowVersion,
    updatedAt: now,
    ...(isContinuationTerminal(status) ? { completedAt: now } : {}),
  };
  delete next.leaseOwner;
  delete next.leaseExpiresAt;
  delete next.heartbeatAt;
  delete next.deliveryStatus;
  delete next.deliveryEvents;
  delete next.currentInterrupt;
  return next;
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

function claimProjectionMatches(claim: ContinuationClaim): boolean {
  return claim.job.jobId === claim.attempt.jobId
    && claim.workerId === claim.attempt.workerId
    && claim.job.leaseOwner === claim.workerId
    && claim.job.rowVersion === claim.claimedRowVersion;
}

function timestampAfterElapsed(timestamp: string, startedAt: bigint): string {
  const elapsedMilliseconds = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  return elapsedMilliseconds > 0
    ? addMilliseconds(timestamp, elapsedMilliseconds)
    : timestamp;
}

function assertOneChange(changes: number | bigint, jobId: string): void {
  if (Number(changes) !== 1) throw staleClaimError(jobId);
}

function staleClaimError(jobId: string): Error {
  return new Error(`Stale continuation claim for ${jobId}.`);
}
