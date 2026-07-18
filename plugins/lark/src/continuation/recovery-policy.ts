import type {
  DurableRunFailure,
  DurableRunRecoveryBudget,
  DurableRunRecoveryDecision,
} from '../domain/durable-run.js';

export function decideRecovery(
  failure: DurableRunFailure,
  budget: DurableRunRecoveryBudget,
): DurableRunRecoveryDecision {
  if (
    budget.fingerprintAttempts >= budget.maxFingerprintAttempts
    || budget.totalAttempts >= budget.maxTotalAttempts
  ) {
    return {
      action: 'fail',
      status: 'failed',
      reason: 'The bounded recovery budget was exhausted.',
    };
  }

  if (failure.category === 'capability_unavailable' || !failure.capabilityAvailable) {
    return {
      action: 'block',
      status: 'blocked',
      reason: failure.hints[0] || 'A required capability is unavailable.',
    };
  }
  if (failure.category === 'terminal') {
    return {
      action: 'fail',
      status: 'failed',
      reason: 'The failure is terminal and cannot be recovered automatically.',
    };
  }
  if (
    failure.category === 'authentication_required'
    || failure.category === 'permission_required'
  ) {
    return waitForUser(
      failure,
      failure.hints[0] || 'Complete the required authorization, then resume the task.',
    );
  }
  if (failure.retrySafety !== 'safe') {
    return waitForUser(
      failure,
      'The prior operation outcome is unknown. Confirm the result or provide corrected input, then resume the task.',
    );
  }
  if (failure.category === 'invalid_invocation') {
    return {
      action: 'retry',
      status: 'recovering',
      delaySeconds: 0,
      reason: 'The failed invocation can be corrected without replaying an external side effect.',
    };
  }
  if (failure.category === 'transient' || failure.category === 'unknown') {
    return {
      action: 'retry',
      status: 'recovering',
      delaySeconds: failure.category === 'transient' ? 30 : 0,
      reason: failure.category === 'transient'
        ? 'The transient failure is safe to retry within the recovery budget.'
        : 'The failure is explicitly safe to retry within the recovery budget.',
    };
  }
  return {
    action: 'fail',
    status: 'failed',
    reason: 'The failure cannot be recovered automatically.',
  };
}

function waitForUser(
  failure: DurableRunFailure,
  prompt: string,
): Extract<DurableRunRecoveryDecision, { action: 'wait_user' }> {
  return {
    action: 'wait_user',
    status: 'waiting_user',
    prompt,
    reason: failure.diagnostic,
  };
}
