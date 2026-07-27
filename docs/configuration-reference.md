# Configuration Reference

This file is generated from `src/config-schema.ts`. Edit the schema, then run `npm run generate:config`.

## Credentials

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_APP_ID` | string | yes | - | no | - | Feishu/Lark application ID. | bootstrap |
| `LARK_APP_SECRET` | string | yes | - | yes | - | Feishu/Lark application secret. | bootstrap |

## Messaging

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_CARD_FOOTER_METRICS_ENABLED` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Append compact runtime metrics to generated card replies. | messaging |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | number | no | 20000 | no | a non-negative number | Token threshold for showing usage in card footers. | messaging |
| `LARK_CODEX_EXEC_COMMAND` | string | no | codex | no | - | Codex CLI command used for exec delivery. | messaging |
| `LARK_CODEX_EXEC_CWD` | string | no | ~/.codex/channels/lark/codex-exec-workdir | no | - | Working directory for foreground Codex exec turns. | messaging |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Prevent child exec turns from loading user Codex configuration. | messaging |
| `LARK_CODEX_EXEC_MODEL` | string | no | (empty) | no | - | Optional global model override for Codex exec. | messaging |
| `LARK_CODEX_EXEC_PROFILE` | string | no | (empty) | no | - | Optional Codex configuration profile. | messaging |
| `LARK_CODEX_EXEC_SANDBOX` | enum(read-only, workspace-write, danger-full-access) | no | workspace-write | no | read-only, workspace-write, danger-full-access | Sandbox mode passed to foreground Codex exec. | messaging |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | number | no | 600000 | no | a positive number | Timeout for one foreground Codex exec run. | messaging |
| `LARK_CODEX_EXEC_TOOL_TRACE` | boolean | no | false | no | true/false, 1/0, yes/no, on/off | Write sanitized Codex tool execution traces locally. | messaging |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | enum(compact, full, hidden) | no | compact | no | compact, full, hidden | Local Codex tool trace detail level. | messaging |
| `LARK_CODEX_EXEC_TRACE_LOG` | string | no | ~/.codex/channels/lark/logs/trace.log | no | - | Path of the local Codex tool trace log. | messaging |
| `LARK_CODEX_EXEC_USE_SESSIONS` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Resume one Codex session per Feishu chat or thread. | messaging |
| `LARK_CODEX_SESSION_RETENTION_DAYS` | number | no | 14 | no | a positive number | Retention age for Codex exec session pointers. | messaging |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | boolean | no | false | no | true/false, 1/0, yes/no, on/off | Preview Codex session cleanup without deleting records. | messaging |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | number | no | 24 | no | a non-negative number | Interval for scanning expired Codex session pointers. | messaging |
| `LARK_CONTINUATION_ENABLED` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Enable durable background continuation creation and execution. | continuation |
| `LARK_CONTINUATION_MAX_ATTEMPTS` | number | no | 5 | no | an integer between 1 and 20 | Maximum attempts per continuation Job. | continuation |
| `LARK_CONTINUATION_MAX_CONCURRENCY` | number | no | 1 | no | an integer between 1 and 4 | Maximum concurrent continuation executions. | continuation |
| `LARK_CONTINUATION_MAX_RETRIES` | number | no | 3 | no | an integer between 0 and 10 | Retryable failures allowed within the attempt budget. | continuation |
| `LARK_CONTINUATION_MAX_TOTAL_MINUTES` | number | no | 30 | no | an integer between 5 and 1440 | Maximum lifetime of one continuation Job. | continuation |
| `LARK_CONTINUATION_RETENTION_DAYS` | number | no | 30 | no | an integer between 1 and 3650 | Days to retain terminal continuation details and artifacts. | continuation |
| `LARK_CONTINUATION_WORKING_ROOT` | absolute path | no | LARK_CODEX_EXEC_CWD | no | absolute path | Absolute authorized root for continuation working directories. | continuation |
| `LARK_EXEC_PROGRESS_ENABLED` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Enable bounded progress updates for long foreground turns. | messaging |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | number | no | 300 | no | a positive number | Maximum characters in one progress message. | messaging |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | number | no | 3 | no | a positive number | Maximum progress messages per foreground turn. | messaging |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | number | no | 15000 | no | a non-negative number | Minimum interval between progress messages. | messaging |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | number | no | 250 | no | a positive number | Parent-side progress side-channel polling interval. | messaging |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | number | no | LARK_CODEX_EXEC_TIMEOUT_MS + 60000 | no | a non-negative number | Per-thread queue timeout; zero disables it and positive values are raised above the exec timeout. | messaging |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | number | no | max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000) | no | a positive number | Maximum wait for a visible reply or defer result. | messaging |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | number | no | 1800000 | no | a positive number | Initial cooldown between session health nudges. | messaging |
| `LARK_SESSION_HEALTH_ENABLED` | boolean | no | false | no | true/false, 1/0, yes/no, on/off | Enable owner nudges for long-running Codex sessions. | messaging |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | number | no | 30000 | no | a non-negative number | Idle delay before checking session health gates. | messaging |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | number | no | 21600000 | no | a positive number | Maximum exponential session health cooldown. | messaging |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | number | no | 3 | no | a positive number | Maximum health nudges per session episode. | messaging |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | number | no | 524288 | no | a positive number | Prompt-byte threshold for a session health nudge. | messaging |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | number | no | 160000 | no | a positive number | Reported token threshold for a session health nudge. | messaging |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | number | no | 80 | no | a positive number | Session turn threshold for a health nudge. | messaging |
| `LARK_TEXT_CHUNK_LIMIT` | number | no | 4000 | no | a positive number | Maximum characters per text message chunk. | messaging |

