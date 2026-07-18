# Task 4 Report: Durable Async Task Storage Cutover

## Status

PASS. Task 4A and 4B move Async Task persistence onto the generic Durable Run
SQLite schema, retain the existing Continuation repository as the semantic
adapter, and keep the root source, plugin mirror, and runtime bundle aligned.
No GitHub operation was performed.

## Commits

- Task 4A: `fbde3fc770fc149d25ab522dee75541dbdfd7e55`
  (`feat: add durable run SQLite storage`).
- Task 4B subject: `feat: cut async tasks over to durable storage`.
- The final Task 4B SHA is reported in the task result because a commit cannot
  contain its own object ID.

## Task 4A: Schema And Migration

- Added schema version 10 with `durable_runs`, `durable_attempts`,
  `durable_outbox`, `durable_operation_receipts`, and `durable_interrupts`.
- Added generic SQLite create, idempotency, claim, Attempt, heartbeat,
  transition/outbox, delivery, failure, and structured recovery operations.
- Migrated authentic v1-v9 Continuation fixtures in one immediate transaction,
  preserving public Job/Attempt IDs, idempotency, leases, operation receipts,
  interrupts, retention, outbox state, and delivered message IDs.
- Validated migration counts, references, bounded JSON, and foreign keys before
  dropping the old Continuation base tables.

## Task 4B: Async Task Cutover

### Schema And Map

- Installed five `continuation_*` compatibility views and fifteen write
  triggers over the generic tables so the existing Continuation semantic
  repository retains its tested task-specific operations without a second
  persistence path.
- Mapped legacy columns to versioned Async Task input/state envelopes while
  retaining generic Run ownership fields as authoritative for identity,
  status, row version, lease, attempt count, scheduling, and route.
- Kept commands, artifacts, interrupts, tool-call receipts, retention,
  redaction, audit, outbox, and delivery behavior on the existing repository
  surface.

### Concurrent Initialization RED And Fix

The six-process fresh-database regression failed against the non-transactional
compatibility installer with a trigger-already-exists race. A second injected
failure showed that dropping and recreating compatibility objects without one
transaction could expose a partial schema.

The fix serializes compatibility installation with `BEGIN IMMEDIATE`, drops and
recreates every compatibility view/trigger inside the same transaction, and
rolls back to the previous complete definitions on failure. Repeated and
concurrent fresh/historical opens are idempotent and leave schema version 10,
five views, fifteen triggers, and no foreign-key violations.

### Structured Recovery

- Replaced the Task 3 count-only bridge with real
  `DurableRunInterruptedAttempt[]` records from generic storage.
- The Async Task workload converts claimed/pre-execution interruption into a
  bounded retry, cancellation into cancellation commit, and opaque
  post-execution interruption into `waiting_user` with unknown outcome/risk;
  it never blindly re-executes external work.
- Self-review added a RED restart case for a process crash after recovery was
  claimed but before its transition committed (`0 !== 1`). The repository now
  reclaims the same unfinished Attempt after the recovery lease expires, with a
  new Run row version and Attempt/lease/row-version CAS fences.

### Typed Envelope

- Persists complete versioned Async Task input and state snapshots, strips
  undefined object properties before serialization, and snapshots through the
  bounded Durable Run JSON serializer.
- Validates the full Continuation Job, source facts, task contract,
  permissions, checkpoints, recovery, interrupts, delivery events, and pending
  step/failure commit before materialization.
- Unsupported versions, malformed JSON, incomplete Jobs, and structurally
  invalid persisted envelopes fail closed and cannot become replayable.
- Updated the action smoke's corruption injection to damage the durable state
  envelope structurally while retaining valid outer JSON.

### Ownership CAS

- `markExecutionStarted`, `commitTransition`/Continuation `completeStep`, and
  `failAttempt` return only `committed` or `stale` for claim-bound mutations.
- Fences include Run ID, Attempt ID, worker, active Attempt, current ordinal,
  row version, status, lease, and execution/recovery phase as applicable.
- Transition state, Attempt completion, failure metadata, and outbox rows commit
  atomically. Stale workers cannot win after cancellation, expiry, competing
  claim, recovery reclaim, or a prior terminal transition.

## RED Evidence

```text
node --import tsx scripts/continuation-repository-smoke.ts
FAIL: concurrent fresh opens raced while creating continuation compatibility triggers

node --import tsx scripts/durable-run-repository-smoke.ts
AssertionError at recovery restart reclaim: 0 !== 1

npm test
Error: no such function: async_task_envelope
at scripts/continuation-action-smoke.ts:508
```

The last failure was a stale v9-style test corruption path through a connection
that intentionally did not initialize compatibility functions. The smoke now
corrupts `durable_runs.state_json` directly with valid but structurally invalid
JSON, preserving the intended fail-closed assertion.

## Complete GREEN

All required commands passed on the final source and synchronized mirror:

```text
npm run check:plugin-src-sync
plugin source sync check ok

npm run build
[build-runtime] bundled ./dist
[build-runtime] bundled plugins/lark/runtime

node --import tsx scripts/durable-run-repository-smoke.ts
durable run repository smoke: PASS

node --import tsx scripts/durable-run-migration-smoke.ts
durable run migration smoke: PASS

node --import tsx scripts/continuation-durable-cutover-smoke.ts
continuation durable cutover smoke: PASS

node --import tsx scripts/continuation-repository-smoke.ts
continuation repository smoke: PASS

node --import tsx scripts/continuation-restart-process-smoke.ts
continuation restart process smoke: PASS

node --import tsx scripts/continuation-worker-smoke.ts
continuation worker smoke: PASS

node --import tsx scripts/continuation-runtime-smoke.ts
continuation runtime smoke: PASS

npm run typecheck
exit 0

npm run check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm test
All tests passed.
```

The full suite repeats typecheck, migration/repository/cutover/worker/runtime/
restart checks, plugin source synchronization, architecture guardrails, runtime
bundle generation, module loading, and all existing channel/tool/memory/job
regressions.

## Self-review

- Confirmed schema v10 is the only base persistence schema after migration and
  compatibility objects are views/triggers, not a dual-write legacy store.
- Confirmed active v9 Attempts retain identity, lease, execution phase, and
  operation risk through migration and structured recovery.
- Confirmed invalid Async Task input/state is rejected before execution and
  corrupt rows are isolated through the existing persisted-state recovery path.
- Confirmed claim-bound mutations re-read ownership under an immediate
  transaction and return stale without partial Attempt/outbox changes.
- Confirmed a crash during recovery can be reclaimed only after its recovery
  lease expires; the older recovery claim then loses the row-version fence.
- Confirmed all changed `src` files are byte-identical under
  `plugins/lark/src`, and the checked-in plugin runtime was rebuilt afterward.
- Confirmed the final diff contains Task 4 source, tests, mirror, runtime, and
  this report only.

## Concerns

No unresolved correctness concern was found. Compatibility view writes are an
internal repository mechanism and require the connection-local functions
registered by `SqliteContinuationRepository`; raw external SQLite writes are
not a supported API.
