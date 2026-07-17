# Continuation Permission Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a server-derived continuation permission envelope, authorize an independent working root without copying foreground authority, reserve fail-closed interactive approval, and make policy failures diagnosable.

**Architecture:** The Job stores a snapshot envelope containing filesystem root/mode, declared host tools, network mode, and approval mode. A focused working-directory policy module intersects that snapshot with current operator configuration before every run. The worker supports only `approval.mode=never`; `interactive` is a persisted protocol value that returns blocked until a future approval coordinator is implemented. Trace lookup delegates authorization to `ContinuationTaskService`.

**Tech Stack:** TypeScript, Node.js `fs/promises` and `path`, Zod action schemas, SQLite schema v3, `node --import tsx` smoke tests.

## Global Constraints

- Never inherit foreground approval, network, MCP, connector, profile, user-config, environment-secret, or `danger-full-access` state.
- Continuation Codex runs keep `approval_policy="never"` and `sandbox_workspace_write.network_access=false`.
- Permission evaluation is `snapshot envelope ∩ current operator policy`; current expansion never expands an existing Job.
- `working_directory` remains relative and cannot contain `..`.
- Creation and execution both enforce lexical containment, realpath containment, existence, directory type, and symlink safety.
- Default current root remains `LARK_CODEX_EXEC_CWD`.
- `approval.mode=interactive` is representable but cannot execute in this release.
- Root source files and `plugins/lark/src` mirrors remain byte-identical.

---

### Task 1: Persisted Permission Envelope and Conservative Migration

**Files:**
- Modify: `src/domain/continuation.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify mirrored files under `plugins/lark/src/`
- Modify: `scripts/continuation-domain-smoke.ts`
- Modify: `scripts/continuation-repository-smoke.ts`

**Interfaces:**
- Produces: `ContinuationPermissionEnvelope` with `filesystem.root`, `filesystem.mode`, `hostTools`, `network`, and `approval.mode`.
- Produces: `ContinuationApprovalMode = 'never' | 'interactive'`.
- Extends: `ContinuationCreateRequest.permissions` and therefore `ContinuationJob.permissions`.

- [x] **Step 1: Write failing domain and repository tests**

Assert a new Job round-trips its envelope. Open a schema-v2 fixture and assert migration to v3 derives a conservative envelope: root equals the persisted working directory, mode is `workspace-write`, tools come from `required_tools_json`, network is `none`, and approval is `never`. Assert terminal redaction clears the sensitive root/tool snapshot.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx scripts/continuation-domain-smoke.ts && node --import tsx scripts/continuation-repository-smoke.ts`

Expected: missing `permissions` types/columns or schema version mismatch.

- [x] **Step 3: Implement schema v3 and validation**

Add `permissions_json TEXT NOT NULL` for fresh databases. For v2, add the column with a temporary safe default and update every row inside the migration transaction using its existing canonical working directory and required tools. Validate known enum values, bounded host-tool arrays, and canonical absolute snapshot roots at create/read boundaries.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 command again and require both smoke tests to pass.

---

### Task 2: Canonical Working-Directory Policy

**Files:**
- Create: `src/continuation/working-directory.ts`
- Create: `plugins/lark/src/continuation/working-directory.ts`
- Create: `scripts/continuation-working-directory-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Produces: `resolveContinuationWorkingDirectory(root: string, relative: string): Promise<{ root: string; workingDirectory: string }>`.
- Produces: `validateContinuationWorkingDirectory(roots: string[], candidate: string): Promise<string>` for snapshot/current intersection.
- Produces: `ContinuationWorkingDirectoryError` with stable policy-safe English text.

- [x] **Step 1: Write the failing policy smoke test**

Cover `.`, a normal child, absolute paths, `..`, missing paths, files, symlink escapes, and a candidate allowed by one root but denied by the second root.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx scripts/continuation-working-directory-smoke.ts`

Expected: module-not-found for `continuation/working-directory.js`.

- [x] **Step 3: Implement the policy module**

Apply lexical containment before filesystem access and realpath containment after it. Canonicalize every supplied root and require the candidate to remain under all roots. Return stable errors without exposing arbitrary filesystem exception details.

- [x] **Step 4: Mirror the source and verify GREEN**

Run the Task 2 command and require `continuation working-directory smoke: PASS`.

---

### Task 3: Configuration, Creation, and Runtime Permission Intersection

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/runtime.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify mirrored files under `plugins/lark/src/`
- Modify: `src/codex-exec-delivery.ts`
- Modify: `src/codex-exec-action-channel.ts`
- Modify: `scripts/config-validation-smoke.ts`
- Modify: `scripts/continuation-action-smoke.ts`
- Modify: `scripts/continuation-codex-runner-smoke.ts`
- Modify: `scripts/continuation-runtime-smoke.ts`
- Modify: `scripts/codex-exec-action-channel-smoke.ts`

