import assert from 'node:assert/strict';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  partialOutcomeFromCheckpoint,
  retryDelayMs,
} from '../src/domain/continuation.js';
import type {
  ContinuationCheckpointV2,
  ContinuationDeliveryStatus,
} from '../src/domain/continuation.js';
import { evaluateContinuationProgress } from '../src/continuation/progress-policy.js';

const supersededDeliveryStatus: ContinuationDeliveryStatus = 'superseded';
assert.equal(supersededDeliveryStatus, 'superseded');

for (const status of ['completed', 'partial', 'blocked', 'failed', 'cancelled'] as const) {
  assert.equal(isContinuationTerminal(status), true, `${status} should be terminal`);
}
for (const status of ['queued', 'running', 'waiting_retry', 'recovering', 'waiting_user', 'cancel_requested'] as const) {
  assert.equal(isContinuationTerminal(status), false, `${status} should not be terminal`);
}

assert.equal(retryDelayMs(1, 0), 30_000);
assert.equal(retryDelayMs(2, 0), 120_000);
assert.equal(retryDelayMs(3, 0), 600_000);
assert.equal(retryDelayMs(4, 0), 600_000, 'backoff should remain capped');
assert.equal(retryDelayMs(3, 1), 720_000, 'maximum jitter should add 20 percent');
assert.equal(retryDelayMs(3, -1), 600_000, 'negative jitter input should clamp to zero');

function checkpoint(overrides: Partial<ContinuationCheckpointV2> = {}): ContinuationCheckpointV2 {
  return {
    schemaVersion: 2,
    summary: 'Working checkpoint',
    currentStepId: 'inspect',
    completedStepIds: [],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps: [{ id: 'implement', description: 'Implement the change.' }],
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: [],
    decisions: [],
    nextAction: { id: 'implement', description: 'Implement the change.' },
    stopReason: 'bounded step complete',
    ...overrides,
  };
}

const partialCheckpoint = checkpoint({
  summary: 'Validated the migration.',
  completedStepIds: ['update-schema'],
  remainingSteps: [{ id: 'production-validation', description: 'run production validation' }],
  constraints: ['production credentials are unavailable'],
  decisions: ['use a direct migration'],
  nextAction: { id: 'production-validation', description: 'run production validation' },
});
assert.deepEqual(partialOutcomeFromCheckpoint(partialCheckpoint), {
  outcome: 'partial',
  checkpoint: partialCheckpoint,
  completedWork: ['update-schema'],
  keyFindings: ['Validated the migration.'],
  unperformedWork: ['run production validation'],
  risks: ['production credentials are unavailable'],
  nextSteps: ['run production validation'],
  artifacts: [],
});

const firstProgress = evaluateContinuationProgress({
  previous: null,
  candidate: checkpoint({ completedStepIds: ['inspect'] }),
  requestedOutcome: 'continue',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 1, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(firstProgress.decision, 'continue');
assert.equal(firstProgress.noProgressCount, 0);
assert.equal(firstProgress.delta.stateChanged, true);
assert.deepEqual(firstProgress.delta.newCompletedStepIds, ['inspect']);

const proseOnlyProgress = evaluateContinuationProgress({
  previous: checkpoint({ completedStepIds: ['inspect'] }),
  candidate: checkpoint({
    summary: 'Different prose does not establish progress.',
    completedStepIds: ['inspect'],
    decisions: ['A new free-form decision.'],
    stopReason: 'Another prose-only stop reason.',
  }),
  requestedOutcome: 'continue',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 2, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(proseOnlyProgress.decision, 'continue');
assert.equal(proseOnlyProgress.noProgressCount, 1);
assert.equal(proseOnlyProgress.delta.stateChanged, false);

const propertyOrderStable = evaluateContinuationProgress({
  previous: checkpoint({
    completedStepIds: ['inspect'],
    evidence: [{
      id: 'evidence-1',
      requirementId: 'requirement-1',
      criterionIds: ['criterion-1'],
      reference: 'report',
    }],
  }),
  candidate: checkpoint({
    completedStepIds: ['inspect'],
    evidence: [{
      reference: 'report',
      criterionIds: ['criterion-1'],
      requirementId: 'requirement-1',
      id: 'evidence-1',
    }],
  }),
  requestedOutcome: 'continue',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 2, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(propertyOrderStable.delta.stateChanged, false);

const stalled = evaluateContinuationProgress({
  previous: checkpoint({ completedStepIds: ['inspect'] }),
  candidate: checkpoint({ completedStepIds: ['inspect'] }),
  requestedOutcome: 'continue',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 3, maxAttempts: 5, noProgressCount: 1, maxNoProgressAttempts: 2 },
});
assert.equal(stalled.decision, 'fail_stalled');
assert.equal(stalled.noProgressCount, 2);

const missingNextAction = evaluateContinuationProgress({
  previous: checkpoint({ completedStepIds: ['inspect'] }),
  candidate: checkpoint({ completedStepIds: ['inspect', 'implement'], nextAction: null }),
  requestedOutcome: 'continue',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 2, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(missingNextAction.decision, 'recover');

const completedEarly = evaluateContinuationProgress({
  previous: checkpoint({ completedStepIds: ['inspect'] }),
  candidate: checkpoint({
    completedStepIds: ['inspect', 'implement'],
    completedCriterionIds: ['verified'],
    completedDeliverableIds: ['result'],
    nextAction: null,
  }),
  requestedOutcome: 'completed',
  verification: { status: 'accepted', findings: [] },
  budget: { attemptOrdinal: 2, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(completedEarly.decision, 'complete');

const rejectedCompletion = evaluateContinuationProgress({
  previous: checkpoint({ completedStepIds: ['inspect'] }),
  candidate: checkpoint({ completedStepIds: ['inspect', 'implement'], nextAction: null }),
  requestedOutcome: 'completed',
  verification: { status: 'revision_required', findings: ['criterion verified is missing'] },
  budget: { attemptOrdinal: 2, maxAttempts: 5, noProgressCount: 0, maxNoProgressAttempts: 2 },
});
assert.equal(rejectedCompletion.decision, 'recover');

assert.deepEqual(CONTINUATION_LIMITS, {
  titleChars: 200,
  objectiveBytes: 16 * 1024,
  deliverableCount: 32,
  acceptanceCriteriaCount: 32,
  verificationRequirementCount: 32,
  inputFileCount: 32,
  inputBytesPerFile: 25 * 1024 * 1024,
  managedInputBytesPerJob: 100 * 1024 * 1024,
  contextSnapshotBytes: 64 * 1024,
  checkpointBytes: 64 * 1024,
  toolResultBytes: 64 * 1024,
  finalMessageBytes: 256 * 1024,
  artifactCount: 20,
  requestedPathCount: 32,
  managedArtifactBytesPerJob: 100 * 1024 * 1024,
  managedArtifactEntriesPerJob: 256,
  managedArtifactDirectoryDepth: 8,
  resumeInputChars: 4_096,
});

console.log('continuation domain smoke: PASS');
