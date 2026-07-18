import assert from 'node:assert/strict';
import type { DurableRunFailure } from '../src/domain/durable-run.js';
import { decideRecovery } from '../src/continuation/recovery-policy.js';

function failure(overrides: Partial<DurableRunFailure> = {}): DurableRunFailure {
  return {
    category: 'invalid_invocation',
    retrySafety: 'safe',
    capabilityAvailable: true,
    operationRisk: 'external_side_effect',
    hints: ['Use the documented plural subcommand.'],
    failedStep: 'create-document',
    diagnostic: 'The invocation was rejected before execution.',
    fingerprint: 'invalid:create-document',
    ...overrides,
  };
}

const budget = {
  fingerprintAttempts: 0,
  totalAttempts: 0,
  maxFingerprintAttempts: 2,
  maxTotalAttempts: 4,
};

assert.deepEqual(decideRecovery(failure(), budget), {
  action: 'retry',
  status: 'recovering',
  delaySeconds: 0,
  reason: 'The failed invocation can be corrected without replaying an external side effect.',
});

assert.deepEqual(decideRecovery(failure({
  category: 'transient',
  operationRisk: 'read_only',
  hints: [],
  fingerprint: 'transient:fetch',
}), budget), {
  action: 'retry',
  status: 'recovering',
  delaySeconds: 30,
  reason: 'The transient failure is safe to retry within the recovery budget.',
});

for (const category of ['authentication_required', 'permission_required'] as const) {
  const decision = decideRecovery(failure({
    category,
    retrySafety: 'unsafe',
    hints: ['Complete the requested authorization, then resume.'],
    fingerprint: `${category}:publish`,
  }), budget);
  assert.equal(decision.action, 'wait_user');
  assert.equal(decision.status, 'waiting_user');
  assert.match(decision.prompt, /resume/i);
  assert.match(decision.prompt, /authorization/i);
}

assert.deepEqual(decideRecovery(failure({
  category: 'capability_unavailable',
  retrySafety: 'unsafe',
  capabilityAvailable: false,
  hints: ['Install the required executable.'],
  fingerprint: 'missing:cli',
}), budget), {
  action: 'block',
  status: 'blocked',
  reason: 'Install the required executable.',
});

assert.deepEqual(decideRecovery(failure({
  category: 'terminal',
  retrySafety: 'unsafe',
  hints: [],
  fingerprint: 'terminal:invariant',
}), budget), {
  action: 'fail',
  status: 'failed',
  reason: 'The failure is terminal and cannot be recovered automatically.',
});

const ambiguous = decideRecovery(failure({
  category: 'unknown',
  retrySafety: 'unknown',
  hints: [],
  diagnostic: 'The process ended after an opaque external operation.',
  fingerprint: 'unknown:publish',
}), budget);
assert.equal(ambiguous.action, 'wait_user');
assert.equal(ambiguous.status, 'waiting_user');
assert.match(ambiguous.prompt, /outcome is unknown/i);

for (const exhausted of [
  { ...budget, fingerprintAttempts: 2 },
  { ...budget, totalAttempts: 4 },
]) {
  assert.deepEqual(decideRecovery(failure(), exhausted), {
    action: 'fail',
    status: 'failed',
    reason: 'The bounded recovery budget was exhausted.',
  });
}

console.log('continuation recovery policy smoke: PASS');
