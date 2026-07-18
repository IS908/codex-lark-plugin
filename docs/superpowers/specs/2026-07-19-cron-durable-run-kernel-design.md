# Cron Durable Run Kernel Migration Design

## Context

Issue #302 defines Cronjob and Async Task as separate product concepts that
should share a durable execution foundation. Issue #315 is the focused
implementation issue for migrating Cronjob runs to that foundation.

Today, Cronjob definitions and runtime projections are JSON files under the
configured jobs directory. JobScheduler scans those definitions and directly
owns execution, retry delays, Codex invocation, Feishu delivery, and runtime
updates. Async Task uses a separate SQLite repository and worker with durable
claims, attempts, leases, recovery, and outbox delivery.

The migration must make the durable mechanisms workload-neutral without making
Cronjob an Async Task. It must also remove the legacy Cron execution path in the
same release. There is no feature flag, dual write, or fallback executor.

## Goals

1. Provide one Durable Run Kernel for Run, Attempt, lease, recovery, retry,
   cancellation, outbox, and audit mechanics.
2. Represent Async Task, Cron prompt, and Cron message execution as separate
   workloads over that kernel.
3. Preserve existing Cron definitions, scheduling, timezone, manual rerun,
   identity, prompt, tool, report, and delivery behavior.
4. Separate Cron execution retry from result-delivery retry.
5. Survive process interruption without losing admitted runs or blindly
   replaying unknown external effects.
6. Complete the migration in one cutover and delete the old Scheduler execution
   path.

## Non-goals

- A workflow DAG, generic workflow language, or user-authored step graph.
- Converting Cron definitions from JSON to SQLite.
- Making Cronjob and Async Task share product commands or lifecycle semantics.
- Distributed multi-host scheduling.
- Retaining a rollback path inside the running application.
- Changing Cron expressions, DST policy, report formatting, or tool access.

## Chosen Architecture

### Kernel and workload boundaries

The shared kernel owns only durable mechanics:

- Run and Attempt identity and state;
- idempotent admission;
- atomic claim, lease, heartbeat, and lease recovery;
- execution-attempt commit;
- cancellation and expiration;
- transactional outbox creation;
- delivery claim and result commit;
- retention and audit correlation.

Workload adapters own semantics:

- async_task owns source facts, task contracts, checkpoints, artifacts,
  verification, no-progress handling, recovery policy, and user interrupts;
- cron_prompt owns definition snapshots, Codex report generation, diagnostics,
  and Cron terminal results;
- cron_message owns definition snapshots and fixed-message terminal results.

The kernel never parses Cron expressions and never interprets Async Task
acceptance criteria.

### Module layout

    src/domain/durable-run.ts
    src/ports/durable-run.ts
    src/durable-run/worker.ts
    src/durable-run/sqlite-repository.ts
    src/durable-run/runtime.ts

    src/continuation/async-task-workload.ts
    src/continuation/async-task-delivery.ts

    src/cron/run-admission.ts
    src/cron/direct-exec-workload.ts
    src/cron/delivery.ts

JobScheduler is reduced to schedule scanning and Run admission. It must not
execute Codex, send Feishu messages, sleep for retries, or directly write new
run outcomes.

### Runtime availability

The Durable Run runtime starts independently of
LARK_CONTINUATION_ENABLED. That variable controls registration and admission
of the async_task workload only. Cron workloads are always registered because
Cron behavior existed before Async Task.

The persistence layer initializes and migrates before the Lark channel
connects, but admission and workers start only after the transport is ready.
This preserves the current guarantee that no work is claimed before delivery
is available. SQLite initialization failure leaves chat available but disables
Cron and Async Task execution with explicit diagnostics. It never starts the
deleted legacy Cron executor.

Cron and Async Task use separate concurrency quotas within one runtime so a
long Async Task cannot starve scheduled reports, and a Cron burst cannot consume
all Async Task capacity.

## Persistence Model

### Generic base tables

durable_runs contains:

- run_id, workload_kind, idempotency_key;
- status, created_at, next_run_at, expires_at, completed_at;
- lease owner and expiry;
- current attempt number and maximum attempt count;
- workload input and state JSON;
- route and actor identity JSON;
- terminal error code and redacted summary;
- retention and deletion metadata.

durable_attempts contains:

- attempt_id, run_id, ordinal;
- lease-correlated execution session;
- started, heartbeat, and finished timestamps;
- phase, risk classification, outcome, failure, and bounded diagnostics.

