---
name: configure
description: Configure the codex-lark-plugin by managing ~/.codex/channels/lark/.env. Use when the user asks to configure, setup, or change Lark/Feishu settings or credentials.
---

# lark:configure

Manage the codex-lark-plugin configuration stored in `~/.codex/channels/lark/.env`.

In Codex, invoke this as `$lark:configure`, select the skill from the skill picker, or ask `@lark` to configure credentials.

User arguments: `$ARGUMENTS`

---

## No args — Show current status

1. Read `~/.codex/channels/lark/.env` if it exists.
2. Display all recognized configuration keys with their current values.
3. Mask sensitive values:
   - `LARK_APP_ID`: show the first 6 characters, mask the rest
   - `LARK_APP_SECRET`: show the first 3 and last 2 characters, mask the middle
4. Group the output by category:

```
=== Credentials ===
LARK_APP_ID:       cli_a1****
LARK_APP_SECRET:   abc****xy

=== Memory ===
LARK_INACTIVITY_HOURS:     3
LARK_MAX_SEARCH_RESULTS:   2
LARK_MIN_SEARCH_SCORE:     0.3
LARK_MAX_EPISODE_BYTES:    65536
LARK_PROFILE_DISTILLATION_ENABLED: false
LARK_PROFILE_DISTILLATION_MIN_EPISODES: 3
LARK_PROFILE_DISTILLATION_MAX_EPISODES: 5
LARK_PROFILE_DISTILLATION_COOLDOWN_MS: 86400000
LARK_MEMORY_DEDUP_WINDOW_MS: 1800000

=== Runtime Config Files ===
access-control:  ~/.codex/channels/lark/runtime-config/access-control.json
privacy-rules:   ~/.codex/channels/lark/runtime-config/privacy-rules.md
local-cli-tools: ~/.codex/channels/lark/runtime-config/local-cli-tools.json

=== Messaging ===
LARK_TEXT_CHUNK_LIMIT:              4000
LARK_QUEUE_HANDLER_TIMEOUT_MS:      660000
LARK_REPLY_OBLIGATION_TIMEOUT_MS:   660000
LARK_CODEX_EXEC_COMMAND:            codex
LARK_CODEX_EXEC_CWD:                ~/.codex/channels/lark/codex-exec-workdir
LARK_CODEX_EXEC_TIMEOUT_MS:         600000
LARK_CODEX_EXEC_SANDBOX:            workspace-write
LARK_CODEX_EXEC_MODEL:              (not set)
LARK_CODEX_EXEC_PROFILE:            (not set)
LARK_CODEX_EXEC_IGNORE_USER_CONFIG: true
LARK_CODEX_EXEC_USE_SESSIONS:       true
LARK_EXEC_PROGRESS_ENABLED:         true
LARK_EXEC_PROGRESS_MAX_MESSAGES:    3
LARK_EXEC_PROGRESS_MAX_CHARS:       300
LARK_EXEC_PROGRESS_MIN_INTERVAL_MS: 15000
LARK_EXEC_PROGRESS_POLL_INTERVAL_MS: 250
LARK_CODEX_EXEC_TOOL_TRACE:         false
LARK_CODEX_EXEC_TOOL_TRACE_MODE:    compact
LARK_CODEX_EXEC_TRACE_LOG:          ~/.codex/channels/lark/logs/trace.log
LARK_CARD_FOOTER_METRICS_ENABLED:   true
LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD: 20000
LARK_CODEX_SESSION_RETENTION_DAYS:  14
LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS: 24
LARK_CODEX_SESSION_RETENTION_DRY_RUN: false
LARK_SESSION_HEALTH_ENABLED:        false
LARK_SESSION_HEALTH_TURN_THRESHOLD: 80
LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD: 524288
LARK_SESSION_HEALTH_TOKEN_THRESHOLD: 160000
LARK_SESSION_HEALTH_IDLE_DELAY_MS:  30000
LARK_SESSION_HEALTH_COOLDOWN_MS:    1800000
LARK_SESSION_HEALTH_MAX_COOLDOWN_MS: 21600000
LARK_SESSION_HEALTH_MAX_NUDGES:     3

=== Persistent Continuation ===
LARK_CONTINUATION_ENABLED:          true
LARK_CONTINUATION_MAX_CONCURRENCY:  1
LARK_CONTINUATION_MAX_ATTEMPTS:     5
LARK_CONTINUATION_MAX_RETRIES:      3
LARK_CONTINUATION_MAX_TOTAL_MINUTES: 30
LARK_CONTINUATION_RETENTION_DAYS:   30
LARK_CONTINUATION_WORKING_ROOT:     LARK_CODEX_EXEC_CWD

=== Acknowledgement ===
LARK_ACK_EMOJI:                MeMeMe
LARK_DOC_COMMENT_ACK_EMOJI:    THUMBSUP
LARK_BOT_MESSAGE_TRACKER_SIZE: 500

=== CronJob ===
LARK_CRON_SCAN_INTERVAL:   60
LARK_CRON_TIMEZONE:        (system tz)

=== Reliability ===
LARK_FEISHU_API_TIMEOUT_MS:            30000
LARK_FEISHU_API_RETRY_ATTEMPTS:        3
LARK_FEISHU_API_RETRY_BASE_DELAY_MS:   250
LARK_DOWNLOAD_MAX_BYTES:               26214400
LARK_DOWNLOAD_TIMEOUT_MS:              60000

=== Resource Governance ===
LARK_MAX_EPISODE_FILES_PER_SCOPE: 200
LARK_MAX_EPISODE_SCOPE_BYTES:     10485760
LARK_IDENTITY_SESSION_MAX_ENTRIES: 5000
LARK_DEBUG_LOG:                   ~/.codex/channels/lark/logs/debug.log
LARK_LOG_MAX_BYTES:               5242880
LARK_LOG_MAX_FILES:               5
LARK_LOG_ARCHIVE_RETENTION_MONTHS: 6
LARK_INBOX_MAX_AGE_HOURS:         168
LARK_INBOX_MAX_BYTES:             209715200
LARK_NAME_CACHE_SIZE:             1000
LARK_CHAT_TYPE_CACHE_SIZE:        1000
LARK_LATEST_MESSAGE_TRACKER_SIZE: 1000

=== Identity / Privacy ===
LARK_OWNER_OPEN_ID:               (not set)
LARK_IDENTITY_SESSION_TTL_MS:     auto
LARK_AUDIT_LOG:                   ~/.codex/channels/lark/logs/audit.log
LARK_CARD_CONTEXT_CACHE_SIZE:      200
LARK_CARD_CONTEXT_CACHE_TTL_MS:    1800000
LARK_QUOTED_CONTEXT_MAX_DEPTH:     4
LARK_QUOTED_CONTEXT_MAX_BYTES:     12000
LARK_QUOTED_CARD_USER_FETCH_ENABLED: true
LARK_QUOTED_CARD_USER_FETCH_COMMAND: lark-cli
LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: 10000
LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: 262144
```

