# Codex Lark Plugin

[![docs](https://img.shields.io/badge/docs-中文-blue)](README_CN.md)
[![version](https://img.shields.io/badge/version-1.6.2-informational)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Chat with Codex in real time through Feishu (Lark). Local-file memory, scheduled jobs, rich media support.

---

## How It Works

```
Feishu User ──> Feishu Open Platform ──WebSocket──> codex-lark-plugin (MCP Server) ──> Codex
                                                          <── reply / edit / react ──<
```

The plugin connects to Feishu via the Lark SDK WebSocket client, receives messages in real time, enriches them with memory context, and forwards them to Codex as an MCP channel. Codex's responses are sent back through the Feishu IM API.

---

## Features

### Messaging

- Direct messages (P2P) and group chats (responds to @bot mentions)
- Feishu doc-comment @bot events route into Codex with selected text, parent comment, reply body, and document title context
- Rich message types: text, post (rich text), image, file, audio, video, interactive cards
- **Codex session continuity**: exec delivery stores one Codex session per Feishu chat/thread and resumes it on later messages, so multi-turn conversations keep Codex's native session context
- **Image auto-download**: images are downloaded to a local inbox so Codex can see them directly
- Quoted reply support with automatic parent message fetching, including readable visible text from quoted interactive cards
- Attachment extraction (image, file, audio, video) with type-aware download
- User emoji reactions on bot messages are delivered to Codex as low-noise reaction turns, so the model can return `[LARK_NO_REPLY]` for passive feedback or respond when follow-up is actually needed

### Responding

- Text replies with automatic chunking for long messages (configurable limit)
- **Card rendering**: plain text is preferred. Use Feishu cards sparingly for structured summaries, tables, code blocks, dense lists, or multi-section content that is harder to scan as text. Long or markdown-rich replies may auto-render as pale-red cards; pass `format='card'` to force card, `format='text'` to force plain. Optional `footer` footnote supported
- **Ack reaction**: bot automatically reacts with an emoji (default: MeMeMe) on receive, removes it after replying
- **Doc-comment ack reaction**: inbound doc-comment @mentions receive a persistent configurable emoji reaction (default: THUMBSUP)
- Image and file uploads (images up to 10 MB, files up to 30 MB)
- Message editing (plain text and card markdown)
- Replies to existing Feishu doc-comment threads and creation of new top-level doc comments
- Emoji reactions on any message
- Auto-chunking splits at paragraph, line, or word boundaries

### Memory

- Three-layer architecture: Buffer, Episodic, and Semantic memory
- Auto-flush distillation from conversation buffer to episodic memory; system-initiated flush turns are background-only, so exec failures are logged instead of sent as visible Feishu replies
- Optional Stage 2 profile distillation from recent episodes, default off and gated by per-user cooldowns / minimum episode thresholds
- Local markdown-file storage under `~/.codex/channels/lark/memories/`
- User profiles (tiered public/private since v0.10.0), chat episodes, thread episodes, and global skills
- Memory-enriched context injection on every incoming message, filtered by caller identity

### Privacy & Security (v0.9.0+)

- **Server-derived caller identity**: sensitive tools (`save_memory`, `save_skill`, `create_job`, `list_jobs`, `update_job`, `delete_job`, `what_do_you_know`, `forget_memory`, `run_local_cli_tool`) resolve the calling user from the authenticated Feishu event stream, not from tool arguments — socially-engineered prompts cannot act on behalf of another user
- **Doc-comment binding**: doc-comment tools only run from `doc:<file_token>` turns, require the current `thread_id`, and reject prompt-injected `doc_token` mismatches so comments cannot be posted into a different document
- **Memory transparency (v0.11.0+)**: `what_do_you_know` lists what the bot has stored about the caller (filtered by current-chat visibility); `forget_memory` removes a specific line by hash. Optional `promote_to_rule` feeds corrections into `privacy-rules.md` — a self-learning loop that makes future misclassifications less likely
- **Append-only audit log (v0.11.0+)**: `~/.codex/channels/lark/audit.log` records every sensitive-tool invocation (timestamp / tool / caller / outcome / redacted args) so the operator can retrospectively inspect what was accessed on their machine
- **Terminal skills default to redacted output (v0.11.0+)**: `$lark:jobs` hides prompt bodies by default; verbose opt-in is required. Destructive operations require interactive confirmation
- **Tiered profile memory (v0.10.0+)**: each user's profile is split into `public.md` (visible to anyone who @mentions the user) and `private.md` (owner-only). Private-chat preferences no longer leak into groups via @mention injection
- **L1/L2/L3 classification** (v0.10.0+): hardcoded regex + keyword rules catch phones / credentials / sensitive Chinese keywords. Email is intentionally NOT in L1 — the plugin targets **work-chat use cases** where emails are commonly shared via signatures/directories; personal deployments can add their own "Always private" email rule to `privacy-rules.md`. User-editable `privacy-rules.md` covers personal/org-specific cases; LLM handles the nuance. `parseTieredProfile` applies an L1 safety net over LLM output so misclassified credentials get forced to private
- **Legacy-profile migration respects L2 rules (v0.11.1+)**: if the operator authors `privacy-rules.md` before (or during) the upgrade, `## Always private` phrases are applied as case-insensitive substring matches during migration — org-specific codenames, client names, and people mentions get routed to `private.md` even though L1 alone wouldn't flag them
- **Memory hardening**: public profile writes are server-side checked with L1 and deterministic L2 always-private rules, with sensitive spillover routed to `private.md`; same-user profile operations are serialized; stored memory, quotes, flush buffers, cron prompts, Codex exec prompts, and L2 rules are wrapped as untrusted data in prompts; episode files are capped by `LARK_MAX_EPISODE_BYTES`
- **`list_jobs` visibility filter**: in a group chat, members only see jobs whose `target_chat_id` matches that group (with prompt bodies redacted for non-owners); in a private chat, the caller sees their own jobs. Group members can no longer inspect each other's private jobs
- **Owner-only mutations**: `update_job` / `delete_job` require `caller == created_by`
- **CronJob isolation**: each cronjob execution runs under a unique `thread_id` so scheduled actions don't collide with concurrent human messages in the same chat
- **Terminal fallback**: terminal skill invocations (e.g. `$lark:jobs`) resolve via the reserved `__terminal__` chat id -> `LARK_OWNER_OPEN_ID` only outside active Lark channel turns

### Scheduled Jobs (CronJob)

- **Two job types**: `message` (send fixed content, deterministic) and `prompt` (Codex executes and replies, best-effort)
- Standard cron expressions + simplified aliases (`every 30m`, `daily at 09:00`, `weekdays at 17:00`)
- Create and manage jobs through Feishu chat or the `$lark:jobs` skill
- Crash recovery: missed jobs are executed once on restart
- Job storage as JSON files at `~/.codex/channels/lark/jobs/`

### Reliability

- Per-chat message queue for sequential processing within each conversation
- Shared Feishu API retry/timeout wrapper for hot-path sends, edits, reactions, metadata reads, and downloads
- Attachment/image downloads stream to disk with configurable byte caps and bounded timeouts
- Dependency audit gate available via `npm run audit:deps`
- Single-instance lock to prevent duplicate event handling
- User and chat ID whitelisting for access control (OR semantics when both lists set)
- Crash recovery for scheduled jobs (missed executions run once on restart)

---

## Quick Start

### 1. Create a Feishu Bot

Create a custom app at [Feishu Open Platform](https://open.feishu.cn/app) and enable the following permissions:

| Permission | Purpose |
|---|---|
| `im:message.p2p_msg:readonly` | Receive direct messages |
| `im:message.group_at_msg:readonly` | Receive group @bot messages |
| `im:message:send_as_bot` | Send messages as the bot |
| `im:resource` | Download attachments |
| `im:message.reactions:write` | Add emoji reactions |
| `docs:document.comment:read` | Pre-fetch doc-comment bodies and selected text |
| `docs:document.comment:create` | Post doc-comment replies and new top-level comments |
| `drive:drive.metadata:readonly` | Fetch document titles for doc-comment context |

Enable the WebSocket mode under **Event Subscriptions** and subscribe to these events:
- `im.message.receive_v1` -- receive messages
- `im.message.reaction.created_v1` -- receive user emoji reactions on tracked bot replies
- `drive.notice.comment_add_v1` -- receive doc-comment notifications when @-mentioned

### 2. Install the Plugin

**Via plugin marketplace (recommended):**

Run the following commands in a terminal:

```bash
codex plugin marketplace add https://github.com/IS908/codex-lark-plugin.git
codex plugin add lark@codex-lark-plugin
```

Start a new Codex session after installing so the plugin's skills and MCP server are loaded.

**From source (for development):**

```bash
git clone https://github.com/IS908/codex-lark-plugin.git
cd codex-lark-plugin
npm install
```

For local development, point Codex at this plugin directory so it can read
`.codex-plugin/plugin.json` and `.mcp.json`. You can also run the MCP server
directly for a local smoke test:

```bash
npm start -- --dry-run
```

The dry-run still requires `LARK_APP_ID` and `LARK_APP_SECRET` in `~/.codex/channels/lark/.env` or the shell environment.

Optionally, install [lark-cli](https://github.com/larksuite/cli) for full Feishu API access (calendar, docs, sheets, tasks, contacts, etc.):

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

### 3. Configure Credentials

**Interactive setup (recommended):**

```text
$lark:configure setup
```

This walks you through all configuration options step by step -- credentials, filtering, and memory tuning.

**Quick setup:**

```text
$lark:configure <app_id> <app_secret>
```

**Manual setup:**

```bash
mkdir -p ~/.codex/channels/lark
cat > ~/.codex/channels/lark/.env << 'EOF'
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
EOF
```

### 4. Start

If installed via the plugin marketplace, the plugin starts automatically when Codex launches. Dependencies are installed on first run.

```bash
# If installed from source:
npm start
```

### Updating

**Plugin marketplace:**

```bash
codex plugin marketplace add https://github.com/IS908/codex-lark-plugin.git
codex plugin add lark@codex-lark-plugin
```

Start a new Codex session after reinstalling.

**From source:**

```bash
cd codex-lark-plugin
git pull
```

Configuration in `~/.codex/channels/lark/.env` is preserved across updates. Start a new Codex session or restart Codex to apply changes.

Check current version:

```bash
node -e "console.log(require('./package.json').version)"
```

### Publishing to GitHub

Before the first public push, verify the repository metadata and make sure no local credentials are staged:

```bash
npm install
npm test
npm run check:release-version
npm run audit:deps
git status --short --ignored
```

The repository intentionally tracks `.env.example`, `.mcp.json`, `.codex-plugin/`, `.agents/plugins/marketplace.json`, and the `plugins/lark` marketplace wrapper. Generated output, dependencies, local `.env*` files, logs, and editor/tool state are ignored by `.gitignore`.

Release version checklist:

- Bump `package.json`, `package-lock.json`, `plugins/lark/package.json`, and `plugins/lark/package-lock.json`.
- Bump `.codex-plugin/plugin.json` and `plugins/lark/.codex-plugin/plugin.json`; Codex uses manifest versions when selecting plugin cache directories, so stale manifest versions can leave a new package running from an old runtime cache.
- Update the README badges and `CHANGELOG.md` release heading.
- Run `npm run check:release-version` before tagging. The MCP server-info version is read from `package.json` at startup, so it follows the package version automatically once the package bump is correct.

For a fresh repository:

```bash
git init
git add .
git commit -m "Initial release v1.0.0"
git branch -M main
git remote add origin https://github.com/IS908/codex-lark-plugin.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

If you publish under a different GitHub owner or repository name, update the URLs in `README.md`, `README_CN.md`, `.codex-plugin/plugin.json`, and `plugins/lark/.codex-plugin/plugin.json` before tagging the release.

---

## Memory System

### Three-Layer Architecture

| Layer | Name | Scope | Injection | Storage |
|---|---|---|---|---|
| 1 | Buffer | Per-chat | N/A (in-process) | In-memory ring buffer |
| 2 | Episodic | Per-chat / per-thread | Cold (search-based) | Local markdown files |
| 3 | Semantic | Per-user (profile) or global (skills) | Hot (always loaded) | Local markdown files |

### Memory Enrichment Pipeline

On every incoming message, the plugin injects relevant memory context in this order:

1. **User profile** -- always loaded for the sender (hot injection)
2. **Mentioned user profiles** -- loaded for any @mentioned users
3. **Thread episodes** -- searched by relevance if the message is in a thread
4. **Chat episodes** -- searched by relevance for the current chat
5. **Skills** -- globally searched by relevance

Unchanged memory blocks are deduplicated per `(chat_id, thread_id)` for
`LARK_MEMORY_DEDUP_WINDOW_MS` (30 minutes by default). Profile blocks leave a
small `<memory_context_omitted>` stub when suppressed; episode and skill blocks
are omitted until their content changes or the window expires. A delivery
failure invalidates that scope so the next turn receives the full context.

### Distillation Pipeline

| Stage | Description | Status |
|---|---|---|
| Buffer to Episode | Conversation buffer flushes to episodic memory after inactivity timeout | MVP |
| Episodes to Profile | Optional active-user extraction from recent episodes into tiered profiles; default off, per-user cooldown, L1/L2 safety checks, audited dispatch | Gated |
| Episode compression | Merging and summarizing old episodes | Future |

---

## Configuration Reference

### Required

| Variable | Description |
|---|---|
| `LARK_APP_ID` | Feishu app ID |
| `LARK_APP_SECRET` | Feishu app secret |

### Optional -- Filtering

| Variable | Default | Description |
|---|---|---|
| `LARK_ALLOWED_USER_IDS` | (empty) | Comma-separated list of allowed user open_ids. Empty means all users allowed. |
| `LARK_ALLOWED_CHAT_IDS` | (empty) | Comma-separated list of allowed chat IDs. Empty means all chats allowed. |

> **Whitelist semantics:** when both lists are set, a message is accepted if **either** the sender is in `LARK_ALLOWED_USER_IDS` **or** the chat is in `LARK_ALLOWED_CHAT_IDS` (OR). Setting only one list gates on that list alone.
>
> For `drive.notice.comment_add_v1` doc-comment events, `LARK_ALLOWED_USER_IDS` filters the comment author's `open_id`. If only `LARK_ALLOWED_CHAT_IDS` is set, doc-comment events pass because the synthetic `doc:<file_token>` chat id cannot match a real chat id; Feishu's document ACL and @mention requirement remain the upstream boundary.

### Optional -- Messaging

| Variable | Default | Description |
|---|---|---|
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | Maximum characters per message chunk |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | `30000` | Per-thread message handler timeout in milliseconds |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | `max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000)` | Max wait for a visible reply/defer before logging a missed Lark turn |
| `LARK_CODEX_DELIVERY_MODE` | `exec` | `exec` runs `codex exec` for each Feishu message and sends the final answer directly through Feishu. `notification` keeps the legacy `notifications/Codex/channel` path for compatible hosts. |
| `LARK_CHANNEL_RUNTIME` | `sdk` | Channel runtime selector. `sdk` is the default live runtime during internal testing; set `legacy` to roll back to the pre-SDK WebSocket path without changing credentials, memory, or jobs. |
| `LARK_CODEX_EXEC_COMMAND` | `codex` | Codex CLI command used by exec delivery |
| `LARK_CODEX_EXEC_CWD` | `~/.codex/channels/lark/codex-exec-workdir` | Working directory for `codex exec`; keep it free of `.mcp.json` to avoid recursively loading this Lark MCP server |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | `600000` | Timeout for one `codex exec` run |
| `LARK_CODEX_EXEC_SANDBOX` | `workspace-write` | Sandbox passed to `codex exec`: `read-only`, `workspace-write`, or `danger-full-access` |
| `LARK_CODEX_EXEC_MODEL` | (empty) | Optional model override for exec delivery |
| `LARK_CODEX_EXEC_PROFILE` | (empty) | Optional Codex config profile for exec delivery; startup warns if the selected profile appears to include the Lark MCP server |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | `true` | Pass `--ignore-user-config` to `codex exec` to avoid recursively loading the Lark MCP server |
| `LARK_CODEX_EXEC_USE_SESSIONS` | `true` | Resume one Codex exec session per Feishu `chat_id` / `thread_id`. This preserves multi-turn context inside the Codex CLI session store; it does not attach to an already-open interactive terminal TUI session. |

Exec delivery also supports a parent-process action bridge for built-in actions
that cannot safely call this MCP server from the child `codex exec` process:
`save_memory`, `create_job`, `create_github_issue`, `run_local_cli_tool`, and
`recall_message`. The child returns a validated `LARK_ACTIONS_JSON` marker
block; the parent strips the block from the visible reply, derives caller
identity from the current Feishu event, executes the action locally, and rejects
malformed blocks instead of recursively loading the Lark MCP server.

Because exec delivery is a single-turn flow, the plugin also guards against
misleading follow-up promises. A final answer must not claim that Codex will
create, file, post, or reply later after the visible Feishu reply is sent unless
the same output includes a structured action, `[LARK_DEFER]` /
`[LARK_NO_REPLY]`, or a scheduled job action. If a risky follow-up promise is
returned without such a mechanism, the bridge replaces it with a safe notice
instead of implying that background work will continue.

`create_github_issue` is disabled by default. When enabled, it runs
`gh issue create` with `spawn(..., { shell: false })`, requires a default repo
or repo allowlist, writes the audit log, and returns the created issue URL to
the same IM or doc-comment reply path.

For SDK migration smoke commands, rollout controls, and rollback steps, see
[SDK channel rollout](docs/sdk-channel-rollout.md).

### Optional -- Local CLI Tools

`run_local_cli_tool` is a controlled MCP tool for trusted host-local CLI or
skill-backed workflows, such as `lark-cli`. It does not run shell strings and
does not change the general `codex exec` sandbox. Each invocation resolves the
caller from `IdentitySession`, authorizes against the per-tool config, applies
one parameter filtering mode, runs `spawn(command, args, { shell: false })`,
captures bounded output, redacts common secrets, and writes the audit log.
By default, the child process receives only a small runtime environment
(`HOME`, `PATH`, temp/user/locale keys). Use `envAllowlist` for selected parent
environment keys, literal `env` for fixed values, or `inheritEnv: true` only for
trusted tools that intentionally need the full plugin process environment.

Config file: `LARK_LOCAL_CLI_TOOLS_CONFIG`, default
`~/.codex/channels/lark/local-cli-tools.json`.

```json
{
  "tools": {
    "lark_cli": {
      "command": "/opt/homebrew/bin/lark-cli",
      "allowedSubcommands": ["doc", "drive", "sheets"],
      "paramBlocklist": ["--token", "--secret", "--app-secret", "--debug-dump-env"],
      "envAllowlist": ["LARK_APP_ID"],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "owners"
    },
    "lark_doc_create": {
      "command": "/opt/homebrew/bin/lark-cli",
      "fixedArgs": ["doc", "create"],
      "paramAllowlist": ["--title", "--content", "--folder", "--format"],
      "env": { "LARK_CLI_OUTPUT": "json" },
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "lark_allowed_user_ids"
    }
  }
}
```

`allowedCallers` accepts `"owners"`, `"lark_allowed_user_ids"`, `"public"`, or
an explicit array of Feishu/Lark `open_id` values. Tool configs must set exactly
one of `paramAllowlist` or `paramBlocklist`. Commands must be absolute paths.
Environment keys in `envAllowlist` and `env` must use shell-compatible names
such as `LARK_APP_ID` or `CUSTOM_SAFE`.

### Optional -- Acknowledgement

| Variable | Default | Description |
|---|---|---|
| `LARK_ACK_EMOJI` | `MeMeMe` | Emoji reaction on message receive. Set to empty string to disable. |
| `LARK_DOC_COMMENT_ACK_EMOJI` | `THUMBSUP` | Persistent emoji reaction on inbound doc-comment @mentions. Set to empty string to disable. |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | `500` | Max bot-sent message IDs tracked for reaction-event routing and bot-message mutation guards (FIFO) |

### Optional -- Feishu API reliability

| Variable | Default | Description |
|---|---|---|
| `LARK_FEISHU_API_TIMEOUT_MS` | `30000` | Per Feishu API call timeout in milliseconds |
| `LARK_FEISHU_API_RETRY_ATTEMPTS` | `3` | Attempts for retryable transient Feishu/API/network failures |
| `LARK_FEISHU_API_RETRY_BASE_DELAY_MS` | `250` | Exponential backoff base delay in milliseconds |
| `LARK_DOWNLOAD_MAX_BYTES` | `26214400` | Maximum bytes for downloaded attachments/images before the write is rejected |
| `LARK_DOWNLOAD_TIMEOUT_MS` | `60000` | Attachment/image download timeout in milliseconds |

### Optional -- CronJob

| Variable | Default | Description |
|---|---|---|
| `LARK_CRON_SCAN_INTERVAL` | `60` | CronJob scheduler scan interval in seconds |
| `LARK_CRON_TIMEZONE` | system timezone | IANA timezone for cron schedule evaluation (e.g. `Asia/Shanghai`, `UTC`). Affects how hours in cron expressions map to wall-clock time. |

### Optional -- Codex Exec Session Health

Session-health nudges are off by default and only run when
`LARK_SESSION_HEALTH_ENABLED=true`, `LARK_OWNER_OPEN_ID` is set, and Codex exec
session resume is enabled. Session retention only prunes this plugin's
`codex-sessions/` resume-pointer JSON files; it does not clear, compact, reset,
or delete Codex CLI transcript/session data.

When Codex exec JSONL exposes token/context usage, the monitor uses that real
usage before falling back to the weaker heuristic of exec turn count and prompt
bytes observed by the bridge. It only DMs the owner after the channel is quiet:
the message queue is idle, ack reactions are clear, and no reply obligations are
pending. Repeated nudges use exponential cooldown and stop after the configured
per-session cap. The episode resets when Codex returns a new session id for the
same chat/thread, such as after stale-session recovery, or when the plugin
process restarts.

| Variable | Default | Description |
|---|---|---|
| `LARK_SESSION_HEALTH_ENABLED` | `false` | Enable owner DM nudges for long-running Codex exec sessions |
| `LARK_SESSION_HEALTH_TURN_THRESHOLD` | `80` | Nudge after this many exec turns in the same chat/thread session |
| `LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD` | `524288` | Nudge after this many cumulative prompt bytes when Codex exec JSONL does not expose token usage |
| `LARK_SESSION_HEALTH_TOKEN_THRESHOLD` | `160000` | Nudge after this many reported Codex exec total tokens when JSONL usage is available |
| `LARK_SESSION_HEALTH_IDLE_DELAY_MS` | `30000` | Delay before checking the idle/quiet gates |
| `LARK_SESSION_HEALTH_COOLDOWN_MS` | `1800000` | First nudge cooldown in milliseconds |
| `LARK_SESSION_HEALTH_MAX_COOLDOWN_MS` | `21600000` | Maximum exponential cooldown in milliseconds |
| `LARK_SESSION_HEALTH_MAX_NUDGES` | `3` | Maximum nudges per heuristic session episode |

### Optional -- Codex Exec Session Retention

The plugin stores one small resume pointer per Feishu `chat_id` / `thread_id`
under `~/.codex/channels/lark/codex-sessions/`. Retention cleanup bounds that
pointer directory; it does not delete Codex's own session transcripts. Records
are eligible only after the TTL, and active, recently touched, malformed, or
incomplete records are skipped. Set dry-run mode to preview candidates in logs.

| Variable | Default | Description |
|---|---|---|
| `LARK_CODEX_SESSION_RETENTION_DAYS` | `14` | Keep Codex exec resume-pointer records newer than this many days |
| `LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS` | `24` | Periodic cleanup interval. Set `0` to disable automatic cleanup. |
| `LARK_CODEX_SESSION_RETENTION_DRY_RUN` | `false` | Preview eligible records and emit counts without deleting files |

### Optional -- Memory

| Variable | Default | Description |
|---|---|---|
| `LARK_MIN_SEARCH_SCORE` | `0.3` | Minimum similarity score for memory search results |
| `LARK_MAX_SEARCH_RESULTS` | `2` | Maximum number of memory search results to inject |
| `LARK_INACTIVITY_HOURS` | `3` | Hours of inactivity before buffer flush to episodic memory |
| `LARK_MAX_EPISODE_BYTES` | `65536` | Maximum UTF-8 bytes persisted per episode file before truncation |
| `LARK_MAX_EPISODE_FILES_PER_SCOPE` | `200` | Maximum episode files retained per chat/thread scope after pruning |
| `LARK_MAX_EPISODE_SCOPE_BYTES` | `10485760` | Maximum total episode bytes retained per chat/thread scope after pruning |
| `LARK_PROFILE_DISTILLATION_ENABLED` | `false` | Enable Stage 2 profile distillation from recent episodes into tiered profiles |
| `LARK_PROFILE_DISTILLATION_MIN_EPISODES` | `3` | Minimum episodes in the chat/thread scope before a profile distillation dispatch |
| `LARK_PROFILE_DISTILLATION_MAX_EPISODES` | `5` | Maximum recent episodes included in one profile distillation prompt |
| `LARK_PROFILE_DISTILLATION_COOLDOWN_MS` | `86400000` | Per-user cooldown between profile distillation dispatches |
| `LARK_MEMORY_DEDUP_WINDOW_MS` | `1800000` | Suppress unchanged memory blocks per chat/thread for this many milliseconds. Set `0` to disable. |

### Optional -- Identity / privacy (v0.9.0+)

| Variable | Default | Description |
|---|---|---|
| `LARK_OWNER_OPEN_ID` | (empty) | Operator open_id. Enables terminal skill invocations (e.g. `$lark:jobs`) to resolve the caller via the reserved `__terminal__` chat id outside active Lark turns. When unset, terminal-side sensitive operations are denied. |
| `LARK_IDENTITY_SESSION_TTL_MS` | `max(2h, LARK_INACTIVITY_HOURS × 2h)` | Lifetime of a server-side `(chat_id, thread_id?) → open_id` session entry. Must exceed the auto-flush window so distillation-triggered tool calls still resolve to the last real user. |
| `LARK_IDENTITY_SESSION_MAX_ENTRIES` | `5000` | Maximum server-derived caller session entries retained in memory. Oldest entries are evicted first. |
| `LARK_PRIVACY_RULES_FILE` | `~/.codex/channels/lark/privacy-rules.md` | Override the path to the L2 user rules file. The distiller injects this file's contents into its classification prompt. |
| `LARK_AUDIT_LOG` | `~/.codex/channels/lark/audit.log` | Override the path to the append-only audit log. Every sensitive-tool invocation is recorded (best-effort; log failures never propagate). (v0.11.0+) |
| `LARK_LOCAL_CLI_TOOLS_CONFIG` | `~/.codex/channels/lark/local-cli-tools.json` | Allowlist config for `run_local_cli_tool` host-local CLI execution. (v1.1.0+) |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | `true` | When bot SDK/raw fetches cannot hydrate a quoted Interactive Card, try `lark-cli im +messages-mget --as user` as a best-effort user-identity fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | `lark-cli` | Executable used for the quoted-card user fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | `10000` | Timeout for the quoted-card user fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | `262144` | Maximum stdout/stderr bytes captured from the quoted-card user fallback. |
| `LARK_GITHUB_ISSUE_ACTION_ENABLED` | `false` | Enable the optional `create_github_issue` Codex exec action. |
| `LARK_GITHUB_DEFAULT_REPO` | (empty) | Default `owner/repo` used when the action omits `repo`. |
| `LARK_GITHUB_ALLOWED_REPOS` | (empty) | Comma-separated repo allowlist. When set, `create_github_issue` can only target these repos; when empty, only `LARK_GITHUB_DEFAULT_REPO` is accepted. |
| `LARK_GITHUB_ISSUE_COMMAND` | `gh` | Executable used for GitHub issue creation. It is spawned directly, not through a shell. |
| `LARK_GITHUB_ISSUE_TIMEOUT_MS` | `30000` | Timeout for GitHub issue creation. |
| `LARK_GITHUB_ISSUE_MAX_OUTPUT_BYTES` | `65536` | Maximum stdout/stderr bytes captured from the GitHub issue command. |

### Optional -- Resource Governance

| Variable | Default | Description |
|---|---|---|
| `LARK_DEBUG_LOG` | `~/.codex/channels/lark/debug.log` | Override the debug log path |
| `LARK_LOG_MAX_BYTES` | `5242880` | Rotate debug/audit logs once the active file exceeds this size |
| `LARK_LOG_MAX_FILES` | `5` | Number of rotated log files to retain |
| `LARK_INBOX_MAX_AGE_HOURS` | `168` | Startup cleanup deletes inbox downloads older than this |
| `LARK_INBOX_MAX_BYTES` | `209715200` | Startup cleanup deletes least-recently-used inbox files until under this byte cap |
| `LARK_NAME_CACHE_SIZE` | `1000` | Maximum cached Feishu user/chat display names |
| `LARK_CHAT_TYPE_CACHE_SIZE` | `1000` | Maximum cached Feishu chat type entries |
| `LARK_LATEST_MESSAGE_TRACKER_SIZE` | `1000` | Maximum latest-inbound message tracker entries |
| `LARK_CARD_CONTEXT_CACHE_SIZE` | `200` | Maximum cached fetched-card parent/root contexts |
| `LARK_CARD_CONTEXT_CACHE_TTL_MS` | `1800000` | TTL for fetched interactive-card parent/root context cache |
| `LARK_QUOTED_CONTEXT_MAX_DEPTH` | `4` | Maximum quoted/replied message chain depth hydrated before prompting Codex |
| `LARK_QUOTED_CONTEXT_MAX_BYTES` | `12000` | UTF-8 byte budget for hydrated quoted-message context; oversized content is replaced with an explicit failure marker |

---

## Interactive Configuration

The plugin includes an interactive setup command accessible within Codex:

| Command | Description |
|---|---|
| `$lark:configure` | Show current configuration status (secrets are masked) |
| `$lark:configure <app_id> <app_secret>` | Quick credential setup |
| `$lark:configure setup` | Full interactive walkthrough |
| `$lark:configure clear` | Remove all configuration |

### `$lark:configure setup` Flow

The interactive setup walks through 5 steps, each with the option to skip or use defaults:

```
Step 1: Credentials
  -> LARK_APP_ID and LARK_APP_SECRET (shows masked current values if already set)

Step 2: Filtering (optional)
  -> LARK_ALLOWED_USER_IDS, LARK_ALLOWED_CHAT_IDS

Step 3: CronJob (optional)
  -> LARK_CRON_TIMEZONE

Step 4: Advanced tuning (optional)
  -> LARK_INACTIVITY_HOURS, LARK_MAX_SEARCH_RESULTS, LARK_MIN_SEARCH_SCORE,
     LARK_TEXT_CHUNK_LIMIT, LARK_QUEUE_HANDLER_TIMEOUT_MS,
     LARK_ACK_EMOJI, LARK_BOT_MESSAGE_TRACKER_SIZE,
     LARK_MAX_EPISODE_BYTES, LARK_MAX_EPISODE_FILES_PER_SCOPE,
     LARK_MAX_EPISODE_SCOPE_BYTES, LARK_CRON_SCAN_INTERVAL,
     LARK_FEISHU_API_TIMEOUT_MS, LARK_FEISHU_API_RETRY_ATTEMPTS,
     LARK_FEISHU_API_RETRY_BASE_DELAY_MS,
     LARK_DOWNLOAD_MAX_BYTES, LARK_DOWNLOAD_TIMEOUT_MS,
     LARK_IDENTITY_SESSION_MAX_ENTRIES, LARK_DEBUG_LOG,
     LARK_LOG_MAX_BYTES, LARK_LOG_MAX_FILES, LARK_INBOX_MAX_AGE_HOURS,
     LARK_INBOX_MAX_BYTES, LARK_NAME_CACHE_SIZE,
     LARK_CHAT_TYPE_CACHE_SIZE, LARK_LATEST_MESSAGE_TRACKER_SIZE,
     LARK_QUOTED_CONTEXT_MAX_DEPTH, LARK_QUOTED_CONTEXT_MAX_BYTES,
     LARK_CODEX_SESSION_RETENTION_DAYS,
     LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS,
     LARK_CODEX_SESSION_RETENTION_DRY_RUN

Step 5: Write config
  -> ~/.codex/channels/lark/.env
```

All values are written to `~/.codex/channels/lark/.env`. Changes require a new Codex session or Codex restart to take effect.

---

## lark-cli Integration

Install [lark-cli](https://github.com/nicepkg/lark-cli) for full Feishu API access beyond messaging -- calendar, docs, sheets, tasks, contacts, and more. Once installed, lark-cli skills are loaded by Codex alongside this plugin.

---

## Background Daemon

Run the plugin as a persistent background process using tmux:

```bash
tmux new-session -d -s codex-lark 'bash scripts/start.sh'
```

Reattach with `tmux attach -t codex-lark`. View logs with `tmux capture-pane -t codex-lark -p`.

Stop the active plugin instance safely without deleting lock files by hand:

```bash
npm run stop
# or
bash scripts/stop.sh
```

---

## Available Tools

The plugin registers the following MCP tools for Codex to use:

| Tool | Description |
|---|---|
| `reply` | Send a text reply to a Feishu chat. Supports optional image and file attachments. Long text is auto-chunked. |
| `edit_message` | Edit a previously sent bot message (text or card_markdown). |
| `react` | Add an emoji reaction to a message. |
| `download_attachment` | Download an attachment (image, file, audio, video) from a message to the local inbox. |
| `defer_reply` | Mark the current Lark turn as intentionally deferred or no-reply without sending a Feishu message. Used by the reply-obligation guard. |
| `reply_doc_comment` | Reply to the triggering Feishu doc-comment thread. Owner-only and scoped to the current `doc:<file_token>` turn. |
| `create_doc_comment` | Create a new top-level comment in the triggering Feishu document. Owner-only and scoped to the current `doc:<file_token>` turn. |
| `save_memory` | Save a memory entry (profile / chat episode / thread episode) for cross-session recall. Profile writes target the resolved caller (server-derived, v0.9.0+) and go into the chosen `tier` (`public` or `private`, default `private`, v0.10.0+). Requires `chat_id`. |
| `save_skill` | Save a reusable procedure as a globally searchable skill. Owner-only because skills are visible across users/chats; requires `chat_id` and optional `thread_id` for server-derived caller identity. |
| `create_job` | Create a scheduled cronjob (message or prompt type). Creator derived from session; requires `chat_id` (used to populate `origin_chat_id`). |
| `list_jobs` | List cronjobs visible in the current chat. Filter follows rendering-visibility: private → caller's own jobs, group → jobs with `target_chat_id == currentChat` (prompts redacted for non-owners). Requires `chat_id`. |
| `update_job` | Update a cronjob (schedule, content, pause/resume). Owner-only. Requires `chat_id`. |
| `delete_job` | Delete a cronjob. Owner-only. Requires `chat_id`. |
| `what_do_you_know` | List what the bot has stored in the caller's profile. Filtered by rendering visibility (both tiers in p2p, public only in groups). Each line carries an 8-char hash for use with `forget_memory`. (v0.11.0+) |
| `forget_memory` | Remove a specific line from the caller's profile by hash. Caller-scoped and idempotent. Optional `promote_to_rule` promotes the removal into a durable `## Always private` rule in `privacy-rules.md`. (v0.11.0+) |
| `run_local_cli_tool` | Run a configured allowlisted local CLI capability on the plugin host. Caller identity is server-derived from `chat_id` / `thread_id`; parameters and environment are filtered by `local-cli-tools.json`. (v1.1.0+) |

---

## Requirements

- **Node.js** 20+ and npm
- **Feishu/Lark** custom app with WebSocket mode enabled
- **lark-cli** (optional) -- for extended Feishu API access (calendar, docs, sheets, tasks, contacts)

---

## License

[Apache 2.0](LICENSE)
