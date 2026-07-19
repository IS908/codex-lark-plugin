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
import { serializeDurableRunJson } from '../domain/durable-run.js';
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
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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

  async create(request: DurableRunCreateRequest): Promise<DurableRunCreateResult> {
    if (request.workloadKind !== this.kind) {
      throw new Error(`Async Task adapter cannot create workload ${request.workloadKind}.`);
    }
    const input = parseAsyncTaskInput(request.input, request.inputVersion);
    const state = parseAsyncTaskState(request.state, request.stateVersion);
    assertAsyncTaskRunEnvelopeIdentity(request, input.job, state.job);
    return this.options.repository.durableRuns.create(request);
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

  async recoverExpiredLeases(
    workloadKinds: readonly string[],
    now: string,
  ): Promise<DurableRunInterruptedAttempt[]> {
    if (!workloadKinds.includes(this.kind)) return [];
    const interrupted = await this.options.repository.recoverExpiredLeases(now);
    await this.options.repository.expireOverdue(now);
    return interrupted;
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
  ): Promise<DurableRunClaimMutationResult> {
    const deliveryThrew = this.thrownDeliveryResults.delete(result);
    const continuationClaim = continuationDeliveryClaimFromDurable(claim);
    const continuationResult = continuationDeliveryResultFromDurable(result);
    try {
      await this.options.repository.markDeliveryResult(
        continuationClaim,
        continuationResult,
        now,
      );
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
      return 'committed';
    } catch (error) {
      await this.auditDelivery(continuationClaim, 'error', 'delivery_state_persist_failed');
      throw error;
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

  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition {
    const state = parseAsyncTaskState(context.claim.run.state, context.claim.run.stateVersion);
    const job = continuationJobFromDurable(state.job, context.claim);
    if (job.status === 'cancel_requested') {
      return {
        status: 'cancelled',
        stateVersion: ASYNC_TASK_STATE_VERSION,
        state: { schemaVersion: 1, job } satisfies AsyncTaskKernelState,
      };
    }
    if (
      context.executionPhase === 'execution_started'
      && (context.operationRisk === 'external_side_effect' || context.operationRisk === 'unknown')
    ) {
      const failedStep = currentContinuationStepId(job);
      const failure: DurableRunFailure = {
        category: 'unknown',
        retrySafety: 'unknown',
        capabilityAvailable: true,
        operationRisk: context.operationRisk,
        hints: ['Confirm whether the interrupted operation completed before resuming.'],
        failedStep,
        diagnostic: 'The worker lease expired after opaque execution started, so the external outcome is unknown.',
        fingerprint: `lease-expired:${failedStep}`,
      };
      const result: ContinuationExecutionResult = {
        outcome: {
          outcome: 'waiting_user',
          checkpoint: job.checkpoint ?? checkpointFromInitialContext(job),
          failure,
          prompt: 'Confirm whether the interrupted operation completed, then resume with the observed result.',
          reason: failure.diagnostic,
        },
      };
      return {
        status: 'waiting_user',
        stateVersion: ASYNC_TASK_STATE_VERSION,
        state: {
          schemaVersion: 1,
          job,
          commit: { kind: 'step', result },
        } satisfies AsyncTaskKernelState,
        errorCode: 'lease_expired_unknown_outcome',
        errorSummary: failure.diagnostic,
        failure,
      };
    }
    const failure: ContinuationFailure = {
      errorCode: 'lease_expired',
      errorSummary: 'Worker lease expired.',
      retryable: true,
    };
    return {
      status: 'waiting_retry',
      stateVersion: ASYNC_TASK_STATE_VERSION,
      state: {
        schemaVersion: 1,
        job,
        commit: { kind: 'failure', failure },
      } satisfies AsyncTaskKernelState,
      nextRunAt: context.recoveredAt,
      errorCode: failure.errorCode,
      errorSummary: failure.errorSummary,
    };
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

export function asyncTaskDurableCreateRequestFromJob(
  job: ContinuationJob,
): DurableRunCreateRequest {
  return {
    runId: job.jobId,
    workloadKind: 'async_task',
    idempotencyKey: job.idempotencyKey,
    inputVersion: ASYNC_TASK_INPUT_VERSION,
    input: {
      schemaVersion: 1,
      job: omitUndefinedProperties(job) as ContinuationJob,
    } satisfies AsyncTaskKernelInput,
    stateVersion: ASYNC_TASK_STATE_VERSION,
    state: asyncTaskStateEnvelopeFromJob(job),
    route: job.route,
    actorOpenId: job.creatorOpenId,
    createdAt: job.createdAt,
    nextRunAt: job.nextRunAt,
    expiresAt: job.expiresAt,
    maxAttempts: job.maxAttempts,
  };
}

export function asyncTaskStateEnvelopeFromJob(job: ContinuationJob): AsyncTaskKernelState {
  return {
    schemaVersion: 1,
    job: omitUndefinedProperties(job) as ContinuationJob,
  };
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
    state: asyncTaskStateEnvelopeFromJob(job),
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
  if (claim.durableClaim) return claim.durableClaim;
  return {
    run: durableRunFromJob(claim.job),
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

function durableDeliveryClaimFromContinuation(
  claim: ContinuationDeliveryClaim,
): DurableRunDeliveryClaim {
  if (claim.durableClaim) return claim.durableClaim;
  return {
    outboxId: claim.outboxId,
    runId: claim.jobId,
    workloadKind: 'async_task',
    eventKey: claim.eventKey,
    kind: claim.kind,
    ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
    workerId: claim.workerId,
    route: claim.route,
    idempotencyKey: claim.idempotencyKey,
    payload: claim.payload,
    attemptCount: claim.attemptCount,
    leaseExpiresAt: '9999-12-31T23:59:59.999Z',
    ...(claim.firstAttemptAt ? { firstAttemptAt: claim.firstAttemptAt } : {}),
    ...(claim.lastAttemptAt ? { lastAttemptAt: claim.lastAttemptAt } : {}),
    ...(claim.lastErrorCode ? { lastErrorCode: claim.lastErrorCode } : {}),
    ...(claim.lastErrorSummary ? { lastErrorSummary: claim.lastErrorSummary } : {}),
  };
}

function omitUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry === undefined) throw new Error('Async Task arrays must not contain undefined values.');
      return omitUndefinedProperties(entry);
    });
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedProperties(entry)]),
  );
}

