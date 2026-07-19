# Cron Durable Run Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Move Cronjob runs and Async Task onto one generic durable Run/Attempt/lease/outbox kernel, cut Cron over once, and remove the legacy Scheduler execution path.

**Architecture:** Generic kernel contracts and SQLite tables own durable mechanics. Async Task and Cron use validated workload adapters. Cron JSON remains the definition and schedule source; SQLite is the run and delivery source, with JSON runtime fields maintained only as a compatibility projection.

**Tech Stack:** TypeScript ESM, Node.js 24 node:sqlite, cron-parser, existing Codex exec and Lark transport adapters, shell-driven smoke tests.

## Global Constraints

- One runtime cutover: no feature flag, dual write, or fallback Cron executor.
- LARK_CONTINUATION_ENABLED controls only Async Task; Cron remains available.
- Cronjob and Async Task remain separate workloads and user-facing concepts.
- Preserve existing public Job IDs, task IDs, Attempt IDs, commands, schedules, per-Job timezone, prompt/model/tools, identity, report rendering, and target routing.
- Execution and delivery are distinct durable states; delivery retry never reruns Codex.
- Unknown external outcomes are not blindly replayed.
- Existing continuation SQLite records migrate transactionally and remain operable.
- Root source and plugins/lark/src stay synchronized; runtime bundle is rebuilt before completion.
- User-facing error messages remain English.

---

### Task 1: Lock Down Cron Compatibility Before Refactoring

**Files:**
- Modify: scripts/scheduler-smoke.ts
- Modify: scripts/job-smoke.ts
- Create: scripts/cron-compatibility-smoke.ts
- Modify: scripts/test.sh

**Interfaces:**
- Consumes: JobScheduler, computeLatestDueRun, runJobNow, JobFile JSON fixtures.
- Produces: an executable compatibility matrix that all later tasks must keep green.

- [ ] **Step 1: Write failing characterization tests for uncovered lifecycle behavior**

Add tests that call start, recoverMissedJobs, tick, and stop through a controlled clock and repository fixture. Assert:

    exact-boundary next_run_at === now is admitted once
    multiple missed occurrences admit only the latest occurrence
    paused Jobs are skipped by scheduled admission
    paused Jobs may run manually without changing status or future next_run_at
    two simultaneous manual/scheduled requests return already_running for one
    deleting and recreating the same Job ID rejects stale projection

- [ ] **Step 2: Add DST and per-Job timezone fixtures**

Use America/New_York fixtures for 2026-03-08 and 2026-11-01. Assert
computeLatestDueRun and computeNextRun preserve current cron-parser behavior and
that a persisted Job timezone wins over appConfig.cronTimezone.

- [ ] **Step 3: Run the tests and record the expected failures**

Run:

    node --import tsx scripts/cron-compatibility-smoke.ts

Expected: FAIL because the new lifecycle harness and exact-boundary admission
surface do not exist yet. Existing scheduler-smoke and job-smoke must still pass.

- [ ] **Step 4: Add the minimal public test seams without changing behavior**

Expose clock, scan interval, and repository callbacks through SchedulerOptions
with production defaults. Keep executeJob private and preserve all production
behavior.

- [ ] **Step 5: Run the compatibility group**

Run:

    node --import tsx scripts/scheduler-smoke.ts
    node --import tsx scripts/job-smoke.ts
    node --import tsx scripts/cron-compatibility-smoke.ts

Expected: PASS.

- [ ] **Step 6: Commit**

    git add scripts/scheduler-smoke.ts scripts/job-smoke.ts scripts/cron-compatibility-smoke.ts scripts/test.sh src/scheduler.ts
    git commit -m "test: lock down cron run compatibility"

### Task 2: Define the Generic Durable Run Contracts

