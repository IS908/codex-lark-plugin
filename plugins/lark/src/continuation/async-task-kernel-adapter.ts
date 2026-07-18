import type {
  ContinuationClaim,
  ContinuationDeliveryClaim,
  ContinuationDeliveryResult,
  ContinuationExecutionResult,
  ContinuationFailure,
  ContinuationJob,
} from '../domain/continuation.js';
import { ContinuationExecutionError } from '../domain/continuation.js';
import type {
  DurableRunClaim,
  DurableRunCreateRequest,
  DurableRunCreateResult,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunPreflight,
  DurableRunRecord,
  DurableRunTransition,
  DurableRunWorkloadClaim,
  DurableRunWorkloadContext,
} from '../domain/durable-run.js';
import { formatContinuationDiagnosticMessage } from '../diagnostic-log-format.js';
import type {
  ContinuationClaimMutationResult,
  ContinuationAudit,
  ContinuationDelivery,
  ContinuationExecutor,
  ContinuationRepository,
} from '../ports/continuation.js';
import type {
  DurableRunClaimMutationResult,
  DurableRunDelivery,
  DurableRunRepository,
  DurableRunWorkload,
} from '../ports/durable-run.js';
import { redactContinuationText } from './redaction.js';

const ASYNC_TASK_INPUT_VERSION = 1;
const ASYNC_TASK_STATE_VERSION = 1;

interface AsyncTaskKernelInput {
  schemaVersion: 1;
  job: ContinuationJob;
}

type AsyncTaskCommit =
  | { kind: 'step'; result: ContinuationExecutionResult }
  | { kind: 'failure'; failure: ContinuationFailure };

interface AsyncTaskKernelState {
  schemaVersion: 1;
  job: ContinuationJob;
  commit?: AsyncTaskCommit;
}

type AsyncTaskExecution =
  | { kind: 'step'; result: ContinuationExecutionResult }
  | { kind: 'failure'; failure: ContinuationFailure };

interface ContinuationDeliveryEnvelope {
  schemaVersion: 1;
  claim: ContinuationDeliveryClaim;
}

export interface AsyncTaskKernelAdapterOptions {
  repository: ContinuationRepository;
  executor: ContinuationExecutor;
  delivery: ContinuationDelivery;
  audit?: ContinuationAudit;
  debug?: (message: string) => void;
}

