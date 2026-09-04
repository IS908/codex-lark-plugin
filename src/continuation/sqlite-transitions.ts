import { createHash } from 'node:crypto';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  partialOutcomeFromCheckpoint,
  retryDelayMs,
  type ContinuationClaim,
  type ContinuationAttemptDelta,
  type ContinuationCheckpointV2,
  type ContinuationExecutionResult,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationRecoveryState,
  type ContinuationStatus,
  type ContinuationStepOutcome,
  type ContinuationVerificationVerdict,
} from '../domain/continuation.js';
import { createAttemptDelta, evaluateContinuationProgress } from './progress-policy.js';
import type {
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunTransition,
} from '../domain/durable-run.js';
import { asyncTaskStateEnvelopeFromJob } from './async-task-kernel-adapter.js';
import { redactContinuationText } from './redaction.js';
import {
  MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT,
  MAX_TOTAL_RECOVERY_ATTEMPTS,
  addMilliseconds,
  assertJsonBytes,
  attemptBudgetTerminalReason,
  boundedDurableRunFailure,
  boundedFailure,
  checkpointFromInitialContext,
  continuationStepId,
  deliveryIdempotencyKey,
  hasOpaqueExecutionEffects,
  makeId,
  partialResultSummary,
  renderBlockedPayload,
  renderFailedPayload,
  renderInterruptPayload,
  renderPartialPayload,
  renderProgressPayload,
  truncateCharacters,
  validateFinalResult,
  validatePartialResult,
} from './sqlite-codec.js';

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

export {
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
};
