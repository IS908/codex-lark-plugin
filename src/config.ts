import { config } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

const envPath = path.join(os.homedir(), '.codex', 'channels', 'lark', '.env');
config({ path: envPath });

const channelHome = path.join(os.homedir(), '.codex', 'channels', 'lark');
const defaultCodexExecCwd = path.join(channelHome, 'codex-exec-workdir');

function required(key: string): string {
  const val = process.env[key];
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
  queueHandlerTimeoutMs: optionalNonNegativeNumber('LARK_QUEUE_HANDLER_TIMEOUT_MS', 30_000),
  codexDeliveryMode: optionalChoice(
    'LARK_CODEX_DELIVERY_MODE',
    'exec',
    ['exec', 'notification'] as const,
  ),
  channelRuntime: optionalChoice(
    'LARK_CHANNEL_RUNTIME',
    'legacy',
    ['legacy', 'sdk'] as const,
  ),
  codexExecCommand: optional('LARK_CODEX_EXEC_COMMAND', 'codex'),
  codexExecCwd: optional('LARK_CODEX_EXEC_CWD', defaultCodexExecCwd),
  codexExecTimeoutMs: optionalPositiveNumber('LARK_CODEX_EXEC_TIMEOUT_MS', 10 * 60 * 1000),
  codexExecSandbox: optionalChoice(
    'LARK_CODEX_EXEC_SANDBOX',
    'workspace-write',
    ['read-only', 'workspace-write', 'danger-full-access'] as const,
  ),
  codexExecModel: process.env.LARK_CODEX_EXEC_MODEL || null,
  codexExecProfile: process.env.LARK_CODEX_EXEC_PROFILE || null,
  codexExecIgnoreUserConfig: optionalBoolean('LARK_CODEX_EXEC_IGNORE_USER_CONFIG', true),
  codexExecUseSessions: optionalBoolean('LARK_CODEX_EXEC_USE_SESSIONS', true),
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
    Math.max(60_000, optionalPositiveNumber('LARK_CODEX_EXEC_TIMEOUT_MS', 10 * 60 * 1000) + 60_000),
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
} as const;

export type AppConfig = typeof appConfig;
