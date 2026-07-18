# Task 3 Report: Generic Durable Run Worker

## Status

PASS. Task 3 is implemented and ready to commit. No GitHub operations were
performed, and no persistence schema was changed.

## Commit

- Baseline: `48972c970b5a0e0aa11dd7af361d85d509f48ea3`.
- Commit: `refactor: extract durable run worker` (the commit containing this
  report; its SHA is reported in the final task result because a Git commit
  cannot contain its own final object ID).

## Files

- `src/durable-run/worker.ts`
  - Added workload-neutral claim, typed materialization, preflight, execution,
    heartbeat, structured lease recovery, transition commit, shutdown, and
    independent delivery orchestration.
  - Enforces independent per-workload concurrency quotas with active Runs keyed
    by Run ID.
  - Leaves shutdown/lost leases and unknown transition commits to recovery
    rather than replaying execution.
- `src/continuation/async-task-kernel-adapter.ts`
  - Explicitly converts existing Continuation Jobs, Attempts, transitions, and
    outbox claims to and from the Durable Run contracts.
  - Preserves Async Task failure classification, cancellation, expiration,
    audit, redacted diagnostics, delivery retry, and terminal/outbox repository
    behavior.
  - Retains the legacy repository's internal no-blind-replay lease recovery
    until Task 4 migrates persistence to structured interrupted Attempts.
- `src/continuation/worker.ts`
  - Replaced orchestration with a compatibility facade over
    `DurableRunWorker` and `AsyncTaskKernelAdapter` while retaining `start`,
    `tick`, `stop`, and `activeCount`.
- `scripts/durable-run-worker-smoke.ts`
  - Covers claim, typed materialization, preflight, heartbeat, terminal
    transition plus delivery request, structured recovery, unknown commit
    outcome, lease loss, independent Async Task/Cron quotas, bounded failures,
    shutdown, and claim/delivery shutdown races.
- `scripts/continuation-worker-smoke.ts`
  - Retains the existing Async Task behavior assertions, waits for execution
    after asynchronous preflight, and now checks claimed/committed/delivery
    debug events.
- `scripts/test.sh`
  - Added the generic worker smoke to the full suite.
- `plugins/lark/src/durable-run/worker.ts`
- `plugins/lark/src/continuation/async-task-kernel-adapter.ts`
- `plugins/lark/src/continuation/worker.ts`
  - Byte-identical plugin source mirrors.
- `plugins/lark/runtime/index.js`
  - Rebuilt runtime bundle containing the new worker and adapter.
- `.superpowers/sdd/task-3-report.md`
  - This report.

## TDD Evidence

### RED

The initial generic smoke failed before production code existed:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: ERR_MODULE_NOT_FOUND: src/durable-run/worker.js
```

Additional test-first race and contract failures were observed during self-review:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: shutdown claim race executed run_claim-race instead of leaving its lease

node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: shutdown delivery race sent outbox_delivery-race

node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: empty Error message produced an empty DurableRunFailure diagnostic
```

### GREEN

Fresh targeted verification:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
durable run worker smoke: PASS

node --import tsx scripts/continuation-worker-smoke.ts
continuation worker smoke: PASS

node --import tsx scripts/continuation-domain-smoke.ts
continuation domain smoke: PASS

node --import tsx scripts/continuation-repository-smoke.ts
continuation repository smoke: PASS

npm run --silent typecheck
exit 0

