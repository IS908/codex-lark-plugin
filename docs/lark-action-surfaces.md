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
| Create default review jobs | `create_default_review_jobs` | `create_default_review_jobs` | yes; both create paused job presets through `default-review-jobs` |
| Issue proposal lifecycle | `create_issue_proposal`, `list_issue_proposals`, `reject_issue_proposal`, `create_issue_from_proposal`, `create_low_risk_pr_from_proposal` | same action names | partial; both use `issue-proposal-store`; proposal filing uses the built-in proposal filing path unless a configured local CLI tool override is explicitly provided, while low-risk PR creation still goes through `runConfiguredLocalCliTool` |
| Run local CLI tool | `run_local_cli_tool` | `run_local_cli_tool` | yes; both call `runConfiguredLocalCliTool` |
| Image/file media reply | `reply(files=[...])` | `send_message` (`image`/`file` only) | partial; both flow through `sendFeishuReply`; exec supports `local_path` plus `current_message:first_image` for images |
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
- Issue proposal actions are the narrow exception for periodic review UX: they
  persist local proposal state and require explicit human approval before the
  final GitHub write. Issue creation uses the built-in token-backed GitHub HTTP
  proposal filing path by default, and only uses an allowlisted local CLI tool
  such as `external_issue_create` when explicitly requested as an override.
  Low-risk PR creation is only allowed after the
  proposal is marked `low-risk-auto-pr-eligible` and its GitHub issue exists,
  then goes through a separate allowlisted wrapper such as
  `gh_low_risk_pr_create`. Neither path may merge or release automatically.
- `send_message` is intentionally narrow in exec mode: first-class image/file
  replies only, using local paths or the current inbound message's first
  downloaded image. Mixed rich post output, audio/video, and interactive cards
  need separate design slices before they are exposed as normal exec actions.
- `create_default_review_jobs` must only create paused presets. Users must
  explicitly resume those jobs before self-review or low-risk auto-fix runs.
- Codex exec final answers have no background continuation after the visible
  Feishu reply is posted. If the child output promises later external work
  without a structured action, defer/no-reply marker, or scheduled job, delivery
  rewrites the reply into a safe notice instead of implying that work will keep
  running.
- Capabilities should be added to exec actions only when there is a clear need
  for the parent-process bridge. Otherwise, prefer MCP tools.
