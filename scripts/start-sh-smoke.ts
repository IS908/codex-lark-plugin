import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'lark-start-sh-home-'));

try {
  const result = spawnSync('bash', ['scripts/start.sh', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      LARK_APP_ID: 'start_smoke_app_id',
      LARK_APP_SECRET: 'start_smoke_secret',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '', 'scripts/start.sh must not write to stdout');

  const lines = result.stderr.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2, `expected launcher stderr output, got: ${JSON.stringify(result.stderr)}`);
  for (const line of lines) {
    assert.match(
      line,
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}\] /,
      `missing timestamp prefix: ${line}`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('start-sh smoke: PASS');
