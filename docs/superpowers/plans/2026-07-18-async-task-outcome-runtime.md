# Async Task Outcome Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist trustworthy Async Task inputs and contracts, then add outcome-driven checkpoints and generic recovery without changing Cronjob behavior.

**Architecture:** Keep the existing continuation bounded context and SQLite runtime. Separate immutable server facts, validated model contracts, model-owned progress checkpoints, and parent-owned operation/recovery events so future Durable Run Kernel extraction does not force Cronjob into the Async Task protocol.

**Tech Stack:** TypeScript ESM, Zod, Node.js 24 `node:sqlite`, SHA-256, existing smoke-test scripts.

## Global Constraints

- Do not modify Cronjob execution, scheduling, rerun, or delivery behavior.
- Do not add a DAG, Postgres, an external workflow engine, or a second state machine.
- Preserve stdout for MCP JSON-RPC; diagnostics use stderr.
- Preserve current redaction, retention, outbox, and no-blind-replay guarantees.
- Mirror every `src/` change under `plugins/lark/src/` and rebuild runtime output.
- Use failing smoke tests before each production behavior change.

---

### Task 1: Issue #303 Immutable Facts And Managed Inputs

**Files:**
- Modify: `src/domain/continuation.ts`
- Modify: `src/continuation/artifact-store.ts`
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/codex-exec-action-schemas.ts`
- Modify: `src/codex-exec-action-channel.ts`
- Test: `scripts/continuation-action-smoke.ts`
- Test: `scripts/continuation-repository-smoke.ts`
- Test: `scripts/continuation-restart-process-smoke.ts`

**Interfaces:**
- Produces: `AsyncTaskFactSnapshot`, `AsyncTaskContract`, `AsyncTaskInputArtifact`, and `ContinuationArtifactStore.ingestInputs(jobId, paths)`.
- Consumes: authenticated `LarkMessage`, canonical working-directory resolution, existing repository creation transaction.

- [ ] **Step 1: Add failing action tests for explicit deliverables and verification requirements**

Add a valid `create_continuation_job` action with `deliverables` and
`verification_requirements`, then assert empty IDs, duplicate IDs, and oversized
entries are rejected by `CreateContinuationActionSchema`.

- [ ] **Step 2: Run the action smoke test and verify the new action fails validation**

Run: `npx tsx scripts/continuation-action-smoke.ts`
Expected: FAIL because the schema and domain contract fields do not exist.

- [ ] **Step 3: Add bounded contract and fact types**

Define server-owned source facts separately from model-authored contract fields.
Use stable criterion and deliverable IDs validated by `/^[A-Za-z0-9_.-]{1,80}$/`.
Keep paths out of model-provided source facts.

- [ ] **Step 4: Add failing managed-input tests**

Create image/file fixtures, call creation from a message containing `imagePaths`
and attachments, and assert managed references survive source deletion, have a
SHA-256 checksum, and reject paths outside the admitted local input set.

- [ ] **Step 5: Run repository and restart smoke tests and verify failure**

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: FAIL because fact/contract columns and managed input ingestion are absent.

Run: `npx tsx scripts/continuation-restart-process-smoke.ts`
Expected: FAIL because source facts are not restored after reopening SQLite.

- [ ] **Step 6: Implement managed input ingestion and schema v7 migration**

Copy admitted local files into `artifacts/<job-id>/inputs/`, compute SHA-256 while
copying, store relative references, and persist `source_facts_json` plus
`task_contract_json`. Rebuild SQLite CHECK-constrained tables in one transaction
and migrate legacy jobs to bounded synthetic facts/contracts derived from existing
trusted columns.

- [ ] **Step 7: Verify issue #303 targeted tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx tsx scripts/continuation-action-smoke.ts`
Expected: PASS.

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: PASS.

Run: `npx tsx scripts/continuation-restart-process-smoke.ts`
Expected: PASS.

- [ ] **Step 8: Mirror, self-review, commit, PR, and merge #303**

Run `rsync -a src/ plugins/lark/src/`, `npm run check:plugin-src-sync`,
`git diff --check`, and `npm test`. Review fact ownership, redaction, migration,
and unrelated churn. Commit with `feat: persist async task source facts`, open a
PR with `Closes #303`, inspect checks/comments, fix findings, and squash merge.

### Task 2: Issue #300 CheckpointV2 And Outcome Scheduling