**Files:**
- Modify: src/domain/durable-run.ts
- Create: src/ports/durable-run.ts
- Create: scripts/durable-run-domain-smoke.ts
- Modify: scripts/test.sh
- Mirror: plugins/lark/src/domain/durable-run.ts
- Create mirror: plugins/lark/src/ports/durable-run.ts

**Interfaces:**
- Produces:

    type DurableRunStatus =
      | 'queued' | 'running' | 'waiting_retry' | 'waiting_user'
      | 'recovering' | 'completed' | 'partial' | 'blocked'
      | 'failed' | 'cancel_requested' | 'cancelled'

    interface DurableRunRecord {
      runId: string
      workloadKind: string
      idempotencyKey: string
      status: DurableRunStatus
      inputVersion: number
      input: unknown
      stateVersion: number
      state: unknown
      route: unknown
      actorOpenId: string
      nextRunAt: string
      expiresAt: string
      maxAttempts: number
      attemptCount: number
      rowVersion: number
    }

    interface DurableRunWorkload<Input, State, Result> {
      kind: string
      parseInput(value: unknown, version: number): Input
      parseState(value: unknown, version: number): State
      preflight(context: DurableRunWorkloadContext<Input, State>): Promise<DurableRunPreflight>
      execute(claim: DurableRunWorkloadClaim<Input, State>, signal: AbortSignal): Promise<Result>
      reduce(claim: DurableRunWorkloadClaim<Input, State>, result: Result): DurableRunTransition
      recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition
    }

    interface DurableRunRepository {
      initialize(): Promise<void>
      create(request: DurableRunCreateRequest): Promise<DurableRunCreateResult>
      get(runId: string): Promise<DurableRunRecord | null>
      claimDue(workloadKinds: readonly string[], workerId: string, now: string, leaseExpiresAt: string): Promise<DurableRunClaim | null>
      markExecutionStarted(claim: DurableRunClaim, now: string): Promise<void>
      heartbeat(claim: DurableRunClaim, now: string, leaseExpiresAt: string): Promise<boolean>
      commitTransition(claim: DurableRunClaim, transition: DurableRunTransition, now: string): Promise<void>
      failAttempt(claim: DurableRunClaim, failure: DurableRunFailure, now: string): Promise<void>
      recoverExpiredLeases(now: string): Promise<DurableRunInterruptedAttempt[]>
      claimDelivery(workloadKinds: readonly string[], workerId: string, now: string): Promise<DurableRunDeliveryClaim | null>
      commitDelivery(claim: DurableRunDeliveryClaim, result: DurableRunDeliveryResult, now: string): Promise<void>
      close(): void
    }

- [ ] **Step 1: Write failing domain tests**

Test terminal-state recognition, the complete legal transition matrix, typed
workload materialization, transition validation, bounded workload JSON, stable
collision-free Cron idempotency keys, structured expired-lease recovery, and
rejection of unknown workload kinds.

- [ ] **Step 2: Run the domain test**

    node --import tsx scripts/durable-run-domain-smoke.ts

Expected: FAIL because the generic types and validators are missing.

- [ ] **Step 3: Implement the contracts and pure validators**

Keep all domain and port files free of config, SQLite, Codex, Lark, Scheduler,
and continuation infrastructure imports. Canonicalize Cron key components with
delimiter-safe encoding and normalize scheduled occurrences to ISO timestamps.
Snapshot JSON in one traversal before measuring and serializing it. Validate
transition timestamps and bounded failure/error fields, cap delivery intents,
and reject duplicate delivery idempotency keys.

- [ ] **Step 4: Run domain and architecture tests**

    node --import tsx scripts/durable-run-domain-smoke.ts
    npm run check:architecture

Expected: PASS.

- [ ] **Step 5: Mirror and verify source sync**

Apply the same focused file patches to the plugin mirror, then run:

    npm run check:plugin-src-sync

