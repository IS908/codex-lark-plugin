# Task 2 Report: Generic Durable Run Contracts

## Status

PASS. Task 2 is implemented and committed. No GitHub operations were performed.

## Commit

- `31da8c2d3d3cb37dd471859a25d9afb93824d8d8` (`refactor: define durable run kernel contracts`)
- Baseline: `5d20a970d6e7d9838c298721c4deb72ee31b02e4`

## Files

- `src/domain/durable-run.ts`
  - Added the generic Run status, record, attempt, claim, transition, preflight,
    interrupted-attempt, creation, delivery, and result contracts.
  - Added terminal-state recognition, transition validation, bounded JSON
    serialization, workload-kind validation, and stable scheduled/manual Cron
    idempotency helpers.
  - Preserved the existing generic failure and recovery contracts.
- `src/ports/durable-run.ts`
  - Added `DurableRunWorkload`, `DurableRunRepository`, `DurableRunDelivery`,
    and `DurableRunClock` ports.
- `scripts/durable-run-domain-smoke.ts`
  - Covers terminal statuses, valid and invalid transitions, retry scheduling
    requirements, JSON compatibility and byte limits, exact Cron idempotency
    keys, and rejection of unknown workload kinds.
- `scripts/test.sh`
  - Added the Durable Run domain smoke to the main test sequence.
- `plugins/lark/src/domain/durable-run.ts`
- `plugins/lark/src/ports/durable-run.ts`
  - Exact source mirrors of the workspace contracts.

## TDD Evidence

### RED

Command:

```text
node --import tsx scripts/durable-run-domain-smoke.ts
```

Observed exit code: `1`.

Observed failure:

```text
SyntaxError: The requested module '../src/domain/durable-run.js' does not provide an export named 'assertDurableRunTransition'
```

This was the expected missing-contract failure after adding the smoke and
before changing production domain/port code.

### GREEN

Fresh pre-commit verification:

```text
node --import tsx scripts/durable-run-domain-smoke.ts
durable run domain smoke: PASS

npm run check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm run typecheck
tsc --noEmit

npm run check:plugin-src-sync
plugin source sync check ok
```

All four commands exited `0`.

## Self-review

- Confirmed every status and required record/repository/workload member from
  the brief is represented.
- Confirmed transition validation rejects terminal-state exits and retry or
  recovery transitions without `nextRunAt`.
- Confirmed workload state and delivery JSON must be plain, finite,
  non-cyclic JSON and remains bounded by UTF-8 byte size.
- Confirmed scheduled and manual keys match the design exactly:
  `cron:<job>:<revision>:<occurrence>` and
  `cron-manual:<job>:<revision>:<request>`.
- Confirmed workspace and plugin mirror files are byte-synchronized through
  `check:plugin-src-sync`.
- Confirmed domain has no imports. The only ports import is a type-only import
  from `../domain/durable-run.js`; there are no config, SQLite, Codex, Lark,
  Scheduler, or continuation-infrastructure imports.
- Confirmed `git diff --cached --check` was clean before commit.

## Concerns

None for Task 2. Repository persistence and worker behavior remain intentionally
out of scope for subsequent tasks.

## Review Remediation (2026-07-19)

### Status

PASS. All findings in `task-2-review.md` were addressed against the tightened
Task 2 contract. No GitHub operations were performed.

### Commit

- Baseline: `5ac5ddceb1171ad1c8bd4a1f8ebfe89a567ed4ec`.
- Fix commit: `fix: address issue 315 task 2 review findings` (the commit
  containing this report; its SHA is recorded in the final task result because
  a Git commit cannot contain its own final object ID).

### Files

- `src/domain/durable-run.ts`
  - Added typed workload Context/Claim contracts, explicit interrupted execution
    phase and operation risk, complete transition validation, canonical Cron
    key encoding, and one-pass JSON snapshotting with a depth limit.
- `src/ports/durable-run.ts`
  - Routed parsed Input/State through workload methods, added one-time
    materialization helpers, and changed expired-lease recovery from a count to
    structured interrupted Attempts.
- `scripts/durable-run-domain-smoke.ts`
  - Added the full transition matrix, typed workload flow, structured recovery,
    collision/canonical timestamp, malformed transition, stable snapshot,
    cycle/non-finite/depth, and Unicode byte-boundary coverage.
- `plugins/lark/src/domain/durable-run.ts`
- `plugins/lark/src/ports/durable-run.ts`
  - Byte-identical mirrors of the workspace contracts.
- `.superpowers/sdd/task-2-report.md`
  - Added this remediation record.

### TDD Evidence

RED was observed before each corresponding production change:

```text
node --import tsx scripts/durable-run-domain-smoke.ts
exit 1: Missing expected exception for nextRunAt='not-a-date'

node --import tsx scripts/durable-run-domain-smoke.ts
exit 1: ports/durable-run.js does not provide materializeDurableRunWorkloadClaim

node --import tsx scripts/durable-run-domain-smoke.ts
exit 1: JSON snapshot proxy read assertion failed (3 !== 0)

node --import tsx scripts/durable-run-domain-smoke.ts
exit 1: Missing expected exception for deliveries=null
```

GREEN after implementation and mirror synchronization:

```text
node --import tsx scripts/durable-run-domain-smoke.ts
durable run domain smoke: PASS

npm run check:architecture
architecture check ok: 0 baseline cycle component(s), 0 baseline restricted import(s)

npm run typecheck
tsc --noEmit

npm run check:plugin-src-sync
plugin source sync check ok
```

The smoke file also passed a standalone strict `tsc` invocation, proving that
the generic fixture consumes typed Input/State rather than relying on `tsx`
type erasure.

### Self-review

- Confirmed `recoverExpiredLeases` returns `DurableRunInterruptedAttempt[]` and
  each interruption preserves `claimed|execution_started` plus operation risk
  for workload-specific no-blind-replay decisions.
- Confirmed Input/State are parsed once into `DurableRunWorkloadContext`, then
  retained in `DurableRunWorkloadClaim` for preflight, execute, and reduce.
- Confirmed Cron components use reversible percent encoding and scheduled
  occurrences normalize to `Date.toISOString()` before key construction;
  delimiter collision and equivalent-instant cases are covered.
- Confirmed all 121 status pairs are checked and persisted transition fields
  reject invalid timestamps, malformed or oversized failures/errors,
  excessive deliveries, malformed delivery entries, and duplicate keys.
- Confirmed JSON serialization snapshots data descriptors in one traversal,
  rejects accessors/cycles/non-JSON values, never rereads proxied array values,
  and enforces independent depth and UTF-8 byte limits.
- Confirmed domain/port boundaries retain only domain imports permitted by the
  architecture guardrails, and both plugin mirrors are byte-identical.

### Concerns

None for Task 2. Concrete repository CAS/recovery implementation remains in the
later persistence task, and worker invocation of workload recovery remains in
Task 3 as specified by the implementation plan.
