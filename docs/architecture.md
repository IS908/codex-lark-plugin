# Architecture Boundaries

This project uses a layered architecture target for new code and incremental
refactors. Existing runtime behavior is preserved while current coupling is
paid down in phases tracked by GitHub issues.

## Target Direction

```text
entrypoints / bootstrap
    ↓
application / use-cases
    ↓
domain
    ↓
ports ← infrastructure adapters
```

Inner layers must not import outer layers.

- **Domain** owns pure message, conversation, boundary, job, and memory models,
  plus policies and state transitions that do not perform side effects.
- **Application/use-cases** orchestrate inbound turns, reply delivery,
  conversation flushes, and scheduled job execution through ports.
- **Ports** describe contracts for message transport, session storage, memory
  repositories, job repositories, clocks, and schedulers.
- **Infrastructure** contains Lark SDK/OpenAPI, Codex exec, filesystem
  persistence, timers, cron, process-global configuration, and runtime adapters.
- **Entrypoints/bootstrap** wire dependencies and process lifecycle only.

## Automated Guardrails

`npm run check:architecture` runs `scripts/architecture-check.js`.
`npm test` runs the same check.

The check currently enforces:

- no new circular dependency components under `src/`;
- no new imports from `channel.ts` as a shared contract owner;
- no new transport API modules importing back from the `lark-transport.ts`
  facade;
- no new `job-store.ts` ↔ `cronjob-diagnostics.ts` coupling;
- future `src/domain/**` and `src/ports/**` modules cannot import known
  infrastructure modules.
- continuation domain/port contracts cannot import continuation or process
  infrastructure, and `src/continuation/**` cannot import the cronjob store,
  service, or scheduler.
- `src/scheduler.ts` is admission-only: it cannot import or reference Codex
  delivery, Lark transport send APIs, scheduler retry helpers, retry/sleep
  constants, or Cron workload implementations. Its sole Cron dependency is
  `cron/run-admission`, which creates durable-run requests through the
  domain/ports boundary.

Temporary exceptions must be listed in `scripts/architecture-baseline.json` with
a reason and removal phase. The current baseline is empty; adding an exception
requires an explicit architecture decision and baseline update.

## Current Baseline

The current baseline is empty:

- `LarkMessage` and channel handler contracts live in `src/lark-message.ts`;
- bot/latest message trackers live in `src/message-trackers.ts`;
- transport contracts live in `src/lark-transport-contracts.ts`;
- job and cronjob diagnostic contracts live in `src/job-contracts.ts` and
  `src/cronjob-diagnostic-contracts.ts`;
- shared job timezone helpers live in `src/job-timezone.ts`.
- `src/index.ts` is now a composition root; startup cleanup, session health,
  conversation flush, Codex delivery, and channel service orchestration live in
  focused service modules.
- Codex exec action schemas and envelope parsing live in
  `src/codex-exec-action-schemas.ts`; dispatch goes through
  `src/codex-exec-action-registry.ts` so action validation/routing is separate
  from the individual handler implementations.
- `src/scheduler.ts` owns only schedule scanning and Cron run admission. Retry,
  delivery, execution, leases, and recovery belong to the shared durable-run
  kernel; Cron adapters participate through `src/domain/durable-run.ts` and
  `src/ports/durable-run.ts`. `src/scheduler-policy.ts` remains a legacy
  delivery-policy dependency outside the Scheduler boundary.
- Synthetic cronjob thread identifiers live in `src/job-thread.ts`; the Cron
  prompt executor and reply-routing policy depend on that focused contract
  directly, while Scheduler remains unaware of execution-thread mechanics.
- Reply target planning and invalid/synthetic message handling live in
  `src/reply-routing-policy.ts`; `src/reply-sender.ts` owns upload/send
  adapter behavior.
- Profile memory privacy, line identity, and merge policy live in
  `src/memory/profile-policy.ts`; `src/memory/file.ts` owns filesystem
  persistence, locks, and migration orchestration.