5. Suggest next steps:
   - If credentials are missing: "Run `$lark:configure <app_id> <app_secret>` to set credentials, or `$lark:configure setup` for full interactive setup."
   - If credentials exist: "Configuration looks good. Start a new Codex session or restart Codex to apply changes."

---

## `<app_id> <app_secret>` — Quick credential setup

1. Treat the first argument as `LARK_APP_ID` and the second as `LARK_APP_SECRET`.
2. Run `mkdir -p ~/.codex/channels/lark`.
3. Read the existing `.env` if present.
4. Update or append:
   - `LARK_APP_ID=<app_id>`
   - `LARK_APP_SECRET=<app_secret>`
5. Preserve all other existing keys unchanged.
6. Write the file back.
7. Confirm: "Credentials saved to `~/.codex/channels/lark/.env`."
8. Tell the user to start a new Codex session or restart Codex.

---

## `setup` — Full interactive setup

Walk the user through complete configuration, one question at a time.

### Step 1: Credentials

Ask for `LARK_APP_ID` and `LARK_APP_SECRET`.
- If already set, show masked current values and ask if user wants to update.
- If user says "keep" or "skip", preserve existing values.
- Explain: these come from the Feishu Open Platform app dashboard.

### Step 2: Runtime access control (optional)

Explain that access control is no longer stored in `.env`. It lives in
`~/.codex/channels/lark/runtime-config/access-control.json` and is normally
managed by the owner with `/access` in Lark or the `manage_access_control` tool.
`LARK_OWNER_OPEN_ID` should be set before using those owner-only controls.

