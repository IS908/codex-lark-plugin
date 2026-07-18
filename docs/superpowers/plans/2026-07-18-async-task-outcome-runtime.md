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
- Create: `src/continuation/input-store.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify: `src/continuation/runtime.ts`
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/worker.ts`
- Modify: `src/codex-exec-action-schemas.ts`
- Modify: `src/codex-exec-action-channel.ts`
- Modify: `src/codex-exec-actions.ts`
- Test: `scripts/continuation-action-smoke.ts`
- Test: `scripts/codex-exec-actions-smoke.ts`
- Test: `scripts/continuation-codex-runner-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`
- Test: `scripts/continuation-repository-smoke.ts`
- Test: `scripts/continuation-restart-process-smoke.ts`
- Test: `scripts/continuation-worker-smoke.ts`

**Interfaces:**
- Produces: `AsyncTaskFactSnapshot`, `AsyncTaskContract`, `AsyncTaskInputArtifact`, deterministic `continuationJobId(idempotencyKey)`, and staged input installation under a read-only input store.
- Consumes: authenticated `LarkMessage`, canonical working-directory resolution, existing repository creation transaction.

- [ ] **Step 1: Add failing action tests for explicit deliverables and verification requirements**

Add a valid `create_continuation_job` action whose wire fields are
`deliverables: [{id, description, required}]`,
`acceptance_criteria: [{id, description, deliverable_ids}]`, and
`verification_requirements: [{id, description, kind: "artifact_exists" | "artifact_sha256" | "evidence_reference"}]`.
Assert empty IDs, duplicate IDs, unknown deliverable references, and oversized
entries are rejected by `CreateContinuationActionSchema`.

- [ ] **Step 2: Run the action smoke test and verify the new action fails validation**

Run: `npx tsx scripts/continuation-action-smoke.ts`
Expected: FAIL because the schema and domain contract fields do not exist.

- [ ] **Step 3: Add bounded contract and fact types**

Define server-owned source facts separately from model-authored contract fields.
Use stable criterion and deliverable IDs validated by `/^[A-Za-z0-9_.-]{1,80}$/`.
Keep paths out of model-provided source facts.

- [ ] **Step 4: Add failing managed-input tests**

Create image/file fixtures. Existing downloaded images are admitted directly;
`executeCreateContinuation` downloads message attachment descriptors through the
current Lark transport only after the continuation action is accepted. Assert
managed references survive source deletion, have a SHA-256 checksum, and reject
paths outside the admitted set. Add failures for unreadable input and download
failure. After reopening SQLite, tamper with and remove managed inputs; assert the
worker records `continuation_input_integrity_failed` and never invokes Codex.
Retry a terminal Job after deleting its original source, then assert the new Job
owns a staged copy whose validity and cleanup are independent from the old tree.

- [ ] **Step 5: Run repository and restart smoke tests and verify failure**

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: FAIL because fact/contract columns and managed input ingestion are absent.

Run: `npx tsx scripts/continuation-restart-process-smoke.ts`
Expected: FAIL because source facts are not restored after reopening SQLite.

- [ ] **Step 6: Implement managed input ingestion and schema v7 migration**

Derive a deterministic Job ID, serialize same-ID creation, copy files into a
staging directory, compute SHA-256, chmod the completed tree read-only, atomically
rename it to `inputs/<job-id>`, and then persist `source_facts_json` plus
`task_contract_json`. On persistence failure remove a newly installed tree when no
matching row exists; clean aged orphan staging/final trees at startup. Preserve the
v1-v6 migration chain. Legacy rows use `provenance: legacy_unavailable`, null/empty
unrecoverable facts, and deterministic criterion IDs instead of fabricated source
text. Keep the v7 flattened `objective`, `acceptanceCriteria`, and
`contextSnapshot` projection derived from the contract so the existing runner
continues to execute after migration and restart. Before every execution, verify
the immutable manifest and fail closed before invoking Codex on a missing or
modified input. Clone retry inputs into a separately owned staged tree. Add
duplicate/concurrent create, staging failure, DB failure, integrity, projection,
retry-isolation, and cleanup tests.

