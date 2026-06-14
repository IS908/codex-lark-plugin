# channel-sdk-node migration boundary

This document closes the planning boundary for migrating `codex-lark-plugin`
toward the public `larksuite/channel-sdk-node` project. The npm package exposed
by that project is `@larksuite/channel`; there is no public npm package named
`channel-sdk-node`.

The migration target remains Codex only. This plan does not add Claude support,
does not move memory out of local files, and does not change the Feishu/Lark
event stream as the caller identity trust anchor.

## Current ownership

`codex-lark-plugin` currently owns these responsibilities:

- MCP stdio server startup and tool registration.
- `Codex/channel` notification capability and Codex exec delivery.
- Feishu/Lark WebSocket lifecycle through `@larksuiteoapi/node-sdk`.
- Inbound event parsing for messages, reactions, comments, mentions, quoted
  replies, cards, and attachments.
- Outbound replies, edits, reactions, doc-comment replies, file upload, and
  card rendering.
- Server-derived caller identity and sensitive-tool authorization.
- Local memory storage, privacy classification, prompt hardening, and
  transparency/forget operations.
- Scheduled jobs, job visibility, owner-only mutation, and cron prompt
  injection identity.
- Append-only audit logging and local CLI allowlist enforcement.
- Runtime hardening: stderr-only SDK logging, single-instance lock, resource
  cleanup, retry/timeout wrappers, and dry-run validation.

## Boundary decision

| Area | Keep local | SDK candidate | Parity requirement |
| --- | --- | --- | --- |
| MCP stdio server | Yes | No | Preserve `@modelcontextprotocol/sdk` server setup, capabilities, tools, and stdout discipline. |
| Codex exec delivery | Yes | No | Preserve one Codex session per Feishu `chat_id` / `thread_id` and `codex exec resume` behavior. |
| `Codex/channel` notification mode | Yes | No | Preserve `notifications/Codex/channel` payload shape and metadata. |
| Lark WebSocket lifecycle | Adapter owned by plugin | Yes | SDK may replace raw WS setup only behind an opt-in runtime flag. |
| Message normalization | Adapter owned by plugin | Yes | Normalized SDK messages must map losslessly to existing `LarkMessage` fields used downstream. |
| P2P/group gating | Shared | Yes | Preserve current behavior: P2P always processes; groups require precise bot mention plus configured allowlists. |
| Ack reactions | Shared | Yes | Preserve receive-time ack, post-reply revoke, doc-comment ack, and non-blocking failure behavior. |
| Replies and edits | Shared | Yes | Preserve text chunking, thread replies, card forcing, markdown/card fallback, and edit semantics. |
| Attachments and images | Shared | Yes | Preserve image auto-download to local inbox, file metadata, byte caps, local paths, and attachment tool behavior. |
| Interactive cards | Shared | Partial | Preserve readable card extraction, card reply rendering, and quoted card context. |
| Doc comments | Shared | Partial | Preserve `doc:<file_token>` thread identity, selected text/title context, reply fallback, and token-mismatch rejection. |
| Reactions | Shared | Partial | Preserve passive handling of user reactions on bot messages and explicit reaction tools. |
| Identity session | Yes | No | SDK path must call `IdentitySession.setCaller` from authenticated event identity before any Codex turn. |
| Sensitive tools | Yes | No | Tools must keep deriving caller server-side; no SDK path may trust client-declared `open_id` or `created_by`. |
| Memory and privacy | Yes | No | Preserve tiered profile visibility, L1/L2/L3 classification, local files, and untrusted-data prompt wrappers. |
| Jobs and scheduler | Yes | No | Preserve owner-only mutation, group/private visibility filters, cron identity binding, and crash recovery. |
| Audit log | Yes | No | Preserve best-effort append-only audit lines with redacted args and non-fatal log failures. |
| Local CLI tools | Yes | No | Preserve allowlist config, terminal owner fallback guard, redacted audit args, and denied-by-default behavior. |
| SDK logging | Adapter owned by plugin | Yes | Every SDK logger must route to stderr to protect MCP JSON-RPC framing. |
| Dry-run | Yes | Partial | Dry-run must validate both legacy and SDK-backed startup paths without connecting to Lark. |

## SDK extension points to use

The SDK-facing adapter should start from these public `@larksuite/channel`
surfaces:

- `createLarkChannel(...)` for the opt-in SDK runtime path.
- `channel.on('message', ...)` for inbound Feishu/Lark messages.
- `channel.on('comment', ...)` for cloud-doc comment mentions.
- `channel.on('reaction', ...)` for reaction events.
- `channel.send(...)`, `editMessage(...)`, `addReaction(...)`,
  `removeReaction(...)`, and `downloadResource(...)` for outbound behavior.
- `channel.comments` only where it can preserve the existing doc-comment
  authorization model.
- `channel.rawClient` as an escape hatch for behavior not yet covered by the
  SDK, while keeping stderr-only logging and retry expectations explicit.

## Known gaps before implementation

- The issue language says `channel-sdk-node`, but the installable npm package
  is `@larksuite/channel`; implementation work should pin that package name
  and version explicitly.
- The current plugin has no SDK-backed runtime path and no `@larksuite/channel`
  dependency.
- The SDK adapter must prove that `NormalizedMessage` contains all data needed
  for quoted/root messages, topic/thread ids, mentions, attachments, images,
  cards, and doc comments. Missing fields must use `rawClient` or stay on the
  legacy path until parity exists.
- The SDK policy layer cannot replace this plugin's identity and tool
  authorization layer. It may only pre-filter messages.
- The SDK outbound helpers cannot replace Codex exec sessions,
  `Codex/channel` notifications, memory enrichment, job injection, or audit
  logging.

## Implementation order

1. Add a disabled-by-default SDK-backed scaffold behind a runtime flag.
2. Preserve identity, sensitive tools, memory, jobs, audit logging, and local
   CLI authorization on the SDK path.
3. Port user-visible message and delivery behavior to the SDK path.
4. Add parity tests, dry-run/smoke coverage, rollout docs, and rollback docs.
5. Only after parity is verified, consider making the SDK path the default.

## Codex-specific behavior that must remain

- MCP server instructions, tool schema, and `Codex/channel` capability.
- Codex exec delivery, session persistence, and resume behavior.
- Memory context enrichment before Codex receives a turn.
- Tool authorization based on server-derived Feishu/Lark identity.
- The reserved `__terminal__` owner fallback and its active-turn guard.
- Local-only memory, jobs, audit log, and operator configuration paths.
- Marketplace/cache sync behavior for Codex plugin installation.

## Validation checklist for future PRs

- `npm run typecheck`
- `npm start -- --dry-run` for the legacy path.
- SDK dry-run for the opt-in path, without connecting to Lark.
- Focused smoke coverage for message normalization, doc comments, attachments,
  cards, reactions, identity, memory privacy, job visibility, local CLI tools,
  and stderr-only SDK logging.
