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
    codexExecCwd: appConfig.codexExecCwd,
    channelRuntime: appConfig.channelRuntime,
    codexSessionRetentionDays: appConfig.codexSessionRetentionDays,
    codexSessionRetentionScanIntervalHours: appConfig.codexSessionRetentionScanIntervalHours,
    codexSessionRetentionDryRun: appConfig.codexSessionRetentionDryRun,
    quotedCardUserFetchEnabled: appConfig.quotedCardUserFetchEnabled,
    quotedCardUserFetchCommand: appConfig.quotedCardUserFetchCommand,
    quotedCardUserFetchTimeoutMs: appConfig.quotedCardUserFetchTimeoutMs,
    quotedCardUserFetchMaxBytes: appConfig.quotedCardUserFetchMaxBytes,
    githubIssueActionEnabled: appConfig.githubIssueActionEnabled,
    githubIssueDefaultRepo: appConfig.githubIssueDefaultRepo,
    githubIssueAllowedRepos: appConfig.githubIssueAllowedRepos,
    githubIssueCommand: appConfig.githubIssueCommand,
    githubIssueTimeoutMs: appConfig.githubIssueTimeoutMs,
    githubIssueMaxOutputBytes: appConfig.githubIssueMaxOutputBytes
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
expectFail({ LARK_CHANNEL_RUNTIME: 'claude' }, /LARK_CHANNEL_RUNTIME.*legacy, sdk/i);
expectFail({ LARK_CODEX_SESSION_RETENTION_DAYS: '0' }, /LARK_CODEX_SESSION_RETENTION_DAYS.*positive/i);
expectFail({ LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS: '-1' }, /LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS.*non-negative/i);
expectFail({ LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: '0' }, /LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS.*positive/i);
expectFail({ LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: '0' }, /LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES.*positive/i);
expectFail({ LARK_GITHUB_ISSUE_TIMEOUT_MS: '0' }, /LARK_GITHUB_ISSUE_TIMEOUT_MS.*positive/i);
expectFail({ LARK_GITHUB_ISSUE_MAX_OUTPUT_BYTES: '0' }, /LARK_GITHUB_ISSUE_MAX_OUTPUT_BYTES.*positive/i);

const zeroAllowed = expectOk({
  LARK_MEMORY_DEDUP_WINDOW_MS: '0',
  LARK_INBOX_MAX_BYTES: '0',
});
assert.equal(zeroAllowed.memoryDedupWindowMs, 0);
assert.equal(zeroAllowed.inboxMaxBytes, 0);

const defaultPaths = expectOk({});
assert.match(defaultPaths.codexExecCwd, /codex-exec-workdir$/);
assert.doesNotMatch(defaultPaths.codexExecCwd, /codex-lark-plugin$/);
assert.equal(defaultPaths.channelRuntime, 'sdk');
assert.equal(defaultPaths.codexSessionRetentionDays, 14);
assert.equal(defaultPaths.codexSessionRetentionScanIntervalHours, 24);
assert.equal(defaultPaths.codexSessionRetentionDryRun, false);
assert.equal(defaultPaths.quotedCardUserFetchEnabled, true);
assert.equal(defaultPaths.quotedCardUserFetchCommand, 'lark-cli');
assert.equal(defaultPaths.quotedCardUserFetchTimeoutMs, 10_000);
assert.equal(defaultPaths.quotedCardUserFetchMaxBytes, 256 * 1024);
assert.equal(defaultPaths.githubIssueActionEnabled, false);
assert.equal(defaultPaths.githubIssueDefaultRepo, null);
assert.deepEqual(defaultPaths.githubIssueAllowedRepos, []);
assert.equal(defaultPaths.githubIssueCommand, 'gh');
assert.equal(defaultPaths.githubIssueTimeoutMs, 30_000);
assert.equal(defaultPaths.githubIssueMaxOutputBytes, 64 * 1024);

const retentionDryRun = expectOk({ LARK_CODEX_SESSION_RETENTION_DRY_RUN: 'true' });
assert.equal(retentionDryRun.codexSessionRetentionDryRun, true);

const userFetchDisabled = expectOk({ LARK_QUOTED_CARD_USER_FETCH_ENABLED: 'false' });
assert.equal(userFetchDisabled.quotedCardUserFetchEnabled, false);

const customUserFetch = expectOk({
  LARK_QUOTED_CARD_USER_FETCH_COMMAND: '/usr/local/bin/lark-cli',
  LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: '2500',
  LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: '1024',
});
assert.equal(customUserFetch.quotedCardUserFetchCommand, '/usr/local/bin/lark-cli');
assert.equal(customUserFetch.quotedCardUserFetchTimeoutMs, 2500);
assert.equal(customUserFetch.quotedCardUserFetchMaxBytes, 1024);

const customGithubIssueAction = expectOk({
  LARK_GITHUB_ISSUE_ACTION_ENABLED: 'true',
  LARK_GITHUB_DEFAULT_REPO: 'IS908/codex-lark-plugin',
  LARK_GITHUB_ALLOWED_REPOS: 'IS908/codex-lark-plugin,Other/repo',
  LARK_GITHUB_ISSUE_COMMAND: '/opt/homebrew/bin/gh',
  LARK_GITHUB_ISSUE_TIMEOUT_MS: '4000',
  LARK_GITHUB_ISSUE_MAX_OUTPUT_BYTES: '2048',
});
assert.equal(customGithubIssueAction.githubIssueActionEnabled, true);
assert.equal(customGithubIssueAction.githubIssueDefaultRepo, 'IS908/codex-lark-plugin');
assert.deepEqual(customGithubIssueAction.githubIssueAllowedRepos, ['IS908/codex-lark-plugin', 'Other/repo']);
assert.equal(customGithubIssueAction.githubIssueCommand, '/opt/homebrew/bin/gh');
assert.equal(customGithubIssueAction.githubIssueTimeoutMs, 4000);
assert.equal(customGithubIssueAction.githubIssueMaxOutputBytes, 2048);

const sdkRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'sdk' });
assert.equal(sdkRuntime.channelRuntime, 'sdk');

const legacyRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'legacy' });
assert.equal(legacyRuntime.channelRuntime, 'legacy');

console.log('config-validation smoke: PASS');