- [ ] **Step 6: Commit**

    git add src/domain/durable-run.ts src/ports/durable-run.ts scripts/durable-run-domain-smoke.ts scripts/test.sh plugins/lark/src/domain/durable-run.ts plugins/lark/src/ports/durable-run.ts
    git commit -m "refactor: define durable run kernel contracts"

### Task 3: Extract the Generic Worker and Keep Async Task Green

**Files:**
- Create: src/durable-run/worker.ts
- Create: src/continuation/async-task-kernel-adapter.ts
- Modify: src/continuation/worker.ts
- Create: scripts/durable-run-worker-smoke.ts
- Modify: scripts/continuation-worker-smoke.ts
- Modify: scripts/test.sh
- Mirror corresponding plugins/lark/src files

**Interfaces:**
- Consumes: DurableRunRepository, DurableRunWorkload, DurableRunDelivery.
- Produces:

    class DurableRunWorker {
      constructor(options: {
        repository: DurableRunRepository
        workloads: readonly DurableRunWorkload[]
        delivery: DurableRunDelivery
        clock: DurableRunClock
        maxConcurrencyByWorkload: Readonly<Record<string, number>>
        scanIntervalMs?: number
        heartbeatIntervalMs?: number
        leaseDurationMs?: number
      })
      start(): void
      tick(): Promise<void>
      stop(): Promise<void>
    }

- [ ] **Step 1: Write failing generic worker tests**

Cover claim, heartbeat, terminal commit plus outbox, lease loss, shutdown,
delivery claim, and independent concurrency quotas for async_task and cron.

- [ ] **Step 2: Run the generic worker test**

    node --import tsx scripts/durable-run-worker-smoke.ts

Expected: FAIL because DurableRunWorker does not exist.

- [ ] **Step 3: Move workload-neutral orchestration into DurableRunWorker**

Use keyed active maps by Run ID. A workload quota limits only that kind while a
global delivery loop continues independently. The worker must call preflight
before execution and must commit transitions through the repository.

- [ ] **Step 4: Adapt ContinuationWorker without changing its public surface**

ContinuationWorker becomes a compatibility facade that constructs a generic
worker through AsyncTaskKernelAdapter. Existing callers and tests still use
start, tick, stop, and activeCount.

- [ ] **Step 5: Run generic and continuation worker tests**

    node --import tsx scripts/durable-run-worker-smoke.ts
    node --import tsx scripts/continuation-worker-smoke.ts

Expected: PASS with unchanged continuation assertions.

- [ ] **Step 6: Commit**

    git add src/durable-run/worker.ts src/continuation/async-task-kernel-adapter.ts src/continuation/worker.ts scripts/durable-run-worker-smoke.ts scripts/continuation-worker-smoke.ts scripts/test.sh plugins/lark/src
    git commit -m "refactor: extract durable run worker"

### Task 4: Migrate SQLite to Generic Run, Attempt, and Outbox Tables

**Files:**
- Create: src/durable-run/sqlite-repository.ts
- Create: src/durable-run/sqlite-migrations.ts
- Modify: src/continuation/sqlite-repository.ts
- Modify: scripts/fixtures/continuation-historical-schema.ts
- Create: scripts/durable-run-repository-smoke.ts
- Create: scripts/durable-run-migration-smoke.ts
- Modify: scripts/continuation-repository-smoke.ts
- Modify: scripts/continuation-restart-process-smoke.ts
- Modify: scripts/test.sh
- Mirror corresponding plugins/lark/src files

**Interfaces:**
- Produces SqliteDurableRunRepository.open with one shared database and
transactional Run/Attempt/outbox commits.
- Continuation repository remains the Async Task semantic adapter and delegates
base persistence to SqliteDurableRunRepository.

- [ ] **Step 1: Write failing fresh-schema repository tests**

Assert idempotent create, CAS claim, Attempt insertion, heartbeat, atomic
transition plus outbox, delivery claim, delivery result, and workload filtering.

- [ ] **Step 2: Write failing historical migration tests**

