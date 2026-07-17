# Continuation Lifecycle Direct Migration Design

## Scope

This design closes #289 before #288 because attempt convergence defines the
terminal states and delivery records that retention must understand. It uses a
direct SQLite migration and one runtime contract. There is no rollout flag,
dual-write path, or legacy execution branch.

## Phase 1: Attempt Budget And Forced Convergence

- Replace `maxSteps` and `LARK_CONTINUATION_MAX_STEPS` with `maxAttempts` and
  `LARK_CONTINUATION_MAX_ATTEMPTS` (default `5`, range `1`-`20`). Existing Jobs
  migrate to `min(max_steps, 5)` so active work cannot retain an unbounded loop.
- Replace the 24-hour creation budget with
  `LARK_CONTINUATION_MAX_TOTAL_MINUTES` (default `30`, range `5`-`1440`). The
  persisted `expires_at` remains the hard wall-clock deadline.
- The penultimate attempt receives a convergence warning. The final attempt
  cannot return `continue` semantically or operationally.
- Add terminal `partial` and `blocked` Job states. `partial` carries completed
  work, key findings, unperformed work, risks, and next steps. `blocked` keeps
  completed/unperformed work and an actionable recovery capability.
- If the final attempt still returns `continue`, the parent converts its
  checkpoint deterministically into `partial`; no extra model call is needed.
- Claim and retry paths enforce the attempt budget using persisted attempt
  ordinals. A Job at the budget cannot be scheduled again.

## Phase 2: Attempt Progress Delivery

- Generalize the outbox to multiple events per Job with stable event keys:
  `progress:<attempt_id>` and `terminal`.
- A committed `continue` transaction inserts one progress event derived from
  the checkpoint. Empty status prose is never emitted.
- Terminal insertion supersedes undelivered progress events and is delivered
  with priority. Already delivered progress remains an immutable fact.
- Idempotency is enforced by `(job_id, event_key)` and the existing Feishu UUID
  derivation. Delivery retries do not alter committed Job state.
- `/task status` reports event kind, attempt ID, status, retry count, and bounded
  delivery error metadata.

## Phase 3: Retention, Retain, And Filtering

- Add persisted `retain` (default false). `/task retain <job_id> on|off` is
  available to the creator and to the owner for visible Jobs.
- `/task list --status <csv>` filters in SQL. `pending` expands to `queued`,
  `waiting_retry`, and `cancel_requested`; terminal states include
  `completed`, `partial`, `blocked`, `failed`, and `cancelled`.
- Automatic retention considers terminal `completed_at`, skips retained Jobs,
  and requires the terminal outbox event to be `delivered` before redaction.
- Cleanup deletes detailed attempts/tool-call rows and managed artifacts, clears
  message payloads and task bodies, and keeps a compact tombstone row plus the
  append-only audit record.
- Automatic and manual cleanup are idempotent. The runtime audits each automatic
  cleanup result; manual commands continue through the command audit path.

## Compatibility And Release

- SQLite migrations preserve durable Jobs but immediately adopt the new
  contract. Source, plugin source, and runtime bundles remain synchronized.
- Phase 1 and Phase 2 release together as v2.5.0 and close #289.
- Phase 3 releases as v2.6.0 and closes #288.

## Verification

- Focused smoke tests cover migration, prompt modes, final-attempt enforcement,
  cancellation races, progress idempotency, delivery ordering, retention gates,
  retain authorization, filtering, and cleanup idempotency.
- Every PR runs `npm test`, `npm run build`, source-sync checks, architecture
  checks, and a self-review before merge.