export function continuationClaimFromDurable(claim: DurableRunClaim): ContinuationClaim {
  const input = parseAsyncTaskInput(claim.run.input, claim.run.inputVersion);
  const state = parseAsyncTaskState(claim.run.state, claim.run.stateVersion);
  assertAsyncTaskEnvelopeIdentity(claim, input.job, state.job);
  const job = continuationJobFromDurable(state.job, claim);
  return {
    job,
    workerId: claim.workerId,
    claimedRowVersion: claim.claimedRowVersion,
    durableClaim: claim,
    attempt: {
      attemptId: claim.attempt.attemptId,
      jobId: claim.run.runId,
      ordinal: claim.attempt.ordinal,
      workerId: claim.attempt.workerId,
      ...(job.executionSessionId
        ? { executionSessionId: job.executionSessionId }
        : {}),
      startedAt: claim.attempt.claimedAt,
      heartbeatAt: claim.attempt.heartbeatAt,
    },
  };
}

function assertAsyncTaskEnvelopeIdentity(
  claim: DurableRunClaim,
  input: ContinuationJob,
  state: ContinuationJob,
): void {
  assertAsyncTaskRunEnvelopeIdentity(claim.run, input, state);
}

function assertAsyncTaskRunEnvelopeIdentity(
  run: Pick<DurableRunRecord, 'runId' | 'idempotencyKey' | 'actorOpenId' | 'route'>,
  input: ContinuationJob,
  state: ContinuationJob,
): void {
  const immutableInput = asyncTaskImmutableIdentity(input);
  const immutableState = asyncTaskImmutableIdentity(state);
  assertAsyncTaskJobMatchesRun(run, input);
  assertAsyncTaskJobMatchesRun(run, state);
  if (!isDeepStrictEqual(immutableInput, immutableState)) {
    throw new Error('Async Task input/state envelope identity mismatch.');
  }
}

