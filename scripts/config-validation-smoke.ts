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
    debugLogPath: appConfig.debugLogPath,
    auditLogPath: appConfig.auditLogPath,
    codexExecTraceLogPath: appConfig.codexExecTraceLogPath,
    logArchiveRetentionMonths: appConfig.logArchiveRetentionMonths,
    codexSessionRetentionDays: appConfig.codexSessionRetentionDays,
    codexSessionRetentionScanIntervalHours: appConfig.codexSessionRetentionScanIntervalHours,
    codexSessionRetentionDryRun: appConfig.codexSessionRetentionDryRun,
    continuationEnabled: appConfig.continuationEnabled,
    continuationMaxConcurrency: appConfig.continuationMaxConcurrency,
    continuationMaxAttempts: appConfig.continuationMaxAttempts,
    continuationMaxRetries: appConfig.continuationMaxRetries,
    continuationMaxTotalMinutes: appConfig.continuationMaxTotalMinutes,
    continuationRetentionDays: appConfig.continuationRetentionDays,
    continuationWorkingRoot: appConfig.continuationWorkingRoot,
    continuationDbPath: appConfig.continuationDbPath,
    continuationArtifactsDir: appConfig.continuationArtifactsDir,
    quotedCardUserFetchEnabled: appConfig.quotedCardUserFetchEnabled,
    quotedCardUserFetchCommand: appConfig.quotedCardUserFetchCommand,
    quotedCardUserFetchTimeoutMs: appConfig.quotedCardUserFetchTimeoutMs,
    quotedCardUserFetchMaxBytes: appConfig.quotedCardUserFetchMaxBytes,
    hasIssueProposalsDir: Object.prototype.hasOwnProperty.call(appConfig, 'issueProposalsDir'),
    hasGithubIssueTimeoutMs: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueTimeoutMs'),
    hasGithubIssueApiBaseUrl: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueApiBaseUrl'),
    hasGithubIssueToken: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueToken'),
    hasGithubIssueActionConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueActionEnabled'),
    hasGithubIssueDefaultRepoConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueDefaultRepo'),
    hasGithubIssueAllowedReposConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueAllowedRepos'),
    hasGithubIssueCommandConfig: Object.prototype.hasOwnProperty.call(appConfig, 'githubIssueCommand'),
    hasContinuationMaxStepsConfig: Object.prototype.hasOwnProperty.call(appConfig, 'continuationMaxSteps'),
    hasContinuationMaxAgeHoursConfig: Object.prototype.hasOwnProperty.call(appConfig, 'continuationMaxAgeHours')
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
expectFail({ LARK_CHANNEL_RUNTIME: 'legacy' }, /LARK_CHANNEL_RUNTIME.*removed/i);
expectFail({ LARK_CHANNEL_RUNTIME: 'claude' }, /LARK_CHANNEL_RUNTIME.*no longer supported/i);
expectFail({ LARK_CODEX_DELIVERY_MODE: 'notification' }, /LARK_CODEX_DELIVERY_MODE.*removed/i);
expectFail({ LARK_CODEX_DELIVERY_MODE: 'claude' }, /LARK_CODEX_DELIVERY_MODE.*no longer supported/i);
expectFail({ LARK_CODEX_SESSION_RETENTION_DAYS: '0' }, /LARK_CODEX_SESSION_RETENTION_DAYS.*positive/i);
expectFail({ LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS: '-1' }, /LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS.*non-negative/i);
expectFail({ LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: '0' }, /LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS.*positive/i);
expectFail({ LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: '0' }, /LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES.*positive/i);
expectFail({ LARK_LOG_ARCHIVE_RETENTION_MONTHS: '-1' }, /LARK_LOG_ARCHIVE_RETENTION_MONTHS.*non-negative/i);
expectFail({ LARK_CONTINUATION_MAX_CONCURRENCY: '0' }, /LARK_CONTINUATION_MAX_CONCURRENCY.*integer between 1 and 4/i);
expectFail({ LARK_CONTINUATION_MAX_CONCURRENCY: '5' }, /LARK_CONTINUATION_MAX_CONCURRENCY.*integer between 1 and 4/i);
expectFail({ LARK_CONTINUATION_MAX_RETRIES: '-1' }, /LARK_CONTINUATION_MAX_RETRIES.*integer between 0 and 10/i);
expectFail({ LARK_CONTINUATION_MAX_ATTEMPTS: '2.5' }, /LARK_CONTINUATION_MAX_ATTEMPTS.*integer between 1 and 20/i);
expectFail({ LARK_CONTINUATION_MAX_ATTEMPTS: '21' }, /LARK_CONTINUATION_MAX_ATTEMPTS.*integer between 1 and 20/i);
expectFail({ LARK_CONTINUATION_MAX_TOTAL_MINUTES: '4' }, /LARK_CONTINUATION_MAX_TOTAL_MINUTES.*integer between 5 and 1440/i);
expectFail({ LARK_CONTINUATION_MAX_TOTAL_MINUTES: '1441' }, /LARK_CONTINUATION_MAX_TOTAL_MINUTES.*integer between 5 and 1440/i);
expectFail({ LARK_CONTINUATION_WORKING_ROOT: 'relative/root' }, /LARK_CONTINUATION_WORKING_ROOT.*absolute/i);

