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

=== Filtering ===
LARK_ALLOWED_USER_IDS:     (not set)
LARK_ALLOWED_CHAT_IDS:     (not set)

=== Messaging ===
LARK_TEXT_CHUNK_LIMIT:              4000
LARK_QUEUE_HANDLER_TIMEOUT_MS:      660000
LARK_CODEX_DELIVERY_MODE:           exec
LARK_CODEX_EXEC_COMMAND:            codex
LARK_CODEX_EXEC_CWD:                plugin cwd
LARK_CODEX_EXEC_TIMEOUT_MS:         600000
LARK_CODEX_EXEC_SANDBOX:            workspace-write
LARK_CODEX_EXEC_MODEL:              (not set)
LARK_CODEX_EXEC_PROFILE:            (not set)
LARK_CODEX_EXEC_IGNORE_USER_CONFIG: true
LARK_CODEX_EXEC_USE_SESSIONS:       true

=== Acknowledgement ===
LARK_ACK_EMOJI:                MeMeMe
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
LARK_DEBUG_LOG:                   ~/.codex/channels/lark/debug.log
LARK_LOG_MAX_BYTES:               5242880
LARK_LOG_MAX_FILES:               5
LARK_INBOX_MAX_AGE_HOURS:         168
LARK_INBOX_MAX_BYTES:             209715200
LARK_NAME_CACHE_SIZE:             1000
LARK_CHAT_TYPE_CACHE_SIZE:        1000
LARK_LATEST_MESSAGE_TRACKER_SIZE: 1000

=== Identity / Privacy ===
LARK_OWNER_OPEN_ID:               (not set)
LARK_IDENTITY_SESSION_TTL_MS:     auto
LARK_PRIVACY_RULES_FILE:          ~/.codex/channels/lark/privacy-rules.md
LARK_AUDIT_LOG:                   ~/.codex/channels/lark/audit.log
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

### Step 2: Filtering (optional)

Ask if the user wants to restrict access:
- `LARK_ALLOWED_USER_IDS` — comma-separated sender open_id whitelist. Empty = allow all.
- `LARK_ALLOWED_CHAT_IDS` — comma-separated chat ID whitelist. Empty = allow all.
- If user says "skip" or "no", leave these empty.

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
- `LARK_CODEX_DELIVERY_MODE` — `exec` or `notification` (default: `exec`)
- `LARK_CODEX_EXEC_SANDBOX` — sandbox passed to `codex exec` (default: `workspace-write`)
- `LARK_CODEX_EXEC_USE_SESSIONS` — resume one Codex session per Feishu chat/thread (default: true)
- `LARK_ACK_EMOJI` — emoji reaction on message receive, empty to disable (default: `MeMeMe`)
- `LARK_BOT_MESSAGE_TRACKER_SIZE` — max bot message IDs tracked for reaction filtering (default: 500)
- `LARK_CRON_SCAN_INTERVAL` — cronjob scan interval in seconds (default: 60)
- `LARK_FEISHU_API_TIMEOUT_MS` — timeout for Feishu API calls (default: 30000)
- `LARK_FEISHU_API_RETRY_ATTEMPTS` — retry attempts for retryable Feishu API failures (default: 3)
- `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` — base delay for Feishu API retry backoff (default: 250)
- `LARK_DOWNLOAD_MAX_BYTES` — max bytes for streamed downloads (default: 26214400)
- `LARK_DOWNLOAD_TIMEOUT_MS` — timeout for attachment/image downloads (default: 60000)
- `LARK_MAX_EPISODE_BYTES` — max bytes per episode file before truncation (default: 65536)
- `LARK_MAX_EPISODE_FILES_PER_SCOPE` — max episode files per chat/thread scope (default: 200)
- `LARK_MAX_EPISODE_SCOPE_BYTES` — max total episode bytes per chat/thread scope (default: 10485760)
- `LARK_IDENTITY_SESSION_MAX_ENTRIES` — max caller session entries (default: 5000)
- `LARK_DEBUG_LOG` — debug log path (default: `~/.codex/channels/lark/debug.log`)
- `LARK_LOG_MAX_BYTES` — rotate debug/audit logs after this many bytes (default: 5242880)
- `LARK_LOG_MAX_FILES` — rotated log files to keep (default: 5)
- `LARK_INBOX_MAX_AGE_HOURS` — remove old inbox downloads on startup (default: 168)
- `LARK_INBOX_MAX_BYTES` — LRU byte cap for inbox downloads (default: 209715200)
- `LARK_NAME_CACHE_SIZE` — max cached Feishu user/chat names (default: 1000)
- `LARK_CHAT_TYPE_CACHE_SIZE` — max cached Feishu chat types (default: 1000)
- `LARK_LATEST_MESSAGE_TRACKER_SIZE` — max latest-message tracker entries (default: 1000)

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
   `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_ALLOWED_USER_IDS`,
   `LARK_ALLOWED_CHAT_IDS`, `LARK_TEXT_CHUNK_LIMIT`, `LARK_QUEUE_HANDLER_TIMEOUT_MS`,
   `LARK_INACTIVITY_HOURS`,
   `LARK_MAX_SEARCH_RESULTS`, `LARK_MIN_SEARCH_SCORE`,
   `LARK_CODEX_DELIVERY_MODE`, `LARK_CODEX_EXEC_COMMAND`,
   `LARK_CODEX_EXEC_CWD`, `LARK_CODEX_EXEC_TIMEOUT_MS`,
   `LARK_CODEX_EXEC_SANDBOX`, `LARK_CODEX_EXEC_MODEL`,
   `LARK_CODEX_EXEC_PROFILE`, `LARK_CODEX_EXEC_IGNORE_USER_CONFIG`,
   `LARK_CODEX_EXEC_USE_SESSIONS`,
   `LARK_ACK_EMOJI`, `LARK_BOT_MESSAGE_TRACKER_SIZE`,
   `LARK_CRON_SCAN_INTERVAL`, `LARK_CRON_TIMEZONE`,
   `LARK_FEISHU_API_TIMEOUT_MS`, `LARK_FEISHU_API_RETRY_ATTEMPTS`,
   `LARK_FEISHU_API_RETRY_BASE_DELAY_MS`, `LARK_DOWNLOAD_MAX_BYTES`,
   `LARK_DOWNLOAD_TIMEOUT_MS`, `LARK_MAX_EPISODE_BYTES`,
   `LARK_MAX_EPISODE_FILES_PER_SCOPE`, `LARK_MAX_EPISODE_SCOPE_BYTES`,
   `LARK_IDENTITY_SESSION_MAX_ENTRIES`, `LARK_DEBUG_LOG`,
   `LARK_LOG_MAX_BYTES`, `LARK_LOG_MAX_FILES`,
   `LARK_INBOX_MAX_AGE_HOURS`, `LARK_INBOX_MAX_BYTES`,
   `LARK_NAME_CACHE_SIZE`, `LARK_CHAT_TYPE_CACHE_SIZE`,
   `LARK_LATEST_MESSAGE_TRACKER_SIZE`,
   `LARK_OWNER_OPEN_ID`, `LARK_IDENTITY_SESSION_TTL_MS`,
   `LARK_PRIVACY_RULES_FILE`, `LARK_AUDIT_LOG`.
