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
