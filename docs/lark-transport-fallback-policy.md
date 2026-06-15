# LarkTransport SDK Fallback Policy

`LarkTransport` is the public facade. Its internals are split by domain, but
callers should not need to know whether an operation used the SDK or raw
OpenAPI.

## Operation Policy

| operation | behavior | raw fallback | rationale |
| --- | --- | --- | --- |
| `send` | `fallback-to-raw` | yes | User-visible replies and scheduled messages should still deliver when SDK send returns opaque transient errors. |
| `recall` | `fallback-to-raw` | yes | Recall is an explicit user action and raw OpenAPI has equivalent semantics. |
| `edit_message` | `fail-closed` | no | Editing unknown messages must not silently switch authorization or target semantics. |
| `update_card` | `fail-closed` | no | Card update payload parsing differs enough that SDK errors should remain visible. |
| `add_reaction` | `fail-closed` | no | Ack/reaction failures are non-blocking in callers and should not hide SDK routing problems. |
| `remove_reaction` | `fail-closed` | no | Reaction removal should preserve the SDK/raw ownership chosen for the stored reaction id. |
| `remove_reaction_by_emoji` | `fail-closed` | no | There is no exact raw equivalent for removing by emoji without resolving reaction ids first. |
| `download_resource` | `fail-closed` | no | Download byte/time caps are local, but SDK resource selection failures should surface instead of trying a different identity path. |
| `fetch_message_text` | `best-effort-raw-context` | yes | Quoted-card readability is best effort: SDK fetch is tried first, then raw get/mget can recover placeholder card text. |
| `doc_comment` | `raw-only` | no | Doc-comment writes currently use raw Drive APIs behind the transport facade to preserve ids and exact thread semantics. |

## Doc-Comment SDK Decision

Decision: partially migrate.

Doc-comment receive already uses the SDK comment event path when
`LARK_CHANNEL_RUNTIME=sdk`. Selected-text context fetch is also SDK-first:
`LarkChannel.addSdkCommentContext()` calls `channel.comments.resolveTarget()`
and `channel.comments.fetch()` on a best-effort basis, then preserves the local
`doc:<file_token>` chat id and `thread_id === comment_id` identity binding.

Doc-comment writes stay raw-only for now:

- `channel.comments.reply(target, commentId, text)` currently returns
  `Promise<void>`, while the MCP `reply_doc_comment` tool reports `reply_id`
  when raw Drive OpenAPI returns one.
- The SDK reply helper may fall back to a fresh top-level comment for whole-doc
  comments. That is useful SDK behavior, but it changes the plugin's stricter
  `thread_id === comment_id` reply scope.
- The SDK surface does not expose an id-preserving top-level create equivalent
  for `create_doc_comment`; raw Drive OpenAPI currently returns `comment_id`.

Keep the write path raw until the SDK exposes reply/create semantics that
preserve `reply_id` / `comment_id` and do not weaken the existing doc-token,
thread, owner-only, audit, and mismatch protections.

## Diagnostics

SDK fallback logs use `sdkFailureDiagnostic()` through
`formatSdkFallbackLog(operation, error)`. The diagnostic is operation-neutral,
redacted, and includes available SDK/OpenAPI error shape fields such as
`name`, `message`, `code`, HTTP `status`, Feishu `code/msg`, sanitized
`context`, and sanitized `cause`.
