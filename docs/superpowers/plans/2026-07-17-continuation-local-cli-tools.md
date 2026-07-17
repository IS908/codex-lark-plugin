# Continuation Local CLI Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Allow a persistent continuation task to invoke an explicitly configured local CLI tool without granting the sandboxed Codex process arbitrary host or network access.

**Architecture:** The continuation output protocol gains one intermediate `tool_request` outcome. A parent-owned invoker checks the requested name against both `job.requiredTools` and `local-cli-tools.json`, records the invocation in SQLite before spawning the configured command, and returns the bounded redacted result to a resumed sandboxed Codex step. One call is allowed per step; completed calls replay their stored result and ambiguous in-flight calls block instead of executing twice.

**Tech Stack:** TypeScript, Zod, Node.js `child_process`, built-in `node:sqlite`, existing smoke-test scripts.

## Global Constraints

- Keep continuation Codex execution at `approval_policy="never"` and `sandbox_workspace_write.network_access=false`.
- `required_tools` declares task intent but never grants a command by itself.
- Preserve configured command, caller, subcommand, parameter, environment, timeout, output, redaction, and audit controls.
- Do not expose arbitrary binaries, shell execution, identity fields, or network access to the continuation process.
- Never automatically replay a host tool call whose result is ambiguous after interruption.

---

### Task 1: Make Local CLI Execution Reusable by Trusted Runtime Identity

**Files:**
- Modify: `src/local-cli-tools.ts`
- Modify: `scripts/local-cli-tools-smoke.ts`

**Interfaces:**
- Produces: `runConfiguredLocalCliToolAsCaller(options)` for trusted parent-owned callers.
- Preserves: `runConfiguredLocalCliTool(options)` as the foreground identity-session adapter.

- [x] **Step 1: Write failing smoke assertions**

Add a direct trusted-caller invocation and an aborted invocation to `scripts/local-cli-tools-smoke.ts`:

```ts
const direct = await runConfiguredLocalCliToolAsCaller({
  caller: 'ou_owner',
  tool: 'echo',
  args: ['doc'],
  configPath,
});
assert.equal(direct.ok, true);
```

- [x] **Step 2: Run the focused smoke test and verify the missing export failure**

Run: `node --import tsx scripts/local-cli-tools-smoke.ts`

- [x] **Step 3: Extract the trusted-caller adapter**

Implement this interface and pass `abortSignal` into the child process lifecycle:

```ts
export interface RunConfiguredLocalCliToolAsCallerOptions {
  caller: string;
  tool: string;
  args?: string[];
  configPath?: string;
  abortSignal?: AbortSignal;
  auditContext?: { job_id?: string; attempt_id?: string };
}
```

The foreground adapter resolves `caller` through `IdentitySession` and delegates without changing existing authorization behavior.

- [x] **Step 4: Re-run the focused smoke test**

Run: `node --import tsx scripts/local-cli-tools-smoke.ts`
Expected: `local CLI tools smoke: PASS`.

### Task 2: Add a Durable Tool Invocation Ledger

**Files:**
- Modify: `src/domain/continuation.ts`
- Modify: `src/ports/continuation.ts`
- Modify: `src/continuation/sqlite-repository.ts`
- Modify: `scripts/continuation-repository-smoke.ts`

**Interfaces:**
- Produces: `ContinuationToolRequest`, `ContinuationToolResult`, and repository methods `beginToolCall` and `completeToolCall`.
- Consumes: active `ContinuationClaim` ownership and row-version checks.

- [x] **Step 1: Write failing repository scenarios**

Cover a new call returning `execute`, a completed call returning `replay`, a changed request returning `conflict`, and an unfinished existing call returning `unknown`.

- [x] **Step 2: Run the repository smoke and verify the missing methods**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`

- [x] **Step 3: Add schema version 2 migration and repository methods**

Add `continuation_tool_calls` with a unique `(job_id, step_index)` key. Insert `running` before process execution, store bounded results as `completed`, and interpret an existing `running` record as `unknown` on recovery.

```ts
beginToolCall(
  claim: ContinuationClaim,
  request: ContinuationToolRequest,
  now: string,
): Promise<ContinuationToolCallDecision>;

completeToolCall(
  claim: ContinuationClaim,
  callId: string,
  result: ContinuationToolResult,
  now: string,
): Promise<void>;
```

- [x] **Step 4: Re-run repository and restart smoke tests**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`
Run: `node --import tsx scripts/continuation-restart-process-smoke.ts`

### Task 3: Execute One Authorized Tool Request per Continuation Step

**Files:**
- Create: `src/continuation/local-cli-tool-invoker.ts`
- Modify: `src/continuation/codex-runner.ts`
- Modify: `src/continuation/runtime.ts`
- Modify: `src/index.ts`
- Modify: `scripts/continuation-codex-runner-smoke.ts`
- Modify: `scripts/continuation-runtime-smoke.ts`

**Interfaces:**
- Produces: `ContinuationToolInvoker.invoke(claim, request, signal)`.
- Consumes: the repository ledger and `runConfiguredLocalCliToolAsCaller`.

- [x] **Step 1: Add failing runner tests**

Test a declared successful request followed by a resumed structured outcome, an undeclared request, a failed configured tool, an ambiguous ledger decision, and a second request in the same step.

- [x] **Step 2: Run the focused runner smoke and verify failure**

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`

- [x] **Step 3: Implement the strict intermediate protocol**

Extend the output schema with:

```json
{
  "outcome": "tool_request",
  "tool": "lark_cli",
  "args": ["doc", "get", "--token", "value"]
}
```

Validate the tool against `requiredTools`, invoke only through the parent-owned adapter, and resume Codex with the result wrapped as untrusted data. Convert unavailable, unauthorized, ambiguous, or repeated requests into a structured `blocked` outcome.

- [x] **Step 4: Wire the invoker into the default runtime**

Pass `appConfig.localCliToolsConfigPath` from `src/index.ts`; custom test executors remain injectable without the local CLI dependency.

- [x] **Step 5: Re-run runner and runtime smoke tests**

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`
Run: `node --import tsx scripts/continuation-runtime-smoke.ts`

### Task 4: Document, Verify, Review, and Deliver

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/architecture.md`
- Modify: `docs/lark-action-surfaces.md`

**Interfaces:**
- Documents: exact `required_tools` to `local-cli-tools.json` name matching and blocked/recovery behavior.

- [x] **Step 1: Update English and Chinese configuration documentation**

Document that users configure the actual command under `tools.<name>` and ask a foreground task to declare that same `<name>` in `required_tools`; existing jobs with an empty list do not gain access.

- [x] **Step 2: Run all required verification**

Run: `npm run typecheck`
Run: `npm run check:architecture`
Run: `npm test`
Run: `npm start -- --dry-run`

- [x] **Step 3: Self-review the full diff and fix every material finding**

Inspect authorization, identity derivation, schema migration, abort handling, output redaction/bounds, replay behavior, documentation, and unrelated churn. Repeat focused and full checks after fixes.

- [x] **Step 4: Commit, push, open a PR, inspect checks, merge, and release**

Use a feature-level semver increment because continuation gains a new execution capability. Link and close issue #274 through the merged PR and release notes.