export class AsyncTaskKernelAdapter implements
  DurableRunRepository,
  DurableRunWorkload<AsyncTaskKernelInput, AsyncTaskKernelState, AsyncTaskExecution>,
  DurableRunDelivery {
  readonly kind = 'async_task';
  private readonly thrownDeliveryResults = new WeakSet<object>();

  constructor(private readonly options: AsyncTaskKernelAdapterOptions) {}

  initialize(): Promise<void> {
    return this.options.repository.initialize();
  }

  async create(_request: DurableRunCreateRequest): Promise<DurableRunCreateResult> {
    throw new Error('Async Task creation remains on ContinuationService until schema migration.');
  }

  async get(runId: string): Promise<DurableRunRecord | null> {
    const job = await this.options.repository.get(runId);
    return job ? durableRunFromJob(job) : null;
  }

  async claimDue(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<DurableRunClaim | null> {
    if (!workloadKinds.includes(this.kind)) return null;
    const claim = await this.options.repository.claimDue(workerId, now, leaseExpiresAt);
    if (!claim) return null;
    this.debug('claimed', claim, 'running');
    return durableClaimFromContinuation(claim);
  }

  async markExecutionStarted(
    claim: DurableRunClaim,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    const continuationClaim = continuationClaimFromDurable(claim);
    const result = await this.options.repository.markExecutionStarted(continuationClaim, now);
    if (result === 'stale') return result;
    await this.audit(
      'continuation.execute.start',
      continuationClaim,
      'ok',
      permissionAuditDetail(continuationClaim),
    );
    return 'committed';
  }

  heartbeat(
    claim: DurableRunClaim,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const continuationClaim = continuationClaimFromDurable(claim);
    return this.options.repository.heartbeat(
      continuationClaim.job.jobId,
      continuationClaim.workerId,
      now,
      leaseExpiresAt,
    );
  }

  async commitTransition(
    claim: DurableRunClaim,
    transition: DurableRunTransition,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    const continuationClaim = continuationClaimFromDurable(claim);
    const state = parseAsyncTaskState(transition.state, transition.stateVersion);
    if (state.commit?.kind === 'step') {
      return this.commitStep(continuationClaim, state.commit.result, now);
    }
    if (state.commit?.kind === 'failure') {
      return this.commitFailure(continuationClaim, state.commit.failure, now);
    }
    if (transition.status === 'cancelled') {
      const result = await this.options.repository.completeCancellation(continuationClaim, now);
      if (result === 'stale') return result;
      await this.audit('continuation.cancel', continuationClaim, 'ok');
      this.debug('cancelled', continuationClaim, 'cancelled');
      return 'committed';
    }
    if (transition.status === 'failed' && transition.errorCode === 'durable_run_expired') {
      const result = await this.options.repository.failAttempt(
        continuationClaim,
        {
          errorCode: 'continuation_expired',
          errorSummary: 'The continuation reached its maximum age.',
          retryable: false,
        },
        now,
      );
      if (result === 'stale') return result;
      await this.audit('continuation.execute', continuationClaim, 'error', 'continuation_expired');
      this.debug('expired', continuationClaim, 'failed');
      return 'committed';
    }
    throw new Error(`Unsupported Async Task kernel transition: ${transition.status}`);
  }

  async failAttempt(
    claim: DurableRunClaim,
    failure: DurableRunFailure,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    const continuationClaim = continuationClaimFromDurable(claim);
    return this.commitFailure(continuationClaim, {
      errorCode: 'continuation_execution_failed',
      errorSummary: failure.diagnostic,
      retryable: failure.retrySafety !== 'unsafe',
    }, now);
  }

  async recoverExpiredLeases(now: string): Promise<DurableRunInterruptedAttempt[]> {
    // The pre-migration repository applies its recovery policy transactionally and returns only a
    // count. Returning no synthetic claims is deliberate: fabricating them would enable blind replay.
    await this.options.repository.recoverExpiredLeases(now);
    await this.options.repository.expireOverdue(now);
    return [];
  }

  async claimDelivery(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
  ): Promise<DurableRunDeliveryClaim | null> {
    if (!workloadKinds.includes(this.kind)) return null;
    const claim = await this.options.repository.claimPendingDelivery(workerId, now);
    return claim ? durableDeliveryClaimFromContinuation(claim) : null;
  }

  async commitDelivery(
    claim: DurableRunDeliveryClaim,
    result: DurableRunDeliveryResult,
    now: string,
  ): Promise<void> {
    const deliveryThrew = this.thrownDeliveryResults.delete(result);
    const continuationClaim = continuationDeliveryClaimFromDurable(claim);
    const continuationResult = continuationDeliveryResultFromDurable(result);
    try {
      await this.options.repository.markDeliveryResult(continuationClaim, continuationResult, now);
      await this.auditDelivery(
        continuationClaim,
        continuationResult.status === 'delivered' ? 'ok' : 'error',
        deliveryThrew ? 'continuation_delivery_failed' : continuationResult.status,
      );
      if (!deliveryThrew) {
        this.emitDebug(formatContinuationDiagnosticMessage({
          event: 'delivery_committed',
          jobId: continuationClaim.jobId,
          state: continuationResult.status,
        }));
      }
    } catch {
      await this.auditDelivery(continuationClaim, 'error', 'delivery_state_persist_failed');
    }
  }

  close(): void {
    this.options.repository.close();
  }

  parseInput(value: unknown, version: number): AsyncTaskKernelInput {
    return parseAsyncTaskInput(value, version);
  }

  parseState(value: unknown, version: number): AsyncTaskKernelState {
    return parseAsyncTaskState(value, version);
  }

  async preflight(
    _context: DurableRunWorkloadContext<AsyncTaskKernelInput, AsyncTaskKernelState>,
  ): Promise<DurableRunPreflight> {
    return { action: 'execute' };
  }

  async execute(
    claim: DurableRunWorkloadClaim<AsyncTaskKernelInput, AsyncTaskKernelState>,
    signal: AbortSignal,
  ): Promise<AsyncTaskExecution> {
    try {
      return {
        kind: 'step',
        result: await this.options.executor.execute(continuationClaimFromDurable(claim), signal),
      };
    } catch (error) {
      return { kind: 'failure', failure: classifyExecutionFailure(error) };
    }
  }

  reduce(
    claim: DurableRunWorkloadClaim<AsyncTaskKernelInput, AsyncTaskKernelState>,
    result: AsyncTaskExecution,
  ): DurableRunTransition {
    if (result.kind === 'failure') {
      return {
        status: result.failure.retryable ? 'waiting_retry' : 'failed',
        stateVersion: ASYNC_TASK_STATE_VERSION,
        state: {
          ...claim.run.state,
          commit: result,
        } satisfies AsyncTaskKernelState,
        ...(result.failure.retryable ? { nextRunAt: claim.run.nextRunAt } : {}),
        errorCode: result.failure.errorCode,
        errorSummary: result.failure.errorSummary,
      };
    }
    const status = durableStatusForExecution(result.result);
    return {
      status,
      stateVersion: ASYNC_TASK_STATE_VERSION,
      state: {
        ...claim.run.state,
        commit: result,
      } satisfies AsyncTaskKernelState,
      ...(status === 'waiting_retry' || status === 'recovering'
        ? { nextRunAt: claim.run.nextRunAt }
        : {}),
    };
  }

  recoverInterruptedAttempt(_context: DurableRunInterruptedAttempt): DurableRunTransition {
    throw new Error('Legacy Async Task lease recovery is committed inside ContinuationRepository.');
  }

  async deliver(claim: DurableRunDeliveryClaim): Promise<DurableRunDeliveryResult> {
    const continuationClaim = continuationDeliveryClaimFromDurable(claim);
    try {
      return durableDeliveryResultFromContinuation(
        await this.options.delivery.deliver(continuationClaim),
      );
    } catch (error) {
      const result: DurableRunDeliveryResult = {
        status: 'retry',
        errorCode: 'continuation_delivery_failed',
        errorSummary: errorSummary(error),
      };
      this.thrownDeliveryResults.add(result);
      return result;
    }
  }

  async handleWorkerStateError(claim: DurableRunClaim): Promise<void> {
    const continuationClaim = continuationClaimFromDurable(claim);
    await this.audit('continuation.execute', continuationClaim, 'error', 'worker_state_error');
    this.debug('worker_state_error', continuationClaim, 'running');
  }

  private async commitStep(
    claim: ContinuationClaim,
    result: ContinuationExecutionResult,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    const resultStatus = await this.options.repository.completeStep(claim, result, now);
    if (resultStatus === 'stale') return resultStatus;
    const committed = await this.options.repository.get(claim.job.jobId);
    const committedState = committed?.status ?? result.outcome.outcome;
    const detail = committed
      ? `state=${committed.status};verification=${committed.lastVerification?.status ?? 'none'};material_change=${committed.lastAttemptDelta?.stateChanged ?? false};no_progress=${committed.noProgressCount}`
      : `state=${committedState}`;
    await this.audit('continuation.execute', claim, 'ok', detail);
    this.debug('step_committed', claim, committedState);
    return 'committed';
  }

  private async commitFailure(
    claim: ContinuationClaim,
    failure: ContinuationFailure,
    now: string,
  ): Promise<ContinuationClaimMutationResult> {
    let committedState: ContinuationJob['status'] = 'failed';
    const result = await this.options.repository.failAttempt(claim, failure, now);
    if (result === 'stale') return result;
    committedState = (await this.options.repository.get(claim.job.jobId))?.status
      ?? committedState;
    await this.audit(
      'continuation.execute',
      claim,
      'error',
      `attempt_failed;state=${committedState}`,
    );
    this.debug('attempt_failed', claim, committedState);
    return 'committed';
  }

  private async audit(
    action: string,
    claim: ContinuationClaim,
    result: 'ok' | 'denied' | 'error',
    detail?: string,
  ): Promise<void> {
    await this.options.audit?.record({
      action,
      actorOpenId: claim.job.creatorOpenId,
      jobId: claim.job.jobId,
      attemptId: claim.attempt.attemptId,
      result,
      ...(detail ? { detail: sanitizeText(detail) } : {}),
    }).catch(() => {});
  }

  private async auditDelivery(
    claim: ContinuationDeliveryClaim,
    result: 'ok' | 'error',
    detail: string,
  ): Promise<void> {
    await this.options.audit?.record({
      action: 'continuation.deliver',
      jobId: claim.jobId,
      attemptId: claim.attemptId,
      result,
      detail: sanitizeText(`${claim.kind}:${claim.eventKey}:${detail}`),
    }).catch(() => {});
  }

  private debug(event: string, claim: ContinuationClaim, state?: string): void {
    try {
      this.emitDebug(formatContinuationDiagnosticMessage({
        event,
        jobId: claim.job.jobId,
        attemptId: claim.attempt.attemptId,
        ...(state ? { state } : {}),
      }));
    } catch {
      // Diagnostics never affect continuation state.
    }
  }

  private emitDebug(message: string): void {
    try {
      this.options.debug?.(message);
    } catch {
      // Diagnostics never affect continuation state.
    }
  }
}

function durableRunFromJob(job: ContinuationJob): DurableRunRecord {
  return {
    runId: job.jobId,
    workloadKind: 'async_task',
    idempotencyKey: job.idempotencyKey,
    status: job.status,
    inputVersion: ASYNC_TASK_INPUT_VERSION,
    input: { schemaVersion: 1, job } satisfies AsyncTaskKernelInput,
    stateVersion: ASYNC_TASK_STATE_VERSION,
    state: { schemaVersion: 1, job } satisfies AsyncTaskKernelState,
    route: job.route,
    actorOpenId: job.creatorOpenId,
    nextRunAt: job.nextRunAt,
    expiresAt: job.expiresAt,
    maxAttempts: job.maxAttempts,
    attemptCount: job.attemptCount ?? 0,
    rowVersion: job.rowVersion,
  };
}

function durableClaimFromContinuation(claim: ContinuationClaim): DurableRunClaim {
  const run = durableRunFromJob(claim.job);
  return {
    run,
    workerId: claim.workerId,
    claimedRowVersion: claim.claimedRowVersion,
    attempt: {
      attemptId: claim.attempt.attemptId,
      runId: claim.job.jobId,
      ordinal: claim.attempt.ordinal,
      workerId: claim.attempt.workerId,
      claimedAt: claim.attempt.startedAt,
      heartbeatAt: claim.attempt.heartbeatAt,
      leaseExpiresAt: claim.job.leaseExpiresAt ?? claim.attempt.heartbeatAt,
    },
  };
}

function continuationClaimFromDurable(claim: DurableRunClaim): ContinuationClaim {
  const state = parseAsyncTaskState(claim.run.state, claim.run.stateVersion);
  return {
    job: state.job,
    workerId: claim.workerId,
    claimedRowVersion: claim.claimedRowVersion,
    attempt: {
      attemptId: claim.attempt.attemptId,
      jobId: claim.run.runId,
      ordinal: claim.attempt.ordinal,
      workerId: claim.attempt.workerId,
      ...(state.job.executionSessionId
        ? { executionSessionId: state.job.executionSessionId }
        : {}),
      startedAt: claim.attempt.claimedAt,
      heartbeatAt: claim.attempt.heartbeatAt,
    },
  };
}

function parseAsyncTaskInput(value: unknown, version: number): AsyncTaskKernelInput {
  if (version !== ASYNC_TASK_INPUT_VERSION || !isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Unsupported Async Task kernel input version: ${version}`);
  }
  return { schemaVersion: 1, job: parseContinuationJob(value.job) };
}

function parseAsyncTaskState(value: unknown, version: number): AsyncTaskKernelState {
  if (version !== ASYNC_TASK_STATE_VERSION || !isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Unsupported Async Task kernel state version: ${version}`);
  }
  const state: AsyncTaskKernelState = {
    schemaVersion: 1,
    job: parseContinuationJob(value.job),
  };
  if (value.commit !== undefined) state.commit = parseAsyncTaskCommit(value.commit);
  return state;
}

