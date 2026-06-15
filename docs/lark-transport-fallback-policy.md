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
| `doc_comment` | `raw-only` | no | Doc-comment writes currently use raw Drive APIs behind the transport facade. |

## Diagnostics

SDK fallback logs use `sdkFailureDiagnostic()` through
`formatSdkFallbackLog(operation, error)`. The diagnostic is operation-neutral,
redacted, and includes available SDK/OpenAPI error shape fields such as
`name`, `message`, `code`, HTTP `status`, Feishu `code/msg`, sanitized
`context`, and sanitized `cause`.
