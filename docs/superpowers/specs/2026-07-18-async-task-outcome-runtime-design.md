# Async Task Outcome Runtime Design

## Context

The persistent continuation runtime already provides SQLite durability, worker
leases, bounded attempts, managed artifacts, a host-tool receipt ledger, and a
transactional delivery outbox. Issues #299 and #300 identify correctness gaps in
failure recovery and attempt handoff. Issues #301 and #302 define the longer-term
direction: one-off Async Tasks and reusable Cronjob definitions remain separate
products while infrastructure may later converge into a Durable Run Kernel.

This design improves Async Task correctness without migrating Cronjob execution,
adding a DAG, or adopting an external workflow engine.

## Product Boundaries

- A Cronjob owns a reusable schedule and starts a direct execution on each run.
- An Async Task is a one-off background completion contract created only from an
  explicit asynchronous user request.
- A durable runtime supplies persistence and delivery mechanics; it does not force
  both products to use the same execution strategy or model protocol.
- The current `ContinuationJob` is one workflow run. A committed checkpoint
  transition is one business step, and an attempt is one disposable worker/model
  execution. Separate Run and Step tables are deferred until branching or multiple
  attempts per business step become real requirements.

## Trusted Facts And Model Interpretation

Creation persists two independent records.

`AsyncTaskFactSnapshot` is server-derived and immutable:

- schema version;
- original unenriched user text;
- bounded quoted-message text;
- authenticated sender, source message, chat, thread, and route;
- source message type and timestamp;
- managed input artifact references for downloaded images and attachments;
- canonical working directory, selected model, and permission envelope.

It never contains the memory-enriched prompt. Source paths are copied into the
job's managed artifact area, hashed, and represented by stable relative references.
Missing or unreadable inputs fail creation instead of creating a task that cannot
survive restart.

`AsyncTaskContract` is a validated model interpretation:

- title and objective;
- explicit deliverables;
- acceptance criteria with stable IDs;
- deterministic verification requirements;
- initial summary, constraints, decisions, and references.

The contract cannot replace or mutate source facts. Later checkpoints refer to
contract criterion and deliverable IDs, so unmet requirements cannot disappear by
rewriting a summary.

## Checkpoint And Parent-Owned Facts

CheckpointV2 contains only agent workflow progress:

- completed steps and evidence references;
- current step;
- remaining steps;
- artifact references;
- decisions and constraints;
- one concrete next action;
- a bounded stop reason.

Tool calls, normalized failures, recovery budgets, side effects, interrupt inputs,
and delivery receipts are parent-owned facts. They are stored in repository rows
or append-only events and are composed into the next execution snapshot. Model
output cannot reset counters, claim an external effect, or overwrite source facts.

## Outcome-Driven Scheduling

A non-terminal attempt emits a structured delta. Another attempt is scheduled only
when acceptance remains unmet, the next action is concrete, the total budget
allows it, and the committed checkpoint contains a material change. Material
change is determined from canonical evidence, artifact, completed-step, decision,
or current-step fields rather than model confidence alone.

Two consecutive no-progress deltas terminate with
`failed/continuation_stalled`. Maximum attempts remain a safety ceiling, not an
execution target. Existing early completion remains valid.

## Failure And Recovery

Adapters normalize raw errors into tool-independent semantics:

- `invalid_invocation`;
- `transient`;
- `authentication_required`;
- `permission_required`;
- `capability_unavailable`;
- `terminal`;
- `unknown`.

A pure policy maps category, retry safety, operation risk, error fingerprint, and
remaining budgets to `recover`, `retry`, `wait_for_user`, `block`, or `fail`.
Structured invalid invocation errors are safe to repair because the adapter has
evidence that invocation validation rejected the operation. Transient operations
are retried only when the adapter establishes retry safety. Unknown external
outcomes remain preserved and are never blindly replayed.

The durable states become:

```text
queued -> running -> recovering -> running
                  -> waiting_user -> recovering
                  -> completed | partial | blocked | failed | cancelled
```

Per-error and total recovery budgets are parent-owned. Exhaustion produces a
terminal failure with the completed work and recovery history.

## Human Resume

`waiting_user` persists an interrupt with a bounded question, required action,
resume schema, and expiry. Its outbox event records the delivered Lark message ID.
The creator or owner may resume the same Job by replying to that message or by
using `/task resume <job-id> <input>`. The input becomes a parent-owned event and
the Job moves to `recovering`; retry does not clone the task or discard progress.

## Verification

The first release performs deterministic verification of managed artifact
existence, checksums, criterion evidence references, and delivery constraints. A
`ContinuationVerifier` port separates verification from execution so an
independent Codex review session and bounded revision loop can be added later
without changing checkpoint or repository contracts.

Executor completion, verification acceptance, and delivery remain separate facts.
No task is presented as completed when verification fails or delivery is unknown.

## Persistence And Migration

Async Task storage migrates directly from schema v6 to v7. Existing checkpoints
are normalized once into the new representation; there is no dual state machine or
runtime compatibility branch. Existing identifiers and `/task` commands remain
readable.

New parent-owned event and interrupt records are bounded and redacted. Existing
tool-call and outbox idempotency behavior remains authoritative for external
effects and delivery.

## Delivery Plan

1. #303 persists immutable facts, managed input artifacts, and task contracts.
2. #300 introduces CheckpointV2, attempt deltas, event history, and no-progress
   convergence.
3. #299 introduces normalized failure policy, recovery budgets, `waiting_user`,
   and same-Job resume.
4. The three changes release together as v2.8.0.
5. Independent semantic verification follows in a later minor release.
6. Durable Run Kernel extraction and Cronjob direct-exec migration are evaluated
   only after Async Task behavior is stable and parity can be measured.

## Acceptance

- A restart preserves immutable source facts, managed inputs, contracts,
  checkpoints, recovery history, and delivery state.
- Models cannot rewrite source facts or parent-owned operation receipts.
- Attempts stop early on completion and stop safely on repeated no progress.
- Recoverable invocation failures do not become false capability blocks.
- User-action failures resume the same Job after authenticated input.
- External effects with unknown outcomes are not blindly repeated.
- Cronjob scheduling, execution, rerun, report, and delivery behavior are unchanged.