function assertAsyncTaskJobMatchesRun(
  run: Pick<DurableRunRecord, 'runId' | 'idempotencyKey' | 'actorOpenId' | 'route'>,
  job: ContinuationJob,
): void {
  if (
    job.jobId !== run.runId
    || job.idempotencyKey !== run.idempotencyKey
    || job.creatorOpenId !== run.actorOpenId
    || !isDeepStrictEqual(job.route, run.route)
  ) {
    throw new Error('Async Task envelope identity does not match its durable Run.');
  }
}

export function validateAsyncTaskPersistedRun(run: DurableRunRecord): {
  errorCode: string;
  errorSummary: string;
  deliveries?: readonly import('../domain/durable-run.js').DurableRunDeliveryRequest[];
} | null {
  let trustedInput: ContinuationJob | null = null;
  try {
    const input = parseAsyncTaskInput(run.input, run.inputVersion);
    assertAsyncTaskJobMatchesRun(run, input.job);
    trustedInput = input.job;
    const state = parseAsyncTaskState(run.state, run.stateVersion);
    assertAsyncTaskRunEnvelopeIdentity(run, input.job, state.job);
    return null;
  } catch {
    return {
      errorCode: 'continuation_persisted_state_invalid',
      errorSummary: 'Stored task state failed integrity validation.',
      ...(trustedInput ? {
        deliveries: [{
          eventKey: 'terminal',
          kind: 'terminal',
          attemptId: null,
          idempotencyKey: `invalid-state:${run.workloadKind}:${run.runId}:terminal`,
          route: trustedInput.route,
          payload: `Task failed: ${run.runId}\nStored task state failed integrity validation.`,
        }],
      } : {}),
    };
  }
}