For every existing schema fixture, assert:

    original Job ID and Attempt ID are preserved
    idempotency keys and leases are preserved
    active opaque Attempts are not reset
    outbox message IDs and delivery states are preserved
    interrupts and operation receipts remain available
    old continuation base tables no longer exist after commit
    foreign_key_check returns no rows

- [ ] **Step 3: Run repository tests**

    node --import tsx scripts/durable-run-repository-smoke.ts
    node --import tsx scripts/durable-run-migration-smoke.ts

Expected: FAIL because the generic repository and migration do not exist.

- [ ] **Step 4: Implement schema version 10 migration**

Create durable_runs, durable_attempts, durable_outbox,
durable_operation_receipts, and durable_interrupts. Migrate in one immediate
transaction, validate counts and references, then drop superseded base tables.
Use input_version and state_version with bounded JSON parsers.

- [ ] **Step 5: Convert Continuation repository to an Async Task adapter**

Keep its existing public methods and all task-specific transition logic. Replace
base claims, Attempts, leases, and outbox writes with generic repository calls.
Do not change task IDs, command output, retention, recovery, or artifact paths.

- [ ] **Step 6: Run all continuation persistence tests**

    node --import tsx scripts/durable-run-repository-smoke.ts
    node --import tsx scripts/durable-run-migration-smoke.ts
    node --import tsx scripts/continuation-repository-smoke.ts
    node --import tsx scripts/continuation-restart-process-smoke.ts

Expected: PASS.

- [ ] **Step 7: Commit**

    git add src/durable-run src/continuation/sqlite-repository.ts scripts/durable-run-repository-smoke.ts scripts/durable-run-migration-smoke.ts scripts/continuation-repository-smoke.ts scripts/continuation-restart-process-smoke.ts scripts/fixtures/continuation-historical-schema.ts scripts/test.sh plugins/lark/src
    git commit -m "feat: migrate async tasks to durable run storage"

### Task 5: Add Cron Definition Revision and Idempotent Run Admission

**Files:**
- Modify: src/job-contracts.ts
- Modify: src/job-store.ts
- Create: src/cron/run-admission.ts
- Modify: src/scheduler.ts
- Modify: scripts/job-smoke.ts
- Create: scripts/cron-run-admission-smoke.ts
- Modify: scripts/scheduler-smoke.ts
- Modify: scripts/test.sh
- Mirror corresponding plugins/lark/src files

**Interfaces:**
- JobMeta gains revision: number.
- Semantic create/update increments revision; runtime projection does not.
- Produces:

    interface CronRunAdmission {
      admitScheduled(job: JobFile, now: Date): Promise<CronAdmissionResult>
      admitManual(job: JobFile, requestId: string, now: Date): Promise<CronAdmissionResult>
      waitForExecution(runId: string, signal?: AbortSignal): Promise<'success' | 'failed'>
    }

- [ ] **Step 1: Write failing revision tests**

Assert deterministic backfill to revision 1, increment on prompt/model/schedule/
target/name/status changes, no increment on runtime projection, and atomic
preservation during concurrent edits.

- [ ] **Step 2: Write failing admission tests**

Assert stable scheduled and manual idempotency keys, latest missed occurrence,
exact boundary inclusion, schedule cursor CAS, paused scheduled rejection,
paused manual acceptance, overlap rejection, and delete/recreate protection.

- [ ] **Step 3: Run job and admission tests**

    node --import tsx scripts/job-smoke.ts
    node --import tsx scripts/cron-run-admission-smoke.ts

Expected: FAIL because revision and CronRunAdmission are missing.

- [ ] **Step 4: Implement revision and admission**

Store an immutable Cron workload input containing Job ID, created_at identity,
revision, type, content or prompt, model, schedule occurrence, target, creator,
timezone, and route metadata.

- [ ] **Step 5: Add the admission dependency without cutting production over**

