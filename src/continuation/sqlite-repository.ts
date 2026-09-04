import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  retryDelayMs,
  type ContinuationClaim,
  type ContinuationCleanupResult,
  type ContinuationCreateRequest,
  type ContinuationDeliveryClaim,
  type ContinuationDeliveryRecord,
  type ContinuationDeliveryResult,
  type ContinuationExecutionResult,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationPendingInterruptRoute,
  type ContinuationRecoveryState,
  type ContinuationStatus,
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
import { DURABLE_RUN_SCHEMA_VERSION } from '../durable-run/sqlite-migrations.js';
import {
  EMPTY_CHECKPOINT,
  EMPTY_PERMISSION_ENVELOPE,
  addMilliseconds,
  assertJsonBytes,
  canReexecuteSameToolRequest,
  canReplaceCompletedToolFailure,
  cleanupErrorSummary,
  continuationJobForCreate,
  continuationStepId,
  corruptTombstoneContract,
  corruptTombstoneFacts,
  createRequestFingerprint,
  discardRedactionQuarantines,
  deliveryIdempotencyKey,
  emptyRoute,
  isDeliveryRoute,
  jobSelectSql,
  makeId,
  mapJob,
  mapPendingInterruptRoute,
  numberField,
  optionalStringField,
  parseToolResult,
  parseTrustedJson,
  projectCreateRequest,
  redactedLegacyContract,
  redactedLegacyFacts,
  restoreRedactionQuarantines,
  stringField,
  toolCallId,
  toolRequestHash,
  trustedRouteFromCorruptRow,
  validateCreateRequest,
  validateToolRequest,
  validateToolResult,
  type RedactionQuarantines,
  type SqlRow,
} from './sqlite-codec.js';
import {
  assertOneChange,
  buildContinuationFailureTransition,
  buildContinuationStepTransition,
  claimProjectionMatches,
  continuationDurableTransition,
  continuationJobForCommandState,
  continuationTerminalDelivery,
  durableClaimKey,
  durableFailureForContinuationFailure,
  staleClaimError,
  timestampAfterElapsed,
} from './sqlite-transitions.js';
import {
  healthCheckContinuationDatabase,
  initializeContinuationDatabase,
  openContinuationDatabase,
} from './sqlite-database.js';

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
    const database = await openContinuationDatabase(databasePath);
    try {
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
    await initializeContinuationDatabase(this.database);
  }

  async healthCheck(): Promise<void> {
    healthCheckContinuationDatabase(this.database);
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
    ) {
      this.forgetActiveDurableClaim(claim.durableClaim);
      return 'stale';
    }
    // commitTransition atomically fences the current persisted lease, owner, and Attempt.
    // claim.attempt.leaseExpiresAt is the original claim snapshot and is not updated by heartbeats.
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
    ) {
      this.forgetActiveDurableClaim(claim.durableClaim);
      return 'stale';
    }
    // failAttempt performs the same atomic persisted-claim fence as commitTransition.
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
    leaseExpiresAt?: string,
  ): Promise<ContinuationDeliveryClaim | null> {
    while (true) {
      const claim = await this.durableRuns.claimDelivery(
        ['async_task'],
        workerId,
        now,
        leaseExpiresAt,
      );
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
      try {
        return continuationDeliveryClaimFromDurable(claim);
      } catch {
        await this.durableRuns.commitDelivery(claim, claim.recoveredFromExpiredLease
          ? {
              status: 'unknown',
              errorCode: 'continuation_delivery_envelope_interrupted_unknown',
              errorSummary: 'An interrupted delivery has an invalid stored envelope; it was not replayed.',
            }
          : {
              status: 'failed',
              errorCode: 'continuation_delivery_envelope_invalid',
              errorSummary: 'The stored Async Task delivery envelope is invalid.',
            }, now);
        continue;
      }
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