function asyncTaskImmutableIdentity(job: ContinuationJob): unknown {
  return {
    jobId: job.jobId,
    idempotencyKey: job.idempotencyKey,
    creatorOpenId: job.creatorOpenId,
    route: job.route,
    sourceMessageId: job.sourceMessageId,
    sourceThreadId: job.sourceThreadId,
    title: job.title,
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    contextSnapshot: job.contextSnapshot,
    sourceFacts: job.sourceFacts,
    taskContract: job.taskContract,
    requiredTools: job.requiredTools,
    workingDirectory: job.workingDirectory,
    permissions: job.permissions,
    model: job.model,
    parentSessionId: job.parentSessionId,
    maxAttempts: job.maxAttempts,
    maxRetries: job.maxRetries,
    timeoutSeconds: job.timeoutSeconds,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

function continuationJobFromDurable(
  persisted: ContinuationJob,
  claim: DurableRunClaim,
): ContinuationJob {
  return {
    ...persisted,
    jobId: claim.run.runId,
    idempotencyKey: claim.run.idempotencyKey,
    creatorOpenId: claim.run.actorOpenId,
    route: claim.run.route as ContinuationJob['route'],
    status: claim.run.status,
    rowVersion: claim.run.rowVersion,
    nextRunAt: claim.run.nextRunAt,
    expiresAt: claim.run.expiresAt,
    maxAttempts: claim.run.maxAttempts,
    attemptCount: claim.run.attemptCount,
    leaseOwner: claim.workerId,
    leaseExpiresAt: claim.attempt.leaseExpiresAt,
    heartbeatAt: claim.attempt.heartbeatAt,
  };
}

function currentContinuationStepId(job: ContinuationJob): string {
  return job.checkpoint?.nextAction?.id
    ?? job.checkpoint?.currentStepId
    ?? 'initial-step';
}

function checkpointFromInitialContext(job: ContinuationJob): NonNullable<ContinuationJob['checkpoint']> {
  const completedStepIds = job.contextSnapshot.completedSteps.map((description, index) => (
    `legacy-completed-${index + 1}-${stableStepSuffix(description)}`
  ));
  const remainingSteps = job.contextSnapshot.remainingSteps.map((description, index) => ({
    id: `legacy-remaining-${index + 1}-${stableStepSuffix(description)}`,
    description,
  }));
  const currentStepId = remainingSteps[0]?.id ?? completedStepIds.at(-1) ?? 'initial-step';
  return {
    schemaVersion: 2,
    summary: job.contextSnapshot.summary,
    currentStepId,
    completedStepIds,
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps,
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: [...job.contextSnapshot.constraints],
    decisions: [...job.contextSnapshot.decisions],
    nextAction: remainingSteps[0] ?? null,
    stopReason: 'Recovered after an interrupted Attempt.',
  };
}

function stableStepSuffix(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseTrustedAsyncTaskInputJob(
  value: unknown,
  version: number,
): ContinuationJob {
  return parseAsyncTaskInput(value, version).job;
}

function parseAsyncTaskInput(value: unknown, version: number): AsyncTaskKernelInput {
  const snapshot = snapshotAsyncTaskEnvelope(value, 'input');
  if (version !== ASYNC_TASK_INPUT_VERSION || !isRecord(snapshot) || snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported Async Task kernel input version: ${version}`);
  }
  return { schemaVersion: 1, job: parseContinuationJob(snapshot.job) };
}

function parseAsyncTaskState(value: unknown, version: number): AsyncTaskKernelState {
  const snapshot = snapshotAsyncTaskEnvelope(value, 'state');
  if (version !== ASYNC_TASK_STATE_VERSION || !isRecord(snapshot) || snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported Async Task kernel state version: ${version}`);
  }
  const state: AsyncTaskKernelState = {
    schemaVersion: 1,
    job: parseContinuationJob(snapshot.job),
  };
  if (snapshot.commit !== undefined) state.commit = parseAsyncTaskCommit(snapshot.commit);
  return state;
}

function parseContinuationJob(value: unknown): ContinuationJob {
  if (!isValidContinuationJob(value)) {
    throw new Error('Invalid Continuation Job in Async Task kernel envelope.');
  }
  return value;
}

function snapshotAsyncTaskEnvelope(value: unknown, kind: 'input' | 'state'): unknown {
  const serialized = serializeDurableRunJson(value, `Async Task ${kind} envelope`);
  return JSON.parse(serialized) as unknown;
}

const CONTINUATION_STATUSES = new Set([
  'queued', 'running', 'waiting_retry', 'recovering', 'waiting_user',
  'cancel_requested', 'completed', 'partial', 'blocked', 'failed', 'cancelled',
]);

function isValidContinuationJob(value: unknown): value is ContinuationJob {
  if (!isRecord(value)) return false;
  if (
    !requiredString(value.jobId)
    || !requiredString(value.idempotencyKey)
    || !requiredString(value.creatorOpenId)
    || !isDeliveryRoute(value.route)
    || !requiredString(value.sourceMessageId)
    || !isOptionalString(value.sourceThreadId)
    || typeof value.title !== 'string'
    || typeof value.objective !== 'string'
    || !isStringArray(value.acceptanceCriteria)
    || !isCheckpoint(value.contextSnapshot)
    || !isSourceFacts(value.sourceFacts)
    || !isTaskContract(value.taskContract)
    || !isStringArray(value.requiredTools)
    || typeof value.workingDirectory !== 'string'
    || !isPermissionEnvelope(value.permissions)
    || !isOptionalString(value.model)
    || !isOptionalString(value.parentSessionId)
    || !positiveInteger(value.maxAttempts)
    || !nonNegativeInteger(value.maxRetries)
    || !positiveInteger(value.timeoutSeconds)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.expiresAt)
    || !positiveInteger(value.rowVersion)
    || typeof value.status !== 'string'
    || !CONTINUATION_STATUSES.has(value.status)
    || !isOptionalString(value.executionSessionId)
    || !isOptionalCheckpointV2(value.checkpoint)
    || !isOptionalAttemptDelta(value.lastAttemptDelta)
    || !isOptionalVerification(value.lastVerification)
    || !isOptionalRecoveryState(value.recovery)
    || !nonNegativeInteger(value.recoveryTotalCount)
    || !isCountRecord(value.recoveryFingerprintCounts)
    || !isOptionalInterrupt(value.currentInterrupt)
    || !nonNegativeInteger(value.noProgressCount)
    || (value.attemptCount !== undefined && !nonNegativeInteger(value.attemptCount))
    || !nonNegativeInteger(value.stepCount)
    || !nonNegativeInteger(value.failureCount)
    || !validTimestamp(value.nextRunAt)
    || !isOptionalString(value.leaseOwner)
    || !isOptionalTimestamp(value.leaseExpiresAt)
    || !isOptionalTimestamp(value.heartbeatAt)
    || !isOptionalString(value.resultSummary)
    || !isStringArray(value.resultArtifacts)
    || !isOptionalString(value.errorCode)
    || !isOptionalString(value.errorSummary)
    || !isOptionalTimestamp(value.startedAt)
    || !validTimestamp(value.updatedAt)
    || !isOptionalTimestamp(value.completedAt)
    || !isOptionalTimestamp(value.deletedAt)
    || typeof value.retained !== 'boolean'
    || !isOptionalDeliveryStatus(value.deliveryStatus)
    || !isOptionalDeliveryEvents(value.deliveryEvents)
  ) return false;
  const sourceFacts = value.sourceFacts as Record<string, unknown>;
  const taskContract = value.taskContract as Record<string, unknown>;
  return sourceFacts.sourceMessageId === value.sourceMessageId
    && taskContract.title === value.title
    && taskContract.objective === value.objective;
}

function parseAsyncTaskCommit(value: unknown): AsyncTaskCommit {
  if (!isRecord(value)) throw new Error('Invalid Async Task kernel commit.');
  if (value.kind === 'step' && isContinuationExecutionResult(value.result)) {
    return { kind: 'step', result: value.result };
  }
  if (value.kind === 'failure' && isContinuationFailure(value.failure)) {
    return { kind: 'failure', failure: value.failure };
  }
  throw new Error('Invalid Async Task kernel commit.');
}

function isContinuationExecutionResult(value: unknown): value is ContinuationExecutionResult {
  return isRecord(value)
    && (value.executionSessionId === undefined
      || value.executionSessionId === null
      || typeof value.executionSessionId === 'string')
    && isContinuationStepOutcome(value.outcome);
}

function isContinuationStepOutcome(value: unknown): boolean {
  if (!isRecord(value) || !isCheckpointV2(value.checkpoint)) return false;
  switch (value.outcome) {
    case 'continue':
      return value.resumeAfterSeconds === undefined || nonNegativeInteger(value.resumeAfterSeconds);
    case 'completed':
      return typeof value.finalMessage === 'string'
        && isOptionalString(value.resultSummary)
        && isStringArray(value.artifacts);
    case 'partial':
      return isStringArray(value.completedWork)
        && isStringArray(value.keyFindings)
        && isStringArray(value.unperformedWork)
        && isStringArray(value.risks)
        && isStringArray(value.nextSteps)
        && isStringArray(value.artifacts);
    case 'recovering':
      return isDurableFailure(value.failure)
        && nonNegativeInteger(value.delaySeconds)
        && typeof value.reason === 'string';
    case 'waiting_user':
      return isDurableFailure(value.failure)
        && typeof value.prompt === 'string'
        && typeof value.reason === 'string';
    case 'failed':
      return typeof value.errorCode === 'string'
        && typeof value.errorSummary === 'string'
        && typeof value.retryable === 'boolean'
        && isStringArray(value.completedWork)
        && isStringArray(value.unperformedWork)
        && isOptionalDurableFailure(value.recoveryFailure);
    case 'blocked':
      return typeof value.errorCode === 'string'
        && typeof value.errorSummary === 'string'
        && typeof value.requiredCapability === 'string'
        && isStringArray(value.completedWork)
        && isStringArray(value.unperformedWork)
        && isOptionalDurableFailure(value.recoveryFailure);
    default:
      return false;
  }
}

function isContinuationFailure(value: unknown): value is ContinuationFailure {
  return isRecord(value)
    && typeof value.errorCode === 'string'
    && typeof value.errorSummary === 'string'
    && typeof value.retryable === 'boolean';
}

function isDeliveryRoute(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'message_thread') {
    return requiredString(value.conversationId)
      && requiredString(value.sourceMessageId)
      && isOptionalString(value.threadId);
  }
  return value.kind === 'comment_thread'
    && requiredString(value.documentToken)
    && requiredString(value.commentId)
    && requiredString(value.fileType);
}

