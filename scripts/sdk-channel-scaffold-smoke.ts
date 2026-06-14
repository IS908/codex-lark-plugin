import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runStart(extraEnv: Record<string, string>, args: string[] = ['--dry-run']) {
  const home = mkdtempSync(join(tmpdir(), 'lark-sdk-scaffold-home-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        LARK_APP_ID: 'cli_test_app_id',
        LARK_APP_SECRET: 'test_app_secret',
        ...extraEnv,
      },
      timeout: 10_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const sdkDryRun = runStart({});
assert.equal(sdkDryRun.status, 0, sdkDryRun.stderr + sdkDryRun.stdout);
assert.equal(sdkDryRun.stdout, '');
assert.match(sdkDryRun.stderr, /\[dry-run\] Channel runtime: sdk/);
assert.match(sdkDryRun.stderr, /\[sdk-channel\] SDK scaffold validated/);

const legacyDryRun = runStart({ LARK_CHANNEL_RUNTIME: 'legacy' });
assert.equal(legacyDryRun.status, 0, legacyDryRun.stderr + legacyDryRun.stdout);
assert.equal(legacyDryRun.stdout, '');
assert.match(legacyDryRun.stderr, /\[dry-run\] Channel runtime: legacy/);

console.log('sdk-channel-scaffold smoke: PASS');
