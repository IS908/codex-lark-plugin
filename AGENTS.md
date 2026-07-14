# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Codex Lark Plugin is an MCP (Model Context Protocol) channel plugin that connects Codex to Feishu/Lark via WebSocket. It receives messages from Feishu users, enriches them with memory context, and forwards them to Codex. Responses flow back through the Feishu IM API.

## Commands

```bash
npm start              # Run with tsx (development)
npm run build          # Compile TypeScript to dist/
npm run typecheck      # Type-check without emitting
bash scripts/start.sh  # Production launcher (loads lark-cli skills)
npm start -- --dry-run # Validate config and module loading without connecting
```

## Architecture

```
src/index.ts        – Entry point: wires MCP server, LarkChannel, memory, and buffer together
src/config.ts       – Loads config from ~/.codex/channels/lark/.env (dotenv)
src/channel.ts      – LarkChannel: Feishu WebSocket client, message parsing, memory enrichment pipeline
src/tools.ts        – Registers core MCP tools: reply_doc_comment, create_doc_comment, reply, edit_message, react, download_attachment, defer_reply, save_memory, save_skill, create_job, list_jobs, update_job, delete_job, what_do_you_know, forget_memory
src/local-cli-tools.ts – Registers optional `run_local_cli_tool` from the local allowlist config
src/audit-log.ts    – Append-only audit log for sensitive tool invocations
src/feishu-card.ts  – Card builder: markdown optimization, Schema 2.0 card assembly
src/job-store.ts    – Job CRUD: read/write JSON files, sanitizeJobId, expandScheduleAlias
src/scheduler.ts    – JobScheduler: periodic scan (60s), trigger execution, crash recovery
src/queue.ts        – Per-thread sequential message queue
src/memory/
  file.ts           – MemoryStore: local markdown files under ~/.codex/channels/lark/memories/ (Episodes, tiered Profiles public.md/private.md, Skills)
  buffer.ts         – In-memory ring buffer with auto-flush on inactivity
  distiller.ts      – Builds flush prompts to distill buffer into episodic memory; parseTieredProfile with L1 safety net
src/privacy-rules.ts  – L1 hardcoded regex + keyword rules; L2 user-rules file (privacy-rules.md) read/append
```

**Data flow:** Feishu event → `LarkChannel.handleMessageEvent` → whitelist check → ack reaction (MeMeMe) → text extraction → image auto-download → enqueue per-chat → record in buffer → enrich with memory (profile + episodes + skills) → deliver by configured mode:
- `exec` (default): run `codex exec` and reply directly through Feishu. The plugin stores one Codex session id per Feishu `chat_id` / `thread_id` under `~/.codex/channels/lark/codex-sessions/` and resumes it with `codex exec resume` for multi-turn continuity.
  - Long-running visible turns can emit bounded progress updates through a parent-owned JSONL side channel (`LARK_EXEC_PROGRESS_*`): the child gets only a file path + per-turn token, while the parent validates token/schema, rejects identity fields, filters filler/duplicates, and sends accepted progress via the same IM/doc-comment reply path before the final answer.
- `notification`: forward via `notifications/Codex/channel`; Codex calls `reply` tool; response sent back to Feishu.
After either mode replies, the ack reaction is revoked.

**Exec media action:** `send_message` is available only in the parent-owned
Codex exec action bridge, not as an MCP tool. It supports image/file attachments
from local paths, `current_message:first_image`, and `quoted_message:first_image`,
plus ordered `kind=rich`
text+image parts that prefer one Feishu post and fall back to ordered split
messages. All variants route through `sendFeishuReply` so thread routing and
plugin runtime identity stay centralized.

**Reaction flow:** Feishu reaction event → `handleReactionEvent` / `handleSdkReactionEvent` → filter bot self, untracked messages, and whitelists → enqueue a normal `messageType="reaction"` turn for user reactions on tracked bot replies. Codex sees the emoji, reactor, and target bot message context, then decides whether to continue, retry, ask, respond, or return `[LARK_NO_REPLY]`. Bot self-reaction echoes and reactions on untracked messages are still dropped.

**CronJob flow:** `JobScheduler.tick()` every 60s → read all job files → for each active job where `next_run_at <= now` → execute (message: direct Feishu API / prompt: in `exec` mode, run through the same `codex exec` delivery path as chat messages under a unique `thread_id` + bind session identity to `job.created_by`; in `notification` mode, fall back to `notifications/Codex/channel`) → update `runtime` in job file. On startup, `recoverMissedJobs()` runs the same check once for crash recovery.

**Identity flow (v0.9.0+):** Every inbound message calls `identitySession.setCaller(chatId, threadId, senderId)` before enqueue. Sensitive MCP tools (`save_memory`, `save_skill`, `create_job`, `list_jobs`, `update_job`, `delete_job`, `what_do_you_know`, `forget_memory`, `run_local_cli_tool`) derive the caller from the session via `resolveCaller(chat_id, thread_id)` / `IdentitySession` — they never trust Codex-declared identity parameters. Terminal skills use the reserved `chat_id = "__terminal__"` outside active channel turns, which resolves to `LARK_OWNER_OPEN_ID`.

## Key Design Decisions