function isPermissionEnvelope(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.filesystem) || !isRecord(value.approval)) return false;
  return ['bounded', 'trusted_personal_workspace'].includes(String(value.profile))
    && typeof value.filesystem.root === 'string'
    && ['read-only', 'workspace-write'].includes(String(value.filesystem.mode))
    && isStringArray(value.filesystem.requestedPaths)
    && isStringArray(value.hostTools)
    && ['none', 'enabled'].includes(String(value.network))
    && ['denied', 'allowed'].includes(String(value.externalSideEffects))
    && ['never', 'interactive'].includes(String(value.approval.mode));
}

function isCheckpoint(value: unknown): boolean {
  return isRecord(value)
    && typeof value.summary === 'string'
    && isStringArray(value.completedSteps)
    && isStringArray(value.remainingSteps)
    && isStringArray(value.constraints)
    && isStringArray(value.decisions)
    && isStringArray(value.references);
}

function isSourceFacts(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasOnlyKeys(value, [
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
  ])) return false;
  if (!Array.isArray(value.inputs) || !value.inputs.every((input) => (
    isRecord(input)
    && requiredString(input.id)
    && ['message_image', 'message_attachment'].includes(String(input.kind))
    && requiredString(input.fileName)
    && requiredString(input.relativePath)
    && requiredString(input.sha256)
    && nonNegativeInteger(input.sizeBytes)
  ))) return false;
  return ['captured', 'legacy_unavailable'].includes(String(value.provenance))
    && isNullableString(value.originalUserText)
    && isNullableString(value.sourceContextText)
    && isNullableString(value.quotedMessageText)
    && typeof value.creatorOpenId === 'string'
    && typeof value.chatId === 'string'
    && typeof value.chatType === 'string'
    && isDeliveryRoute(value.route)
    && typeof value.sourceMessageId === 'string'
    && isOptionalString(value.sourceThreadId)
    && isNullableString(value.sourceMessageType)
    && isNullableString(value.sourceTimestamp)
    && typeof value.workingDirectory === 'string'
    && isNullableString(value.model)
    && isPermissionEnvelope(value.permissions);
}

