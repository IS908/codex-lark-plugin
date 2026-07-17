# Codex Lark Plugin

[![docs](https://img.shields.io/badge/docs-中文-blue)](README_CN.md)
[![version](https://img.shields.io/badge/version-2.5.0-informational)](CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%3E%3D24.15.0-339933?logo=node.js&logoColor=white)](package.json)
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
- User emoji reactions on bot messages are delivered to Codex as normal interaction turns with the reacted bot message as context, so the model can continue, retry, ask, reply, or return `[LARK_NO_REPLY]`

### Responding

- Text replies with automatic chunking for long messages (configurable limit)
- Long Lark/Feishu replies are guided toward lightweight Markdown structure when it improves scanability, while short replies, code, logs, JSON, diffs, command output, action blocks, and explicit user-requested formats stay unchanged
- **Card rendering**: simple replies stay as copyable text, while rich Markdown with headings, fenced code, tables, multi-item lists, or structured sections is automatically rendered as a body-only Feishu Schema 2.0 interactive card with no generated header/template. Pass `format='text'` to force plain text, `format='card'` to force a generated card, or a raw `card` payload for pre-built cards. Optional `footer` footnote supported for generated cards; Codex exec card replies can append a compact runtime metrics footer
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

- **Server-derived caller identity**: sensitive tools (`save_memory`, `save_skill`, `create_job`, `list_jobs`, `update_job`, `delete_job`, `what_do_you_know`, `forget_memory`, `run_local_cli_tool`, `manage_access_control`) resolve the calling user from the authenticated Feishu event stream, not from tool arguments — socially-engineered prompts cannot act on behalf of another user
- **Doc-comment binding**: doc-comment tools only run from `doc:<file_token>` turns, require the current `thread_id`, and reject prompt-injected `doc_token` mismatches so comments cannot be posted into a different document
- **Memory transparency (v0.11.0+)**: `what_do_you_know` lists what the bot has stored about the caller (filtered by current-chat visibility); `forget_memory` removes a specific line by hash. Optional `promote_to_rule` feeds corrections into `privacy-rules.md` — a self-learning loop that makes future misclassifications less likely
- **Append-only audit log (v0.11.0+)**: `~/.codex/channels/lark/logs/audit.log` records every sensitive-tool invocation as compact text lines (time / log id / `audit` / tool / outcome / caller / redacted args) so the operator can retrospectively inspect what was accessed on their machine
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

- **Two job types**: `message` sends fixed content deterministically; `prompt` runs through the same `codex exec` delivery path as chat messages
- Prompt job failures include structured run diagnostics: run metadata, observable stage timings, diagnostic-only progress, and redacted `codex exec` stdout/stderr tails when available
- Standard cron expressions + simplified aliases (`every 30m`, `daily at 09:00`, `weekdays at 17:00`)
- Create and manage jobs through Feishu chat or the `$lark:jobs` skill
- Crash recovery: missed jobs are executed once on restart
- Job storage as JSON files at `~/.codex/channels/lark/jobs/`

### Persistent Continuations

- Codex can commit one structured `create_continuation_job` exec action when a foreground P2P, group, or document-comment turn cannot finish safely in one process run. The visible acknowledgement includes a durable Job ID.
- Jobs, attempts, checkpoints, leases, and a multi-event delivery outbox are transactionally stored in `~/.codex/channels/lark/runtime/continuations/jobs.sqlite`; managed artifacts live under the sibling `artifacts/` directory.
- Each Job owns a dedicated Codex execution session. A parent foreground session is provenance only; an unavailable resume session is replaced safely without mutating the foreground chat session.
- `/task list|status|cancel|retry|delete` bypass Codex and remain available for direct control. Creators manage their own tasks; `LARK_OWNER_OPEN_ID` can manage every task. Retry creates a new Job ID, and partial/blocked/failed/cancelled tasks can be retried.
- The parent derives each permission profile from the authenticated sender: the owner and current `allowed_user_ids` members automatically receive `trusted_personal_workspace` for broad local reads, network access, and external operations under a trust-first policy; all other admitted users remain `bounded`. Bounded tasks force approval policy `never`, disable sandbox network access, ignore user Codex config, and cannot send messages, create nested jobs, or perform source-control publishing actions. Trusted attempts always write sanitized command traces keyed by Job/attempt ID. There is no continuation MCP tool. Standard Codex filesystem/shell tools stay inside the sandbox and are never listed in `required_tools`. A task may request one parent-owned `run_local_cli_tool` call per step only when its exact configured host-tool name appears in `required_tools`; caller/config policy and the durable no-blind-replay ledger are still enforced.
- Every committed `continue` attempt queues one bounded factual progress update keyed by `progress:<attempt_id>`. A terminal event uses the reserved `terminal` key, takes delivery priority, and supersedes progress that is still safely known to be undelivered. `/task status ID` shows per-event status, attempt IDs, retry counts, and bounded errors.
- Each IM delivery event reuses one stable Feishu UUID inside its one-hour deduplication window. Document-comment delivery uses a unique event marker and bounded read-back after an ambiguous send. Unreconciled sends become `delivery_unknown` and are not blindly repeated.

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

Dry-run validates local wiring without real Lark credentials; live startup still requires `LARK_APP_ID` and `LARK_APP_SECRET` in `~/.codex/channels/lark/.env` or the shell environment.

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

### Runtime Access Control

Access control is managed in
`~/.codex/channels/lark/runtime-config/access-control.json`, not in `.env`.
`LARK_OWNER_OPEN_ID` remains the immutable trust root. Only the owner can change
runtime access control through `/access` in Lark or the `manage_access_control`
tool, and every attempt is written to the audit log.

```json
{
  "version": 1,
  "revision": 3,
  "updated_at": "2026-07-11T00:00:00.000Z",
  "updated_by": "ou_owner",
  "allowed_user_ids": ["ou_xxx"],
  "allowed_chat_ids": ["oc_xxx"],
  "group_no_mention_chat_ids": ["oc_trusted"]
}
```

Missing file means no user/chat allowlist, so regular messages are accepted,
and no groups are trusted for no-mention triggering. The file is loaded once at
startup; owner mutations persist atomically and update the in-memory snapshot
immediately. External file edits take effect after restart. Invalid reloads or
failed mutations do not replace the last known-good snapshot.

Whitelist semantics stay OR-based: when both `allowed_user_ids` and
`allowed_chat_ids` are non-empty, a message is accepted if either the sender or
the chat matches. Doc-comment events filter on `allowed_user_ids` because their
synthetic `doc:<file_token>` chat id cannot match a real chat id.

By default, group messages still require an explicit @bot mention. Add a group
chat id to `group_no_mention_chat_ids` to allow no-mention triggering for that
trusted group. Top-level no-mention messages pass only when they look like a
clear question or command, or include an actionable Lark/Feishu resource URL;
thread replies in those groups may enter Codex with
`unmentioned_group_trigger=true`, and the prompt requires Codex to return
`[LARK_NO_REPLY]` for low-confidence or unrelated messages.

Owner-only Lark commands:

```text
/access
/access list
/access add user ou_xxx
/access remove user ou_xxx
/access add chat oc_xxx
/access remove chat oc_xxx
/access add chat current
/access remove chat here
/access add no-mention oc_xxx
/access remove no-mention oc_xxx
/access admin list users
/access admin list chats
/access admin list no-mention
```

`/access` and `/access list` report only the current caller/chat status, for
example `User access: allowed`, `Chat access: allowed`, and
`No-mention mode: enabled`. Normal status and mutation responses do not include
the complete configured ID lists. Use the explicit admin list commands above
when the owner needs to inspect the full runtime access configuration.

`current`, `here`, `当前群聊`, and `当前群聊id` are resolved by the bridge from
the current Feishu event. Chat writes require `oc_...` format and a successful
Feishu `chat.get` check before the access-control file is changed.

### Optional -- Messaging

| Variable | Default | Description |
|---|---|---|
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | Maximum characters per message chunk |
| `LARK_QUEUE_HANDLER_TIMEOUT_MS` | `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` | Per-thread queue guardrail in milliseconds. `0` disables it; positive values below `LARK_CODEX_EXEC_TIMEOUT_MS + 60000` are raised to that minimum so `codex exec` owns normal timeout failure replies. |
| `LARK_REPLY_OBLIGATION_TIMEOUT_MS` | `max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000)` | Max wait for a visible reply/defer before logging a missed Lark turn |
| `LARK_CODEX_EXEC_COMMAND` | `codex` | Codex CLI command used by exec delivery |
| `LARK_CODEX_EXEC_CWD` | `~/.codex/channels/lark/codex-exec-workdir` | Working directory for `codex exec`; keep it free of `.mcp.json` to avoid recursively loading this Lark MCP server |
| `LARK_CODEX_EXEC_TIMEOUT_MS` | `600000` | Timeout for one `codex exec` run |
| `LARK_CODEX_EXEC_SANDBOX` | `workspace-write` | Sandbox passed to `codex exec`: `read-only`, `workspace-write`, or `danger-full-access` |
| `LARK_CODEX_EXEC_MODEL` | (empty) | Optional global model override for exec delivery. Realtime chats can override it per chat/thread with `/model <model-id>` when `LARK_CODEX_EXEC_USE_SESSIONS=true`. |
| `LARK_CODEX_EXEC_PROFILE` | (empty) | Optional Codex config profile for exec delivery; startup warns if the selected profile appears to include the Lark MCP server |
| `LARK_CODEX_EXEC_IGNORE_USER_CONFIG` | `true` | Pass `--ignore-user-config` to `codex exec` to avoid recursively loading the Lark MCP server |
| `LARK_CODEX_EXEC_USE_SESSIONS` | `true` | Resume one Codex exec session per Feishu `chat_id` / `thread_id`. This preserves multi-turn context inside the Codex CLI session store; it does not attach to an already-open interactive terminal TUI session. |
| `LARK_EXEC_PROGRESS_ENABLED` | `true` | Enable the bounded Codex exec progress side channel for long-running visible turns |
| `LARK_EXEC_PROGRESS_MAX_MESSAGES` | `3` | Maximum progress messages per Codex exec turn |
| `LARK_EXEC_PROGRESS_MAX_CHARS` | `300` | Maximum characters per progress message |
| `LARK_EXEC_PROGRESS_MIN_INTERVAL_MS` | `15000` | Minimum interval between progress messages in one turn |
| `LARK_EXEC_PROGRESS_POLL_INTERVAL_MS` | `250` | Parent watcher polling interval for progress JSONL |
| `LARK_CODEX_EXEC_TOOL_TRACE` | `false` | Enable local `codex exec --json` tool execution tracing to `trace.log`. This never renders tool traces into Feishu replies. |
| `LARK_CODEX_EXEC_TOOL_TRACE_MODE` | `compact` | Trace mode: `compact` writes sanitized summaries; `full` writes sanitized/truncated event JSON; `hidden` is a compatibility alias that keeps local compact tracing while never showing tool traces in Feishu. |
| `LARK_CODEX_EXEC_TRACE_LOG` | `~/.codex/channels/lark/logs/trace.log` | Override the local codex exec tool trace text log path |
| `LARK_CARD_FOOTER_METRICS_ENABLED` | `true` | Append compact runtime metrics to generated card replies from Codex exec. Plain text replies are unchanged. |
| `LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD` | `20000` | Show token usage in the card footer only when reported total tokens exceed this threshold. |

Realtime Feishu/Lark chats support lightweight control commands. `/help`
renders the command list from the same definition used by the parser so command
help does not drift silently. Model, access, flush, and new-session attempts are
written to the audit log.

```text
/help              Show supported chat commands and permission scope
/model             Show the effective model for the current chat/thread
/model <model-id>  Set a chat/thread model override for subsequent realtime turns
/model reset       Clear only the chat/thread model override
/flush             Distill buffered context now and keep the current Codex session
/new               Distill buffered context, then start a fresh session on next turn
/task list         List your durable background tasks
/task status ID    Show an authorized task's execution and delivery state
/task cancel ID    Cancel a queued/running authorized task
/task retry ID     Clone an incomplete terminal task under a new Job ID
/task delete ID    Redact and delete a terminal authorized task

Owner-only:
/access            Show current user/chat/no-mention access status
/access ...        Manage runtime access control
```

Model resolution order is: chat/thread override, then `LARK_CODEX_EXEC_MODEL`,
then the Codex CLI default. The override is stored on the existing
`codex-sessions` record and follows the same retention lifecycle. `/flush`
persists the current chat/thread buffer into memory and leaves the session
pointer unchanged; it does not create a raw-context isolation boundary. `/new`
runs the same safe flush first, then atomically advances a persisted
chat/thread generation boundary (`cutoffMessageId` + `cutoffTimestampMs`) and
clears only the current chat/thread session pointer. The next turn starts a new
Codex session, receives at most the bounded handoff summary once, and prompt
assembly filters pre-cutoff Recent Thread Context plus quoted/root/hydrated
message bodies before they reach Codex. Older explicitly quoted messages are
not automatically injected across the boundary; the prompt keeps only a compact
omission marker. Long-term memories, jobs, access control, and model overrides
are preserved. If distillation or boundary persistence fails, buffered context,
the current session pointer, and the previous generation boundary are preserved.

Exec delivery can expose a bounded progress side channel for long-running
visible IM/doc-comment turns. The parent bridge creates a temporary JSONL file
and passes its path plus a per-turn token to the child `codex exec` process.
The child may append signed progress events; the parent validates the token and
schema, rejects identity fields such as `chat_id`/`open_id`, drops duplicate or
low-signal filler, enforces the configured count/length/rate limits, and sends
accepted progress messages through the same IM or doc-comment reply path before
the final answer. If the progress file cannot be created, the bridge disables
progress for that turn and still delivers the final reply.

When `LARK_CODEX_EXEC_TOOL_TRACE=true`, the parent bridge also scans
`codex exec --json` stdout for tool execution events and appends sanitized
human-readable text lines to `LARK_CODEX_EXEC_TRACE_LOG`. This is local-only
troubleshooting data: Feishu still receives only the final answer or bounded
progress messages. `compact` mode records a short text line with tool/type,
status, trace id, duration, and sanitized argument/error summary; `full` mode
keeps the event shape with redaction/truncation. Trace log lines include a
`log_id` and `run_id` near the start: ordinary Feishu message turns use the
source message id as `log_id`, cronjob prompt turns use the stable `job_id`,
continuation turns use their durable Job ID, and `run_id` distinguishes repeated
executions of the same source. A Codex process failure also emits one sanitized
`codex_exec failed` record with a stable stage and error code, even when no tool
event was produced. Local trace
lines display a compact run id (`TRACE_RUN_ID_DISPLAY_LENGTH=16`, separators
removed) to keep logs readable, while the bridge still accepts the full
internal `run_id` when querying. When tracing is enabled, the exec action bridge
exposes a bounded `get_run_trace` query for the current/quoted message, an
authorized cronjob, or a continuation Job visible to its creator/owner; it
returns only sanitized structured summaries for all matching runs unless a
`run_id` is supplied, never raw `trace.log` contents.
Debug, audit, and trace logs use
`LARK_CRON_TIMEZONE` for timestamps with an explicit UTC offset, and share the
canonical local diagnostic text format described in
[docs/local-diagnostic-logs.md](docs/local-diagnostic-logs.md).
Progress directories are owner-only (`0700`) and JSONL files are owner-only
read/write (`0600`). Stale `.lark-progress/turn-*` entries older than 12 hours
are removed on startup and by a best-effort hourly cleanup.

For generated card replies, `LARK_CARD_FOOTER_METRICS_ENABLED=true` appends a
compact runtime footer after the final `turn.completed` event is available,
for example `🔧4 · 🧩2 · ⏱18s · 📊 I62.4k(C48.2k) O1.3k T63.7k`. Existing
business footer text is preserved before the runtime footer. Token usage is
omitted when usage is unavailable or `total_tokens` does not exceed
`LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD`; elapsed time is still shown.

Exec delivery also supports a parent-process action bridge for built-in actions
that cannot safely call this MCP server from the child `codex exec` process:
`save_memory`, `create_job`, `list_jobs`, `update_job`, `disable_job`,
`delete_job`, `upsert_job`, `run_local_cli_tool`, `manage_access_control`,
`send_message`, and `recall_message`. The parent creates
an owner-only action JSONL side channel for each `codex exec` turn and passes
the child only a file path plus per-turn token. The child writes structured
action requests there while stdout remains user-visible reply text only. The
parent validates token/schema, rejects child-supplied identity fields, derives
caller identity from the current Feishu event, executes accepted actions
locally, and fails malformed action requests instead of recursively loading the
Lark MCP server. `create_job` and `list_jobs` expose
stable `job_id` values so later turns can update, pause, replace, or delete the
exact reminder instead of recreating a duplicate name.
`send_message` is the exec-mode media action: it can send image/file attachments
through the plugin runtime identity using a local path, the current inbound
message's first downloaded image, or a quoted/replied message's first image. It
also supports ordered `kind=rich`
text+image parts, preferring one Feishu post and falling back to ordered split
messages when rich post delivery is unavailable. Audio/video and interactive
cards remain separate follow-up design work.

External project-management writes are intentionally not built into the core
Lark plugin. Creating GitHub/GitLab issues, Jira tickets, Linear issues, PRs,
or project-governance review proposals should be modeled as user-configured
skills, custom MCP tools, normal Codex runtime tools, or allowlisted
`run_local_cli_tool` workflows. The plugin provides the Lark channel, identity,
cronjob, audit, and generic local tool boundary; provider-specific policy stays
outside the plugin.

Because exec delivery is a single-turn flow, the plugin also guards against
misleading follow-up promises. A final answer must not claim that Codex will
create, file, post, or reply later after the visible Feishu reply is sent unless
the same output includes a structured action, `[LARK_DEFER]` /
`[LARK_NO_REPLY]`, or a scheduled job action. If a risky follow-up promise is
returned without such a mechanism, the bridge replaces it with a safe notice
instead of implying that background work will continue.

For SDK migration smoke commands, rollout controls, rollback steps, and
compatibility removal gates, see [SDK channel rollout](docs/sdk-channel-rollout.md)
and [transition compatibility matrix](docs/transition-compatibility.md).

### Optional -- Local CLI Tools

`run_local_cli_tool` is an optional sandbox host-tool bridge for trusted
host-local CLI or skill-backed workflows, such as `lark-cli`. It is exposed to
`codex exec` prompts only when `LARK_CODEX_EXEC_SANDBOX` is `read-only` or
`workspace-write` and at least one allowlisted tool exists. It is an additional
capability, not an exclusive route for external systems: Codex may still use
other available skills, connectors, MCP tools, runtime tools, or normal CLI
access when they are available. Missing bridge config should not by itself make
Codex stop at a draft.

The bridge does not run shell strings and does not change the general
`codex exec` sandbox. Foreground invocations resolve the caller from
`IdentitySession`; continuation invocations use the creator identity persisted
from the authenticated source event. Each path authorizes against the same
per-tool config, applies one parameter filtering mode, runs
`spawn(command, args, { shell: false })`, captures bounded output, redacts
common secrets, and writes the audit log.
By default, the child process receives only a small runtime environment
(`HOME`, `PATH`, temp/user/locale keys). Use `envAllowlist` for selected parent
environment keys, literal `env` for fixed values, or `inheritEnv: true` only for
trusted tools that intentionally need the full plugin process environment.

Config file: `~/.codex/channels/lark/runtime-config/local-cli-tools.json`.

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
    },
    "my_tracker_create_item": {
      "command": "/Users/you/bin/my-tracker-create-item",
      "fixedArgs": [],
      "paramAllowlist": ["--project", "--title", "--body", "--label"],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "allowedCallers": "owners"
    }
  }
}
```

`allowedCallers` accepts `"owners"`, `"lark_allowed_user_ids"`, `"public"`, or
an explicit array of Feishu/Lark `open_id` values. Tool configs must set exactly
one of `paramAllowlist` or `paramBlocklist`. Commands must be absolute paths.
Environment keys in `envAllowlist` and `env` must use shell-compatible names
such as `LARK_APP_ID` or `CUSTOM_SAFE`.

Bounded continuation tasks can use these tools without enabling network in
the sandboxed Codex process. Trusted-profile tasks may enable sandbox network
independently; the host bridge still applies its own allowlist. The `required_tools` array written when the task is
created declares only additional parent-owned host CLI tools. Standard Codex
tools such as `exec_command` and `apply_patch` must not be included; use
`required_tools: []` for routine repository analysis. Any non-empty entry must
contain the exact key under `tools` (for example `lark_cli`), and
the same tool must be configured when the task is created, then remain configured
and authorize the persisted creator when it runs. Unknown names are rejected before the Job
is persisted. `required_tools` declares task intent; it is not a second allowlist
and never grants a command by itself. Ask the foreground turn to
create a background task that requires the configured tool name. Existing jobs
with `required_tools: []` do not gain access and must be recreated.

One host tool request is allowed per continuation step. The parent records a
request fingerprint before spawning the configured command, then returns the
bounded redacted result to the same sandboxed Codex session. A completed call
reuses its stored result after recovery; a call left in progress has an
ambiguous external outcome and blocks the task instead of being replayed.

External tracker examples are user-owned wrappers, not plugin-provided tools or
reserved action names. For example, `my_tracker_create_item` above would be a
local script outside this repository, with its own argument validation, required
field checks, provider CLI capability probes, and dry-run tests for argument
assembly before any write path is enabled. You can also expose a separate
provider-specific skill or custom MCP server. The core plugin does not parse
GitHub/GitLab/Jira/Linear semantics and does not provide built-in issue or PR
creation tools.

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
| `LARK_CRON_TIMEZONE` | system timezone | Default IANA timezone for new cronjobs and local debug/audit/trace log timestamps (e.g. `Asia/Shanghai`, `UTC`). Each job stores its own `meta.timezone`; changing this env var later does not silently retime existing jobs. |

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

### Persistent Continuation Runtime

v2.0.0 is a direct cutover and requires Node.js 24.15.0 or newer for the built-in
`node:sqlite` runtime. There is no legacy continuation implementation or rollout
flag to preserve. Upgrade Node before restarting the plugin; rollback requires
reinstalling v1.21.4 rather than enabling compatibility code.

| Variable | Default | Description |
|---|---|---|
| `LARK_CONTINUATION_ENABLED` | `true` | Enable durable background continuation creation and execution |
| `LARK_CONTINUATION_MAX_CONCURRENCY` | `1` | Concurrent continuation executions (`1`-`4`) |
| `LARK_CONTINUATION_MAX_ATTEMPTS` | `5` | Maximum execution attempts per Job (`1`-`20`) |
| `LARK_CONTINUATION_MAX_RETRIES` | `3` | Retryable execution failures within the attempt budget (`0`-`10`) |
| `LARK_CONTINUATION_MAX_TOTAL_MINUTES` | `30` | Maximum Job lifetime (`5`-`1440` minutes) |
| `LARK_CONTINUATION_RETENTION_DAYS` | `30` | Days before terminal task details and managed artifacts are redacted |
| `LARK_CONTINUATION_WORKING_ROOT` | `LARK_CODEX_EXEC_CWD` | Absolute root authorized for continuation working directories |

The penultimate attempt receives a convergence warning. The final attempt must
return `completed`, `partial`, `blocked`, or `failed`; a model-produced
`continue` is converted deterministically to `partial` from its checkpoint.

`working_directory` in a continuation action is relative to this root. For
example, with `LARK_CONTINUATION_WORKING_ROOT=/Users/you/workspace`, use
`working_directory="aitask"` to run under `/Users/you/workspace/aitask`.
Creation and every execution require an existing directory and enforce both
lexical and realpath containment, including symlink escape checks.

The action does not accept `capability_profile`. The parent derives it from the
authenticated sender: `LARK_OWNER_OPEN_ID` and users explicitly listed in the
current `allowed_user_ids` access-control list automatically receive
`trusted_personal_workspace`; users admitted only through `allowed_chat_ids`
remain `bounded`. `requested_paths` is optional and defaults to the canonical
`working_directory`. Supplied paths may be absolute or relative to
`LARK_CONTINUATION_WORKING_ROOT`, must exist at creation time, and are persisted
as canonical absolute paths. They are preflight and audit metadata, not a
capability grant or read allowlist.

`trusted_personal_workspace` requests Codex CLI `disk-full-read-access`, enables
sandbox network access, and allows the background Codex process to perform external operations required by the user
objective. It does not yet classify or interactively approve individual remote
effects. Use it only for trusted users. Creator eligibility is checked again at
every attempt, so removing a user from `allowed_user_ids` blocks queued/retried
trusted Jobs. The Job permission snapshot is recorded
in `audit.log`, and sanitized command/tool events are forced into `trace.log`
with Job ID and attempt ID correlation even when
`LARK_CODEX_EXEC_TOOL_TRACE=false`. Secrets continue through the existing
diagnostic redaction path; file contents are not copied into audit records.

Each Job persists a server-derived permission envelope. Execution uses the
intersection of that snapshot and current operator policy: the working
directory must remain beneath both roots, `read-only` wins over
`workspace-write`, and host tools must be declared in the Job and still pass the
current `local-cli-tools.json` policy. Network is disabled for `bounded` Jobs and
enabled only by a server-derived, eligible `trusted_personal_workspace` snapshot;
foreground approvals/configuration are never inherited. Existing permission
JSON without profile fields is read conservatively as `bounded`, so no SQLite
schema fork is needed. Existing v1/v2 SQLite Jobs migrate
conservatively. `approval.mode=interactive` is reserved in the persisted
protocol but is not executable in v2.2.0; such a Job fails closed as blocked.
A future coordinator must bind one-time approval to an operation digest,
requester and approver identities, expiry, decision, and single consumption.

The SQLite database uses WAL mode, process-safe leases, transactional terminal
outbox creation, and startup lease recovery. Initialization failure degrades
only continuation actions and `/task`; ordinary chat and cronjob processing stay
available. `delivery_unknown` means the provider may already have accepted the
terminal result, so `/task retry` refuses to rerun it and the user must make a
new foreground request after checking Lark. Diagnostic logs include Job/attempt
IDs but omit objectives, checkpoints, result bodies, and credentials.

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
| `LARK_AUDIT_LOG` | `~/.codex/channels/lark/logs/audit.log` | Override the path to the append-only text-line audit log. Every sensitive-tool invocation is recorded (best-effort; log failures never propagate). (v0.11.0+) |
| `LARK_QUOTED_CARD_USER_FETCH_ENABLED` | `true` | When bot SDK/raw fetches cannot hydrate a quoted Interactive Card, try `lark-cli im +messages-mget --as user` as a best-effort user-identity fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_COMMAND` | `lark-cli` | Executable used for the quoted-card user fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS` | `10000` | Timeout for the quoted-card user fallback. |
| `LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES` | `262144` | Maximum stdout/stderr bytes captured from the quoted-card user fallback. |

L2 privacy rules live at
`~/.codex/channels/lark/runtime-config/privacy-rules.md`. Local CLI allowlists
live at `~/.codex/channels/lark/runtime-config/local-cli-tools.json`.

### Optional -- Resource Governance

| Variable | Default | Description |
|---|---|---|
| `LARK_DEBUG_LOG` | `~/.codex/channels/lark/logs/debug.log` | Override the debug log path. Debug lines use `LARK_CRON_TIMEZONE` timestamps and omit bracket wrappers, e.g. `2026-07-10T19:20:50.822+08:00 channel ...`. |
| `LARK_LOG_MAX_BYTES` | `5242880` | Rotate debug/audit/trace logs once the active file exceeds this size |
| `LARK_LOG_MAX_FILES` | `5` | Number of rotated log files to retain |
| `LARK_LOG_ARCHIVE_RETENTION_MONTHS` | `6` | Compress previous-month debug/audit/trace logs under `archive/YYYY-MM/` and keep this many archive months. Set `0` to disable monthly archival. |
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

Step 2: Runtime access control (optional)
  -> owner-managed after setup with /access or manage_access_control

Step 3: CronJob (optional)
  -> LARK_CRON_TIMEZONE (default timezone for newly created jobs)

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
     LARK_LOG_MAX_BYTES, LARK_LOG_MAX_FILES, LARK_LOG_ARCHIVE_RETENTION_MONTHS,
     LARK_CODEX_EXEC_TRACE_LOG,
     LARK_INBOX_MAX_AGE_HOURS,
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
| `create_job` | Create a scheduled cronjob (message or prompt type). Creator derived from session; requires `chat_id` (used to populate `origin_chat_id`). Optional `timezone` stores an explicit IANA timezone in the job file. |
| `list_jobs` | List cronjobs visible in the current chat. Filter follows rendering-visibility: private → caller's own jobs, group → jobs with `target_chat_id == currentChat` (prompts redacted for non-owners). Requires `chat_id`; renders each job's own timezone plus UTC. |
| `update_job` | Update a cronjob (schedule, timezone, content, pause/resume). Owner-only. Requires `chat_id`. |
| `delete_job` | Delete a cronjob. Owner-only. Requires `chat_id`. |
| `what_do_you_know` | List what the bot has stored in the caller's profile. Filtered by rendering visibility (both tiers in p2p, public only in groups). Each line carries an 8-char hash for use with `forget_memory`. (v0.11.0+) |
| `forget_memory` | Remove a specific line from the caller's profile by hash. Caller-scoped and idempotent. Optional `promote_to_rule` promotes the removal into a durable `## Always private` rule in `privacy-rules.md`. (v0.11.0+) |
| `run_local_cli_tool` | Optional sandbox host-tool bridge for a configured allowlisted local CLI capability on the plugin host; it is additive and not an exclusive route for external systems. Caller identity is server-derived from `chat_id` / `thread_id`; parameters and environment are filtered by `local-cli-tools.json`. (v1.1.0+) |
| `manage_access_control` | Owner-only list/add/remove for runtime access control. Mirrors `/access` and audits every attempt. |

---

## Requirements

- **Node.js** >= 24.15.0 and npm
- **Feishu/Lark** custom app with WebSocket mode enabled
- **lark-cli** (optional) -- for extended Feishu API access (calendar, docs, sheets, tasks, contacts)

---

## License

[Apache 2.0](LICENSE)