Add a Scheduler admission port and constructor seam, but leave the current
production executor selected until Task 7. The new admission service is tested
directly in this task and is not enabled by a feature flag or shipped as a
second runtime path.

- [ ] **Step 6: Run compatibility tests**

    node --import tsx scripts/cron-run-admission-smoke.ts
    node --import tsx scripts/cron-compatibility-smoke.ts
    node --import tsx scripts/scheduler-smoke.ts

Expected: all PASS. Existing Scheduler behavior remains green until Task 7
performs the atomic production cutover.

- [ ] **Step 7: Commit**

    git add src/job-contracts.ts src/job-store.ts src/cron/run-admission.ts src/scheduler.ts scripts/job-smoke.ts scripts/cron-run-admission-smoke.ts scripts/scheduler-smoke.ts scripts/test.sh plugins/lark/src
    git commit -m "feat: admit cron runs durably"

### Task 6: Implement Cron Direct-Exec Workloads

**Files:**
- Create: src/cron/contracts.ts
- Create: src/cron/direct-exec-workload.ts
- Create: src/cron/message-workload.ts
- Create: src/cron/prompt-executor.ts
- Modify: src/codex-exec-delivery.ts
- Modify: src/channel-services.ts
- Create: scripts/cron-workload-smoke.ts
- Create: scripts/cron-prompt-fidelity-smoke.ts
- Modify: scripts/codex-exec-delivery-smoke.ts
- Modify: scripts/test.sh
- Mirror corresponding plugins/lark/src files

**Interfaces:**
- Produces a generation-only CronPromptExecutor:

    interface CronPromptExecution {
      report: string
      runStatus: 'success' | 'failed'
      failureReason: string | null
      diagnostics: CronJobDiagnosticSnapshot
    }

    type CronPromptExecutor =
      (input: CronPromptExecutionInput, signal: AbortSignal)
        => Promise<CronPromptExecution>

- [ ] **Step 1: Write failing prompt-fidelity tests**

Assert exact cronJobPrompt input, model override, working directory, creator
identity, synthetic thread, tools/action dispatcher, trace Job ID, hidden
progress, lifecycle guard, and report text.

- [ ] **Step 2: Write failing workload-result tests**

Assert prompt success, empty report, lifecycle rejection, execution error,
message Job content, bounded diagnostics, English failure report, and
transactional terminal delivery intent.

- [ ] **Step 3: Run workload tests**

    node --import tsx scripts/cron-workload-smoke.ts
    node --import tsx scripts/cron-prompt-fidelity-smoke.ts

Expected: FAIL because generation-only execution does not exist.

- [ ] **Step 4: Split Codex generation from Feishu send**

Add a delivery sink abstraction to deliverMessageViaCodexExec so the Cron
executor captures the final report and lifecycle state without calling
sendReplyViaFeishu. Live chat keeps its current sink.

- [ ] **Step 5: Implement prompt and message workloads**

Prompt execute returns a result; reduce creates an outbox intent. Message execute
validates fixed content and immediately returns an outbox intent. Neither
workload imports Lark transport.

- [ ] **Step 6: Run prompt and live-chat regression tests**

    node --import tsx scripts/cron-workload-smoke.ts
    node --import tsx scripts/cron-prompt-fidelity-smoke.ts
    node --import tsx scripts/codex-exec-delivery-smoke.ts

Expected: PASS.

- [ ] **Step 7: Commit**

    git add src/cron src/codex-exec-delivery.ts src/channel-services.ts scripts/cron-workload-smoke.ts scripts/cron-prompt-fidelity-smoke.ts scripts/codex-exec-delivery-smoke.ts scripts/test.sh plugins/lark/src
    git commit -m "feat: add cron direct exec workloads"

### Task 7: Add Durable Cron Delivery and Remove Legacy Execution