function isTaskContract(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isCheckpoint(value.initialContext)) return false;
  const deliverables = Array.isArray(value.deliverables) && value.deliverables.every((entry) => (
    isRecord(entry)
    && requiredString(entry.id)
    && typeof entry.description === 'string'
    && typeof entry.required === 'boolean'
  ));
  const criteria = Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.every((entry) => (
    isRecord(entry)
    && requiredString(entry.id)
    && typeof entry.description === 'string'
    && isStringArray(entry.deliverableIds)
  ));
  const requirements = Array.isArray(value.verificationRequirements)
    && value.verificationRequirements.every((entry) => (
      isRecord(entry)
      && requiredString(entry.id)
      && typeof entry.description === 'string'
      && ['artifact_exists', 'artifact_sha256', 'evidence_reference'].includes(String(entry.kind))
    ));
  return typeof value.title === 'string'
    && typeof value.objective === 'string'
    && deliverables
    && criteria
    && requirements;
}

function isOptionalCheckpointV2(value: unknown): boolean {
  if (value === undefined) return true;
  return isCheckpointV2(value);
}

function isCheckpointV2(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  return typeof value.summary === 'string'
    && requiredString(value.currentStepId)
    && isStringArray(value.completedStepIds)
    && isStringArray(value.completedCriterionIds)
    && isStringArray(value.completedDeliverableIds)
    && isStepArray(value.remainingSteps)
    && isArtifactArray(value.artifacts)
    && isEvidenceArray(value.evidence)
    && isSideEffectArray(value.sideEffects)
    && isStringArray(value.constraints)
    && isStringArray(value.decisions)
    && (value.nextAction === null || isStep(value.nextAction))
    && typeof value.stopReason === 'string';
}

function isStepArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isStep);
}

function isStep(value: unknown): boolean {
  return isRecord(value) && requiredString(value.id) && typeof value.description === 'string';
}

function isArtifactArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && requiredString(entry.id)
    && requiredString(entry.deliverableId)
    && requiredString(entry.path)
    && requiredString(entry.sha256)
  ));
}

function isEvidenceArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && requiredString(entry.id)
    && requiredString(entry.requirementId)
    && isStringArray(entry.criterionIds)
    && isOptionalString(entry.artifactId)
    && isOptionalString(entry.reference)
  ));
}

function isSideEffectArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && requiredString(entry.id)
    && typeof entry.description === 'string'
    && requiredString(entry.idempotencyKey)
  ));
}

function isOptionalAttemptDelta(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value)
    && value.schemaVersion === 1
    && requiredString(value.stepId)
    && requiredString(value.checkpointHash)
    && requiredString(value.materialHash)
    && typeof value.stateChanged === 'boolean'
    && isStringArray(value.newCompletedStepIds)
    && isStringArray(value.newCompletedCriterionIds)
    && isStringArray(value.newCompletedDeliverableIds)
    && isStringArray(value.newArtifactIds)
    && isStringArray(value.newEvidenceIds)
    && isStringArray(value.newSideEffectIds)
    && isOptionalString(value.nextActionStepId);
}

function isOptionalVerification(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && ['accepted', 'revision_required'].includes(String(value.status))
    && isStringArray(value.findings)
  );
}

function isOptionalRecoveryState(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isDurableFailure(value.failure)) return false;
  return nonNegativeInteger(value.fingerprintAttempts)
    && nonNegativeInteger(value.totalAttempts)
    && ['retry', 'wait_user', 'block', 'fail'].includes(String(value.lastDecision))
    && isOptionalString(value.userInput);
}

function isDurableFailure(value: unknown): boolean {
  return isRecord(value)
    && ['invalid_invocation', 'transient', 'authentication_required', 'permission_required',
      'capability_unavailable', 'terminal', 'unknown'].includes(String(value.category))
    && ['safe', 'unsafe', 'unknown'].includes(String(value.retrySafety))
    && typeof value.capabilityAvailable === 'boolean'
    && ['pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown']
      .includes(String(value.operationRisk))
    && isStringArray(value.hints)
    && requiredString(value.failedStep)
    && typeof value.diagnostic === 'string'
    && requiredString(value.fingerprint);
}

function isOptionalDurableFailure(value: unknown): boolean {
  return value === undefined || isDurableFailure(value);
}

function isOptionalInterrupt(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value)
    && requiredString(value.interruptId)
    && requiredString(value.jobId)
    && requiredString(value.attemptId)
    && ['pending', 'delivered', 'resolved'].includes(String(value.status))
    && typeof value.prompt === 'string'
    && isOptionalString(value.deliveredMessageId)
    && isOptionalString(value.responseText)
    && validTimestamp(value.createdAt)
    && isOptionalTimestamp(value.deliveredAt)
    && isOptionalTimestamp(value.resolvedAt);
}

