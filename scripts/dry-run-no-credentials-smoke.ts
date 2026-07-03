import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'lark-dry-run-no-creds-'));

try {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.LARK_APP_ID;
  delete env.LARK_APP_SECRET;

  const result = spawnSync('npm', ['run', '--silent', 'start', '--', '--dry-run'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  assert.equal(result.status, 0, `dry-run without Lark credentials failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stderr, /\[dry-run\] All modules loaded successfully\./);
  assert.doesNotMatch(result.stderr, /Missing required env var: LARK_APP_(ID|SECRET)/);
  assert.equal(result.stdout, '', 'MCP dry-run should keep stdout empty');
  console.log('dry-run-no-credentials smoke: PASS');
} finally {
  rmSync(home, { recursive: true, force: true });
}