durable_outbox contains:

- delivery identity and idempotency key;
- Run and Attempt references;
- route, kind, bounded rendered payload, and workload metadata;
- pending, sending, sent, failed, or unknown state;
- delivery attempts, retry time, message ID, and redacted error.

Workload-specific state remains in validated versioned JSON. It is parsed by the
registered workload before claim and bounded before commit. This avoids a large
set of nullable Async Task columns in the generic table while retaining one
transactional Run/Attempt/outbox model.

### Cron definition and runtime projection

Cron JSON remains authoritative for:

- ID and display name;
- type and task definition;
- schedule and timezone;
- target, creator, and model;
- active or paused state;
- next_run_at schedule cursor;
- monotonic definition revision.

The admitted Run stores an immutable definition snapshot. Later edits apply only
to future Runs.

New execution and delivery state is authoritative in SQLite. Existing JSON
runtime fields remain a compatibility projection so current list/status UI and
skills do not break. Projection updates use compare-and-swap against Job ID,
creation identity, and definition revision. They never overwrite concurrent
metadata edits. Historical runtime fields present before migration remain
readable but do not cause new execution.

### Idempotency

Scheduled Runs use:

    cron:<job-id>:<definition-revision>:<scheduled-occurrence>

Manual Runs use a trusted request ID:

    cron-manual:<job-id>:<definition-revision>:<request-id>

Feishu delivery uses a stable outbox delivery key derived from the Run and
delivery kind. A retry reuses the same key.

## Schema Migration

The existing continuation schema is migrated in one SQLite transaction:

1. Create generic Durable Run tables and schema-version metadata.
2. Convert each existing continuation Job into a workload_kind=async_task
   Run while preserving public Job ID and idempotency key.
3. Convert Attempts, outbox entries, interrupts, and operation receipts while
   preserving IDs, statuses, leases, execution phases, message IDs, and
   timestamps.
4. Store continuation-specific fields in versioned Async Task input/state.
5. Validate record counts, foreign keys, required identifiers, and bounded JSON.
6. Drop superseded continuation base tables and rename the new tables.
7. Commit once.

Active Attempts retain their leases. Startup recovery applies the existing
opaque-execution rule after lease expiry; migration never resets them to queued.

Migration failure rolls back the transaction and marks the Durable Run runtime
unavailable. No legacy runtime starts.

Existing Cron JSON definitions gain a deterministic revision during normal
read/backfill. Subsequent semantic definition changes increment it atomically.
Runtime-only projection changes do not increment revision.

## Scheduling and Admission

For every active due definition:

1. Refresh the Job and compute the latest due occurrence in the Job timezone.
2. Build the immutable workload snapshot and idempotency key.
3. Idempotently create the Run.
4. Compare-and-swap the Job schedule cursor to the next occurrence.
5. Wake the Durable Run worker.

If the process stops after Run creation but before cursor advancement, the next
scan repeats admission with the same key and then advances the cursor. If it
stops after cursor advancement, the admitted Run remains claimable in SQLite.

Startup recovery admits only the latest missed occurrence, matching current
behavior. The exact due boundary is standardized as next_run_at <= now.

Admission rejects overlap when a non-terminal Run exists for the same Job
instance. Manual rerun uses the same overlap rule but may admit a paused Job and
does not alter status or a future schedule cursor.

run_job waits for its admitted Run to reach an execution terminal state and
returns success or failed, preserving its current action contract. Delivery may
continue independently if execution produced a result but Feishu is temporarily
unavailable.

## Execution

### Cron prompt

The direct-exec workload reuses the current cronJobPrompt, model override,
Codex configuration, working directory, tool/action bridge, creator identity,
and synthetic thread isolation.

Codex execution produces a bounded report and lifecycle result. It does not
send Feishu messages. Empty output and lifecycle rejection become failed
execution results with an English error report payload.

The execution commit atomically:

- finalizes the Attempt;
- records success or failure;
- stores bounded report and diagnostics in workload state;
- inserts exactly one terminal outbox entry;
- updates the compatibility projection request.

### Cron message

The fixed-message workload performs no model execution. It validates and
commits the configured content as a terminal delivery payload. The Feishu send
occurs only in the delivery adapter. This preserves one common outbox path for
both Cron types.

### Retry and interrupted execution

Safe pre-execution infrastructure failures may be retried within the existing
bounded retry count and delay policy.

