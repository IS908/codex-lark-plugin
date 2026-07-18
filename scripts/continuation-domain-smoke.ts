import assert from 'node:assert/strict';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  partialOutcomeFromCheckpoint,
  retryDelayMs,
} from '../src/domain/continuation.js';
import type { ContinuationDeliveryStatus } from '../src/domain/continuation.js';

const supersededDeliveryStatus: ContinuationDeliveryStatus = 'superseded';
assert.equal(supersededDeliveryStatus, 'superseded');

for (const status of ['completed', 'partial', 'blocked', 'failed', 'cancelled'] as const) {
  assert.equal(isContinuationTerminal(status), true, `${status} should be terminal`);
}
for (const status of ['queued', 'running', 'waiting_retry', 'cancel_requested'] as const) {
  assert.equal(isContinuationTerminal(status), false, `${status} should not be terminal`);
}

assert.equal(retryDelayMs(1, 0), 30_000);
assert.equal(retryDelayMs(2, 0), 120_000);
assert.equal(retryDelayMs(3, 0), 600_000);
assert.equal(retryDelayMs(4, 0), 600_000, 'backoff should remain capped');
assert.equal(retryDelayMs(3, 1), 720_000, 'maximum jitter should add 20 percent');
assert.equal(retryDelayMs(3, -1), 600_000, 'negative jitter input should clamp to zero');

assert.deepEqual(partialOutcomeFromCheckpoint({
  summary: 'Validated the migration.',
  completedSteps: ['updated the schema'],
  remainingSteps: ['run production validation'],
  constraints: ['production credentials are unavailable'],
  decisions: ['use a direct migration'],
  references: ['report.md'],
}, 'run production validation'), {
  outcome: 'partial',
  completedWork: ['updated the schema'],
  keyFindings: ['Validated the migration.'],
  unperformedWork: ['run production validation'],
  risks: ['production credentials are unavailable'],
  nextSteps: ['run production validation'],
  artifacts: [],
});

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
});

console.log('continuation domain smoke: PASS');
