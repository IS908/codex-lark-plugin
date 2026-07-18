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
  execution. Multiple attempts already may execute one business step, so each Job
  and Attempt gains a stable parent-assigned `currentStepId`. A separate Step table
  remains deferred until branching or step dependencies become real requirements.

## Trusted Facts And Model Interpretation

Creation persists two independent records.

`AsyncTaskFactSnapshot` is server-derived, redacted before persistence, and
immutable after creation:

- schema version;
- original unenriched user text;
- bounded quoted-message text;
- authenticated sender, source message, chat, thread, and route;
- source message type and timestamp;
- managed input artifact references for downloaded images and attachments;
- canonical working directory, selected model, and permission envelope.

The permission envelope is an immutable admission-time audit snapshot, not a
durable grant of authority. Before every attempt and resume, the parent computes
effective permissions as the intersection of that snapshot and current policy,
including the current trusted-workspace, sandbox-root, and local-tool rules. A
later revocation or narrowing can never preserve broader authority. It blocks the
run immediately, or becomes `waiting_user` after #299 when an authenticated user
action can restore the missing authorization.

It never contains the memory-enriched prompt or a raw credential-bearing message.
Downloaded source paths are staged, hashed, and atomically renamed into a separate
read-only `inputs/<job-id>/` tree; they are never placed in the writable artifact
tree. The Codex sandbox receives the input paths as readable references but only
the sibling artifact tree as an additional writable directory. Checksums are
revalidated by a pre-claim gate before each attempt, after restart and before a
lease or attempt row is created. A missing or modified admitted input records a
redacted integrity event and atomically terminates the still-due Job as
`failed/continuation_input_integrity_failed`, with zero new attempts, no lease,
and no Codex invocation. The gate uses the selected Job's row version when it
commits either failure or claim, so cancellation and concurrent workers cannot
race the filesystem result into an invalid transition. The integrity-failure
transaction also inserts the normal idempotent terminal outbox row, so the
Job has at most one logical terminal delivery event even though no execution
attempt exists. Physical network delivery remains reconciled and does not claim
distributed exactly-once semantics. Missing or unreadable inputs fail creation.

This is logical immutability within the Codex sandbox boundary. Processes under
the same OS uid are trusted: they can bypass `chmod` and can mutate a path after
a checksum gate. The implementation narrows that window with pre-claim and
pre-spawn verification, but does not claim descriptor-bound snapshots or
OS-adversary-proof immutability.

Creation derives a deterministic Job ID from the source-message idempotency key,
serializes same-ID creation in-process, stages input files, atomically renames the
complete manifest, and then commits the SQLite row. A database failure removes the
newly installed input tree when no matching row exists. Startup cleanup removes
aged orphan staging/final trees that have no Job row. This is compensating
recovery, not a false cross-filesystem transaction.

Legacy rows cannot reconstruct facts that v6 never stored. Migration marks their
fact snapshot `provenance: legacy_unavailable`, keeps unavailable text and input
fields null/empty, and derives stable criterion IDs from the stored criterion
ordinal plus hash. It never fabricates original user text or quoted context. The
existing v1-v6 migration chain remains supported. Schema v7 also retains the
existing flattened `objective`, `acceptanceCriteria`, and `contextSnapshot`
execution projection, derived from the new contract, so #303 remains independently
deployable with the v6 runner. #300 removes that runner dependency when it starts
consuming facts and contracts directly.

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
verification verdicts, and delivery receipts are parent-owned facts. They are
stored in repository rows or append-only events and are composed into the next
execution snapshot. Model output cannot reset counters, claim an external effect,
or overwrite source facts.

The host-tool receipt key becomes `(job_id, step_id, request_hash)`. A completed
failed validation call permits a corrected request hash in the same business step;
an unknown in-flight call blocks all replacement requests until reconciled. This
preserves no-blind-replay while allowing bounded invocation repair.

## Outcome-Driven Scheduling

A non-terminal attempt emits a structured delta. Another attempt is scheduled only
when acceptance remains unmet, the next action is concrete, the total budget
allows it, and the committed checkpoint contains a material change. Material
change is limited to parent-verifiable state: new evidence content/checksums,
changed output artifact checksums, newly completed stable criterion/deliverable/
step IDs, or a repository-authorized current-step transition backed by completion
of the prior step. Free-form summaries, decisions, constraints, stop reasons,
confidence, and next-action prose cannot reset the no-progress counter.

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

