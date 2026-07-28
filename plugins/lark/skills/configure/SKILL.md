---
name: configure
description: Configure the codex-lark-plugin by managing ~/.codex/channels/lark/.env. Use when the user asks to configure, setup, or change Lark/Feishu settings or credentials.
---

# lark:configure

Manage the codex-lark-plugin configuration stored in `~/.codex/channels/lark/.env`.

In Codex, invoke this as `$lark:configure`, select the skill from the skill picker, or ask `@lark` to configure credentials.

User arguments: `$ARGUMENTS`

---

## `doctor` — Run live setup diagnostics

1. Resolve this skill's plugin root as two directories above this `SKILL.md`.
2. Run `npm --prefix <plugin-root> run --silent doctor`.
3. Show the complete `PASS` / `WARN` / `FAIL` output to the user.
4. Treat a non-zero exit as a failed diagnosis, not as a tool crash.
5. Do not print the `.env` contents or rerun the underlying APIs manually. The
   doctor already redacts credentials, tokens, authorization headers, and raw
   remote responses.
6. Explain that `event_subscriptions=WARN` requires manual verification in the
   Feishu Open Platform when the read-only application API does not expose the
   subscription list.

The doctor is read-only. It validates local configuration, Node.js, live
credentials, app identity, required/recommended tenant permissions, WebSocket
mode, and the verifiable portion of event subscription readiness.

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

