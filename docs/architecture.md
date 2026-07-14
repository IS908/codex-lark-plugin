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

The remaining planned order is:

1. Hotspot module splits.

## PR Guidance

For architecture-sensitive changes, the PR description should state:

- which layer owns any new state or policy;
- failure behavior and rollback/partial-write semantics;
- new dependency edges and whether the architecture baseline changed;
- impact on known hotspots such as `index.ts`, `codex-exec-actions.ts`,
  `scheduler.ts`, `reply-sender.ts`, `memory/file.ts`, and `channel.ts`;
- why any new baseline entry is temporary and which follow-up removes it.