### Step 3: CronJob timezone (optional)

Ask if the user wants to set a specific timezone for cronjob schedules:
- `LARK_CRON_TIMEZONE` — IANA timezone name (e.g. `Asia/Shanghai`, `UTC`). Default: system timezone. This affects how cron hours map to wall-clock time — worth setting explicitly for servers that may move between timezones.

If user says "use system tz" or "skip", leave unset.

### Step 4: Advanced tuning (optional)

Ask if the user wants to adjust any of these advanced settings (or use defaults):
- `LARK_INACTIVITY_HOURS` — hours of silence before memory auto-flush (default: 3)
- `LARK_MAX_SEARCH_RESULTS` — max episodes injected per message (default: 2)
- `LARK_MIN_SEARCH_SCORE` — minimum relevance score for episode search (default: 0.3)
- `LARK_TEXT_CHUNK_LIMIT` — max chars per reply chunk (default: 4000)
- `LARK_QUEUE_HANDLER_TIMEOUT_MS` — per-message queue guardrail timeout (default: `LARK_CODEX_EXEC_TIMEOUT_MS + 60000`; set `0` to disable; lower positive values are raised to the default)
- `LARK_REPLY_OBLIGATION_TIMEOUT_MS` — max wait for a visible reply/defer before logging a missed Lark turn (default: `LARK_CODEX_EXEC_TIMEOUT_MS + 60000`)
- `LARK_CODEX_EXEC_CWD` — working directory for `codex exec` (default: `~/.codex/channels/lark/codex-exec-workdir`)
- `LARK_CODEX_EXEC_SANDBOX` — sandbox passed to `codex exec` (default: `workspace-write`); the optional `run_local_cli_tool` host bridge is only described to Codex exec when this is `read-only`/`workspace-write` and `runtime-config/local-cli-tools.json` has allowlisted tools.
- `LARK_CODEX_EXEC_USE_SESSIONS` — resume one Codex session per Feishu chat/thread (default: true)
- `LARK_EXEC_PROGRESS_ENABLED` — send bounded progress messages during long-running visible Codex exec turns (default: true)
- `LARK_EXEC_PROGRESS_MAX_MESSAGES` — max progress messages per Codex exec turn (default: 3)
- `LARK_EXEC_PROGRESS_MAX_CHARS` — max chars per progress message (default: 300)
- `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` — minimum interval between progress messages in one turn (default: 15000)
- `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` — parent watcher polling interval for progress JSONL (default: 250)
- `LARK_CODEX_EXEC_TOOL_TRACE` — write local codex exec tool-call trace text lines to trace.log; never renders tool traces into Feishu replies (default: false)
- `LARK_CODEX_EXEC_TOOL_TRACE_MODE` — `compact`, `full`, or `hidden`; `hidden` keeps local compact tracing and no visible Feishu tool trace (default: compact)
- `LARK_CODEX_EXEC_TRACE_LOG` — local codex exec tool trace text log path (default: `~/.codex/channels/lark/logs/trace.log`)
- `LARK_CARD_FOOTER_METRICS_ENABLED` — append compact runtime metrics to generated card replies from Codex exec (default: true)
- `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` — show token usage in card footer only above this total-token threshold (default: 20000)
- `LARK_CODEX_SESSION_RETENTION_DAYS` — keep Codex exec resume-pointer records newer than this many days (default: 14)
- `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` — periodic cleanup interval; set `0` to disable automatic cleanup (default: 24)
- `LARK_CODEX_SESSION_RETENTION_DRY_RUN` — preview session cleanup candidates without deleting records (default: false)
- `LARK_CONTINUATION_ENABLED` — enable durable background continuation creation and execution (default: true)
- `LARK_CONTINUATION_MAX_CONCURRENCY` — concurrent continuation Codex runs, from 1 to 4 (default: 1)
- `LARK_CONTINUATION_MAX_ATTEMPTS` — maximum execution attempts per continuation, from 1 to 20 (default: 5)
- `LARK_CONTINUATION_MAX_RETRIES` — retryable execution failures per step, from 0 to 10 (default: 3)
- `LARK_CONTINUATION_MAX_TOTAL_MINUTES` — maximum continuation lifetime, from 5 to 1440 minutes (default: 30)
- `LARK_CONTINUATION_RETENTION_DAYS` — days before terminal task bodies and managed artifacts are redacted (default: 30)
- `LARK_CONTINUATION_WORKING_ROOT` — absolute root that continuation `working_directory` values may select beneath; defaults to `LARK_CODEX_EXEC_CWD`
- `LARK_SESSION_HEALTH_ENABLED` — enable owner DM nudges for long-running Codex exec sessions (default: false)
- `LARK_SESSION_HEALTH_TURN_THRESHOLD` — turns before a session-health nudge can fire (default: 80)
- `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` — heuristic prompt bytes threshold for session-health nudges (default: 524288)
- `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` — token threshold when Codex exec JSONL usage is available (default: 160000)
- `LARK_SESSION_HEALTH_IDLE_DELAY_MS` — idle delay before sending session-health nudges (default: 30000)
- `LARK_SESSION_HEALTH_COOLDOWN_MS` — initial cooldown between session-health nudges (default: 1800000)
- `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` — max exponential cooldown between session-health nudges (default: 21600000)
- `LARK_SESSION_HEALTH_MAX_NUDGES` — max nudges per session (default: 3)
- `LARK_ACK_EMOJI` — emoji reaction on message receive, empty to disable (default: `MeMeMe`)
- `LARK_DOC_COMMENT_ACK_EMOJI` — persistent emoji reaction on inbound doc-comment mentions, empty to disable (default: `THUMBSUP`)
- `LARK_BOT_MESSAGE_TRACKER_SIZE` — max bot message IDs tracked for reaction filtering (default: 500)
- `LARK_CRON_SCAN_INTERVAL` — cronjob scan interval in seconds (default: 60)
- `LARK_FEISHU_API_TIMEOUT_MS` — timeout for Feishu API calls (default: 30000)
- `LARK_FEISHU_API_RETRY_ATTEMPTS` — retry attempts for retryable Feishu API failures (default: 3)
- `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` — base delay for Feishu API retry backoff (default: 250)
- `LARK_DOWNLOAD_MAX_BYTES` — max bytes for streamed downloads (default: 26214400)
- `LARK_DOWNLOAD_TIMEOUT_MS` — timeout for attachment/image downloads (default: 60000)
- `LARK_MAX_EPISODE_BYTES` — max bytes per episode file before truncation (default: 65536)
- `LARK_PROFILE_DISTILLATION_ENABLED` — distill recent episodes into tiered profiles (default: false)
- `LARK_PROFILE_DISTILLATION_MIN_EPISODES` — min episodes before profile distillation can dispatch (default: 3)
- `LARK_PROFILE_DISTILLATION_MAX_EPISODES` — max recent episodes included in one profile distillation prompt (default: 5)
- `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` — per-user profile distillation cooldown (default: 86400000)
- `LARK_MEMORY_DEDUP_WINDOW_MS` — suppress unchanged memory context blocks per chat/thread (default: 1800000; set `0` to disable)
- `LARK_MAX_EPISODE_FILES_PER_SCOPE` — max episode files per chat/thread scope (default: 200)
- `LARK_MAX_EPISODE_SCOPE_BYTES` — max total episode bytes per chat/thread scope (default: 10485760)
- `LARK_IDENTITY_SESSION_MAX_ENTRIES` — max caller session entries (default: 5000)
- `LARK_DEBUG_LOG` — debug log path (default: `~/.codex/channels/lark/logs/debug.log`)
- `LARK_LOG_MAX_BYTES` — rotate debug/audit/trace logs after this many bytes (default: 5242880)
- `LARK_LOG_MAX_FILES` — rotated log files to keep (default: 5)
- `LARK_LOG_ARCHIVE_RETENTION_MONTHS` — monthly gzip archive directories to keep; `0` disables archival (default: 6)
- `LARK_INBOX_MAX_AGE_HOURS` — remove old inbox downloads on startup (default: 168)
- `LARK_INBOX_MAX_BYTES` — LRU byte cap for inbox downloads (default: 209715200)
- `LARK_NAME_CACHE_SIZE` — max cached Feishu user/chat names (default: 1000)
- `LARK_CHAT_TYPE_CACHE_SIZE` — max cached Feishu chat types (default: 1000)
- `LARK_LATEST_MESSAGE_TRACKER_SIZE` — max latest-message tracker entries (default: 1000)
- `LARK_CARD_CONTEXT_CACHE_SIZE` — cached fetched-card parent/root contexts (default: 200)
- `LARK_CARD_CONTEXT_CACHE_TTL_MS` — TTL for fetched-card context cache (default: 1800000)
- `LARK_QUOTED_CONTEXT_MAX_DEPTH` — max quoted/replied message chain depth before prompting Codex (default: 4)
- `LARK_QUOTED_CONTEXT_MAX_BYTES` — UTF-8 byte budget for hydrated quoted-message context (default: 12000)
- `LARK_QUOTED_CARD_USER_FETCH_ENABLED` — allow user-identity fallback for quoted interactive card hydration (default: true)
- `LARK_QUOTED_CARD_USER_FETCH_COMMAND` — `lark-cli` executable for quoted-card user fallback (default: `lark-cli`)
- `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` — timeout for quoted-card user fallback (default: 10000)
- `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` — max captured output from quoted-card user fallback (default: 262144)