- [ ] **Step 7: Verify issue #303 targeted tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx tsx scripts/continuation-action-smoke.ts`
Expected: PASS.

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: PASS.

Run: `npx tsx scripts/continuation-restart-process-smoke.ts`
Expected: PASS.

Run: `npx tsx scripts/continuation-worker-smoke.ts`
Expected: PASS with pre-execution input-integrity enforcement.

Run: `npx tsx scripts/continuation-codex-runner-smoke.ts`
Expected: PASS with the v7 flattened compatibility projection.

Run: `npx tsx scripts/continuation-command-smoke.ts`
Expected: PASS with independently owned managed inputs on `/task retry`.

- [ ] **Step 8: Mirror, self-review, commit, PR, and merge #303**

Run `rsync -a src/ plugins/lark/src/`, `npm run check:plugin-src-sync`,
`git diff --check`, and `npm test`. Review fact ownership, redaction, migration,
and unrelated churn. Commit with `feat: persist async task source facts`, open a
PR with `Closes #303`, inspect checks/comments, fix findings, and squash merge.

### Task 2: Issue #300 CheckpointV2 And Outcome Scheduling

**Files:**
- Create: `src/continuation/progress-policy.ts`
- Create: `src/continuation/verifier.ts`
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/command-handler.ts`
- Modify: `src/continuation/worker.ts`
- Test: `scripts/continuation-domain-smoke.ts`
- Test: `scripts/continuation-codex-runner-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`
- Test: `scripts/continuation-repository-smoke.ts`
- Test: `scripts/continuation-restart-process-smoke.ts`
- Test: `scripts/continuation-worker-smoke.ts`

**Interfaces:**
- Produces: `ContinuationCheckpointV2`, stable `currentStepId`, `ContinuationAttemptDelta`, pure `evaluateContinuationProgress(previous, next, budget)`, and `ContinuationVerifier.verify(claim, candidate)`.
- Consumes: #303 task-contract criterion/deliverable IDs and managed artifact references.

- [ ] **Step 1: Add failing pure policy tests**

Cover parent-verifiable evidence content/checksums, output artifact checksum,
completed stable criterion/deliverable/step IDs, and repository-authorized
current-step transitions. Assert free-form summaries, decisions, constraints,
stop reasons, confidence, or next-action prose alone are not material. Also cover
missing next action, duplicate deltas, acceptance completion below max attempts,
and two consecutive no-progress attempts.

- [ ] **Step 2: Run domain smoke and verify policy tests fail**

Run: `npx tsx scripts/continuation-domain-smoke.ts`
Expected: FAIL because the progress policy and V2 types are absent.

- [ ] **Step 3: Implement CheckpointV2 and deterministic progress policy**

Canonicalize bounded progress fields, compare trusted material hashes, require one
next action for continuation, and return `continue`, `complete`, or
`fail_stalled` without trusting model confidence alone.

- [ ] **Step 4: Add failing runner/repository delta tests**

Assert the runner receives immutable facts plus contract, emits a structured
delta, and the repository stores it on the immutable attempt with its stable step
ID. Add completion candidates with criterion evidence. Assert structural verifier
acceptance commits completion, verifier rejection moves to `recovering` with
bounded findings, output checksum mismatch is rejected, and `delivery_unknown`
remains distinct from execution/verification state. Restart must preserve the
latest valid checkpoint, verdict, and no-progress count. Assert each attempt
intersects the immutable admission snapshot with current policy: trusted-profile
revocation and sandbox/root narrowing cannot retain prior authority and block
before execution. `/task list` and `/task status` must classify `recovering` as
pending/runnable rather than terminal.

- [ ] **Step 5: Run runner/repository smoke and verify failure**

Run: `npx tsx scripts/continuation-codex-runner-smoke.ts`
Expected: FAIL because the output schema lacks V2 checkpoint/delta fields.

Run: `npx tsx scripts/continuation-repository-smoke.ts`
Expected: FAIL because attempts do not persist deltas.

- [ ] **Step 6: Implement runner, repository, and event integration**

Migrate v7 to v8, including `recovering` as a schedulable status with the same
lease/cancellation/expiry guarantees as other due states. Persist bounded attempt
deltas, stable step IDs, verification verdicts, and parent-owned state-transition
events. Convert legacy checkpoints once without inventing facts. Invoke the
verifier before terminal completion; revision returns to `recovering`. Terminate
with `continuation_stalled` after the configured consecutive no-progress limit.
Update command/service projections so `recovering` is consistently listed as a
pending runnable state. Recompute effective permission from current policy for
every claim instead of treating the immutable source-fact envelope as authority;
#299 may later turn a user-fixable authorization block into `waiting_user`.

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
- Modify: `src/continuation/runtime.ts`
- Modify: `src/channel-services.ts`
- Modify: `src/channel.ts`
- Modify: `src/index.ts`
- Modify: `src/lark-message.ts`
- Modify: `src/message-trackers.ts`
- Modify: `src/inbound-turn-pipeline.ts`
- Test: `scripts/continuation-local-cli-invoker-smoke.ts`
- Test: `scripts/continuation-worker-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`
- Test: `scripts/inbound-turn-pipeline-smoke.ts`
- Test: `scripts/continuation-repository-smoke.ts`
- Test: `scripts/continuation-restart-process-smoke.ts`

**Interfaces:**
- Produces: `DurableRunFailure`, `DurableRunRecoveryDecision`, pure `decideRecovery`, persisted interrupts, and `ContinuationTaskService.resumeForActor`.
- Consumes: #300 checkpoint/delta and event contracts plus existing tool-call/outbox receipts.

- [ ] **Step 1: Add failing normalization and policy tests**

Cover invalid invocation with hints, safe transient retry, ambiguous side effect,
authentication/permission wait, unavailable capability block, terminal failure,
unknown error, fingerprint budget, total recovery budget, and interrupted opaque
Codex execution. Assert opaque workspace/network/external effects never receive an
automatic lease-expiry replay unless the failure is proven pre-execution.

- [ ] **Step 2: Run invoker/worker smoke and verify failure**

Run: `npx tsx scripts/continuation-local-cli-invoker-smoke.ts`
Expected: FAIL because failed tool results have no normalized semantics.

Run: `npx tsx scripts/continuation-worker-smoke.ts`
Expected: FAIL because `recovering` and `waiting_user` are unsupported.

- [ ] **Step 3: Implement generic failure semantics and adapter normalization**

Parse structured adapter output without matching tool names. The adapter reports
category, retry safety, capability availability, operation risk, hints, failed
step, and a bounded redacted diagnostic. The policy alone chooses task state.
Migrate the tool-call key to `(job_id, step_id, request_hash)`: completed validation
failures allow corrected hashes, while any unknown running call prevents a
replacement.

- [ ] **Step 4: Add failing interrupt/resume tests**

Assert a permission failure creates one interrupt outbox row, stores its unique
interrupt ID and delivered message ID, authorizes creator/owner plus route, and
resumes the same Job. The exact command grammar is
`/task resume <job-id> <non-empty input up to 4096 characters>`. IM supports a
same-conversation quoted reply admitted by normal mention policy; document comments
require the command. Atomic first-input-wins rejects duplicate/stale input and
restart preserves correlation.

- [ ] **Step 5: Run command/inbound tests and verify failure**

Run: `npx tsx scripts/continuation-command-smoke.ts`
Expected: FAIL because `/task resume` is unknown.

Run: `npx tsx scripts/inbound-turn-pipeline-smoke.ts`
Expected: FAIL because quoted interrupt routing is not resolved.

- [ ] **Step 6: Implement persisted recovery, interrupt delivery, and same-Job resume**

Migrate v8 to v9. Preserve `waiting_retry`, `recovering`, and `cancel_requested`;
add non-runnable `waiting_user` with cancellation/expiry/list semantics.
Add bounded counters, interrupt rows, interrupt outbox markers, persistent
delivery-message lookup, authenticated first-input events, and atomic resume to
`recovering`. Existing `/task retry` continues to clone terminal jobs. Preserve
unknown external outcomes without replay.

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
