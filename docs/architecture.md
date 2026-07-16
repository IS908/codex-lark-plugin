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
- Scheduler retry and permanent-target classification live in
  `src/scheduler-policy.ts`; timer, storage, and delivery effects remain in
  `src/scheduler.ts`.
- Synthetic cronjob thread identifiers live in `src/job-thread.ts`; scheduler
  re-exports them for compatibility, but routing policy can depend on the
  light contract directly.
- Reply target planning and invalid/synthetic message handling live in
  `src/reply-routing-policy.ts`; `src/reply-sender.ts` owns upload/send
  adapter behavior.
- Profile memory privacy, line identity, and merge policy live in
  `src/memory/profile-policy.ts`; `src/memory/file.ts` owns filesystem
  persistence, locks, and migration orchestration.
- Persistent continuation is an independent bounded context. Pure state and
  closed outcomes live in `src/domain/continuation.ts`; repository, executor,
  delivery, clock, and audit contracts live in `src/ports/continuation.ts`.
  SQLite/artifact persistence, the structured Codex runner, leases, commands,
  Lark terminal delivery, and composition live under `src/continuation/`.
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