Once opaque Codex or external tool execution has started, lease loss or an
unknown commit outcome is not blindly replayed. The Run becomes blocked or
failed with an explicit unknown-outcome reason and diagnostic evidence.

Permanent target errors are identified during delivery, auto-pause the matching
Job instance through compare-and-swap, and terminate delivery. Transient
delivery errors retry only the outbox.

## Delivery

The Cron delivery adapter consumes durable_outbox after execution commit.
It uses the current Lark transport, report Markdown/Card behavior, target chat,
bot-message tracking, and stable delivery idempotency key.

Execution and delivery states are independent:

- successful execution plus pending delivery is not reported as fully delivered;
- delivery failure does not rerun Codex;
- a timeout after an ambiguous Feishu response becomes unknown, not an
  automatic duplicate send;
- a confirmed transient pre-send failure may retry the same outbox entry;
- a confirmed message ID marks the delivery sent and updates the runtime
  compatibility projection.

## Shutdown and Recovery

Shutdown stops admission, then stops workers from claiming new Runs. Active
attempts receive the same bounded shutdown behavior as Async Task; unresolved
leases are recovered on restart.

Recovery order is:

1. initialize and migrate SQLite;
2. recover expired leases and delivery claims;
3. connect Lark transport;
4. admit latest missed Cron occurrences;
5. start workload workers and delivery claims.

There is no execution before transport readiness and no fallback to
JobScheduler.executeJob.

## Observability and Audit

Every Run, Attempt, and delivery includes the Run ID, workload kind, Job ID when
applicable, Attempt ID, and actor identity. Diagnostics remain redacted.

Cron status preserves separate:

- execution status;
- output status;
- delivery status;
- report type and bounded report;
- execution error and delivery error;
- diagnostic snapshot.

Audit entries distinguish admission, execution, recovery, delivery, projection,
manual rerun, and auto-pause.

## Compatibility Requirements

The migration must preserve:

- existing Job JSON and stable IDs;
- aliases, Cron expressions, per-Job timezone, DST behavior, pause/resume, and
  latest-missed-run semantics;
- manual rerun of paused Jobs without schedule mutation;
- non-overlap between scheduled and manual runs;
- prompt text, model, tools, actions, working directory, creator identity, and
  target route;
- body-only Markdown/Card report delivery and English error messages;
- message type/content and bot-message tracking;
- status/list rendering and quoted-report rerun metadata;
- concurrent edit and delete/recreate stale-write protection.

## Test Strategy

Testing is test-first and proceeds in these layers:

1. Characterization tests lock down current scheduling, identity, prompt,
   runtime projection, and manual-rerun behavior.
2. Domain tests cover generic Run transitions and idempotency.
3. Repository tests cover admission, claims, leases, atomic Attempt/outbox
   commits, unknown outcomes, and migration from historical schemas.
4. Worker tests cover capacity isolation, heartbeat, cancellation, shutdown,
   and delivery independence.
5. Cron tests cover latest missed occurrence, exact boundary, per-Job timezone,
   DST spring-forward/fall-back, overlap, paused manual runs, edit races, and
   delete/recreate races.
6. Process tests inject exits around admission, claim, execution commit, outbox
   commit, send, and delivery commit.
7. Wiring tests verify the real Cron prompt runner retains model, tools,
   identity, synthetic thread, report rendering, and target route.
8. Architecture checks reject references from Scheduler to Codex execution,
   retry sleeps, and Feishu send APIs.
9. The final gate runs typecheck, build, full test, plugin source sync, dry-run,
   dependency audit, and release metadata checks.

## Cutover and Release

The implementation lands in one migration PR:

- no runtime feature flag;
- no dual write;
- no legacy Cron executor;
- no retained compatibility branch after migration;
- migration failure is explicit and fail-closed.

The release is v2.9.0 because it adds a shared runtime architecture and
changes internal persistence while preserving the public Cron interface.

## Acceptance Criteria

1. Cronjob and Async Task share the generic Run/Attempt/lease/outbox kernel.
2. They remain separate workloads and user-facing concepts.
3. Existing Async Task records and commands survive migration.
4. Existing Cron definitions and management behavior remain compatible.
5. Cron Runs survive restart without loss or blind replay.
6. Delivery retry never re-executes a generated report.
7. No Scheduler-owned execution, retry, or direct delivery code remains.
8. Compatibility, migration, crash/restart, and full regression suites pass.
9. PR is merged, v2.9.0 is released, #315 is closed, and #302 is updated with
   evidence.