## Acknowledgement

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_ACK_EMOJI` | string | no | MeMeMe | no | empty allowed | Emoji reaction added when a message is received. | acknowledgement |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | number | no | 500 | no | a non-negative number | Maximum bot message IDs retained for routing and mutation guards. | reactions, message-mutation |
| `LARK_DOC_COMMENT_ACK_EMOJI` | string | no | THUMBSUP | no | empty allowed | Persistent reaction for inbound document-comment mentions. | acknowledgement, doc-comment |

## Reliability

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_DOWNLOAD_MAX_BYTES` | number | no | 26214400 | no | a positive number | Maximum bytes accepted for one downloaded attachment. | lark-api |
| `LARK_DOWNLOAD_TIMEOUT_MS` | number | no | 60000 | no | a non-negative number | Attachment and image download timeout. | lark-api |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | number | no | 3 | no | a positive number | Attempts for retryable Feishu API failures. | lark-api |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | number | no | 250 | no | a non-negative number | Base delay for exponential Feishu API retries. | lark-api |
| `LARK_FEISHU_API_TIMEOUT_MS` | number | no | 30000 | no | a non-negative number | Timeout for one Feishu API call. | lark-api |

## CronJob

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_CRON_SCAN_INTERVAL` | number | no | 60 | no | a positive number | Cron schedule scan interval in seconds. | cron |
| `LARK_CRON_TIMEZONE` | string | no | system timezone | no | - | Default IANA timezone for new CronJobs and local logs. | cron, logging |

## Memory

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_INACTIVITY_HOURS` | number | no | 3 | no | a positive number | Inactivity threshold before flushing buffered conversation memory. | memory |
| `LARK_MAX_EPISODE_BYTES` | number | no | 65536 | no | a non-negative number | Maximum bytes persisted in one episode file. | memory |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | number | no | 200 | no | a non-negative number | Maximum episode files retained per chat or thread scope. | memory |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | number | no | 10485760 | no | a non-negative number | Maximum total episode bytes retained per scope. | memory |
| `LARK_MAX_SEARCH_RESULTS` | number | no | 2 | no | a positive number | Maximum episode search results injected into a turn. | memory |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | number | no | 1800000 | no | a non-negative number | Window for suppressing unchanged memory blocks. | memory |
| `LARK_MIN_SEARCH_SCORE` | number | no | 0.3 | no | a non-negative number | Minimum relevance score for episode search results. | memory |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | number | no | 86400000 | no | a non-negative number | Per-user cooldown between profile distillation dispatches. | memory |
| `LARK_PROFILE_DISTILLATION_ENABLED` | boolean | no | false | no | true/false, 1/0, yes/no, on/off | Enable profile distillation from recent episodes. | memory |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | number | no | 5 | no | a positive number | Maximum recent episodes included in one distillation prompt. | memory |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | number | no | 3 | no | a positive number | Minimum episodes required before profile distillation. | memory |

