# Continuation Attempt Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound each continuation to five attempts by default and always produce a terminal completed, partial, blocked, or failed delivery.

**Architecture:** Persist an explicit attempt budget, expose convergence mode to the runner, and enforce the final boundary in both the runner and repository. Add `partial` and `blocked` as real terminal states during one SQLite migration.

**Tech Stack:** TypeScript, Zod, Node.js `node:sqlite`, existing smoke-test scripts.

## Global Constraints

- Direct migration only; no feature flag, dual schema, or legacy execution path.
- Default maximum attempts is 5 and hard configuration range is 1-20.
- Default total duration is 30 minutes and configuration range is 5-1440 minutes.
- The final attempt cannot persist `continue`.
- All user-visible errors and terminal labels remain English.

---

### Task 1: Configuration And Domain Contract

**Files:**
- Modify: `src/config.ts`
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Test: `scripts/config-validation-smoke.ts`
- Test: `scripts/continuation-domain-smoke.ts`

**Interfaces:**
- Produces: `ContinuationJob.maxAttempts: number`
- Produces: `ContinuationStepOutcome` variants `partial` and `blocked`
- Produces: `appConfig.continuationMaxAttempts` and `appConfig.continuationMaxTotalMinutes`

- [ ] **Step 1: Write failing config and domain assertions**

```ts
assert.equal(defaultPaths.continuationMaxAttempts, 5);
assert.equal(defaultPaths.continuationMaxTotalMinutes, 30);
assert.equal(isContinuationTerminal('partial'), true);
assert.equal(isContinuationTerminal('blocked'), true);
```

- [ ] **Step 2: Run red tests**

Run: `node --import tsx scripts/config-validation-smoke.ts && node --import tsx scripts/continuation-domain-smoke.ts`
Expected: FAIL because the new config and terminal states do not exist.

- [ ] **Step 3: Replace the old contract**

```ts
continuationMaxAttempts: optionalIntegerRange('LARK_CONTINUATION_MAX_ATTEMPTS', 5, 1, 20),
continuationMaxTotalMinutes: optionalIntegerRange('LARK_CONTINUATION_MAX_TOTAL_MINUTES', 30, 5, 1440),
```

Remove the `continuationMaxSteps` and `continuationMaxAgeHours` runtime fields.

- [ ] **Step 4: Run green tests**

Run: `node --import tsx scripts/config-validation-smoke.ts && node --import tsx scripts/continuation-domain-smoke.ts`
Expected: PASS.

### Task 2: SQLite Direct Migration And Terminal Persistence

**Files:**
- Modify: `src/continuation/sqlite-repository.ts`
- Test: `scripts/continuation-repository-smoke.ts`

**Interfaces:**
- Consumes: `ContinuationJob.maxAttempts`
- Produces: schema version 4 with `max_attempts` and terminal states `partial`/`blocked`
- Produces: repository enforcement that attempt ordinal never exceeds `maxAttempts`

- [ ] **Step 1: Add failing repository coverage**

Create a Job with `maxAttempts: 5`, commit four `continue` results, and assert the
fifth `continue` is stored as `partial` with one terminal outbox record. Open a
schema-v3 fixture and assert `max_steps=24` migrates to `max_attempts=5`.

- [ ] **Step 2: Run the repository test red**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`
Expected: FAIL on missing schema/status handling.

- [ ] **Step 3: Implement schema v4 and terminal writers**

Rebuild `continuation_jobs` and `continuation_attempts` in one transaction so the
CHECK constraints contain `partial` and `blocked`. Copy `min(max_steps, 5)` into
`max_attempts`. Render deterministic terminal payloads from structured outcomes.

- [ ] **Step 4: Run the repository test green**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`
Expected: PASS, including migration and idempotent terminal outbox assertions.

### Task 3: Runner Convergence Modes

**Files:**
- Modify: `src/continuation/codex-runner.ts`
- Test: `scripts/continuation-codex-runner-smoke.ts`

**Interfaces:**
- Consumes: `claim.attempt.ordinal` and `claim.job.maxAttempts`
- Produces: convergence-warning and forced-convergence prompt text
- Produces: final-attempt `continue` conversion to `partial`

- [ ] **Step 1: Add failing prompt and conversion tests**

Assert attempt 4/5 receives a convergence warning, attempt 5/5 says `continue`
is forbidden, and a final `continue` becomes `partial` with checkpoint-derived
completed, unperformed, risk, and next-step fields.

- [ ] **Step 2: Run the runner test red**

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`
Expected: FAIL because the output schema and convergence conversion are absent.

- [ ] **Step 3: Implement structured partial output and server guard**

Add `partial` to both local and wire Zod schemas. After parsing, call a pure
`enforceAttemptConvergence(job, attempt, outcome)` helper that converts a final
`continue` deterministically.

- [ ] **Step 4: Run the runner test green**

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`
Expected: PASS.

### Task 4: Composition, Commands, Documentation, And Review

**Files:**
- Modify: `src/continuation/service.ts`
- Modify: `src/continuation/runtime.ts`
- Modify: `src/continuation/command-handler.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `plugins/lark/.env.example`
- Modify: `README.md`
- Modify: `README_CN.md`
- Test: `scripts/continuation-action-smoke.ts`
- Test: `scripts/continuation-command-smoke.ts`
- Test: `scripts/continuation-runtime-smoke.ts`

**Interfaces:**
- Consumes: new config and repository contracts
- Produces: user-queryable attempts, terminal reason, timing, and delivery status

- [ ] **Step 1: Add failing integration assertions**

Assert new Jobs persist five attempts and a 30-minute expiry, `/task status`
renders `partial`/`blocked`, and cancellation remains authoritative during the
final attempt.

- [ ] **Step 2: Run focused tests red, then wire the new fields**

Run: `node --import tsx scripts/continuation-action-smoke.ts && node --import tsx scripts/continuation-command-smoke.ts && node --import tsx scripts/continuation-runtime-smoke.ts`
Expected before wiring: FAIL. Expected after wiring: PASS.

- [ ] **Step 3: Synchronize plugin source and verify**

Run: `rsync -a src/ plugins/lark/src/ && npm test && npm run build`
Expected: all tests and both runtime bundles pass.

- [ ] **Step 4: Review and commit**

Run: `git diff --check && git status --short`
Expected: only phase-1 files are changed and no whitespace errors exist.

