# Lark Action Surfaces

This plugin exposes Lark operations through two different surfaces:

- MCP tools exposed by the plugin server.
- Structured side-channel action requests in Codex exec mode.

The surfaces are intentionally not identical. MCP tools are interactive tool
calls made by Codex through the MCP server. Codex exec actions are a small
parent-process bridge for actions that must run safely even when the child
`codex exec` process cannot access MCP tools.

## Parity Matrix

| Capability | MCP tool | Codex exec action | Shared implementation |
| --- | --- | --- | --- |
| Plain Feishu reply | `reply` | ordinary exec text output | no; exec replies flow through `deliverMessageViaCodexExec` |
| Defer/no visible reply | `defer_reply` | `[LARK_DEFER]` / `[LARK_NO_REPLY]` sentinel | no; exec uses output parsing |
| Save memory | `save_memory` | `save_memory` | partial; both use server-derived caller identity and `MemoryStore` |
| Job lifecycle | `create_job`, `list_jobs`, `update_job`, `delete_job` | `create_job`, `list_jobs`, `update_job`, `disable_job`, `delete_job`, `upsert_job` | yes; both surfaces delegate job visibility, reference resolution, owner checks, schedule parsing, create/update/delete persistence, and runtime initialization to `job-service` |
| Run local CLI tool | `run_local_cli_tool` | `run_local_cli_tool` | yes; both call `runConfiguredLocalCliTool` |
| Image/file/rich media reply | `reply(files=[...])`; internal `richParts` | `send_message` (`image`/`file`/`rich`) | partial; both flow through `sendFeishuReply`; exec supports `local_path`, `current_message:first_image`, `quoted_message:first_image`, and ordered text+image rich parts |
| Recall bot message | `recall_message` | `recall_message` | yes; both use the tracked bot-message scope guard |
| Edit bot message | `edit_message` | not supported | MCP-only for now; uses the tracked bot-message scope guard |
| Add reaction | `react` | not supported | MCP-only |
| Download attachment | `download_attachment` | not supported | MCP-only |
| Doc comment reply/create | `reply_doc_comment`, `create_doc_comment` | ordinary exec text for current doc-comment reply only | no; structured doc-comment mutations remain MCP-only |
| Persistent continuation | not exposed | `create_continuation_job` | parent validates a bounded execution brief, derives identity/route/session from the trusted event, and commits it through `ContinuationService` |

## Boundary Rules

- Structured exec actions must never include caller identity fields such as
  `open_id`, `created_by`, `chat_id`, or `thread_id`; the parent bridge derives
  identity and scope from the current Feishu event.
- Message mutations that target prior bot messages must validate that the
  target message id is tracked by `BotMessageTracker` and belongs to the current
  chat/thread before calling Lark transport APIs.
- Domain-specific external write actions must not be added directly to the core
  exec action schema. Creating GitHub/GitLab issues, Jira tickets, Linear
  issues, PRs, or review proposals belongs in user-configured skills, custom
  MCP tools, or explicit `run_local_cli_tool` wrappers with allowlists, fixed
  arguments, timeouts, output caps, and audit logging owned by local config.
- `send_message` remains intentionally bounded in exec mode: first-class
  image/file replies and ordered text+image rich parts only. Rich parts prefer a
  single Feishu post and fall back to ordered split messages; audio/video and
  interactive cards still need separate design slices before they are exposed as
  normal exec actions.
- Codex exec final answers have no implicit background continuation after the
  visible Feishu reply is posted. Only a successfully committed
  `create_continuation_job` action establishes a durable follow-up; unrelated
  actions and defer/no-reply markers do not. Unsupported future-work prose is
  rewritten into a safe notice.
- `create_continuation_job` is foreground-only and is not an MCP tool. The
  background runner cannot invoke the action bridge, send Lark messages, create
  nested jobs, or publish source control. Terminal delivery remains parent-owned.
- Capabilities should be added to exec actions only when there is a clear need
  for the parent-process bridge. Otherwise, prefer MCP tools.

## Outbound Message Support Matrix

| Form | Normal Codex final reply | `send_message` action | Constraints and fallback |
| --- | --- | --- | --- |
| Plain text | supported | `kind=rich` with text-only parts, though ordinary final text is preferred | split by `LARK_TEXT_CHUNK_LIMIT`; first chunk quote-replies when `reply_to` is available, later chunks stay in-thread |
| Body-only Markdown card | supported through automatic Schema 2.0 card rendering | not exposed as `send_message` | final rich Markdown still uses `buildCards()`; interactive workflow cards stay separate from ordinary media replies |
| Rich text + images | supported when emitted as `send_message kind=rich` | supported | parts are ordered `text` and `image`; images must be local readable files, `current_message:first_image`, or `quoted_message:first_image`; preferred delivery is one Feishu `post`, with ordered split fallback |
| Image | supported through `reply(files=[{type:"image"}])` and `send_message kind=image` | supported | source is `local_path`, `current_message:first_image`, or `quoted_message:first_image`; upload must return an image key and `fileSentCount >= 1` |
| File | supported through `reply(files=[{type:"file"}])` and `send_message kind=file` | supported | source is `local_path`; files are uploaded as generic Feishu files, not native audio/video messages |
| Native audio/video | unsupported | unsupported | send as a generic file only when acceptable; unsupported `kind=audio`/`video` action payloads are rejected with schema errors |
| Interactive card workflow | supported only through existing card rendering or raw-card MCP reply surfaces | unsupported | keep workflow-specific cards outside `send_message` until there is a concrete interaction contract |

Unsupported outbound forms must fail visibly as invalid action payloads or an
action result error. They should not be silently downgraded to raw text because
that hides delivery loss from the user.