If user says "use defaults" or "skip", leave these at defaults.

### Step 5: Write config

1. Run `mkdir -p ~/.codex/channels/lark`.
2. Read existing `.env` if present.
3. Merge all collected values, preserving any unrecognized keys.
4. Write the file.
5. Show a summary of what was configured (masked secrets).
6. Tell the user: "Configuration complete. Start a new Codex session or restart Codex to apply."

---

## `clear` — Remove configuration

1. Read `~/.codex/channels/lark/.env`.
2. Remove all recognized keys:
   `LARK_APP_ID`, `LARK_APP_SECRET`,
   `LARK_TEXT_CHUNK_LIMIT`, `LARK_QUEUE_HANDLER_TIMEOUT_MS`,
   `LARK_REPLY_OBLIGATION_TIMEOUT_MS`,
   `LARK_CODEX_EXEC_COMMAND`,
   `LARK_CODEX_EXEC_CWD`, `LARK_CODEX_EXEC_TIMEOUT_MS`,
   `LARK_CODEX_EXEC_SANDBOX`, `LARK_CODEX_EXEC_MODEL`,
   `LARK_CODEX_EXEC_PROFILE`, `LARK_CODEX_EXEC_IGNORE_USER_CONFIG`,
   `LARK_CODEX_EXEC_USE_SESSIONS`, `LARK_EXEC_PROGRESS_ENABLED`,
   `LARK_EXEC_PROGRESS_MAX_MESSAGES`, `LARK_EXEC_PROGRESS_MAX_CHARS`,
   `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS`, `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS`,
   `LARK_CODEX_EXEC_TOOL_TRACE`, `LARK_CODEX_EXEC_TOOL_TRACE_MODE`,
   `LARK_CODEX_EXEC_TRACE_LOG`, `LARK_CARD_FOOTER_METRICS_ENABLED`,
   `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD`,
   `LARK_CODEX_SESSION_RETENTION_DAYS`,
   `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS`,
   `LARK_CODEX_SESSION_RETENTION_DRY_RUN`,
   `LARK_CONTINUATION_ENABLED`, `LARK_CONTINUATION_MAX_CONCURRENCY`,
   `LARK_CONTINUATION_MAX_ATTEMPTS`, `LARK_CONTINUATION_MAX_RETRIES`,
   `LARK_CONTINUATION_MAX_TOTAL_MINUTES`, `LARK_CONTINUATION_RETENTION_DAYS`,
   `LARK_CONTINUATION_WORKING_ROOT`,
   `LARK_SESSION_HEALTH_ENABLED`,
   `LARK_SESSION_HEALTH_TURN_THRESHOLD`, `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD`,
   `LARK_SESSION_HEALTH_TOKEN_THRESHOLD`, `LARK_SESSION_HEALTH_IDLE_DELAY_MS`,
   `LARK_SESSION_HEALTH_COOLDOWN_MS`,
   `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS`, `LARK_SESSION_HEALTH_MAX_NUDGES`,
   `LARK_ACK_EMOJI`, `LARK_DOC_COMMENT_ACK_EMOJI`, `LARK_BOT_MESSAGE_TRACKER_SIZE`,
   `LARK_CRON_SCAN_INTERVAL`, `LARK_CRON_TIMEZONE`,
   `LARK_FEISHU_API_TIMEOUT_MS`, `LARK_FEISHU_API_RETRY_ATTEMPTS`,
   `LARK_FEISHU_API_RETRY_BASE_DELAY_MS`, `LARK_DOWNLOAD_MAX_BYTES`,
   `LARK_DOWNLOAD_TIMEOUT_MS`, `LARK_INACTIVITY_HOURS`,
   `LARK_MAX_SEARCH_RESULTS`, `LARK_MIN_SEARCH_SCORE`, `LARK_MAX_EPISODE_BYTES`,
   `LARK_PROFILE_DISTILLATION_ENABLED`, `LARK_PROFILE_DISTILLATION_MIN_EPISODES`,
   `LARK_PROFILE_DISTILLATION_MAX_EPISODES`, `LARK_PROFILE_DISTILLATION_COOLDOWN_MS`,
   `LARK_MEMORY_DEDUP_WINDOW_MS`,
   `LARK_MAX_EPISODE_FILES_PER_SCOPE`, `LARK_MAX_EPISODE_SCOPE_BYTES`,
   `LARK_IDENTITY_SESSION_MAX_ENTRIES`, `LARK_DEBUG_LOG`,
   `LARK_LOG_MAX_BYTES`, `LARK_LOG_MAX_FILES`, `LARK_LOG_ARCHIVE_RETENTION_MONTHS`,
   `LARK_INBOX_MAX_AGE_HOURS`, `LARK_INBOX_MAX_BYTES`,
   `LARK_NAME_CACHE_SIZE`, `LARK_CHAT_TYPE_CACHE_SIZE`,
   `LARK_LATEST_MESSAGE_TRACKER_SIZE`,
   `LARK_OWNER_OPEN_ID`, `LARK_IDENTITY_SESSION_TTL_MS`,
   `LARK_AUDIT_LOG`,
   `LARK_CARD_CONTEXT_CACHE_SIZE`,
   `LARK_CARD_CONTEXT_CACHE_TTL_MS`, `LARK_QUOTED_CONTEXT_MAX_DEPTH`,
   `LARK_QUOTED_CONTEXT_MAX_BYTES`, `LARK_QUOTED_CARD_USER_FETCH_ENABLED`,
   `LARK_QUOTED_CARD_USER_FETCH_COMMAND`, `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS`,
   `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES`.