npm run --silent check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm run --silent check:plugin-src-sync
plugin source sync check ok
```

Full verification:

```text
npm test
All tests passed.
```

The full suite also rebuilt `dist` and `plugins/lark/runtime`, ran continuation
runtime/restart/delivery checks, repeated typecheck/architecture/plugin sync,
and completed the dry-run checks.

## Self-review

- Confirmed recovery consumes structured interrupted Attempts, materializes the
  registered workload, invokes `recoverInterruptedAttempt`, and commits the
  resulting transition without executing the workload.
- Confirmed transition commit errors are outside execution-failure handling, so
  an unknown commit outcome cannot trigger `failAttempt` or a blind replay.
- Confirmed per-kind capacity is independent and the single delivery loop keeps
  running even when execution quotas are saturated.
- Confirmed both execution and delivery re-check shutdown after an awaited
  claim, preventing new work from starting during stop.
- Confirmed active execution heartbeats, lease-loss abort, cancellation,
  expiration, graceful stop, audit, debug, and delivery behavior remain covered.
- Confirmed the adapter delegates terminal step/cancellation/failure commits to
  existing ContinuationRepository transactions, preserving atomic terminal
  outbox creation.
- Confirmed source and plugin mirrors are byte-identical, architecture baseline
  remains empty, and no SQLite or migration file changed.

## Concerns

- Before Task 4, `ContinuationRepository.recoverExpiredLeases` still commits its
  recovery policy internally and returns only a count. The adapter deliberately
  returns an empty structured list after that commit; it never fabricates an
  interrupted claim. Task 4 must replace this bridge with the generic
  repository's real structured records.
- Generic `create` through the Async Task adapter is intentionally unsupported;
  Async Task admission remains on `ContinuationService` until the Task 4 schema
  migration. Worker execution does not call this method.

---

## Issue #315 Task 3 Review Remediation

### Status

PASS. All Critical and Important findings in `task-3-review.md` are fixed. The
fix stays within the Task 3 worker/adapter boundary, changes no persistence
schema, and performs no GitHub operation.

### Findings Fixed

1. Active executions now retain the last confirmed lease deadline. An
   independent deadline timer aborts the executor even when heartbeat throws or
   never settles. Only a heartbeat that returns `true` before the previous
   confirmed deadline replaces that deadline.
2. Execution scanning and delivery pumping now have separate in-flight
   boundaries. Recovery/claim errors and a saturated execution backlog cannot
   prevent delivery from being claimed. A scan has a fixed claim budget equal
   to its initial available slots, and a post-scan delivery pass observes
   outbox rows created during that scan.
3. The generic execution promise now exposes a top-level state-error observer.
   The Continuation facade connects it to the adapter, restoring the legacy
   `continuation.execute:error`, `detail=worker_state_error`, and matching debug
   event without converting unknown state outcomes into `failAttempt`.
4. The Async Task adapter preserves whether a delivery retry originated from a
   thrown delivery call. That path keeps the
   `continuation_delivery_failed` result and audit detail and emits no
   `delivery_committed`; an explicit returned retry still audits as `retry` and
   emits `delivery_committed`.

### RED Evidence

Each finding received an explicit smoke regression before its production fix:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: Timed out waiting for throwing heartbeat lease deadline.

node --import tsx scripts/durable-run-worker-smoke.ts
exit 1: Timed out waiting for delivery after recovery error.

node --import tsx scripts/continuation-worker-smoke.ts
exit 1: workerStateAuditDetails did not include
continuation.execute:worker_state_error.

node --import tsx scripts/continuation-worker-smoke.ts
exit 1: deliveryAuditDetails did not include the expected
continuation_delivery_failed detail.
```

The completed generic smoke also covers heartbeat throw, one successful
renewal followed by a permanently pending heartbeat, recovery failure, claim
failure, and delivery fairness under a short-task backlog. The continuation
smoke distinguishes thrown delivery from an explicit retry result.

### GREEN Evidence

Fresh targeted verification on the final source and rebuilt mirror/runtime:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
durable run worker smoke: PASS

node --import tsx scripts/continuation-worker-smoke.ts
continuation worker smoke: PASS

node --import tsx scripts/continuation-delivery-smoke.ts
continuation delivery smoke: PASS

node --import tsx scripts/continuation-runtime-smoke.ts
continuation runtime smoke: PASS

npm run --silent typecheck
exit 0

npm run --silent check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm run --silent check:plugin-src-sync
plugin source sync check ok