3. If the file becomes empty, delete it.
4. Confirm: "All configuration cleared."

---

## Recognized config keys

| Key | Category | Required | Default |
|-----|----------|----------|---------|
| `LARK_APP_ID` | Credentials | Yes | - |
| `LARK_APP_SECRET` | Credentials | Yes | - |
| `LARK_INACTIVITY_HOURS` | Memory | No | `3` |
| `LARK_MAX_SEARCH_RESULTS` | Memory | No | `2` |
| `LARK_MIN_SEARCH_SCORE` | Memory | No | `0.3` |
| `LARK_ALLOWED_USER_IDS` | Filtering | No | (empty) |
| `LARK_ALLOWED_CHAT_IDS` | Filtering | No | (empty) |
| `LARK_TEXT_CHUNK_LIMIT` | Messaging | No | `4000` |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | Messaging | No | `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` |
| `LARK_CODEX_DELIVERY_MODE` | Messaging | No | `exec` |
| `LARK_CODEX_EXEC_COMMAND` | Messaging | No | `codex` |
| `LARK_CODEX_EXEC_CWD` | Messaging | No | plugin cwd |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | Messaging | No | `600000` |
| `LARK_CODEX_EXEC_SANDBOX` | Messaging | No | `workspace-write` |
| `LARK_CODEX_EXEC_MODEL` | Messaging | No | (empty) |
| `LARK_CODEX_EXEC_PROFILE` | Messaging | No | (empty) |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | Messaging | No | `true` |
| `LARK_CODEX_EXEC_USE_SESSIONS` | Messaging | No | `true` |
| `LARK_ACK_EMOJI` | Acknowledgement | No | `MeMeMe` |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | Acknowledgement | No | `500` |
| `LARK_CRON_SCAN_INTERVAL` | CronJob | No | `60` |
| `LARK_CRON_TIMEZONE` | CronJob | No | system timezone |
| `LARK_FEISHU_API_TIMEOUT_MS` | Reliability | No | `30000` |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | Reliability | No | `3` |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | Reliability | No | `250` |
| `LARK_DOWNLOAD_MAX_BYTES` | Reliability | No | `26214400` |
| `LARK_DOWNLOAD_TIMEOUT_MS` | Reliability | No | `60000` |
| `LARK_MAX_EPISODE_BYTES` | Memory | No | `65536` |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | Resource governance | No | `200` |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | Resource governance | No | `10485760` |
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | Resource governance | No | `5000` |
| `LARK_DEBUG_LOG` | Resource governance | No | `~/.codex/channels/lark/debug.log` |
| `LARK_LOG_MAX_BYTES` | Resource governance | No | `5242880` |
| `LARK_LOG_MAX_FILES` | Resource governance | No | `5` |
| `LARK_INBOX_MAX_AGE_HOURS` | Resource governance | No | `168` |
| `LARK_INBOX_MAX_BYTES` | Resource governance | No | `209715200` |
| `LARK_NAME_CACHE_SIZE` | Resource governance | No | `1000` |
| `LARK_CHAT_TYPE_CACHE_SIZE` | Resource governance | No | `1000` |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | Resource governance | No | `1000` |
| `LARK_OWNER_OPEN_ID` | Identity | No | (empty) |
| `LARK_IDENTITY_SESSION_TTL_MS` | Identity | No | auto |
| `LARK_PRIVACY_RULES_FILE` | Privacy | No | `~/.codex/channels/lark/privacy-rules.md` |
| `LARK_AUDIT_LOG` | Privacy | No | `~/.codex/channels/lark/audit.log` |

## Notes

- Shell environment variables override `.env` values.
- Changes require a new Codex session or Codex restart to take effect.
- The `.env` file is read by `src/config.ts` on MCP server startup.
- When updating, always preserve unrecognized keys (user may have custom variables).
