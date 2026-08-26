import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  __toESM,
  assertSupportedNodeVersion,
  readConfigValues,
  require_main
} from "./chunk-WOBAO6HM.js";

// src/config.ts
var import_dotenv = __toESM(require_main(), 1);
import path from "node:path";
import os from "node:os";
assertSupportedNodeVersion();
var envPath = path.join(os.homedir(), ".codex", "channels", "lark", ".env");
(0, import_dotenv.config)({ path: envPath, quiet: true });
var channelHome = path.join(os.homedir(), ".codex", "channels", "lark");
var runtimeConfigDir = path.join(channelHome, "runtime-config");
var continuationRuntimeDir = path.join(channelHome, "runtime", "continuations");
var isDryRun = process.argv.includes("--dry-run");
function rejectRemovedChannelRuntime() {
  const key = "LARK_CHANNEL_RUNTIME";
  const value = process.env[key]?.trim();
  if (!value || value === "sdk") return;
  if (value === "legacy") {
    throw new Error(`${key}=legacy has been removed. The SDK channel runtime is always used; roll back by installing v1.12.3 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use sdk.`);
}
rejectRemovedChannelRuntime();
function rejectRemovedCodexDeliveryMode() {
  const key = "LARK_CODEX_DELIVERY_MODE";
  const value = process.env[key]?.trim();
  if (!value || value === "exec") return;
  if (value === "notification") {
    throw new Error(`${key}=notification has been removed. Codex exec delivery is always used; roll back by installing v1.12.4 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use exec.`);
}
rejectRemovedCodexDeliveryMode();
var envValues = readConfigValues({ dryRun: isDryRun });
var codexExecCwd = envValues.LARK_CODEX_EXEC_CWD;
var continuationWorkingRoot = envValues.LARK_CONTINUATION_WORKING_ROOT;
var appConfig = {
  // Required
  appId: envValues.LARK_APP_ID,
  appSecret: envValues.LARK_APP_SECRET,
  textChunkLimit: envValues.LARK_TEXT_CHUNK_LIMIT,
  ackEmoji: envValues.LARK_ACK_EMOJI,
  docCommentAckEmoji: envValues.LARK_DOC_COMMENT_ACK_EMOJI,
  botMessageTrackerSize: envValues.LARK_BOT_MESSAGE_TRACKER_SIZE,
  queueHandlerTimeoutMs: envValues.LARK_QUEUE_HANDLER_TIMEOUT_MS,
  codexExecCommand: envValues.LARK_CODEX_EXEC_COMMAND,
  codexExecCwd,
  codexExecTimeoutMs: envValues.LARK_CODEX_EXEC_TIMEOUT_MS,
  codexExecSandbox: envValues.LARK_CODEX_EXEC_SANDBOX,
  codexExecModel: envValues.LARK_CODEX_EXEC_MODEL,
  codexExecProfile: envValues.LARK_CODEX_EXEC_PROFILE,
  codexExecIgnoreUserConfig: envValues.LARK_CODEX_EXEC_IGNORE_USER_CONFIG,
  codexExecUseSessions: envValues.LARK_CODEX_EXEC_USE_SESSIONS,
  codexExecProgressEnabled: envValues.LARK_EXEC_PROGRESS_ENABLED,
  codexExecProgressMaxMessages: envValues.LARK_EXEC_PROGRESS_MAX_MESSAGES,
  codexExecProgressMaxChars: envValues.LARK_EXEC_PROGRESS_MAX_CHARS,
  codexExecProgressMinIntervalMs: envValues.LARK_EXEC_PROGRESS_MIN_INTERVAL_MS,
  codexExecProgressPollIntervalMs: envValues.LARK_EXEC_PROGRESS_POLL_INTERVAL_MS,
  codexExecToolTraceEnabled: envValues.LARK_CODEX_EXEC_TOOL_TRACE,
  codexExecToolTraceMode: envValues.LARK_CODEX_EXEC_TOOL_TRACE_MODE,
  cardFooterMetricsEnabled: envValues.LARK_CARD_FOOTER_METRICS_ENABLED,
  cardFooterMetricsTokenUsageThreshold: envValues.LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD,
  codexSessionRetentionDays: envValues.LARK_CODEX_SESSION_RETENTION_DAYS,
  codexSessionRetentionScanIntervalHours: envValues.LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS,
  codexSessionRetentionDryRun: envValues.LARK_CODEX_SESSION_RETENTION_DRY_RUN,
  continuationEnabled: envValues.LARK_CONTINUATION_ENABLED,
  continuationMaxConcurrency: envValues.LARK_CONTINUATION_MAX_CONCURRENCY,
  continuationMaxAttempts: envValues.LARK_CONTINUATION_MAX_ATTEMPTS,
  continuationMaxRetries: envValues.LARK_CONTINUATION_MAX_RETRIES,
  continuationMaxTotalMinutes: envValues.LARK_CONTINUATION_MAX_TOTAL_MINUTES,
  continuationRetentionDays: envValues.LARK_CONTINUATION_RETENTION_DAYS,
  continuationWorkingRoot,
  sessionHealthEnabled: envValues.LARK_SESSION_HEALTH_ENABLED,
  sessionHealthTurnThreshold: envValues.LARK_SESSION_HEALTH_TURN_THRESHOLD,
  sessionHealthPromptBytesThreshold: envValues.LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD,
  sessionHealthTokenThreshold: envValues.LARK_SESSION_HEALTH_TOKEN_THRESHOLD,
  sessionHealthIdleDelayMs: envValues.LARK_SESSION_HEALTH_IDLE_DELAY_MS,
  sessionHealthCooldownMs: envValues.LARK_SESSION_HEALTH_COOLDOWN_MS,
  sessionHealthMaxCooldownMs: envValues.LARK_SESSION_HEALTH_MAX_COOLDOWN_MS,
  sessionHealthMaxNudges: envValues.LARK_SESSION_HEALTH_MAX_NUDGES,
  replyObligationTimeoutMs: envValues.LARK_REPLY_OBLIGATION_TIMEOUT_MS,
  cronScanInterval: envValues.LARK_CRON_SCAN_INTERVAL,
  cronTimezone: envValues.LARK_CRON_TIMEZONE,
  feishuApiTimeoutMs: envValues.LARK_FEISHU_API_TIMEOUT_MS,
  feishuApiRetryAttempts: envValues.LARK_FEISHU_API_RETRY_ATTEMPTS,
  feishuApiRetryBaseDelayMs: envValues.LARK_FEISHU_API_RETRY_BASE_DELAY_MS,
  logMaxBytes: envValues.LARK_LOG_MAX_BYTES,
  logMaxFiles: envValues.LARK_LOG_MAX_FILES,
  logArchiveRetentionMonths: envValues.LARK_LOG_ARCHIVE_RETENTION_MONTHS,
  // Memory
  minSearchScore: envValues.LARK_MIN_SEARCH_SCORE,
  maxSearchResults: envValues.LARK_MAX_SEARCH_RESULTS,
  inactivityHours: envValues.LARK_INACTIVITY_HOURS,
  maxEpisodeBytes: envValues.LARK_MAX_EPISODE_BYTES,
  maxEpisodeFilesPerScope: envValues.LARK_MAX_EPISODE_FILES_PER_SCOPE,
  maxEpisodeScopeBytes: envValues.LARK_MAX_EPISODE_SCOPE_BYTES,
  profileDistillationEnabled: envValues.LARK_PROFILE_DISTILLATION_ENABLED,
  profileDistillationMinEpisodes: envValues.LARK_PROFILE_DISTILLATION_MIN_EPISODES,
  profileDistillationMaxEpisodes: envValues.LARK_PROFILE_DISTILLATION_MAX_EPISODES,
  profileDistillationCooldownMs: envValues.LARK_PROFILE_DISTILLATION_COOLDOWN_MS,
  memoryDedupWindowMs: envValues.LARK_MEMORY_DEDUP_WINDOW_MS,
  downloadMaxBytes: envValues.LARK_DOWNLOAD_MAX_BYTES,
  downloadTimeoutMs: envValues.LARK_DOWNLOAD_TIMEOUT_MS,
  inboxMaxAgeHours: envValues.LARK_INBOX_MAX_AGE_HOURS,
  inboxMaxBytes: envValues.LARK_INBOX_MAX_BYTES,
  // Identity / privacy
  ownerOpenId: envValues.LARK_OWNER_OPEN_ID,
  identitySessionTtlMs: envValues.LARK_IDENTITY_SESSION_TTL_MS,
  identitySessionMaxEntries: envValues.LARK_IDENTITY_SESSION_MAX_ENTRIES,
  nameCacheSize: envValues.LARK_NAME_CACHE_SIZE,
  chatTypeCacheSize: envValues.LARK_CHAT_TYPE_CACHE_SIZE,
  latestMessageTrackerSize: envValues.LARK_LATEST_MESSAGE_TRACKER_SIZE,
  cardContextCacheSize: envValues.LARK_CARD_CONTEXT_CACHE_SIZE,
  cardContextCacheTtlMs: envValues.LARK_CARD_CONTEXT_CACHE_TTL_MS,
  quotedContextMaxDepth: envValues.LARK_QUOTED_CONTEXT_MAX_DEPTH,
  quotedContextMaxBytes: envValues.LARK_QUOTED_CONTEXT_MAX_BYTES,
  quotedCardUserFetchEnabled: envValues.LARK_QUOTED_CARD_USER_FETCH_ENABLED,
  quotedCardUserFetchCommand: envValues.LARK_QUOTED_CARD_USER_FETCH_COMMAND,
  quotedCardUserFetchTimeoutMs: envValues.LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS,
  quotedCardUserFetchMaxBytes: envValues.LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES,
  // Paths
  memoriesDir: path.join(os.homedir(), ".codex", "channels", "lark", "memories"),
  inboxDir: path.join(os.homedir(), ".codex", "channels", "lark", "inbox"),
  jobsDir: path.join(os.homedir(), ".codex", "channels", "lark", "jobs"),
  codexExecSessionsDir: path.join(os.homedir(), ".codex", "channels", "lark", "codex-sessions"),
  continuationDbPath: path.join(continuationRuntimeDir, "jobs.sqlite"),
  continuationArtifactsDir: path.join(continuationRuntimeDir, "artifacts"),
  runtimeConfigDir,
  accessControlConfigPath: path.join(runtimeConfigDir, "access-control.json"),
  localCliToolsConfigPath: path.join(runtimeConfigDir, "local-cli-tools.json"),
  privacyRulesPath: path.join(runtimeConfigDir, "privacy-rules.md"),
  debugLogPath: envValues.LARK_DEBUG_LOG,
  auditLogPath: envValues.LARK_AUDIT_LOG,
  codexExecTraceLogPath: envValues.LARK_CODEX_EXEC_TRACE_LOG
};

export {
  appConfig
};