npm run --silent build
[build-runtime] bundled ./dist
[build-runtime] bundled plugins/lark/runtime
```

Fresh full verification after the final runtime rebuild:

```text
npm test
All tests passed.
```

### Files

- `src/durable-run/worker.ts`
  - Added confirmed lease deadline enforcement, independent execution/delivery
    pump state, bounded claim refill, post-scan delivery observation, and the
    top-level execution state-error observer.
- `src/continuation/async-task-kernel-adapter.ts`
  - Restored top-level `worker_state_error` observability and preserved delivery
    throw audit/debug provenance.
- `src/continuation/worker.ts`
  - Connected the compatibility facade to the state-error observer.
- `scripts/durable-run-worker-smoke.ts`
  - Added lease throw/hang/renewal and delivery isolation/fairness regressions.
- `scripts/continuation-worker-smoke.ts`
  - Added `worker_state_error` and thrown-versus-explicit delivery retry
    regressions, plus deterministic diagnostic waits for concurrent pumping.
- `plugins/lark/src/durable-run/worker.ts`
- `plugins/lark/src/continuation/async-task-kernel-adapter.ts`
- `plugins/lark/src/continuation/worker.ts`
  - Byte-identical plugin source mirrors.
- `plugins/lark/runtime/index.js`
  - Rebuilt runtime bundle with only the expected worker/adapter changes.
- `.superpowers/sdd/task-3-report.md`
  - This remediation record.

### Commit

- Baseline: `a46419c81aecc7287bf0f442fa3ecbcaf49b2124`.
- Fix commit subject: `fix: harden durable run worker orchestration`.
- The final commit SHA is reported in the task result because a Git commit
  cannot embed its own object ID in the report it contains.

### Self-review

- Confirmed heartbeat throw and permanently pending promises leave the local
  deadline timer armed; a successful renewal is rejected if the previously
  confirmed deadline elapsed before its acknowledgement.
- Confirmed lease-loss abort does not commit a transition or a replayable
  failure, preserving lease recovery as the owner of unknown execution outcome.
- Confirmed delivery starts independently before execution recovery/claim can
  fail or hang, while the bounded claim budget prevents a fast backlog from
  monopolizing one scan.
- Confirmed the post-scan delivery pass preserves the legacy behavior where a
  pre-claim integrity gate creates a terminal outbox row during the same tick.
- Confirmed top-level continuation state errors restore audit/debug only; they
  do not mutate the attempt or mask unknown commit outcomes.
- Confirmed thrown delivery and returned retry persist their original failure
  classifications but retain distinct audit/debug semantics.
- Removed an initially observed bundle-only identifier-renaming side effect;
  the final runtime diff contains only the intended worker/adapter changes.
- Confirmed root/plugin source byte identity, clean architecture guardrails,
  no schema changes, and no GitHub writes.

### Concerns

- No unresolved Critical or Important Task 3 review finding remains.
- The two Task 4 migration cautions already documented in
  `task-3-review.md` remain applicable: structured recovery and full persisted
  Async Task envelope validation must switch atomically with generic
  persistence.

---

## Issue #315 Task 3 Final Critical Remediation

### Status

PASS. The final remaining Critical from the Task 3 re-review is closed. No
persistence schema changed and no GitHub operation was performed.

### Fix

- `DurableRunWorker` now routes both preflight transitions and post-execution
  reduced transitions through `commitExecutionTransition`.
- The shared gate rejects a result when shutdown, a prior abort, the last
  confirmed lease deadline, cancellation, or a non-running/missing claimed run
  makes the worker ineligible to commit. It rechecks local ownership after the
  asynchronous repository status read before committing.
- The execute path also uses the same gate before marking execution started.
- The worker smoke adds delayed-preflight regressions for a confirmed lease
  deadline passing and for `stop()` beginning; both transitions include a
  delivery intent and assert that no transition, replayable failure, or
  delivery result is produced.

### RED Evidence

Before the worker change, the new lease-deadline regression failed:

```text
node --import tsx scripts/durable-run-worker-smoke.ts
AssertionError: delayed preflight committed a completed transition after its
confirmed lease expired.
```

### GREEN Evidence

```text
node --import tsx scripts/durable-run-worker-smoke.ts
durable run worker smoke: PASS

node --import tsx scripts/continuation-worker-smoke.ts
continuation worker smoke: PASS

node --import tsx scripts/continuation-runtime-smoke.ts
continuation runtime smoke: PASS

npm run --silent typecheck
exit 0

npm run --silent check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm run --silent check:plugin-src-sync
plugin source sync check ok

npm run --silent build
[build-runtime] bundled ./dist
[build-runtime] bundled plugins/lark/runtime

npm test
All tests passed.
```

### Remaining Concern

- The Task 4 structured-recovery and persisted Async Task envelope-validation
  cautions remain unchanged; they are outside this Task 3 worker fix.