const zeroAllowed = expectOk({
  LARK_MEMORY_DEDUP_WINDOW_MS: '0',
  LARK_INBOX_MAX_BYTES: '0',
});
assert.equal(zeroAllowed.memoryDedupWindowMs, 0);
assert.equal(zeroAllowed.inboxMaxBytes, 0);

const defaultPaths = expectOk({});
assert.match(defaultPaths.codexExecCwd, /codex-exec-workdir$/);
assert.doesNotMatch(defaultPaths.codexExecCwd, /codex-lark-plugin$/);
assert.match(defaultPaths.debugLogPath, /\.codex\/channels\/lark\/logs\/debug\.log$/);
assert.match(defaultPaths.auditLogPath, /\.codex\/channels\/lark\/logs\/audit\.log$/);
assert.match(defaultPaths.codexExecTraceLogPath, /\.codex\/channels\/lark\/logs\/trace\.log$/);
assert.equal(defaultPaths.logArchiveRetentionMonths, 6);
assert.equal(defaultPaths.codexSessionRetentionDays, 14);
assert.equal(defaultPaths.codexSessionRetentionScanIntervalHours, 24);
assert.equal(defaultPaths.codexSessionRetentionDryRun, false);
assert.equal(defaultPaths.continuationEnabled, true);
assert.equal(defaultPaths.continuationMaxConcurrency, 1);
assert.equal(defaultPaths.continuationMaxAttempts, 5);
assert.equal(defaultPaths.continuationMaxRetries, 3);
assert.equal(defaultPaths.continuationMaxTotalMinutes, 30);
assert.equal(defaultPaths.continuationRetentionDays, 30);
assert.equal(defaultPaths.continuationWorkingRoot, defaultPaths.codexExecCwd);
assert.match(defaultPaths.continuationDbPath, /runtime\/continuations\/jobs\.sqlite$/);
assert.match(defaultPaths.continuationArtifactsDir, /runtime\/continuations\/artifacts$/);
assert.equal(defaultPaths.codexExecTimeoutMs, 600_000);
assert.equal(defaultPaths.queueHandlerTimeoutMs, 660_000);
assert.equal(defaultPaths.replyObligationTimeoutMs, 660_000);
assert.equal(defaultPaths.quotedCardUserFetchEnabled, true);
assert.equal(defaultPaths.quotedCardUserFetchCommand, 'lark-cli');
assert.equal(defaultPaths.quotedCardUserFetchTimeoutMs, 10_000);
assert.equal(defaultPaths.quotedCardUserFetchMaxBytes, 256 * 1024);
assert.equal(defaultPaths.hasIssueProposalsDir, false);
assert.equal(defaultPaths.hasGithubIssueTimeoutMs, false);
assert.equal(defaultPaths.hasGithubIssueApiBaseUrl, false);
assert.equal(defaultPaths.hasGithubIssueToken, false);
assert.equal(defaultPaths.hasGithubIssueActionConfig, false);
assert.equal(defaultPaths.hasGithubIssueDefaultRepoConfig, false);
assert.equal(defaultPaths.hasGithubIssueAllowedReposConfig, false);
assert.equal(defaultPaths.hasGithubIssueCommandConfig, false);
assert.equal(defaultPaths.hasContinuationMaxStepsConfig, false);
assert.equal(defaultPaths.hasContinuationMaxAgeHoursConfig, false);

const retentionDryRun = expectOk({ LARK_CODEX_SESSION_RETENTION_DRY_RUN: 'true' });
assert.equal(retentionDryRun.codexSessionRetentionDryRun, true);

const customContinuationRoot = expectOk({
  LARK_CODEX_EXEC_CWD: '/tmp/foreground-root',
  LARK_CONTINUATION_WORKING_ROOT: '/tmp/continuation-root',
});
assert.equal(customContinuationRoot.continuationWorkingRoot, '/tmp/continuation-root');

const customLogArchiveRetention = expectOk({ LARK_LOG_ARCHIVE_RETENTION_MONTHS: '0' });
assert.equal(customLogArchiveRetention.logArchiveRetentionMonths, 0);

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

const staleSdkRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'sdk' });
assert.equal(Object.prototype.hasOwnProperty.call(staleSdkRuntime, 'channelRuntime'), false);

const staleExecDeliveryMode = expectOk({ LARK_CODEX_DELIVERY_MODE: 'exec' });
assert.equal(Object.prototype.hasOwnProperty.call(staleExecDeliveryMode, 'codexDeliveryMode'), false);

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