Trusted Codex execution can perform opaque filesystem, network, or external
effects that do not pass through the host-tool receipt ledger. A timeout, process
crash, or expired lease after such execution begins is therefore classified as an
unknown external outcome and moves to `waiting_user`; it is never automatically
rerun. Only failures proven to occur before execution, or execution constrained to
read-only/receipt-bearing operations, may use infrastructure retry.

The durable states become:

```text
queued ----------------------> running
waiting_retry ---------------> running
recovering ------------------> running
running -> waiting_retry | recovering | waiting_user
running -> completed | partial | blocked | failed
queued | waiting_retry | recovering | waiting_user -> cancelled
running -> cancel_requested -> cancelled
```

`waiting_retry` is infrastructure retry of the same request. `recovering` is a due
task-level repair with a new validated request/evidence path. `waiting_user` is a
non-runnable interrupt. Per-error and total recovery budgets are parent-owned.
Exhaustion produces a terminal failure with completed work and recovery history.
Existing `/task retry` remains a terminal-job clone; only automatic recovery and
`/task resume` continue the same Job. A retry clones each managed input through
the same staged installation protocol into the new deterministic Job-owned input
tree. The clone does not refer to the original tree: either Job can be retained or
deleted without invalidating the other, and the retry still works after the
original source file has disappeared.

## Human Resume

`waiting_user` persists an interrupt with a bounded question, required action,
resume schema, and expiry. Its outbox event records the delivered Lark message ID
under a unique indexed interrupt ID. The creator or owner may resume the same Job
by using `/task resume <job-id> <input>`. IM routes also accept a same-conversation
reply to the delivered interrupt message when normal group mention policy admits
the turn. Document comments require the explicit command because reply-to-reply
correlation is not reliable. Resume is atomic first-input-wins; stale or duplicate
inputs are rejected. The input becomes a parent-owned event and the Job moves to
`recovering` without cloning or discarding progress.

## Verification

The first release performs deterministic verification of managed input and output
artifact existence/checksums plus criterion evidence-reference integrity. This is
reported as structural verification and never represented as independent semantic
acceptance. A `ContinuationVerifier` port runs after an executor proposes
completion and before terminal execution commit. Its accepted/revision verdict is
persisted; revision returns the Job to `recovering` with bounded findings. An
independent Codex semantic reviewer can replace or compose with this verifier in a
later release without changing checkpoint or repository contracts.

Executor completion, verification acceptance, and delivery remain separate facts.
Execution may be `completed` while delivery is `delivery_unknown`; user-facing
status must say both facts rather than relabel execution or imply receipt. A
verification rejection cannot commit terminal completion.

## Persistence And Migration

Each independently mergeable PR owns one direct schema migration: #303 v6 to v7,
#300 v7 to v8, and #299 v8 to v9. Every initializer continues to support upgrades
from older supported versions through the existing chain. Existing checkpoints
are normalized once when v8 is installed; there is no dual state machine or
runtime compatibility branch. Existing identifiers and `/task` commands remain
readable.

New parent-owned event and interrupt records are bounded and redacted. Existing
tool-call and outbox idempotency behavior remains authoritative for external
effects and delivery.

## Delivery Plan

1. #303 persists immutable facts, logically read-only managed input artifacts,
   and task contracts.
2. #300 introduces CheckpointV2, attempt deltas, event history, and no-progress
   convergence.
3. #299 introduces normalized failure policy, recovery budgets, `waiting_user`,
   and same-Job resume.
4. The three changes release together as v2.8.0.
5. Independent semantic verification follows in a later minor release.
6. Durable Run Kernel extraction and Cronjob direct-exec migration are evaluated
   only after Async Task behavior is stable and parity can be measured.

## Acceptance

- A restart preserves immutable source facts, checksum-verified managed inputs, contracts,
  checkpoints, recovery history, and delivery state.
- Models cannot rewrite source facts or parent-owned operation receipts.
- Attempts stop early on completion and stop safely on repeated no progress.
- Recoverable invocation failures do not become false capability blocks.
- User-action failures resume the same Job after authenticated input.
- External effects with unknown outcomes are not blindly repeated.
- Cronjob scheduling, execution, rerun, report, and delivery behavior are unchanged.
