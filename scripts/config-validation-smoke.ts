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
    queueHandlerTimeoutMs: appConfig.queueHandlerTimeoutMs,
    codexExecTimeoutMs: appConfig.codexExecTimeoutMs,
    replyObligationTimeoutMs: appConfig.replyObligationTimeoutMs,
    codexExecCwd: appConfig.codexExecCwd,
    channelRuntime: appConfig.channelRuntime,
    codexSessionRetentionDays: appConfig.codexSessionRetentionDays,
    codexSessionRetentionScanIntervalHours: appConfig.codexSessionRetentionScanIntervalHours,
    codexSessionRetentionDryRun: appConfig.codexSessionRetentionDryRun,
    quotedCardUserFetchEnabled: appConfig.quotedCardUserFetchEnabled,
    quotedCardUserFetchCommand: appConfig.quotedCardUserFetchCommand,
    quotedCardUserFetchTimeoutMs: appConfig.quotedCardUserFetchTimeoutMs,
    quotedCardUserFetchMaxBytes: appConfig.quotedCardUserFetchMaxBytes,
    githubIssueGhCommand: appConfig.githubIssueGhCommand,
    githubIssueTimeoutMs: appConfig.githubIssueTimeoutMs,
    githubIssueMaxOutputBytes: appConfig.githubIssueMaxOutputBytes,
    githubIssueApiBaseUrl: appConfig.githubIssueApiBaseUrl,
    githubIssueToken: appConfig.githubIssueToken,
    hasGithubIssueActionConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueActionEnabled'),
    hasGithubIssueDefaultRepoConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueDefaultRepo'),
    hasGithubIssueAllowedReposConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueAllowedRepos'),
    hasGithubIssueCommandConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueCommand')
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
assert.equal(defaultPaths.codexExecTimeoutMs, 600_000);
assert.equal(defaultPaths.queueHandlerTimeoutMs, 660_000);
assert.equal(defaultPaths.replyObligationTimeoutMs, 660_000);
assert.equal(defaultPaths.quotedCardUserFetchEnabled, true);
assert.equal(defaultPaths.quotedCardUserFetchCommand, 'lark-cli');
assert.equal(defaultPaths.quotedCardUserFetchTimeoutMs, 10_000);
assert.equal(defaultPaths.quotedCardUserFetchMaxBytes, 256 * 1024);
assert.equal(defaultPaths.githubIssueGhCommand, 'gh');
assert.equal(defaultPaths.githubIssueTimeoutMs, 30_000);
assert.equal(defaultPaths.githubIssueMaxOutputBytes, 64 * 1024);
assert.equal(defaultPaths.githubIssueApiBaseUrl, 'https://api.github.com');
assert.equal(defaultPaths.githubIssueToken, null);
assert.equal(defaultPaths.hasGithubIssueActionConfig, false);
assert.equal(defaultPaths.hasGithubIssueDefaultRepoConfig, false);
assert.equal(defaultPaths.hasGithubIssueAllowedReposConfig, false);
assert.equal(defaultPaths.hasGithubIssueCommandConfig, false);

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

const customGithubIssue = expectOk({
  LARK_GITHUB_ISSUE_GH_COMMAND: '/opt/homebrew/bin/gh',
  LARK_GITHUB_ISSUE_TIMEOUT_MS: '2500',
  LARK_GITHUB_ISSUE_MAX_OUTPUT_BYTES: '2048',
  LARK_GITHUB_API_BASE_URL: 'https://github.example.test/api/v3',
  LARK_GITHUB_TOKEN: 'token-from-lark',
});
assert.equal(customGithubIssue.githubIssueGhCommand, '/opt/homebrew/bin/gh');
assert.equal(customGithubIssue.githubIssueTimeoutMs, 2500);
assert.equal(customGithubIssue.githubIssueMaxOutputBytes, 2048);
assert.equal(customGithubIssue.githubIssueApiBaseUrl, 'https://github.example.test/api/v3');
assert.equal(customGithubIssue.githubIssueToken, 'token-from-lark');

const sdkRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'sdk' });
assert.equal(sdkRuntime.channelRuntime, 'sdk');

const legacyRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'legacy' });
assert.equal(legacyRuntime.channelRuntime, 'legacy');

const customExecTimeout = expectOk({ LARK_CODEX_EXEC_TIMEOUT_MS: '5000' });
assert.equal(customExecTimeout.codexExecTimeoutMs, 5000);
assert.equal(customExecTimeout.queueHandlerTimeoutMs, 65_000);
assert.equal(customExecTimeout.replyObligationTimeoutMs, 65_000);

const disabledQueueTimeout = expectOk({ LARK_QUEUE_HANDLER_TIMEOUT_MS: '0' });
assert.equal(disabledQueueTimeout.queueHandlerTimeoutMs, 0);

const raisedLegacyQueueTimeout = expectOk({ LARK_QUEUE_HANDLER_TIMEOUT_MS: '30000' });
assert.equal(raisedLegacyQueueTimeout.queueHandlerTimeoutMs, 660_000);

const raisedEqualExecQueueTimeout = expectOk({ LARK_QUEUE_HANDLER_TIMEOUT_MS: '600000' });
assert.equal(raisedEqualExecQueueTimeout.queueHandlerTimeoutMs, 660_000);

const explicitQueueTimeout = expectOk({ LARK_QUEUE_HANDLER_TIMEOUT_MS: '700000' });
assert.equal(explicitQueueTimeout.queueHandlerTimeoutMs, 700_000);

console.log('config-validation smoke: PASS');
