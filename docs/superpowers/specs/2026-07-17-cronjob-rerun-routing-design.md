# Cronjob Rerun And Continuation Routing

## Problem

Foreground turns currently see `create_continuation_job` whenever the runtime is
available. That makes a durable continuation look like the default route for any
heavy task. The bridge also has no action for immediately running an existing
cronjob, so a quoted cronjob report can be reconstructed from a lossy summary
instead of reusing the persisted definition.

The lifecycle guard compounds the problem: broad future-tense text patterns can
classify design discussion as an unresolved background promise.

## Decision

Use parent-owned routing rather than asking the model to reconstruct task state.

1. Add a `run_job` exec action that accepts a stable `job_id` or unique name.
   The parent resolves the persisted job, enforces creator ownership, audits the
   request, and invokes the same scheduler execution path used by timed runs.
2. Preserve a future `next_run_at` during a manual run. If an active job is
   already overdue, advance it after the manual run so the scheduler does not
   immediately duplicate the execution. Paused jobs remain paused.
3. Derive `quoted_cronjob_id` only from locally tracked bot-message routing
   metadata. Expose this trusted value separately from quoted user-visible text.
   The action prompt tells Codex to use `run_job` for a rerun and never rebuild
   the cronjob as a continuation.
4. Hide `create_continuation_job` by default. Expose it on the first run only
   when the user's current message explicitly requests background execution,
   monitoring, waiting, or completion notification. Heavy work alone is not an
   asynchronous signal.
5. Keep the lifecycle guard as a final safety check, but match only unresolved
   first-person commitments after removing fenced code and quoted lines. Design
   discussion, negative statements, completed actions, and non-background
   structured actions do not establish or imply a continuation.

## Boundaries

- `run_job` reuses the complete persisted cronjob definition, model, caller,
  target chat, tool policy, working configuration, and output path.
- A manual run is synchronous from the bridge's perspective: the action does not
  report success until the scheduler run finishes or fails.
- The existing scheduler retry and report-delivery behavior remains authoritative.
- Continuations remain available for explicit asynchronous work; this change
  narrows discovery, not the durable runtime itself.
- No compatibility route or rollout flag is added.

## Verification

- Schema and dispatcher smoke tests cover parsing, ownership, audit-facing
  results, and runner invocation.
- Scheduler smoke tests cover original-definition execution, future schedule
  preservation, paused-job behavior, and overlap rejection.
- Inbound pipeline tests cover trusted quoted cronjob origin derivation.
- Delivery tests cover hidden-by-default continuation, explicit async exposure,
  quoted rerun guidance, and lifecycle false-positive prevention.
- The full project test, build, architecture, source-sync, and dry-run checks must
  pass before merge.
