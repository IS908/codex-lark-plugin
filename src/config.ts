import { config } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

const envPath = path.join(os.homedir(), '.codex', 'channels', 'lark', '.env');
config({ path: envPath });

const channelHome = path.join(os.homedir(), '.codex', 'channels', 'lark');
const defaultCodexExecCwd = path.join(channelHome, 'codex-exec-workdir');
const isDryRun = process.argv.includes('--dry-run');

function required(key: string): string {
  const val = process.env[key];
  if (!val && isDryRun && (key === 'LARK_APP_ID' || key === 'LARK_APP_SECRET')) {
    return `dry_run_${key.toLowerCase()}`;
  }
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalAllowEmpty(key: string, fallback: string): string {
  const val = process.env[key];
  return val === undefined ? fallback : val;
}

function optionalList(key: string): string[] {
  const val = process.env[key];
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = Number(val);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${key}: ${val}. Expected a number.`);
  return parsed;
}

function optionalPositiveNumber(key: string, fallback: number): number {
  const parsed = optionalNumber(key, fallback);
  if (parsed <= 0) throw new Error(`Invalid ${key}: ${parsed}. Expected a positive number.`);
  return parsed;
}

function optionalNonNegativeNumber(key: string, fallback: number): number {
  const parsed = optionalNumber(key, fallback);
  if (parsed < 0) throw new Error(`Invalid ${key}: ${parsed}. Expected a non-negative number.`);
  return parsed;
}

function optionalBoolean(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(val.toLowerCase());
}

function optionalChoice<const T extends readonly string[]>(
  key: string,
  fallback: T[number],
  choices: T,
): T[number] {
  const val = process.env[key] || fallback;
  if ((choices as readonly string[]).includes(val)) return val;
  throw new Error(`Invalid ${key}: ${val}. Expected one of: ${choices.join(', ')}`);
}

function rejectRemovedChannelRuntime(): void {
  const key = 'LARK_' + 'CHANNEL_RUNTIME';
  const value = process.env[key]?.trim();
  if (!value || value === 'sdk') return;
  if (value === 'legacy') {
    throw new Error(`${key}=legacy has been removed. The SDK channel runtime is always used; roll back by installing v1.12.3 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use sdk.`);
}

rejectRemovedChannelRuntime();

function rejectRemovedCodexDeliveryMode(): void {
  const key = 'LARK_' + 'CODEX_DELIVERY_MODE';
  const value = process.env[key]?.trim();
  if (!value || value === 'exec') return;
  if (value === 'notification') {
    throw new Error(`${key}=notification has been removed. Codex exec delivery is always used; roll back by installing v1.12.4 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use exec.`);
}

rejectRemovedCodexDeliveryMode();

const codexExecTimeoutMs = optionalPositiveNumber('LARK_CODEX_EXEC_TIMEOUT_MS', 10 * 60 * 1000);
const codexExecReplyBufferMs = 60_000;

function optionalQueueHandlerTimeoutMs(): number {
  const minimumWithReplyBuffer = codexExecTimeoutMs + codexExecReplyBufferMs;
  const parsed = optionalNonNegativeNumber('LARK_QUEUE_HANDLER_TIMEOUT_MS', minimumWithReplyBuffer);
  if (parsed === 0) return 0;
  return Math.max(parsed, minimumWithReplyBuffer);
}

export const appConfig = {
  // Required
  appId: required('LARK_APP_ID'),
  appSecret: required('LARK_APP_SECRET'),

  // Filtering
  allowedUserIds: optionalList('LARK_ALLOWED_USER_IDS'),
  allowedChatIds: optionalList('LARK_ALLOWED_CHAT_IDS'),
  textChunkLimit: optionalPositiveNumber('LARK_TEXT_CHUNK_LIMIT', 4000),
  ackEmoji: optional('LARK_ACK_EMOJI', 'MeMeMe'),
  docCommentAckEmoji: optionalAllowEmpty('LARK_DOC_COMMENT_ACK_EMOJI', 'THUMBSUP'),
  botMessageTrackerSize: optionalNonNegativeNumber('LARK_BOT_MESSAGE_TRACKER_SIZE', 500),
  queueHandlerTimeoutMs: optionalQueueHandlerTimeoutMs(),
  codexExecCommand: optional('LARK_CODEX_EXEC_COMMAND', 'codex'),
  codexExecCwd: optional('LARK_CODEX_EXEC_CWD', defaultCodexExecCwd),
  codexExecTimeoutMs,
  codexExecSandbox: optionalChoice(
    'LARK_CODEX_EXEC_SANDBOX',
    'workspace-write',
    ['read-only', 'workspace-write', 'danger-full-access'] as const,
  ),
  codexExecModel: process.env.LARK_CODEX_EXEC_MODEL || null,
  codexExecProfile: process.env.LARK_CODEX_EXEC_PROFILE || null,
  codexExecIgnoreUserConfig: optionalBoolean('LARK_CODEX_EXEC_IGNORE_USER_CONFIG', true),
  codexExecUseSessions: optionalBoolean('LARK_CODEX_EXEC_USE_SESSIONS', true),
  codexExecProgressEnabled: optionalBoolean('LARK_EXEC_PROGRESS_ENABLED', true),
  codexExecProgressMaxMessages: optionalPositiveNumber('LARK_EXEC_PROGRESS_MAX_MESSAGES', 3),
  codexExecProgressMaxChars: optionalPositiveNumber('LARK_EXEC_PROGRESS_MAX_CHARS', 300),
  codexExecProgressMinIntervalMs: optionalNonNegativeNumber('LARK_EXEC_PROGRESS_MIN_INTERVAL_MS', 15_000),
  codexExecProgressPollIntervalMs: optionalPositiveNumber('LARK_EXEC_PROGRESS_POLL_INTERVAL_MS', 250),
  codexExecToolTraceEnabled: optionalBoolean('LARK_CODEX_EXEC_TOOL_TRACE', false),
  codexExecToolTraceMode: optionalChoice(
    'LARK_CODEX_EXEC_TOOL_TRACE_MODE',
    'compact',
    ['compact', 'full', 'hidden'] as const,
  ),
  codexSessionRetentionDays: optionalPositiveNumber('LARK_CODEX_SESSION_RETENTION_DAYS', 14),
  codexSessionRetentionScanIntervalHours: optionalNonNegativeNumber(
    'LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS',
    24,
  ),
  codexSessionRetentionDryRun: optionalBoolean('LARK_CODEX_SESSION_RETENTION_DRY_RUN', false),
  sessionHealthEnabled: optionalBoolean('LARK_SESSION_HEALTH_ENABLED', false),
  sessionHealthTurnThreshold: optionalPositiveNumber('LARK_SESSION_HEALTH_TURN_THRESHOLD', 80),
  sessionHealthPromptBytesThreshold: optionalPositiveNumber(
    'LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD',
    512 * 1024,
  ),
  sessionHealthTokenThreshold: optionalPositiveNumber('LARK_SESSION_HEALTH_TOKEN_THRESHOLD', 160_000),
  sessionHealthIdleDelayMs: optionalNonNegativeNumber('LARK_SESSION_HEALTH_IDLE_DELAY_MS', 30_000),
  sessionHealthCooldownMs: optionalPositiveNumber('LARK_SESSION_HEALTH_COOLDOWN_MS', 30 * 60 * 1000),
  sessionHealthMaxCooldownMs: optionalPositiveNumber('LARK_SESSION_HEALTH_MAX_COOLDOWN_MS', 6 * 60 * 60 * 1000),
  sessionHealthMaxNudges: optionalPositiveNumber('LARK_SESSION_HEALTH_MAX_NUDGES', 3),
  replyObligationTimeoutMs: optionalPositiveNumber(
    'LARK_REPLY_OBLIGATION_TIMEOUT_MS',
    Math.max(60_000, codexExecTimeoutMs + codexExecReplyBufferMs),
  ),
  cronScanInterval: optionalPositiveNumber('LARK_CRON_SCAN_INTERVAL', 60),
  cronTimezone: optional('LARK_CRON_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone),
  feishuApiTimeoutMs: optionalNonNegativeNumber('LARK_FEISHU_API_TIMEOUT_MS', 30_000),
  feishuApiRetryAttempts: optionalPositiveNumber('LARK_FEISHU_API_RETRY_ATTEMPTS', 3),
  feishuApiRetryBaseDelayMs: optionalNonNegativeNumber('LARK_FEISHU_API_RETRY_BASE_DELAY_MS', 250),
  logMaxBytes: optionalNonNegativeNumber('LARK_LOG_MAX_BYTES', 5 * 1024 * 1024),
  logMaxFiles: optionalNonNegativeNumber('LARK_LOG_MAX_FILES', 5),

  // Memory
  minSearchScore: optionalNonNegativeNumber('LARK_MIN_SEARCH_SCORE', 0.3),
  maxSearchResults: optionalPositiveNumber('LARK_MAX_SEARCH_RESULTS', 2),
  inactivityHours: optionalPositiveNumber('LARK_INACTIVITY_HOURS', 3),
  maxEpisodeBytes: optionalNonNegativeNumber('LARK_MAX_EPISODE_BYTES', 64 * 1024),
  maxEpisodeFilesPerScope: optionalNonNegativeNumber('LARK_MAX_EPISODE_FILES_PER_SCOPE', 200),
  maxEpisodeScopeBytes: optionalNonNegativeNumber('LARK_MAX_EPISODE_SCOPE_BYTES', 10 * 1024 * 1024),
  profileDistillationEnabled: optionalBoolean('LARK_PROFILE_DISTILLATION_ENABLED', false),
  profileDistillationMinEpisodes: optionalPositiveNumber('LARK_PROFILE_DISTILLATION_MIN_EPISODES', 3),
  profileDistillationMaxEpisodes: optionalPositiveNumber('LARK_PROFILE_DISTILLATION_MAX_EPISODES', 5),
  profileDistillationCooldownMs: optionalNonNegativeNumber(
    'LARK_PROFILE_DISTILLATION_COOLDOWN_MS',
    24 * 60 * 60 * 1000,
  ),
  memoryDedupWindowMs: optionalNonNegativeNumber('LARK_MEMORY_DEDUP_WINDOW_MS', 30 * 60 * 1000),
  downloadMaxBytes: optionalPositiveNumber('LARK_DOWNLOAD_MAX_BYTES', 25 * 1024 * 1024),
  downloadTimeoutMs: optionalNonNegativeNumber('LARK_DOWNLOAD_TIMEOUT_MS', 60_000),
  inboxMaxAgeHours: optionalNonNegativeNumber('LARK_INBOX_MAX_AGE_HOURS', 168),
  inboxMaxBytes: optionalNonNegativeNumber('LARK_INBOX_MAX_BYTES', 200 * 1024 * 1024),

  // Identity / privacy
  ownerOpenId: process.env.LARK_OWNER_OPEN_ID || null,
  /**
   * Session entry TTL. Must comfortably exceed the buffer auto-flush window
   * (LARK_INACTIVITY_HOURS) so that save_memory / save_skill calls triggered
   * by a flush still resolve to the last real user of the chat.
   * Default: max(2h, inactivityHours × 2).
   */
  identitySessionTtlMs: optionalPositiveNumber(
    'LARK_IDENTITY_SESSION_TTL_MS',
    Math.max(
      2 * 60 * 60 * 1000,
      optionalPositiveNumber('LARK_INACTIVITY_HOURS', 3) * 2 * 60 * 60 * 1000,
    ),
  ),
  identitySessionMaxEntries: optionalPositiveNumber('LARK_IDENTITY_SESSION_MAX_ENTRIES', 5000),
  nameCacheSize: optionalNonNegativeNumber('LARK_NAME_CACHE_SIZE', 1000),
  chatTypeCacheSize: optionalNonNegativeNumber('LARK_CHAT_TYPE_CACHE_SIZE', 1000),
  latestMessageTrackerSize: optionalNonNegativeNumber('LARK_LATEST_MESSAGE_TRACKER_SIZE', 1000),
  cardContextCacheSize: optionalNonNegativeNumber('LARK_CARD_CONTEXT_CACHE_SIZE', 200),
  cardContextCacheTtlMs: optionalNonNegativeNumber('LARK_CARD_CONTEXT_CACHE_TTL_MS', 30 * 60 * 1000),
  quotedContextMaxDepth: optionalPositiveNumber('LARK_QUOTED_CONTEXT_MAX_DEPTH', 4),
  quotedContextMaxBytes: optionalPositiveNumber('LARK_QUOTED_CONTEXT_MAX_BYTES', 12_000),
  quotedCardUserFetchEnabled: optionalBoolean('LARK_QUOTED_CARD_USER_FETCH_ENABLED', true),
  quotedCardUserFetchCommand: optional('LARK_QUOTED_CARD_USER_FETCH_COMMAND', 'lark-cli'),
  quotedCardUserFetchTimeoutMs: optionalPositiveNumber('LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS', 10_000),
  quotedCardUserFetchMaxBytes: optionalPositiveNumber('LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES', 256 * 1024),

  // Paths
  memoriesDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'memories'),
  inboxDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'inbox'),
  jobsDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'jobs'),
  codexExecSessionsDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'codex-sessions'),
  localCliToolsConfigPath: optional(
    'LARK_LOCAL_CLI_TOOLS_CONFIG',
    path.join(os.homedir(), '.codex', 'channels', 'lark', 'local-cli-tools.json'),
  ),
  debugLogPath: optional('LARK_DEBUG_LOG', path.join(os.homedir(), '.codex', 'channels', 'lark', 'debug.log')),
  auditLogPath: optional('LARK_AUDIT_LOG', path.join(os.homedir(), '.codex', 'channels', 'lark', 'audit.log')),
  codexExecTraceLogPath: optional(
    'LARK_CODEX_EXEC_TRACE_LOG',
    path.join(os.homedir(), '.codex', 'channels', 'lark', 'trace.log'),
  ),
} as const;

export type AppConfig = typeof appConfig;