**Interfaces:**
- Produces: `appConfig.continuationWorkingRoot` from `LARK_CONTINUATION_WORKING_ROOT`, defaulting to `codexExecCwd`.
- Produces: Service-created permission envelope with canonical snapshot root, bounded filesystem mode, declared tools, `network='none'`, and `approval.mode='never'`.
- Produces: prompt metadata `continuationWorkingRoot`.

- [x] **Step 1: Add failing configuration, prompt, Service, and Runner assertions**

Assert default/custom root behavior, relative child resolution, the prompt root line, snapshot envelope creation, runtime validation against snapshot and current roots, mode intersection (`read-only` wins), and no Codex call after policy denial.

- [x] **Step 2: Add reserved approval assertions**

Construct a Job with `approval.mode='interactive'`; assert Runner returns blocked with `errorCode='continuation_approval_unavailable'` and `requiredCapability='approval.interactive'` before Codex or host tools run.

- [x] **Step 3: Run focused tests and verify RED**

Run: `node --import tsx scripts/config-validation-smoke.ts && node --import tsx scripts/codex-exec-action-channel-smoke.ts && node --import tsx scripts/continuation-action-smoke.ts && node --import tsx scripts/continuation-codex-runner-smoke.ts && node --import tsx scripts/continuation-runtime-smoke.ts`

Expected: failures for missing config, envelope derivation, policy intersection, or approval handling.

- [x] **Step 4: Implement minimal wiring and fail-closed behavior**

Pass current root/mode independently of foreground cwd. Service derives the envelope server-side. Runner first rejects unsupported network/approval values, validates the working directory under snapshot and current roots, chooses the stricter filesystem mode, and only then creates artifacts or invokes Codex.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the Task 3 command again and require all focused smoke tests to pass.

---

### Task 4: Authorized Continuation Trace Lookup

**Files:**
- Modify: `src/codex-exec-action-schemas.ts`
- Modify: `src/codex-exec-actions.ts`
- Modify mirrored files under `plugins/lark/src/`
- Modify: `src/codex-exec-action-channel.ts`
- Modify: `scripts/codex-exec-actions-smoke.ts`
- Modify: `scripts/codex-exec-action-channel-smoke.ts`

**Interfaces:**
- Extends: `GetRunTraceActionSchema.source` with `continuation`.
- Consumes: `ContinuationTaskService.getForActor(jobId, caller, ownerOpenId)` as the authorization boundary.

- [x] **Step 1: Add failing schema and authorization tests**

Cover creator success, owner success, unrelated-user denial, missing Job ID, missing runtime, and rejection of `target` for non-message sources.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx scripts/codex-exec-actions-smoke.ts && node --import tsx scripts/codex-exec-action-channel-smoke.ts`

Expected: `continuation` rejected or unresolved.

- [x] **Step 3: Resolve trace access through the task service**

Require a stable `job_` ID, authorize via `getForActor`, map inaccessible jobs to unauthorized, and pass the authorized ID to `queryRunTrace`. Do not access the repository directly from the action adapter.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the Task 4 command and require both smoke tests to pass.

---

### Task 5: Documentation, Release, and Verification

**Files:**
- Modify: `.env.example`
- Modify: `plugins/lark/.env.example`
- Modify: `skills/configure/SKILL.md`
- Modify: `plugins/lark/skills/configure/SKILL.md`
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `docs/architecture.md`
- Modify: `CHANGELOG.md`
- Modify package and plugin manifests.

**Interfaces:**
- Documents: explicit operator root authorization, persisted/current intersection, conservative migration, fail-closed reserved approval, and Job-ID trace authorization.
- Releases: `2.2.0` because the permission envelope and working-root support add operator-visible capability.

- [x] **Step 1: Update configuration and architecture documentation**

Include root `/Users/you/workspace` with `working_directory="aitask"`. Explain that `interactive` is reserved but disabled and list the future one-time approval requirements.

- [x] **Step 2: Bump all release metadata and rebuild**

Set version `2.2.0`; run `npm run build`.

- [x] **Step 3: Run full verification**

Run: `npm test` and `git diff --check`.

- [x] **Step 4: Self-review and repair findings**

Check migration safety, snapshot/current intersection, approval fail-closed behavior, trace authorization, source mirrors, docs, version links, and unrelated churn. Repeat focused/full tests after fixes.

- [ ] **Step 5: Publish through one reviewed PR**

Commit, push, open a PR with `Closes #276`, inspect checks/comments, merge only the reviewed head, publish `v2.2.0`, then verify the issue closure and tag commit.
