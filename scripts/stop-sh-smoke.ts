import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LARK_INSTANCE_LOCK_PATH } from '../src/instance-lock.js';

assert.equal(LARK_INSTANCE_LOCK_PATH, join(
  homedir(),
  '.codex',
  'channels',
  'lark',
  'runtime',
  'continuations',
  '.instance.lock',
));

const home = mkdtempSync(join(tmpdir(), 'lark-stop-smoke-home-'));
try {
  const result = spawnSync('bash', ['scripts/stop.sh'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`,
      HOME: home,
      LARK_APP_ID: 'stop_smoke_app_id',
      LARK_APP_SECRET: 'stop_smoke_secret',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '', 'scripts/stop.sh must not write to stdout');
  assert.match(result.stderr, /No codex-lark-plugin lock found/i);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('stop-sh smoke: PASS');
