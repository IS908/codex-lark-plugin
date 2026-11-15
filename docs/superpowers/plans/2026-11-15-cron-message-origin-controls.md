# Cron Message Origin Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Issue #374 by making Cron messages restart-safe, directly controllable, privacy-preserving, and verifiably tied to their source Job.

**Architecture:** Extend the shared SQLite durable-run schema with a bounded message-origin store, record confirmed IDs at the Cron delivery boundary, and resolve direct quotes in the inbound pipeline. A shared Cron control service backs both SDK card actions and deterministic quoted commands; generated report cards expose source metadata and controls without embedding Job bodies.

**Tech Stack:** TypeScript ESM, Node.js `node:sqlite`, `@larksuite/channel`, existing smoke-test harness.

**Spec:** `docs/superpowers/specs/2026-11-15-cron-message-origin-controls-design.md`

## Global Constraints

- Node.js 24.15.0 or newer; use the existing built-in SQLite database and migration sequence.
- Never retry a Feishu send solely because post-send origin recording failed.
- Identity comes from authenticated Feishu events; action payloads never carry a caller.
- Default Job lists must not include prompt/content bodies.
- Pausing does not cancel an in-flight Run.

## Review Focus

- Partial and split Feishu delivery: every confirmed message ID maps to one origin, without duplicate replay.
- Deleted and recreated Job with the same ID: stale cards cannot mutate the replacement.
- Cross-chat quote or forged action value: no origin leak and no mutation.
- Store failure after confirmed send: outbox remains `sent`, with a diagnostic only.
- Control sentinel produced by Cron generation: no user-visible marker or empty success report.

---

### Task 1: Durable Message-Origin Store

**Files:**
- Modify: `src/durable-run/sqlite-migrations.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/runtime.ts`
- Create: `src/cron/message-origin-store.ts`
- Test: `scripts/cron-message-origin-store-smoke.ts`
- Test: `scripts/durable-run-migration-smoke.ts`

**Interfaces:**
- Produces: `CronMessageOriginStore.get(messageId)` and `recordDelivery(input)`.

- [x] Write store and v10-to-v11 migration assertions, then verify they fail.
- [x] Implement schema creation, bounded writes, lookup, and runtime exposure.
- [x] Run store and migration smoke tests until green.

### Task 2: Delivery Recording And Report Controls

**Files:**
- Modify: `src/cron/delivery.ts`
- Modify: `src/cron/run-admission.ts`
- Modify: `src/cron/runtime-projection.ts`
- Modify: `src/feishu-card.ts`
- Modify: `src/reply-sender.ts`
- Modify: `src/index.ts`
- Test: `scripts/cron-delivery-smoke.ts`
- Test: `scripts/card-smoke.ts`

**Interfaces:**
- Consumes: `CronMessageOriginRecorder.recordDelivery`.
- Produces: route `jobName`, report footer, callback values, all-ID recording.

- [x] Add failing delivery/card assertions for source metadata, controls, split IDs, and record-write failure.
- [x] Add route metadata, card control rendering, and best-effort post-send recording.
- [x] Wire the shared runtime store into channel lookup and Cron delivery.
- [x] Run Cron delivery and card smoke tests until green.

### Task 3: Shared Cron Controls And Native Card Actions

**Files:**
- Create: `src/cron/control-service.ts`
- Create: `src/cron/card-actions.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/channel.ts`
- Modify: `src/lark-message.ts`
- Modify: `src/sdk-channel-runtime.ts`
- Modify: `src/index.ts`
- Test: `scripts/cron-control-service-smoke.ts`
- Test: `scripts/sdk-runtime-smoke.ts`

**Interfaces:**
- Produces: exact-instance pause/view/run controls and `Scheduler.startJobNow(job)`.

- [x] Write failing tests for owner checks, stale Job fencing, idempotent pause, visibility, admission, and SDK callback responses.
- [x] Implement the shared service, fast admission method, card-action parser, and SDK event wiring.
- [x] Run control and SDK smoke tests until green.

### Task 4: Deterministic Quoted Commands And Concise Details

**Files:**
- Create: `src/cron/inbound-command.ts`
- Modify: `src/codex-delivery-wiring.ts`
- Modify: `src/codex-exec-action-schemas.ts`
- Modify: `src/codex-exec-actions.ts`
- Modify: `src/tools/jobs.ts`
- Modify: `src/prompts.ts`
- Modify: `src/codex-exec-delivery.ts`
- Test: `scripts/cron-inbound-command-smoke.ts`
- Test: `scripts/codex-exec-actions-smoke.ts`
- Test: `scripts/job-smoke.ts`

**Interfaces:**
- Consumes: trusted `quotedCronJobOrigin` and shared control service.
- Produces: deterministic quoted pause/view/run handling, bounded candidates, concise list, explicit details.

- [x] Write failing tests for mapped commands, unmapped historical quotes, no guessing, concise list output, and authorized details.
- [x] Implement command interception and detail/list rendering changes.
- [x] Add prompt guidance for trusted quoted pause/view/run operations.
- [x] Run command, action, and Job smoke tests until green.

### Task 5: Sentinel Suppression And Full Verification

**Files:**
- Modify: `src/codex-exec-delivery.ts`
- Modify: `scripts/codex-exec-delivery-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Produces: unconditional suppression of valid defer/no-reply sentinels.

- [x] Add a failing Cron delivery-sink sentinel test with no turn-obligation tracker.
- [x] Suppress sentinels before any delivery sink or user-visible send.
- [x] Run targeted smoke tests, `npm run typecheck`, `npm run check:architecture`, `git diff --check`, and `npm test`.
