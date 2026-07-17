import assert from 'node:assert/strict';
import {
  CONTINUATION_LIMITS,
  isContinuationTerminal,
  retryDelayMs,
} from '../src/domain/continuation.js';

for (const status of ['completed', 'failed', 'cancelled'] as const) {
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

assert.deepEqual(CONTINUATION_LIMITS, {
  titleChars: 200,
  objectiveBytes: 16 * 1024,
  acceptanceCriteriaCount: 32,
  contextSnapshotBytes: 64 * 1024,
  checkpointBytes: 64 * 1024,
  toolResultBytes: 64 * 1024,
  finalMessageBytes: 256 * 1024,
  artifactCount: 20,
  requestedPathCount: 32,
  managedArtifactBytesPerJob: 100 * 1024 * 1024,
});

console.log('continuation domain smoke: PASS');