- **ESM-only**: `"type": "module"` in package.json; all imports use `.js` extensions.
- **Stdio transport**: MCP server communicates via stdin/stdout; all debug logging goes to `console.error`.
- **Single-instance lock**: PID-based lock file in `/tmp/` prevents duplicate WebSocket connections.
- **Config location**: All user config lives at `~/.codex/channels/lark/.env`, not in the repo.
- **Memory is local-only**: All memory (profiles, episodes, skills) lives as markdown files under `~/.codex/channels/lark/memories/`. No remote backends — this keeps the trust boundary at OS file permissions and avoids vector-index policy questions for sensitive content.
- **Tiered profile memory (v0.10.0+)**: each user's profile lives at `profiles/{userId}/public.md` + `private.md`. `getProfile(ownerId, caller)` returns both tiers joined when caller === ownerId, and only public otherwise. Legacy single-file profiles lazy-migrate on first read (L1 + L2 classifier splits lines — L2 added in v0.11.1).
- **3-layer privacy classification**: L1 hardcoded regex/keyword rules (in code) > L2 user-edited `privacy-rules.md` (injected into distiller prompt; also consulted by legacy-profile migration via substring match, v0.11.1+) > L3 LLM judgment. `parseTieredProfile` applies L1 as a safety net over LLM output; direct public profile writes are also L1-checked server-side and sensitive spillover is routed to `private.md`.
- **Memory prompt hardening**: stored memory, quoted messages, flush buffers, cron prompts, and L2 rules are wrapped as untrusted data before injection. Same-user profile operations are serialized, and episode files are capped by `LARK_MAX_EPISODE_BYTES`.
- **Identity is server-derived**: `IdentitySession` maps `(chat_id, thread_id?) → open_id` from authenticated Feishu events. MCP tools never accept a client-declared `open_id` or `created_by` — those are resolved server-side. The `__terminal__` owner fallback is blocked while active channel turns are in flight. Trust anchor = Feishu webhook signature.
- **CronJob visibility**: `list_jobs` filters by rendering-visibility — private chat shows caller's own jobs; group shows jobs whose `target_chat_id` matches the current chat (with prompt bodies redacted for non-owners). `update_job` / `delete_job` are owner-only.
- **Memory transparency (v0.11.0+)**: `what_do_you_know` returns the caller's profile entries (filtered by current-chat visibility); `forget_memory` removes a line by 8-char hash. `forget_memory(promote_to_rule=true)` appends the removed line to `privacy-rules.md` so future distillations classify similar content as private — the self-learning loop that completes the L1/L2/L3 infrastructure from v0.10.0.
- **Audit log (v0.11.0+)**: every sensitive-tool invocation appends a line to `~/.codex/channels/lark/audit.log` (ok/denied/error with redacted args). Best-effort — log failures never propagate into tool behavior.
- **Image auto-download**: Images are downloaded to `~/.codex/channels/lark/inbox/` on receive. Codex reads local paths via `image_path` in notification meta.
- **Ack reaction**: Configurable emoji (`LARK_ACK_EMOJI`, default `MeMeMe`) sent on receive, auto-revoked after reply. Fire-and-forget, won't block message processing.
- **Bot message tracking**: `BotMessageTracker` (default 500, FIFO, configurable via `LARK_BOT_MESSAGE_TRACKER_SIZE`) tracks bot-sent message IDs. Used to route user reaction events on bot replies and to scope bot-message edit/recall guards.

## Configuration

Required env vars: `LARK_APP_ID`, `LARK_APP_SECRET` (in `~/.codex/channels/lark/.env`).

Optional but recommended: `LARK_OWNER_OPEN_ID` — enables terminal-side skills (e.g. `$lark:jobs`) to act as the operator. Without it, terminal tool calls are denied.

The `$lark:configure` skill (in `skills/configure/SKILL.md`) provides interactive setup within Codex.

## Important Conventions

- **Stdout is sacred**: MCP uses stdio for JSON-RPC. All logging must go to `console.error`, never `console.log`. The Lark SDK uses custom loggers to redirect to stderr.
- **`.mcp.json` must use `--silent`**: Prevents npm script lifecycle output from corrupting MCP transport.
- **Channel protocol**: Messages are forwarded to Codex via `notifications/Codex/channel` (not `sendLoggingMessage`). Requires `experimental: { 'Codex/channel': {} }` capability.
- **Architecture guardrails**: New code should follow `docs/architecture.md`. `npm run check:architecture` and `npm test` reject new dependency cycles and new forbidden cross-layer imports. Existing violations are only allowed when listed in `scripts/architecture-baseline.json` with a removal reason.
- **User display names**: Resolved via contact API → cached. Falls back to stable aliases (`user_` + last 7 chars of open_id). Memory keys always use raw open_id/chat_id.
- **Group chat filtering**: Only messages with @bot mentions are processed (precise match via bot open_id fetched at startup). P2P messages are always processed.
- **Reaction events**: If the Feishu app subscribes to `im.message.reaction.created_v1`, user reactions on tracked bot replies are forwarded as normal interaction turns. The reaction prompt tells Codex to interpret the emoji with the reacted bot message instead of treating acknowledgement/completion emoji as passive by default.

## Debugging

Debug logs are written to `~/.codex/channels/lark/debug.log`. Contains raw event data (sender, mentions, chatType) for diagnosing message flow issues.
When `LARK_CODEX_EXEC_TOOL_TRACE=true`, sanitized local Codex exec tool execution events are written to `~/.codex/channels/lark/trace.log` (or `LARK_CODEX_EXEC_TRACE_LOG`) and are never rendered into Feishu replies.

Plugin code runs from three locations — all must stay in sync during development:
- `workspace` (source of truth)
- `~/.codex/plugins/marketplaces/codex-lark-plugin/` (marketplace clone)
- `~/.codex/plugins/cache/codex-lark-plugin/lark/<version>/` (Codex runtime cache)
