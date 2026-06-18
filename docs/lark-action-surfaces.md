# Lark Action Surfaces

This plugin exposes Lark operations through two different surfaces:

- MCP tools in notification mode.
- Structured action blocks in Codex exec mode.

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
| Create job | `create_job` | `create_job` | partial; both use server-derived caller identity and `job-store` |
| Run local CLI tool | `run_local_cli_tool` | `run_local_cli_tool` | yes; both call `runConfiguredLocalCliTool` |
| Recall bot message | `recall_message` | `recall_message` | yes; both use the tracked bot-message scope guard |
| Edit bot message | `edit_message` | not supported | MCP-only for now; uses the tracked bot-message scope guard |
| Add reaction | `react` | not supported | MCP-only |
| Download attachment | `download_attachment` | not supported | MCP-only |
| Doc comment reply/create | `reply_doc_comment`, `create_doc_comment` | ordinary exec text for current doc-comment reply only | no; structured doc-comment mutations remain MCP-only |

## Boundary Rules

- Structured exec actions must never include caller identity fields such as
  `open_id`, `created_by`, `chat_id`, or `thread_id`; the parent bridge derives
  identity and scope from the current Feishu event.
- Message mutations that target prior bot messages must validate that the
  target message id is tracked by `BotMessageTracker` and belongs to the current
  chat/thread before calling Lark transport APIs.
- Domain-specific external write actions should not be added directly to the
  core exec action schema. Use `run_local_cli_tool` for explicitly configured
  host-local workflows, with allowlists, fixed arguments, timeouts, output caps,
  and audit logging owned by the local tool config.
- Codex exec final answers have no background continuation after the visible
  Feishu reply is posted. If the child output promises later external work
  without a structured action, defer/no-reply marker, or scheduled job, delivery
  rewrites the reply into a safe notice instead of implying that work will keep
  running.
- Capabilities should be added to exec actions only when there is a clear need
  for the parent-process bridge. Otherwise, prefer MCP tools.