- Persistent continuation is an independent bounded context. Pure state and
  closed outcomes live in `src/domain/continuation.ts`; repository, executor,
  delivery, clock, and audit contracts live in `src/ports/continuation.ts`.
  Server-derived source facts (including bounded document-comment selected and
  parent context) and task contracts are persisted independently;
  admitted source files live in logically immutable, checksum-verified input
  trees that are read-only to Codex and the sandbox, never in the writable
  output artifact tree. Processes running under the same OS uid remain inside
  the local trust boundary and can bypass file mode bits; checksum validation
  detects mutation but is not an OS-adversary-proof isolation boundary.
  SQLite/artifact persistence, the structured Codex runner, leases, commands,
  Lark progress/terminal delivery, and composition live under `src/continuation/`.
  Attempt handoff uses a schema-versioned checkpoint with stable step,
  deliverable, criterion, artifact, evidence, and side-effect IDs. The parent
  verifies monotonic continuity and artifact checksums, derives a material-only
  attempt delta, and persists both the delta and verification verdict. Free-form
  summaries, decisions, stop reasons, and confidence do not count as progress.
  A verified completion may terminate below the configured attempt ceiling;
  rejected candidates enter the schedulable `recovering` state, and two
  consecutive attempts without verified material change terminate early as
  `continuation_stalled`. Checkpoints, deltas, verdicts, and no-progress counts
  are restored from SQLite after restart and are exposed through `/task status`.
  Parent-owned adapters normalize host-tool failures into stable orchestration
  categories. A generic recovery policy combines those categories with explicit
  retry safety, operation risk, and persisted per-fingerprint/total budgets.
  Safe repair retries remain `recovering`; authentication, permission, and
  ambiguous external outcomes create a durable `waiting_user` interrupt. The
  creator or owner may resume the same Job only from its original route, using
  `/task resume` or an IM reply to the delivered interrupt. Tool-call identity is
  `(job_id, step_id, request_hash)`, so completed side effects are never blindly
  replayed after retries, restarts, or schema migration.
  Retention consumes the persisted terminal delivery result, serializes cleanup
  against retain mutations, and preserves only a compact audited tombstone.
  The local CLI continuation adapter is parent-owned. Standard Codex tools stay
  inside the sandbox. The `bounded` continuation profile remains network-disabled.
  The parent derives authority from authenticated identity and automatically
  assigns the owner or current `allowed_user_ids` members the audited
  `trusted_personal_workspace` profile, which requests `disk-full-read-access`,
  enables network, and revalidates creator eligibility before every attempt
  under the current trust-first policy. Canonical `requested_paths` default to
  the working directory and remain admission/audit metadata rather than a
  profile selector, capability grant, or initial read allowlist. The
  external `required_tools` declaration is reserved for additional host CLI
  names; creation rejects names absent from `local-cli-tools.json`, while the
  adapter revalidates the exact persisted `requiredTools` name against current
  configuration and the persisted creator before spawning one
  configured command. A per-job/per-step SQLite call ledger stores only a
  request fingerprint and bounded redacted result; completed calls replay the
  result, while ambiguous in-flight calls block instead of executing again.
  Each Job also stores a server-derived permission envelope. The focused
  working-directory policy requires the persisted root and current configured
  root to both contain the canonical target on every run, and filesystem modes
  use the stricter value. Approval mode `interactive` is reserved in the domain
  schema but fails closed until a one-time, identity-bound approval coordinator
  exists; foreground approval and user configuration are never copied.
  Terminal state and its outbox row commit in one SQLite transaction; remote
  Lark delivery is reconciled separately and never claims distributed
  exactly-once semantics.

There is no active architecture baseline exception. Future hotspot work should
continue to be driven by concrete behavior or dependency evidence rather than
large mechanical reshuffles.

## PR Guidance

For architecture-sensitive changes, the PR description should state:

- which layer owns any new state or policy;
- failure behavior and rollback/partial-write semantics;
- new dependency edges and whether the architecture baseline changed;
- impact on known hotspots such as `index.ts`, `codex-exec-actions.ts`,
  `scheduler.ts`, `reply-sender.ts`, `memory/file.ts`, and `channel.ts`;
- why any new baseline entry is temporary and which follow-up removes it.
