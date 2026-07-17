# Continuation Progress Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one idempotent, factual progress update for every committed `continue`, while preserving exactly one terminal summary.

**Architecture:** Migrate the single-row terminal outbox into a multi-event outbox keyed by stable event names. Terminal events supersede undelivered progress and receive delivery priority.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Feishu delivery adapter, smoke tests.

## Global Constraints

- Direct schema migration only.
- Event keys are `progress:<attempt_id>` and `terminal`.
- Terminal state commits never depend on successful message delivery.
- Undelivered progress is superseded when a terminal event exists.

---

### Task 1: Multi-Event Outbox

**Files:**
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Test: `scripts/continuation-repository-smoke.ts`

- [ ] Write failing migration, uniqueness, ordering, and supersession assertions.
- [ ] Run `node --import tsx scripts/continuation-repository-smoke.ts` and confirm failure.
- [ ] Migrate to schema v5 with `event_key`, `kind`, `attempt_id`, and unique `(job_id,event_key)`.
- [ ] Re-run the repository smoke test and confirm PASS.

### Task 2: Progress Rendering And Delivery Diagnostics

**Files:**
- Modify: `src/continuation/lark-delivery.ts`
- Modify: `src/continuation/worker.ts`
- Modify: `src/continuation/command-handler.ts`
- Modify: `src/continuation/service.ts`
- Test: `scripts/continuation-delivery-smoke.ts`
- Test: `scripts/continuation-worker-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`

- [ ] Add failing assertions for factual checkpoint rendering, stable UUID reuse, terminal priority, and `/task status` delivery rows.
- [ ] Run the three focused smoke tests and confirm the expected failures.
- [ ] Insert progress events transactionally on `continue`, expose bounded delivery records, and supersede pending progress on terminal insertion.
- [ ] Re-run the focused smoke tests and confirm PASS.

### Task 3: v2.5.0 Release

**Files:**
- Modify: version metadata files checked by `scripts/release-version-check.js`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README_CN.md`

- [ ] Set every package/plugin/badge version to `2.5.0` and document #289 behavior.
- [ ] Run `rsync -a src/ plugins/lark/src/ && npm test && npm run build`.
- [ ] Review the diff, merge the PR, verify merged `main`, publish `v2.5.0`, and close #289 with PR/release evidence.