**Files:**
- Create: src/cron/delivery.ts
- Create: src/cron/runtime-projection.ts
- Create: src/durable-run/runtime.ts
- Modify: src/continuation/runtime.ts
- Modify: src/channel-services.ts
- Modify: src/index.ts
- Modify: src/scheduler.ts
- Modify: src/cronjob-diagnostics.ts
- Create: scripts/cron-delivery-smoke.ts
- Create: scripts/durable-run-runtime-smoke.ts
- Modify: scripts/reply-thread-smoke.ts
- Modify: scripts/scheduler-smoke.ts
- Modify: scripts/test.sh
- Mirror corresponding plugins/lark/src files

**Interfaces:**
- Cron delivery consumes DurableRunDeliveryClaim and returns sent, retry,
  permanent_failure, or unknown.
- Runtime projection compares Job ID, created_at, and revision before updating
  run_status, output_status, delivery_status, report, errors, and diagnostics.

- [ ] **Step 1: Write failing delivery tests**

Assert stable Feishu idempotency key, message and Markdown/Card delivery,
bot-message tracking, transient retry without workload execution, unknown
timeout without duplicate send, permanent target auto-pause, and stale
projection rejection.

- [ ] **Step 2: Write failing runtime wiring tests**

Assert persistence initializes before channel connection, workers start only
after transport readiness, Cron remains registered when continuation is
disabled, independent quotas are applied, and initialization failure does not
start a legacy executor.

- [ ] **Step 3: Run delivery and runtime tests**

    node --import tsx scripts/cron-delivery-smoke.ts
    node --import tsx scripts/durable-run-runtime-smoke.ts

Expected: FAIL because delivery and shared runtime are missing.

- [ ] **Step 4: Implement Cron delivery and runtime projection**

Use one outbox retry loop. Confirmed message IDs mark sent. Ambiguous transport
timeouts mark unknown. Permanent target errors auto-pause only the matching Job
instance and revision.

- [ ] **Step 5: Wire one shared runtime**

Index initializes Durable Run persistence once. Channel services registers
async_task conditionally and both Cron workloads unconditionally, then starts
admission and workers after transport readiness.

- [ ] **Step 6: Delete legacy Cron execution code**

Remove executeJob, executeJobUnlocked, executeMessageJob, executePromptJob,
scheduler retry sleeps, direct Feishu send, promptRunner from SchedulerOptions,
recordCronJobReportDelivery legacy commits, and activeJobIds.

- [ ] **Step 7: Run Cron and continuation regression groups**

    node --import tsx scripts/cron-delivery-smoke.ts
    node --import tsx scripts/durable-run-runtime-smoke.ts
    node --import tsx scripts/scheduler-smoke.ts
    node --import tsx scripts/reply-thread-smoke.ts
    node --import tsx scripts/continuation-runtime-smoke.ts
    node --import tsx scripts/continuation-worker-smoke.ts

Expected: PASS.

- [ ] **Step 8: Commit**

    git add src/cron src/durable-run src/continuation/runtime.ts src/channel-services.ts src/index.ts src/scheduler.ts src/cronjob-diagnostics.ts scripts/cron-delivery-smoke.ts scripts/durable-run-runtime-smoke.ts scripts/reply-thread-smoke.ts scripts/scheduler-smoke.ts scripts/test.sh plugins/lark/src
    git commit -m "feat: cut cron over to durable run delivery"

### Task 8: Verify Crash Recovery, Capacity Isolation, and Architecture

**Files:**
- Create: scripts/cron-durable-restart-worker.ts
- Create: scripts/cron-durable-restart-smoke.ts
- Create: scripts/durable-run-capacity-smoke.ts
- Modify: scripts/architecture-check.js
- Modify: docs/architecture.md
- Modify: scripts/test.sh
- Mirror docs/source changes where applicable

**Interfaces:**
- Produces process-level evidence for crash boundaries and a static guard
  preventing Scheduler execution responsibilities from returning.

- [ ] **Step 1: Write failing process crash tests**

