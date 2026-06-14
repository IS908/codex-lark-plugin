import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const code = `
  const { appConfig } = await import('./src/config.js');
  console.log(JSON.stringify({
    cronScanInterval: appConfig.cronScanInterval,
    textChunkLimit: appConfig.textChunkLimit,
    minSearchScore: appConfig.minSearchScore,
    memoryDedupWindowMs: appConfig.memoryDedupWindowMs,
    inboxMaxBytes: appConfig.inboxMaxBytes,
    codexExecCwd: appConfig.codexExecCwd
  }));
`;

function runConfig(extraEnv: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'lark-config-smoke-home-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        LARK_APP_ID: 'config_test_app_id',
        LARK_APP_SECRET: 'config_test_secret',
        ...extraEnv,
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectOk(extraEnv: Record<string, string>): any {
  const result = runConfig(extraEnv);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function expectFail(extraEnv: Record<string, string>, pattern: RegExp): void {
  const result = runConfig(extraEnv);
  assert.notEqual(result.status, 0, 'expected config import to fail');
  assert.match(result.stderr + result.stdout, pattern);
}

expectFail({ LARK_CRON_SCAN_INTERVAL: '0' }, /LARK_CRON_SCAN_INTERVAL.*positive/i);
expectFail({ LARK_TEXT_CHUNK_LIMIT: '-1' }, /LARK_TEXT_CHUNK_LIMIT.*positive/i);
expectFail({ LARK_MIN_SEARCH_SCORE: 'not-a-number' }, /LARK_MIN_SEARCH_SCORE.*number/i);
expectFail({ LARK_MEMORY_DEDUP_WINDOW_MS: '-1' }, /LARK_MEMORY_DEDUP_WINDOW_MS.*non-negative/i);

const zeroAllowed = expectOk({
  LARK_MEMORY_DEDUP_WINDOW_MS: '0',
  LARK_INBOX_MAX_BYTES: '0',
});
assert.equal(zeroAllowed.memoryDedupWindowMs, 0);
assert.equal(zeroAllowed.inboxMaxBytes, 0);

const defaultPaths = expectOk({});
assert.match(defaultPaths.codexExecCwd, /codex-exec-workdir$/);
assert.doesNotMatch(defaultPaths.codexExecCwd, /codex-lark-plugin$/);

console.log('config-validation smoke: PASS');