**Files:**
- Create: `src/continuation/progress-policy.ts`
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/worker.ts`
- Test: `scripts/continuation-domain-smoke.ts`
- Test: `scripts/continuation-codex-runner-smoke.ts`
- Test: `scripts/continuation-repository-smoke.ts`

**Interfaces:**
- Produces: `ContinuationCheckpointV2`, `ContinuationAttemptDelta`, and pure `evaluateContinuationProgress(previous, next, budget)`.
- Consumes: #303 task-contract criterion/deliverable IDs and managed artifact references.

- [ ] **Step 1: Add failing pure policy tests**

Cover material evidence/artifact/completed-step changes, missing next action,
duplicate deltas, acceptance completion below max attempts, and two consecutive
no-progress attempts.

- [ ] **Step 2: Run domain smoke and verify policy tests fail**

Run: `npx tsx scripts/continuation-domain-smoke.ts`
Expected: FAIL because the progress policy and V2 types are absent.

- [ ] **Step 3: Implement CheckpointV2 and deterministic progress policy**

Canonicalize bounded progress fields, compare trusted material hashes, require one
next action for continuation, and return `continue`, `complete`, or
`fail_stalled` without trusting model confidence alone.

- [ ] **Step 4: Add failing runner/repository delta tests**

Assert the runner receives immutable facts plus contract, emits a structured
delta, the repository stores it on the immutable attempt, and restart preserves
the latest valid checkpoint and no-progress count.

- [ ] **Step 5: Run runner/repository smoke and verify failure**

Run: `npx tsx scripts/continuation-codex-runner-smoke.ts`
Expected: FAIL because the output schema lacks V2 checkpoint/delta fields.

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: FAIL because attempts do not persist deltas.

- [ ] **Step 6: Implement runner, repository, and event integration**

Persist bounded attempt deltas and append parent-owned state-transition events.
Convert legacy checkpoints once during migration/read normalization. Terminate
with `continuation_stalled` after the configured consecutive no-progress limit.

- [ ] **Step 7: Verify, review, PR, and merge #300**

Run targeted tests, `npm run typecheck`, `npm run check:architecture`, source
mirroring, `git diff --check`, and `npm test`. Commit with
`feat: make continuation progress outcome driven`, open a PR with `Closes #300`,
resolve review findings, and squash merge.

### Task 3: Issue #299 Generic Recovery And User Resume

**Files:**
- Create: `src/domain/durable-run.ts`
- Create: `src/continuation/recovery-policy.ts`
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/local-cli-tool-invoker.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/command-handler.ts`
- Modify: `src/continuation/lark-delivery.ts`
- Modify: `src/inbound-turn-pipeline.ts`
- Test: `scripts/continuation-local-cli-invoker-smoke.ts`
- Test: `scripts/continuation-worker-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`
- Test: `scripts/inbound-turn-pipeline-smoke.ts`

**Interfaces:**
- Produces: `DurableRunFailure`, `DurableRunRecoveryDecision`, pure `decideRecovery`, persisted interrupts, and `ContinuationTaskService.resumeForActor`.
- Consumes: #300 checkpoint/delta and event contracts plus existing tool-call/outbox receipts.

- [ ] **Step 1: Add failing normalization and policy tests**

Cover invalid invocation with hints, safe transient retry, ambiguous side effect,
authentication/permission wait, unavailable capability block, terminal failure,
unknown error, fingerprint budget, and total recovery budget.

- [ ] **Step 2: Run invoker/worker smoke and verify failure**

Run: `npx tsx scripts/continuation-local-cli-invoker-smoke.ts`
Expected: FAIL because failed tool results have no normalized semantics.

Run: `npx tsx scripts/continuation-worker-smoke.ts`
Expected: FAIL because `recovering` and `waiting_user` are unsupported.

- [ ] **Step 3: Implement generic failure semantics and adapter normalization**

Parse structured adapter output without matching tool names. The adapter reports
category, retry safety, capability availability, operation risk, hints, failed
step, and a bounded redacted diagnostic. The policy alone chooses task state.

- [ ] **Step 4: Add failing interrupt/resume tests**

Assert a permission failure creates one interrupt outbox row, stores its delivered
message ID, authorizes creator/owner only, resumes the same Job from a quoted reply
or `/task resume`, and rejects duplicate/stale resume input.

- [ ] **Step 5: Run command/inbound tests and verify failure**

Run: `npx tsx scripts/continuation-command-smoke.ts`
Expected: FAIL because `/task resume` is unknown.

Run: `npx tsx scripts/inbound-turn-pipeline-smoke.ts`
Expected: FAIL because quoted interrupt routing is not resolved.

- [ ] **Step 6: Implement persisted recovery, interrupt delivery, and same-Job resume**

Add `recovering` and `waiting_user` transitions, bounded counters, interrupt rows,
interrupt outbox markers, delivery-message lookup, authenticated input events, and
atomic resume to `recovering`. Preserve unknown external outcomes without replay.

- [ ] **Step 7: Verify, review, PR, and merge #299**

Run targeted tests, restart tests, `npm run typecheck`, architecture/source-sync
checks, `git diff --check`, and `npm test`. Commit with
`feat: add generic continuation recovery`, open a PR with `Closes #299`, resolve
all review findings, and squash merge.

### Task 4: Release And Tracker Reconciliation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `plugins/lark/package.json`
- Modify: `plugins/lark/package-lock.json`
- Modify: `plugins/lark/.codex-plugin/plugin.json`
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: merged #303, #300, and #299 behavior.
- Produces: release v2.8.0 and evidence-based final states for #301/#302.

- [ ] **Step 1: Update documentation and v2.8.0 metadata**

Document source-fact ownership, task contracts, CheckpointV2, recovery categories,
waiting-user resume, and unchanged Cronjob behavior. Keep all manifests aligned.

- [ ] **Step 2: Run final release verification**

Run: `npm test`
Expected: PASS with all smoke tests, architecture checks, source sync, build, and
dry-run checks successful.

Run: `npm run check:release-version`
Expected: PASS for 2.8.0.

Run: `git diff --check`
Expected: no output.

- [ ] **Step 3: Merge release PR and publish**

Inspect PR checks/comments, squash merge, publish GitHub release `v2.8.0` from the
merged `main`, and verify the tag is neither draft nor prerelease.

- [ ] **Step 4: Reconcile umbrella issues**

Comment on #301 with the delivered architecture and explicitly deferred semantic
review/kernel extraction. Keep #302 open as the compatibility-direction tracker
unless its documentation-only success criteria are fully satisfied; do not claim
Cronjob kernel migration occurred.