Inject process exits:

    before admission commit
    after Run commit before schedule cursor advance
    after claim before execution
    after execution starts before Attempt commit
    after Attempt/outbox commit before delivery
    after send before delivery commit

Assert no lost admitted Run, no duplicate safe admission, no blind replay after
opaque execution, and no duplicate confirmed delivery.

- [ ] **Step 2: Write failing capacity tests**

Block the Async Task quota and assert a Cron Run still starts. Saturate Cron and
assert Async Task still starts. Assert one delivery loop serves both without
starvation.

- [ ] **Step 3: Add architecture assertions**

Reject Scheduler imports of Codex delivery, Lark transport send APIs,
scheduler-policy retry helpers, and sleep-based retry. Require Cron workload
imports to flow through durable-run ports.

- [ ] **Step 4: Run the new tests**

    node --import tsx scripts/cron-durable-restart-smoke.ts
    node --import tsx scripts/durable-run-capacity-smoke.ts
    npm run check:architecture

Expected: PASS after the Task 7 cutover; any remaining legacy reference fails.

- [ ] **Step 5: Commit**

    git add scripts/cron-durable-restart-worker.ts scripts/cron-durable-restart-smoke.ts scripts/durable-run-capacity-smoke.ts scripts/architecture-check.js scripts/test.sh docs/architecture.md
    git commit -m "test: verify durable cron recovery"

### Task 9: Documentation, Self-Review, Full Verification, and Release

**Files:**
- Modify: README.md
- Modify: CHANGELOG.md
- Modify: package.json
- Modify: package-lock.json
- Modify: plugins/lark/package.json
- Modify: plugins/lark/package-lock.json
- Modify: plugins/lark/.codex-plugin/plugin.json
- Modify: plugins/lark/README.md
- Rebuild: plugins/lark/runtime/index.js

**Interfaces:**
- Produces version 2.9.0 release artifacts and operator migration notes.

- [ ] **Step 1: Document behavior and migration**

Explain that Cron definitions remain JSON, Run history is SQLite-backed,
execution and delivery states are separate, delivery failure does not rerun
Codex, migration is automatic and fail-closed, and continuation enablement does
not control Cron.

- [ ] **Step 2: Update all version metadata to 2.9.0**

Update root/plugin package and lock files, plugin manifest, README badge, and
CHANGELOG. Do not create the release tag before merge.

- [ ] **Step 3: Rebuild mirrored runtime**

    npm run build
    npm run check:plugin-src-sync

Expected: PASS and plugins/lark/runtime/index.js contains the new kernel.

- [ ] **Step 4: Perform self-review**

Review the complete diff for:

    legacy Cron execution or dual-write code
    migration rollback and active-lease safety
    accidental public ID or command changes
    retry of unknown external effects
    report delivery that bypasses outbox
    stale Job projection writes
    unredacted persisted diagnostics
    root/plugin source divergence

Fix every material finding and repeat focused tests.

- [ ] **Step 5: Run the full verification gate**

    npm run typecheck
    npm run check:architecture
    npm run check:plugin-src-sync
    npm test
    npm audit --omit=dev --audit-level=high

Expected: all PASS with no high-severity production dependency finding.

- [ ] **Step 6: Commit release preparation**

    git add README.md CHANGELOG.md package.json package-lock.json plugins/lark
    git commit -m "chore: prepare v2.9.0"

- [ ] **Step 7: Push and create the implementation PR**

    git push -u origin codex/issue-315-cron-durable-run
    gh pr create --title "feat: migrate cron runs to durable run kernel" --body "Closes #315"

- [ ] **Step 8: Inspect checks and review comments**

    gh pr checks --watch
    gh pr view --comments

Fix findings, rerun the full gate, and push until no material finding remains.

- [ ] **Step 9: Merge and release**

Merge the PR, create GitHub Release v2.9.0 from the merged main commit, verify
the release metadata, comment evidence on #302, and confirm #315 is closed.