function isOptionalDeliveryStatus(value: unknown): boolean {
  return value === undefined || [
    'pending', 'sending', 'delivered', 'delivery_unknown', 'failed', 'superseded',
  ].includes(String(value));
}

function isOptionalDeliveryEvents(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => (
    isRecord(entry)
    && requiredString(entry.eventKey)
    && ['progress', 'interrupt', 'terminal'].includes(String(entry.kind))
    && isOptionalString(entry.attemptId)
    && isOptionalDeliveryStatus(entry.status)
    && nonNegativeInteger(entry.attemptCount)
    && isOptionalTimestamp(entry.firstAttemptAt)
    && isOptionalTimestamp(entry.lastAttemptAt)
    && isOptionalString(entry.lastErrorCode)
    && isOptionalString(entry.lastErrorSummary)
    && validTimestamp(entry.createdAt)
    && validTimestamp(entry.updatedAt)
  )));
}

function isCountRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(nonNegativeInteger);
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || validTimestamp(value);
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

function durableFailureForContinuationFailure(
  claim: ContinuationClaim,
  failure: ContinuationFailure,
): DurableRunFailure {
  const diagnostic = sanitizeText(failure.errorSummary);
  const failedStep = currentContinuationStepId(claim.job);
  return {
    category: failure.retryable ? 'transient' : 'terminal',
    retrySafety: failure.retryable ? 'safe' : 'unsafe',
    capabilityAvailable: true,
    operationRisk: 'unknown',
    hints: [],
    failedStep,
    diagnostic,
    fingerprint: createHash('sha256')
      .update(`${failure.errorCode}\0${failedStep}\0${diagnostic}`)
      .digest('hex')
      .slice(0, 32),
  };
}

export function continuationDeliveryClaimFromDurable(
  claim: DurableRunDeliveryClaim,
): ContinuationDeliveryClaim {
  if (claim.workloadKind !== 'async_task' || typeof claim.payload !== 'string') {
    throw new Error('Invalid Continuation delivery envelope.');
  }
  if (
    (claim.kind === 'terminal' && claim.eventKey !== 'terminal')
    || (claim.kind === 'progress' && claim.eventKey !== `progress:${claim.attemptId ?? ''}`)
    || (claim.kind === 'interrupt' && !claim.eventKey.startsWith('interrupt:'))
    || !['terminal', 'progress', 'interrupt'].includes(claim.kind)
  ) {
    throw new Error('Invalid Continuation delivery identity.');
  }
  return {
    outboxId: claim.outboxId,
    jobId: claim.runId,
    eventKey: claim.eventKey,
    kind: claim.kind as ContinuationDeliveryClaim['kind'],
    ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
    ...(claim.kind === 'interrupt'
      ? { interruptId: claim.eventKey.slice('interrupt:'.length) }
      : {}),
    workerId: claim.workerId,
    route: claim.route as ContinuationDeliveryClaim['route'],
    idempotencyKey: claim.idempotencyKey,
    payload: claim.payload,
    status: 'sending',
    attemptCount: claim.attemptCount,
    ...(claim.firstAttemptAt ? { firstAttemptAt: claim.firstAttemptAt } : {}),
    ...(claim.lastAttemptAt ? { lastAttemptAt: claim.lastAttemptAt } : {}),
    ...(claim.lastErrorCode ? { lastErrorCode: claim.lastErrorCode } : {}),
    ...(claim.lastErrorSummary ? { lastErrorSummary: claim.lastErrorSummary } : {}),
    durableClaim: claim,
  };
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
  if (result.status === 'retry' || result.status === 'failed') {
    return {
      status: result.status,
      errorCode: result.errorCode,
      errorSummary: result.errorSummary,
    };
  }
  throw new Error('A superseded delivery is not a workload delivery result.');
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
