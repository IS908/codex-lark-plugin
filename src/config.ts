import { config } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

const envPath = path.join(os.homedir(), '.codex', 'channels', 'lark', '.env');
config({ path: envPath });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalList(key: string): string[] {
  const val = process.env[key];
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? Number(val) : fallback;
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
  textChunkLimit: optionalNumber('LARK_TEXT_CHUNK_LIMIT', 4000),
  ackEmoji: optional('LARK_ACK_EMOJI', 'MeMeMe'),
  botMessageTrackerSize: optionalNumber('LARK_BOT_MESSAGE_TRACKER_SIZE', 500),
  queueHandlerTimeoutMs: optionalNumber('LARK_QUEUE_HANDLER_TIMEOUT_MS', 30_000),
  codexDeliveryMode: optionalChoice(
    'LARK_CODEX_DELIVERY_MODE',
    'exec',
    ['exec', 'notification'] as const,
  ),
  codexExecCommand: optional('LARK_CODEX_EXEC_COMMAND', 'codex'),
  codexExecCwd: optional('LARK_CODEX_EXEC_CWD', process.cwd()),
  codexExecTimeoutMs: optionalNumber('LARK_CODEX_EXEC_TIMEOUT_MS', 10 * 60 * 1000),
  codexExecSandbox: optionalChoice(
    'LARK_CODEX_EXEC_SANDBOX',
    'workspace-write',
    ['read-only', 'workspace-write', 'danger-full-access'] as const,
  ),
  codexExecModel: process.env.LARK_CODEX_EXEC_MODEL || null,
  codexExecProfile: process.env.LARK_CODEX_EXEC_PROFILE || null,
  codexExecIgnoreUserConfig: optionalBoolean('LARK_CODEX_EXEC_IGNORE_USER_CONFIG', true),
  codexExecUseSessions: optionalBoolean('LARK_CODEX_EXEC_USE_SESSIONS', true),
  cronScanInterval: optionalNumber('LARK_CRON_SCAN_INTERVAL', 60),
  cronTimezone: optional('LARK_CRON_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone),
  feishuApiTimeoutMs: optionalNumber('LARK_FEISHU_API_TIMEOUT_MS', 30_000),
  feishuApiRetryAttempts: optionalNumber('LARK_FEISHU_API_RETRY_ATTEMPTS', 3),
  feishuApiRetryBaseDelayMs: optionalNumber('LARK_FEISHU_API_RETRY_BASE_DELAY_MS', 250),

  // Memory
  minSearchScore: optionalNumber('LARK_MIN_SEARCH_SCORE', 0.3),
  maxSearchResults: optionalNumber('LARK_MAX_SEARCH_RESULTS', 2),
  inactivityHours: optionalNumber('LARK_INACTIVITY_HOURS', 3),
  maxEpisodeBytes: optionalNumber('LARK_MAX_EPISODE_BYTES', 64 * 1024),
  downloadMaxBytes: optionalNumber('LARK_DOWNLOAD_MAX_BYTES', 25 * 1024 * 1024),
  downloadTimeoutMs: optionalNumber('LARK_DOWNLOAD_TIMEOUT_MS', 60_000),

  // Identity / privacy
  ownerOpenId: process.env.LARK_OWNER_OPEN_ID || null,
  /**
   * Session entry TTL. Must comfortably exceed the buffer auto-flush window
   * (LARK_INACTIVITY_HOURS) so that save_memory / save_skill calls triggered
   * by a flush still resolve to the last real user of the chat.
   * Default: max(2h, inactivityHours × 2).
   */
  identitySessionTtlMs: optionalNumber(
    'LARK_IDENTITY_SESSION_TTL_MS',
    Math.max(
      2 * 60 * 60 * 1000,
      optionalNumber('LARK_INACTIVITY_HOURS', 3) * 2 * 60 * 60 * 1000,
    ),
  ),

  // Paths
  memoriesDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'memories'),
  inboxDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'inbox'),
  jobsDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'jobs'),
  codexExecSessionsDir: path.join(os.homedir(), '.codex', 'channels', 'lark', 'codex-sessions'),
} as const;

export type AppConfig = typeof appConfig;