<!-- BEGIN GENERATED CONFIG TABLE -->
| Key | Category | Type | Required | Default | Sensitive |
|-----|----------|------|----------|---------|-----------|
| `LARK_ACK_EMOJI` | Acknowledgement | string | No | MeMeMe | No |
| `LARK_APP_ID` | Credentials | string | Yes | - | No |
| `LARK_APP_SECRET` | Credentials | string | Yes | - | Yes |
| `LARK_AUDIT_LOG` | Privacy | string | No | ~/.codex/channels/lark/logs/audit.log | No |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | Acknowledgement | number | No | 500 | No |
| `LARK_CARD_CONTEXT_CACHE_SIZE` | Quoted cards | number | No | 200 | No |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | Quoted cards | number | No | 1800000 | No |
| `LARK_CARD_FOOTER_METRICS_ENABLED` | Messaging | boolean | No | true | No |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | Messaging | number | No | 20000 | No |
| `LARK_CHAT_TYPE_CACHE_SIZE` | Resource governance | number | No | 1000 | No |
| `LARK_CODEX_EXEC_COMMAND` | Messaging | string | No | codex | No |
| `LARK_CODEX_EXEC_CWD` | Messaging | string | No | ~/.codex/channels/lark/codex-exec-workdir | No |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | Messaging | boolean | No | true | No |
| `LARK_CODEX_EXEC_MODEL` | Messaging | string | No | (empty) | No |
| `LARK_CODEX_EXEC_PROFILE` | Messaging | string | No | (empty) | No |
| `LARK_CODEX_EXEC_SANDBOX` | Messaging | enum(read-only, workspace-write, danger-full-access) | No | workspace-write | No |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | Messaging | number | No | 600000 | No |
| `LARK_CODEX_EXEC_TOOL_TRACE` | Messaging | boolean | No | false | No |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | Messaging | enum(compact, full, hidden) | No | compact | No |
| `LARK_CODEX_EXEC_TRACE_LOG` | Messaging | string | No | ~/.codex/channels/lark/logs/trace.log | No |
| `LARK_CODEX_EXEC_USE_SESSIONS` | Messaging | boolean | No | true | No |
| `LARK_CODEX_SESSION_RETENTION_DAYS` | Messaging | number | No | 14 | No |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | Messaging | boolean | No | false | No |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | Messaging | number | No | 24 | No |
| `LARK_CONTINUATION_ENABLED` | Messaging | boolean | No | true | No |
| `LARK_CONTINUATION_MAX_ATTEMPTS` | Messaging | number | No | 5 | No |
| `LARK_CONTINUATION_MAX_CONCURRENCY` | Messaging | number | No | 1 | No |
| `LARK_CONTINUATION_MAX_RETRIES` | Messaging | number | No | 3 | No |
| `LARK_CONTINUATION_MAX_TOTAL_MINUTES` | Messaging | number | No | 30 | No |
| `LARK_CONTINUATION_RETENTION_DAYS` | Messaging | number | No | 30 | No |
| `LARK_CONTINUATION_WORKING_ROOT` | Messaging | absolute path | No | LARK_CODEX_EXEC_CWD | No |
| `LARK_CRON_SCAN_INTERVAL` | CronJob | number | No | 60 | No |
| `LARK_CRON_TIMEZONE` | CronJob | string | No | system timezone | No |
| `LARK_DEBUG_LOG` | Resource governance | string | No | ~/.codex/channels/lark/logs/debug.log | No |
| `LARK_DOC_COMMENT_ACK_EMOJI` | Acknowledgement | string | No | THUMBSUP | No |
| `LARK_DOWNLOAD_MAX_BYTES` | Reliability | number | No | 26214400 | No |
| `LARK_DOWNLOAD_TIMEOUT_MS` | Reliability | number | No | 60000 | No |
| `LARK_EXEC_PROGRESS_ENABLED` | Messaging | boolean | No | true | No |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | Messaging | number | No | 300 | No |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | Messaging | number | No | 3 | No |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | Messaging | number | No | 15000 | No |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | Messaging | number | No | 250 | No |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | Reliability | number | No | 3 | No |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | Reliability | number | No | 250 | No |
| `LARK_FEISHU_API_TIMEOUT_MS` | Reliability | number | No | 30000 | No |
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | Identity | number | No | 5000 | No |
| `LARK_IDENTITY_SESSION_TTL_MS` | Identity | number | No | max(2h, LARK_INACTIVITY_HOURS x 2h) | No |
| `LARK_INACTIVITY_HOURS` | Memory | number | No | 3 | No |
| `LARK_INBOX_MAX_AGE_HOURS` | Resource governance | number | No | 168 | No |
| `LARK_INBOX_MAX_BYTES` | Resource governance | number | No | 209715200 | No |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | Resource governance | number | No | 1000 | No |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | Resource governance | number | No | 6 | No |
| `LARK_LOG_MAX_BYTES` | Resource governance | number | No | 5242880 | No |
| `LARK_LOG_MAX_FILES` | Resource governance | number | No | 5 | No |
| `LARK_MAX_EPISODE_BYTES` | Memory | number | No | 65536 | No |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | Memory | number | No | 200 | No |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | Memory | number | No | 10485760 | No |
| `LARK_MAX_SEARCH_RESULTS` | Memory | number | No | 2 | No |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | Memory | number | No | 1800000 | No |
| `LARK_MIN_SEARCH_SCORE` | Memory | number | No | 0.3 | No |
| `LARK_NAME_CACHE_SIZE` | Resource governance | number | No | 1000 | No |
| `LARK_OWNER_OPEN_ID` | Identity | string | No | (empty) | No |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | Memory | number | No | 86400000 | No |
| `LARK_PROFILE_DISTILLATION_ENABLED` | Memory | boolean | No | false | No |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | Memory | number | No | 5 | No |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | Memory | number | No | 3 | No |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | Messaging | number | No | LARK_CODEX_EXEC_TIMEOUT_MS + 60000 | No |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | Quoted cards | string | No | lark-cli | No |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | Quoted cards | boolean | No | true | No |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | Quoted cards | number | No | 262144 | No |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | Quoted cards | number | No | 10000 | No |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | Quoted cards | number | No | 12000 | No |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | Quoted cards | number | No | 4 | No |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | Messaging | number | No | max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000) | No |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | Messaging | number | No | 1800000 | No |
| `LARK_SESSION_HEALTH_ENABLED` | Messaging | boolean | No | false | No |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | Messaging | number | No | 30000 | No |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | Messaging | number | No | 21600000 | No |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | Messaging | number | No | 3 | No |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | Messaging | number | No | 524288 | No |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | Messaging | number | No | 160000 | No |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | Messaging | number | No | 80 | No |
| `LARK_TEXT_CHUNK_LIMIT` | Messaging | number | No | 4000 | No |
<!-- END GENERATED CONFIG TABLE -->

## Notes

- Shell environment variables override `.env` values.
- Changes require a new Codex session or Codex restart to take effect.
- The `.env` file is read by `src/config.ts` on MCP server startup.
- When updating, always preserve unrecognized keys (user may have custom variables).
