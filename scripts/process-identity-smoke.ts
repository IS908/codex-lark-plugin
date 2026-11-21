import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getLinuxProcessBirthToken, getProcessStartedAt, isCleanupProcessOwnerActive, isRecordedProcessInstanceActive } from '../src/process-identity.js';

const observed = Date.UTC(2026, 10, 22, 12, 0, 0);
// The preceding writer estimated its own start later than the OS observation.
assert.equal(isCleanupProcessOwnerActive(true, observed + 1_040, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, null), true);
assert.equal(isCleanupProcessOwnerActive(true, null, observed), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed + 1_000), false);
assert.equal(isCleanupProcessOwnerActive(false, observed, null), false);
const sameLinuxBirth = { recorded: 'a:42', actual: 'a:42' };
assert.equal(isCleanupProcessOwnerActive(true, observed, observed + 60_000, sameLinuxBirth), true);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed - 60_000, { ...sameLinuxBirth, actual: 'a:43' }), false);
assert.equal(isCleanupProcessOwnerActive(true, observed, observed + 60_000, { ...sameLinuxBirth, recorded: null }), true);
// The plugin's takeover and signal policy is separate from destructive file cleanup.
assert.equal(isRecordedProcessInstanceActive(true, observed, null, 30_001, 30_000), false);

const moduleUrl = new URL('../src/process-identity.ts', import.meta.url).href;
for (let iteration = 0; iteration < 8; iteration++) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { currentProcessStartedAt, getLinuxProcessBirthToken } from ${JSON.stringify(moduleUrl)};\n` +
    'process.stdout.write(JSON.stringify([currentProcessStartedAt(), getLinuxProcessBirthToken(process.pid)]) + "\\n"); setInterval(() => {}, 1000);'],
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
    const [recorded, linuxBirth] = JSON.parse(firstOutput);
    assert.equal(recorded, otherProcessStartedAt, 'writer and observer use the same OS start time');
    if (process.platform === 'linux') assert.ok(linuxBirth && linuxBirth === getLinuxProcessBirthToken(child.pid));
  } finally {
    child.kill();
    await exited;
  }
}
console.log('process identity smoke: PASS');
