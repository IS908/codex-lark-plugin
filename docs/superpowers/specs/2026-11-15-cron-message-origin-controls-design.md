# Cron Message Origin Controls Design

## Intent

Make every durable Cron report traceable to the exact persisted Job and Run that
produced it. A user quoting that report, or clicking its controls, must act on
that exact Job without exposing prompts or guessing from a chat thread.

## Goals

- Persist every confirmed Feishu `message_id` emitted by a Cron delivery with
  its `job_id`, `run_id`, Job instance timestamp, display name, and chat.
- Resolve direct quoted-message commands after restart and reject cross-chat
  mappings.
- Render the source Job name and stable ID on Cron report cards, with controls
  to pause, view, and run the Job now.
- Route card controls and deterministic quoted commands through shared
  authorization and state-transition services.
- Keep default Job lists concise; prompt/content is available only from an
  explicit detail operation.
- Never render `[LARK_DEFER]` or `[LARK_NO_REPLY]` control sentinels.

## Non-Goals

- Cancelling an already running Cron Run. Pausing stops future scheduled
  admissions; it does not cancel an in-flight Run.
- Inferring a Job from a surrounding thread, remembered conversation, or a
  single candidate when the directly quoted message has no trusted mapping.
- Changing fixed-message payload fidelity. Source controls are attached to
  generated report cards; fixed message jobs remain byte-for-byte compatible.

## Approach

Use the shared continuation SQLite database as the source-mapping truth store.
The Cron delivery adapter records all confirmed IDs only after Feishu returns
them; recording failures never turn a confirmed send into a retry. The inbound
pipeline looks up only the directly quoted message and requires the stored chat
to match the current chat.

Add a small Cron control service around the existing Job service and scheduler
admission boundary. It owns exact-instance fencing, owner checks, idempotent
pause semantics, visibility-filtered details, and immediate-run admission. Both
native card callbacks and deterministic quoted commands use this service.

The alternatives were keeping the in-memory bot tracker or asking Codex to
list and infer a Job. Neither survives restart or satisfies the no-guessing
requirement. Encoding the full prompt in card actions was also rejected because
it expands the trust boundary and leaks sensitive Job definitions.

## User-Visible Behavior

- Generated Cron report cards end with `来源任务：<name> · <job_id>` and
  `暂停任务`, `查看任务`, `立即运行` buttons.
- Pausing reports the persisted result and states that an in-flight Run is not
  cancelled. Repeated pause clicks report that the Job is already paused.
- A quoted `暂停这个任务` with a trusted origin pauses that exact Job. Without
  a mapping, the plugin shows a bounded concise candidate list and asks for a
  stable ID; it never guesses.
- Job lists show name, status, schedule, timezone, next/last execution, and
  stable ID. Explicit Job details may show prompt/content only when authorized.

## Safety And Failure Semantics

- Card action values carry only an action, stable Job ID, and Job instance
  creation timestamp. The authenticated Feishu operator remains the caller.
- Mutations require Job ownership and exact-instance matching. View follows the
  same private/group visibility rule as `list_jobs`.
- Every split or fallback report message ID is recorded. Store lookup and write
  failures are fail-closed for command resolution and fail-safe for delivery:
  they do not trigger duplicate sends.
- Control sentinels suppress output even when no foreground turn-obligation
  tracker exists, so Cron generation cannot leak them into report cards.
