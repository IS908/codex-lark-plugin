import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  const fakeBin = join(home, 'fake-bin');
  const fakeNode = join(fakeBin, 'node');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeNode,
    '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo v22.20.0; exit 0; fi\nexit 1\n',
    'utf-8',
  );
  chmodSync(fakeNode, 0o755);

  const unsupported = spawnSync('bash', ['scripts/start.sh', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      LARK_APP_ID: 'start_smoke_app_id',
      LARK_APP_SECRET: 'start_smoke_secret',
    },
  });
  assert.equal(unsupported.status, 1, unsupported.stderr || unsupported.stdout);
  assert.equal(unsupported.stdout, '');
  assert.match(unsupported.stderr, /Node\.js >=24\.15\.0 is required; current version is v22\.20\.0/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('start-sh smoke: PASS');