function parseContinuationJob(value: unknown): ContinuationJob {
  if (
    !isRecord(value)
    || typeof value.jobId !== 'string'
    || typeof value.idempotencyKey !== 'string'
    || typeof value.creatorOpenId !== 'string'
    || typeof value.status !== 'string'
    || typeof value.rowVersion !== 'number'
  ) {
    throw new Error('Invalid Continuation Job in Async Task kernel envelope.');
  }
  return value as unknown as ContinuationJob;
}

function parseAsyncTaskCommit(value: unknown): AsyncTaskCommit {
  if (!isRecord(value)) throw new Error('Invalid Async Task kernel commit.');
  if (value.kind === 'step' && isRecord(value.result)) {
    return { kind: 'step', result: value.result as unknown as ContinuationExecutionResult };
  }
  if (value.kind === 'failure' && isContinuationFailure(value.failure)) {
    return { kind: 'failure', failure: value.failure };
  }
  throw new Error('Invalid Async Task kernel commit.');
}

function isContinuationFailure(value: unknown): value is ContinuationFailure {
  return isRecord(value)
    && typeof value.errorCode === 'string'
    && typeof value.errorSummary === 'string'
    && typeof value.retryable === 'boolean';
}

function durableStatusForExecution(result: ContinuationExecutionResult): DurableRunTransition['status'] {
  switch (result.outcome.outcome) {
    case 'continue': return 'waiting_retry';
    case 'recovering': return 'recovering';
    case 'waiting_user': return 'waiting_user';
    case 'completed': return 'completed';
    case 'partial': return 'partial';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
  }
}

