# Conversational Cron Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Issue #377 by removing management buttons from new Cron reports while preserving exact conversational task management.

**Architecture:** Delivery continues to persist every confirmed message origin and render the source footer, but omits card actions. Quoted and topic replies use the persisted origin through deterministic controls or the existing structured action bridge, with stale-instance fencing.

**Tech Stack:** TypeScript ESM, Node.js `node:sqlite`, Feishu CardKit Schema 2.0, existing smoke-test harness.

**Spec:** `docs/superpowers/specs/2026-11-15-conversational-cron-controls-design.md`

## Global Constraints

- Preserve existing message-origin persistence and cross-chat rejection.
- Keep old delivered card callbacks functional.
- Do not infer a Job from thread history without a mapped parent/root message.
- Reuse persisted Job definitions for reruns and updates.

## Review Focus

- Split and fallback deliveries still persist every confirmed message ID.
- Topic replies resolve the mapped root report without visible buttons.
- Deleted/recreated Jobs cannot be controlled through an old report.
- Ambiguous unmapped commands remain non-mutating and prompt for clarification.
- Action results identify the display name and actual persisted state.

---

### Task 1: Button-Free Report Delivery

**Files:**
- Modify: `scripts/cron-delivery-smoke.ts`
- Modify: `src/cron/delivery.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_CN.md`

**Interfaces:**
- Preserves: `CronMessageOriginRecorder.recordDelivery(...)` and source footer.
- Changes: new report `ReplyRequest` values no longer contain `cardActions`.

- [ ] Add assertions that reports contain the source footer, contain no control buttons, and still record all split IDs.
- [ ] Run `npx tsx scripts/cron-delivery-smoke.ts` and confirm the button assertion fails.
- [ ] Remove new-report card actions without removing legacy callback handling.
- [ ] Update current behavior documentation and rerun the delivery smoke test.

### Task 2: Trusted Conversational Management

**Files:**
- Modify: `scripts/cron-inbound-command-smoke.ts`
- Modify: `scripts/inbound-turn-pipeline-smoke.ts`
- Modify: `scripts/codex-exec-delivery-smoke.ts`
- Modify: `scripts/codex-exec-actions-smoke.ts`
- Modify: `src/cron/inbound-command.ts`
- Modify: `src/inbound-turn-pipeline.ts`
- Modify: `src/quoted-context-loader.ts`
- Modify: `src/codex-exec-delivery.ts`
- Modify: `src/codex-exec-actions.ts`

**Interfaces:**
- Consumes: `LarkMessage.quotedCronJobId` and `quotedCronJobOrigin.jobCreatedAt`.
- Produces: exact run-again handling, trusted action guidance, stale-instance fences, and named operation results.

- [ ] Add failing tests for "run again", full quoted-action guidance, stale quoted updates/reruns, and display-name results.
- [ ] Run the three targeted smoke tests and confirm failures match the missing behavior.
- [ ] Implement the smallest parser, prompt, fencing, and result-format changes.
- [ ] Rerun targeted smoke tests until green.

### Task 3: Verification And Closed Loop

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `plugins/lark/runtime/index.js` through `npm run build:plugin`

**Interfaces:**
- Produces: reviewed source/runtime parity and release-ready evidence.

- [ ] Add an Unreleased changelog entry and rebuild the packaged runtime.
- [ ] Run `npm test`, both dependency audits, runtime sync, release-version check, and `git diff --check`.
- [ ] Commit, open a PR, resolve CI/review feedback, merge, publish the semver-appropriate release, and verify Issue #377 is closed.
