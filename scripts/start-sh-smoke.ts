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
  assert.doesNotMatch(result.stderr, /run npm ci/);

  const lines = result.stderr.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 2, `expected launcher stderr output, got: ${JSON.stringify(result.stderr)}`);
  for (const line of lines) {
    assert.match(
      line,
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}\] /,
      `missing timestamp prefix: ${line}`,
    );
  }

  const staleCheckout = join(home, 'stale-checkout');
  mkdirSync(staleCheckout);
  writeFileSync(join(staleCheckout, 'package.json'), JSON.stringify({
    dependencies: { tar: '7.5.23' },
    scripts: { start: 'node index.mjs' },
  }));
  const startStaleCheckout = () => spawnSync('bash', [join(process.cwd(), 'scripts/start.sh'), '--dry-run'], {
    cwd: staleCheckout,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
  const entry = join(staleCheckout, 'index.mjs');
  writeFileSync(entry, "import 'tar';\n");
  const missingDependency = startStaleCheckout();
  assert.equal(missingDependency.status, 1, missingDependency.stderr);
  assert.equal(missingDependency.stdout, '');
  assert.match(missingDependency.stderr, /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package 'tar'/);
  assert.match(missingDependency.stderr, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}\] Local npm dependency missing\. From the plugin repository root, run npm ci and retry\.$/m);

  writeFileSync(entry, "import './missing-local-file.mjs';\n");
  const missingLocalFile = startStaleCheckout();
  assert.equal(missingLocalFile.status, 1, missingLocalFile.stderr);
  assert.equal(missingLocalFile.stdout, '');
  assert.match(missingLocalFile.stderr, /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
  assert.doesNotMatch(missingLocalFile.stderr, /run npm ci/);

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