3. If the file becomes empty, delete it.
4. Confirm: "All configuration cleared."

---

## Recognized config keys

| Key | Category | Required | Default |
|-----|----------|----------|---------|
| `LARK_APP_ID` | Credentials | Yes | - |
| `LARK_APP_SECRET` | Credentials | Yes | - |
| `LARK_TEXT_CHUNK_LIMIT` | Messaging | No | `4000` |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | Messaging | No | `660000` / `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | Messaging | No | `660000` / `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` |
| `LARK_CODEX_EXEC_COMMAND` | Messaging | No | `codex` |
| `LARK_CODEX_EXEC_CWD` | Messaging | No | `~/.codex/channels/lark/codex-exec-workdir` |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | Messaging | No | `600000` |
| `LARK_CODEX_EXEC_SANDBOX` | Messaging | No | `workspace-write` |
| `LARK_CODEX_EXEC_MODEL` | Messaging | No | (empty) |
| `LARK_CODEX_EXEC_PROFILE` | Messaging | No | (empty) |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | Messaging | No | `true` |
| `LARK_CODEX_EXEC_USE_SESSIONS` | Messaging | No | `true` |
| `LARK_EXEC_PROGRESS_ENABLED` | Messaging | No | `true` |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | Messaging | No | `3` |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | Messaging | No | `300` |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | Messaging | No | `15000` |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | Messaging | No | `250` |
| `LARK_CODEX_EXEC_TOOL_TRACE` | Messaging | No | `false` |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | Messaging | No | `compact` |
| `LARK_CODEX_EXEC_TRACE_LOG` | Messaging | No | `~/.codex/channels/lark/logs/trace.log` |
| `LARK_CARD_FOOTER_METRICS_ENABLED` | Messaging | No | `true` |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | Messaging | No | `20000` |
| `LARK_CODEX_SESSION_RETENTION_DAYS` | Messaging | No | `14` |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | Messaging | No | `24` |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | Messaging | No | `false` |
| `LARK_SESSION_HEALTH_ENABLED` | Messaging | No | `false` |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | Messaging | No | `80` |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | Messaging | No | `524288` |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | Messaging | No | `160000` |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | Messaging | No | `30000` |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | Messaging | No | `1800000` |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | Messaging | No | `21600000` |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | Messaging | No | `3` |
| `LARK_ACK_EMOJI` | Acknowledgement | No | `MeMeMe` |
| `LARK_DOC_COMMENT_ACK_EMOJI` | Acknowledgement | No | `THUMBSUP` |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | Acknowledgement | No | `500` |
| `LARK_CRON_SCAN_INTERVAL` | CronJob | No | `60` |
| `LARK_CRON_TIMEZONE` | CronJob | No | system timezone |
| `LARK_FEISHU_API_TIMEOUT_MS` | Reliability | No | `30000` |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | Reliability | No | `3` |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | Reliability | No | `250` |
| `LARK_DOWNLOAD_MAX_BYTES` | Reliability | No | `26214400` |
| `LARK_DOWNLOAD_TIMEOUT_MS` | Reliability | No | `60000` |
| `LARK_INACTIVITY_HOURS` | Memory | No | `3` |
| `LARK_MAX_SEARCH_RESULTS` | Memory | No | `2` |
| `LARK_MIN_SEARCH_SCORE` | Memory | No | `0.3` |
| `LARK_MAX_EPISODE_BYTES` | Memory | No | `65536` |
| `LARK_PROFILE_DISTILLATION_ENABLED` | Memory | No | `false` |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | Memory | No | `3` |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | Memory | No | `5` |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | Memory | No | `86400000` |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | Memory | No | `1800000` |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | Resource governance | No | `200` |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | Resource governance | No | `10485760` |
| `LARK_DEBUG_LOG` | Resource governance | No | `~/.codex/channels/lark/logs/debug.log` |
| `LARK_LOG_MAX_BYTES` | Resource governance | No | `5242880` |
| `LARK_LOG_MAX_FILES` | Resource governance | No | `5` |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | Resource governance | No | `6` |
| `LARK_INBOX_MAX_AGE_HOURS` | Resource governance | No | `168` |
| `LARK_INBOX_MAX_BYTES` | Resource governance | No | `209715200` |
| `LARK_NAME_CACHE_SIZE` | Resource governance | No | `1000` |
| `LARK_CHAT_TYPE_CACHE_SIZE` | Resource governance | No | `1000` |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | Resource governance | No | `1000` |
| `LARK_OWNER_OPEN_ID` | Identity | No | (empty) |
| `LARK_IDENTITY_SESSION_TTL_MS` | Identity | No | auto |
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | Identity | No | `5000` |
| `LARK_AUDIT_LOG` | Privacy | No | `~/.codex/channels/lark/logs/audit.log` |
| `LARK_CARD_CONTEXT_CACHE_SIZE` | Quoted cards | No | `200` |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | Quoted cards | No | `1800000` |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | Quoted cards | No | `4` |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | Quoted cards | No | `12000` |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | Quoted cards | No | `true` |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | Quoted cards | No | `lark-cli` |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | Quoted cards | No | `10000` |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | Quoted cards | No | `262144` |

## Notes

- Shell environment variables override `.env` values.
- Changes require a new Codex session or Codex restart to take effect.
- The `.env` file is read by `src/config.ts` on MCP server startup.
- When updating, always preserve unrecognized keys (user may have custom variables).
