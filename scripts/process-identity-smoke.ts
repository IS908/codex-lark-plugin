import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getProcessStartedAt, isCleanupProcessOwnerActive, isRecordedProcessInstanceActive } from '../src/process-identity.js';

const observed = Date.UTC(2026, 10, 22, 12, 0, 0);
// The preceding writer estimated its own start later than the OS observation.
assert.equal(isCleanupProcessOwnerActive(true, observed + 1_040, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, null), true);
assert.equal(isCleanupProcessOwnerActive(true, null, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed + 1_000), false);
assert.equal(isCleanupProcessOwnerActive(false, observed, null), false);
// The plugin's takeover and signal policy is separate from destructive file cleanup.
assert.equal(isRecordedProcessInstanceActive(true, observed, null, 30_001, 30_000), false);

const moduleUrl = new URL('../src/process-identity.ts', import.meta.url).href;
for (let iteration = 0; iteration < 8; iteration++) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { currentProcessStartedAt } from ${JSON.stringify(moduleUrl)};\n` +
    'process.stdout.write(String(currentProcessStartedAt()) + "\\n"); setInterval(() => {}, 1000);'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'close');
  try {
    const firstOutput = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5_000) }).then(([data]) => String(data)),
      exited.then(() => { throw new Error('Process identity fixture exited before recording its start.'); }),
    ]);
    assert.ok(child.pid);
    const otherProcessStartedAt = await getProcessStartedAt(child.pid);
    assert.notEqual(otherProcessStartedAt, null);
    assert.equal(Number(firstOutput.trim()), otherProcessStartedAt, 'writer and observer use the same OS start time');
  } finally {
    child.kill();
    await exited;
  }
}
console.log('process identity smoke: PASS');
