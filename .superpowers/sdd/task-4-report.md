# Task 4 Report: Durable Async Task Storage Cutover

## Status

PASS. Async Task persistence now uses the generic Durable Run SQLite tables as
its unique base state engine. The Continuation repository remains the semantic
adapter for task-specific transitions, artifacts, commands, receipts,
interrupts, retention, and delivery rendering.

## Delivered

- Migrated v1-v9 databases transactionally to `durable_runs`,
  `durable_attempts`, `durable_outbox`, `durable_operation_receipts`, and
  `durable_interrupts`.
- Removed writable compatibility triggers. Five `continuation_*` views remain
  read-only and filter to `async_task` workloads.
- Routed normal claims, Attempts, leases, transitions, recovery, cancellation,
  and delivery through the generic repository with row-version, lease,
  Attempt, workload, and delivery-claim fences.
- Added strict versioned input/state validation. Unsupported or corrupt
  envelopes fail closed without being rewritten into executable state.
- Preserved composite `(run_id, attempt_id)` ownership and rejected cross-Run
  child references.
- Preserved route-mismatched or ambiguous historical delivery state as
  fail-closed instead of silently rewriting its destination.
- Mapped historical operation receipts to exact runtime step identities when
  provable. Completed receipts replay, running receipts return unknown, and a
  genuinely unmappable active receipt aborts and rolls back migration.
- Made outbox intent conflicts transactional errors. Cross-Run idempotency and
  same-Run event-key conflicts roll back the Run/Attempt transition.
- Added deterministic FIFO tie-breaking and isolated command smoke fixtures so
  active/recovered tasks and terminal outbox rows cannot leak between cases.

## Verification

The following passed on synchronized root/plugin sources and rebuilt runtime:

```text
npm test
All tests passed.

npm run check:plugin-src-sync
plugin source sync check ok

npm run check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

git diff --check
exit 0
```

Focused migration, generic repository, cutover, Continuation repository,
worker, command, runtime, and process-restart smokes also passed independently.

## Review

The independent review initially requested changes for operation-receipt replay
safety and silently ignored outbox conflicts. Both findings received failing
regressions, fixes, full-suite verification, and a final independent verdict of
`APPROVED`. See `.superpowers/sdd/task-4-review.md`.
