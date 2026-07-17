# Continuation Retention Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make continuation cleanup delivery-aware, retainable, filterable, auditable, and idempotent.

**Architecture:** Add one persisted retain bit, filter Jobs in repository queries, and gate detail redaction on a delivered terminal outbox event. Keep compact tombstone metadata while deleting detailed attempts, tool calls, payloads, and artifacts.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, command handler, audit log, smoke tests.

## Global Constraints

- Direct schema migration only.
- TTL starts at `completed_at`, default remains 30 days.
- Nonterminal, retained, or terminal-undelivered Jobs cannot be automatically cleaned.
- Manual delete remains creator/owner authorized and idempotent cleanup preserves an audit summary.

---

### Task 1: Retain And Delivery-Safe Cleanup

**Files:**
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/runtime.ts`
- Test: `scripts/continuation-repository-smoke.ts`
- Test: `scripts/continuation-runtime-smoke.ts`

- [ ] Add failing assertions for retained, undelivered, nonterminal, and delivered terminal Jobs.
- [ ] Run focused tests and confirm the failures.
- [ ] Migrate to schema v6, gate automatic cleanup, delete detail rows/artifacts, and return cleanup audit summaries.
- [ ] Re-run focused tests and confirm PASS.

### Task 2: Status Filtering And Retain Command

**Files:**
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/command-handler.ts`
- Test: `scripts/continuation-command-smoke.ts`

- [ ] Add failing `/task list --status pending,failed` and `/task retain <job_id> on|off` authorization assertions.
- [ ] Run `node --import tsx scripts/continuation-command-smoke.ts` and confirm failure.
- [ ] Add SQL-backed status filters, pending alias expansion, retain mutation, and command auditing.
- [ ] Re-run the command smoke test and confirm PASS.

### Task 3: v2.6.0 Release

**Files:**
- Modify: version metadata files checked by `scripts/release-version-check.js`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README_CN.md`

- [ ] Set all release metadata to `2.6.0` and document retention/filter commands.
- [ ] Run `rsync -a src/ plugins/lark/src/ && npm test && npm run build`.
- [ ] Review the diff, merge the PR, verify merged `main`, publish `v2.6.0`, and close #288 with PR/release evidence.