## Identity

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | number | no | 5000 | no | a positive number | Maximum server-derived caller identity session entries. | identity |
| `LARK_IDENTITY_SESSION_TTL_MS` | number | no | max(2h, LARK_INACTIVITY_HOURS x 2h) | no | a positive number | Lifetime of server-derived caller identity sessions. | identity |
| `LARK_OWNER_OPEN_ID` | string | no | (empty) | no | - | Immutable operator identity and terminal-skill trust root. | identity, authorization |

## Privacy

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_AUDIT_LOG` | string | no | ~/.codex/channels/lark/logs/audit.log | no | - | Path of the append-only sensitive-operation audit log. | audit |

## Quoted cards

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_CARD_CONTEXT_CACHE_SIZE` | number | no | 200 | no | a non-negative number | Maximum cached parent or root card contexts. | quoted-context |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | number | no | 1800000 | no | a non-negative number | Lifetime of fetched card context cache entries. | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | string | no | lark-cli | no | - | lark-cli command used for quoted-card user fallback. | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | boolean | no | true | no | true/false, 1/0, yes/no, on/off | Allow user-identity fallback when bot card hydration fails. | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | number | no | 262144 | no | a positive number | Maximum output bytes captured from quoted-card user fallback. | quoted-context |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | number | no | 10000 | no | a positive number | Timeout for quoted-card user-identity fallback. | quoted-context |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | number | no | 12000 | no | a positive number | UTF-8 byte budget for hydrated quoted-message context. | quoted-context |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | number | no | 4 | no | a positive number | Maximum quoted-message chain depth hydrated for Codex. | quoted-context |

## Resource governance

| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |
|---|---|---:|---|---:|---|---|---|
| `LARK_CHAT_TYPE_CACHE_SIZE` | number | no | 1000 | no | a non-negative number | Maximum cached Feishu chat types. | resource-governance |
| `LARK_DEBUG_LOG` | string | no | ~/.codex/channels/lark/logs/debug.log | no | - | Path of the local runtime debug log. | resource-governance |
| `LARK_INBOX_MAX_AGE_HOURS` | number | no | 168 | no | a non-negative number | Maximum age of downloaded inbox files during cleanup. | resource-governance |
| `LARK_INBOX_MAX_BYTES` | number | no | 209715200 | no | a non-negative number | LRU byte cap for downloaded inbox files. | resource-governance |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | number | no | 1000 | no | a non-negative number | Maximum latest-inbound-message tracker entries. | resource-governance |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | number | no | 6 | no | a non-negative number | Number of monthly log archive directories retained. | resource-governance |
| `LARK_LOG_MAX_BYTES` | number | no | 5242880 | no | a non-negative number | Log size threshold before rotation. | resource-governance |
| `LARK_LOG_MAX_FILES` | number | no | 5 | no | a non-negative number | Number of rotated log files retained. | resource-governance |
| `LARK_NAME_CACHE_SIZE` | number | no | 1000 | no | a non-negative number | Maximum cached user and chat display names. | resource-governance |