function classifyExecutionFailure(error: unknown): ContinuationFailure {
  if (error instanceof ContinuationExecutionError) {
    return {
      errorCode: error.errorCode,
      errorSummary: sanitizeText(error.errorSummary),
      retryable: error.retryable,
    };
  }
  return {
    errorCode: 'continuation_execution_failed',
    errorSummary: errorSummary(error),
    retryable: true,
  };
}

function durableDeliveryClaimFromContinuation(
  claim: ContinuationDeliveryClaim,
): DurableRunDeliveryClaim {
  return {
    outboxId: claim.outboxId,
    runId: claim.jobId,
    workloadKind: 'async_task',
    kind: claim.kind,
    ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
    workerId: claim.workerId,
    route: claim.route,
    idempotencyKey: claim.idempotencyKey,
    payload: { schemaVersion: 1, claim } satisfies ContinuationDeliveryEnvelope,
    attemptCount: claim.attemptCount,
  };
}

function continuationDeliveryClaimFromDurable(
  claim: DurableRunDeliveryClaim,
): ContinuationDeliveryClaim {
  const payload = claim.payload;
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.claim)) {
    throw new Error('Invalid Continuation delivery envelope.');
  }
  return payload.claim as unknown as ContinuationDeliveryClaim;
}

function durableDeliveryResultFromContinuation(
  result: ContinuationDeliveryResult,
): DurableRunDeliveryResult {
  if (result.status === 'delivered') return { status: 'sent', messageId: result.messageId };
  if (result.status === 'delivery_unknown') {
    return {
      status: 'unknown',
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
    };
  }
  return result;
}

function continuationDeliveryResultFromDurable(
  result: DurableRunDeliveryResult,
): ContinuationDeliveryResult {
  if (result.status === 'sent') return { status: 'delivered', messageId: result.messageId };
  if (result.status === 'unknown') {
    return {
      status: 'delivery_unknown',
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
    };
  }
  return result;
}

function errorSummary(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}

function sanitizeText(value: string): string {
  const sanitized = value
    .replace(/\r/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  const redacted = redactContinuationText(sanitized);
  return redacted.length > 1_000 ? `${redacted.slice(0, 997)}...` : redacted;
}

function permissionAuditDetail(claim: ContinuationClaim): string {
  const permissions = claim.job.permissions;
  return [
    `profile=${permissions.profile}`,
    `network=${permissions.network}`,
    `external_side_effects=${permissions.externalSideEffects}`,
    `requested_paths=${permissions.filesystem.requestedPaths.join(',') || '-'}`,
  ].join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
