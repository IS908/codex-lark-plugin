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

Existing violations are listed in `scripts/architecture-baseline.json` with a
reason and removal phase. Removing a baseline violation is always allowed; adding
one requires an explicit architecture decision and baseline update.

## Current Baseline

The baseline exists because v1.21.1 already has known dependency cycles around:

- `channel.ts` with SDK parity, identity, memory enrichment, doc-comment, and
  inbound pipeline modules;
- `lark-transport.ts` with transport API/context helper modules;
- `job-store.ts` with cronjob diagnostics.

The planned removal order is:

1. Guardrails and baseline.
2. Shared contracts extraction and cycle removal.
3. Composition root slimming.
4. Hotspot module splits.

## PR Guidance

For architecture-sensitive changes, the PR description should state:

- which layer owns any new state or policy;
- failure behavior and rollback/partial-write semantics;
- new dependency edges and whether the architecture baseline changed;
- impact on known hotspots such as `index.ts`, `codex-exec-actions.ts`,
  `scheduler.ts`, `reply-sender.ts`, `memory/file.ts`, and `channel.ts`;
- why any new baseline entry is temporary and which follow-up removes it.
