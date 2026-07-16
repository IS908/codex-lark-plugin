# Persistent Continuation Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, restart-safe continuation Job runtime that executes bounded background Codex steps and delivers one terminal result to the originating Lark IM or document-comment thread.

**Architecture:** Add pure continuation domain types under `src/domain`, port contracts under `src/ports`, and focused SQLite, worker, Codex runner, command, action, delivery, and bootstrap adapters under `src/continuation`. The continuation runtime owns its SQLite state and outbox and does not import cronjob persistence or scheduler code.

**Tech Stack:** TypeScript ESM, Node.js `>=24.15.0`, built-in `node:sqlite`, Zod, existing Codex CLI runner, existing Lark SDK/OpenAPI transport, repository smoke-test scripts.

## Global Constraints

- Target release is `v2.0.0` with Node.js `>=24.15.0`.
- Use `node:sqlite` only; do not add a filesystem fallback or third-party SQLite package.
- Do not reuse cronjob records, `JobScheduler`, or cronjob service operations.
- Do not add continuation MCP tools; expose foreground creation through the existing parent-owned exec action channel and user management through `/task` commands.
- Derive caller and delivery routing from authenticated `LarkMessage` data; reject model-authored identity or route fields.
- Background Codex runs force `--ignore-user-config`, no profile, approval policy `never`, no network, and a sandbox no broader than `workspace-write`.
- Background runs emit no progress messages and cannot access the foreground action registry.
- Persist terminal state and terminal outbox in one SQLite transaction.
- Treat Codex sessions as replaceable caches; durable objective, context snapshot, and checkpoint are authoritative.
- Plugin-generated user-facing errors are English.
- Keep `src/` and `plugins/lark/src/` byte-identical before each full test run.
- Add no architecture baseline exception.

---

### Task 1: Runtime Floor, Configuration, and Pure Domain Contracts

**Files:**
- Create: `src/runtime-version.ts`
- Create: `src/domain/continuation.ts`
- Create: `src/ports/continuation.ts`
- Create: `scripts/runtime-version-smoke.ts`
- Create: `scripts/continuation-domain-smoke.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `scripts/build-runtime-bundles.js`
- Modify: `scripts/start.sh`
- Modify: `scripts/config-validation-smoke.ts`
- Modify: `scripts/test.sh`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `plugins/lark/package.json`
- Modify: `plugins/lark/package-lock.json`

**Interfaces:**
- Produces: `assertSupportedNodeVersion(version?: string): void`.
- Produces: `ContinuationJob`, `ContinuationStatus`, `ContinuationCheckpoint`, `ContinuationStepOutcome`, `ContinuationDeliveryStatus`, `ContinuationCreateRequest`, `isContinuationTerminal(status)`, and `retryDelayMs(failureCount, jitterUnit)`.
- Produces: `ContinuationRepository`, `ContinuationExecutor`, `ContinuationTerminalDelivery`, `ContinuationClock`, and `ContinuationAudit` ports.
- Produces configuration fields `continuationEnabled`, `continuationMaxConcurrency`, `continuationMaxSteps`, `continuationMaxRetries`, `continuationMaxAgeHours`, `continuationRetentionDays`, `continuationDbPath`, and `continuationArtifactsDir`.

- [ ] **Step 1: Add failing runtime-version and domain tests**

```ts
// scripts/runtime-version-smoke.ts
import assert from 'node:assert/strict';
import { assertSupportedNodeVersion } from '../src/runtime-version.js';

assert.doesNotThrow(() => assertSupportedNodeVersion('24.15.0'));
assert.doesNotThrow(() => assertSupportedNodeVersion('26.5.0'));
assert.throws(() => assertSupportedNodeVersion('24.14.1'), /Node\.js >=24\.15\.0 is required/);
assert.throws(() => assertSupportedNodeVersion('22.20.0'), /Node\.js >=24\.15\.0 is required/);
console.log('runtime-version smoke: PASS');
```

```ts
// scripts/continuation-domain-smoke.ts
import assert from 'node:assert/strict';
import { isContinuationTerminal, retryDelayMs } from '../src/domain/continuation.js';

assert.equal(isContinuationTerminal('completed'), true);
assert.equal(isContinuationTerminal('failed'), true);
assert.equal(isContinuationTerminal('cancelled'), true);
assert.equal(isContinuationTerminal('running'), false);
assert.equal(retryDelayMs(1, 0), 30_000);
assert.equal(retryDelayMs(2, 0), 120_000);
assert.equal(retryDelayMs(3, 0), 600_000);
assert.ok(retryDelayMs(3, 1) > 600_000);
console.log('continuation domain smoke: PASS');
```

- [ ] **Step 2: Run the tests and verify missing modules fail**

Run: `node --import tsx scripts/runtime-version-smoke.ts`

Expected: FAIL with `Cannot find module '../src/runtime-version.js'`.

Run: `node --import tsx scripts/continuation-domain-smoke.ts`

Expected: FAIL with `Cannot find module '../src/domain/continuation.js'`.

- [ ] **Step 3: Implement the runtime check and pure contracts**

```ts
// src/runtime-version.ts
const REQUIRED_NODE = [24, 15, 0] as const;

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const parsed = version.split('.').map((part) => Number.parseInt(part, 10));
  const supported = REQUIRED_NODE.every((required, index) => {
    const actual = parsed[index] ?? 0;
    return actual === required || actual > required || parsed.slice(0, index).some((value, i) => value > REQUIRED_NODE[i]);
  });
  if (!supported) {
    throw new Error(`Node.js >=24.15.0 is required; current version is ${version}.`);
  }
}
```

Define the closed domain unions exactly as:

```ts
export type ContinuationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ContinuationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'delivery_unknown'
  | 'failed';

export type ContinuationStepOutcome =
  | { outcome: 'continue'; checkpoint: ContinuationCheckpoint; nextStep: string; resumeAfterSeconds?: number }
  | { outcome: 'completed'; finalMessage: string; resultSummary?: string; artifacts: string[] }
  | { outcome: 'failed'; errorCode: string; errorSummary: string; retryable: boolean; completedWork: string[]; unperformedWork: string[] }
  | { outcome: 'blocked'; errorCode: string; errorSummary: string; requiredCapability: string; completedWork: string[]; unperformedWork: string[] };
```

Define and enforce these storage limits in the same module:

```ts
export const CONTINUATION_LIMITS = {
  titleChars: 200,
  objectiveBytes: 16 * 1024,
  acceptanceCriteriaCount: 32,
  contextSnapshotBytes: 64 * 1024,
  checkpointBytes: 64 * 1024,
  finalMessageBytes: 256 * 1024,
  artifactCount: 20,
  managedArtifactBytesPerJob: 100 * 1024 * 1024,
} as const;
```

Define the port methods used by later tasks, including:

```ts
export interface ContinuationRepository {
  initialize(): Promise<void>;
  healthCheck(): Promise<void>;
  create(request: ContinuationCreateRequest): Promise<{ job: ContinuationJob; created: boolean }>;
  get(jobId: string): Promise<ContinuationJob | null>;
  listByCreator(creatorOpenId: string, limit: number): Promise<ContinuationJob[]>;
  listAll(limit: number): Promise<ContinuationJob[]>;
  claimDue(workerId: string, now: string, leaseExpiresAt: string): Promise<ContinuationClaim | null>;
  heartbeat(jobId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  completeStep(claim: ContinuationClaim, outcome: ContinuationStepOutcome, now: string): Promise<void>;
  failAttempt(claim: ContinuationClaim, failure: ContinuationFailure, now: string): Promise<void>;
  requestCancel(jobId: string, now: string): Promise<'cancelled' | 'cancel_requested' | 'terminal' | 'missing'>;
  recoverExpiredLeases(now: string): Promise<number>;
  cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob>;
  redactTerminal(jobId: string, now: string): Promise<boolean>;
  claimPendingDelivery(workerId: string, now: string): Promise<ContinuationDeliveryClaim | null>;
  markDeliveryResult(claim: ContinuationDeliveryClaim, result: ContinuationDeliveryResult, now: string): Promise<void>;
  purgeExpired(retainAfter: string, now: string): Promise<number>;
  close(): void;
}
```

- [ ] **Step 4: Add and validate continuation configuration**

Add these defaults and reject fractional values or values outside the specified ranges:

```ts
continuationEnabled: optionalBoolean('LARK_CONTINUATION_ENABLED', true),
continuationMaxConcurrency: optionalIntegerRange('LARK_CONTINUATION_MAX_CONCURRENCY', 1, 1, 4),
continuationMaxSteps: optionalIntegerRange('LARK_CONTINUATION_MAX_STEPS', 24, 1, 100),
continuationMaxRetries: optionalIntegerRange('LARK_CONTINUATION_MAX_RETRIES', 3, 0, 10),
continuationMaxAgeHours: optionalIntegerRange('LARK_CONTINUATION_MAX_AGE_HOURS', 24, 1, 168),
continuationRetentionDays: optionalIntegerRange('LARK_CONTINUATION_RETENTION_DAYS', 30, 1, 3650),
continuationDbPath: path.join(runtimeDir, 'continuations', 'jobs.sqlite'),
continuationArtifactsDir: path.join(runtimeDir, 'continuations', 'artifacts'),
```

Extend `scripts/config-validation-smoke.ts` to assert defaults and failures for concurrency `0`, concurrency `5`, retries `-1`, and fractional max steps.

- [ ] **Step 5: Raise the Node floor everywhere**

Set both package manifests and locks to `"node": ">=24.15.0"`, update `@types/node` to `^24.0.0`, change the esbuild target to `node24`, call `assertSupportedNodeVersion()` at the beginning of `main()`, and add a shell check in `scripts/start.sh` before `npm start`.

- [ ] **Step 6: Run focused checks**

Run: `node --import tsx scripts/runtime-version-smoke.ts`

Expected: `runtime-version smoke: PASS`.

Run: `node --import tsx scripts/continuation-domain-smoke.ts`

Expected: `continuation domain smoke: PASS`.

Run: `node --import tsx scripts/config-validation-smoke.ts`

Expected: `config validation smoke: PASS`.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json plugins/lark/package.json plugins/lark/package-lock.json scripts/start.sh scripts/build-runtime-bundles.js scripts/test.sh scripts/runtime-version-smoke.ts scripts/continuation-domain-smoke.ts scripts/config-validation-smoke.ts src/runtime-version.ts src/domain/continuation.ts src/ports/continuation.ts src/config.ts src/index.ts
git commit -m "feat: establish continuation runtime contracts"
```

### Task 2: SQLite Repository and Artifact Retention

**Files:**
- Create: `src/continuation/sqlite-repository.ts`
- Create: `src/continuation/artifact-store.ts`
- Create: `scripts/continuation-repository-smoke.ts`
- Create: `scripts/continuation-claim-worker.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: all domain and repository types from Task 1.
- Produces: `SqliteContinuationRepository.open(options): Promise<SqliteContinuationRepository>`.
- Produces: `ContinuationArtifactStore.ensure(jobId)`, `resolve(jobId, relativePath)`, `remove(jobId)`, and `purge(jobIds)`.

- [ ] **Step 1: Write repository tests before implementation**

The smoke test must first use two repository instances pointed at one temporary database and assert idempotent creation:

```ts
const first = await SqliteContinuationRepository.open({ databasePath, artifactsDir, defaults, clock });
const second = await SqliteContinuationRepository.open({ databasePath, artifactsDir, defaults, clock });
const created = await first.create(createRequest);
assert.equal(created.created, true);
assert.equal((await second.create(createRequest)).job.jobId, created.job.jobId);

```

Then launch two `worker_threads` instances from `scripts/continuation-claim-worker.ts`. Each worker opens its own SQLite connection, waits on one shared atomic barrier, and calls `claimDue` for the same Job. Collect both results and assert exactly one non-null claim. This is the lease race acceptance test; a same-event-loop `Promise.all` is not sufficient.

Also assert `0600` database mode, `0700` artifact directory mode, transactional terminal outbox creation, cancel/complete race behavior, expired lease recovery, clone retry with a new Job ID, body redaction, and retention cleanup.

- [ ] **Step 2: Run the repository smoke and verify failure**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`

Expected: FAIL with missing `src/continuation/sqlite-repository.js`.

- [ ] **Step 3: Implement schema creation and row mapping**

Use dynamic runtime loading so unsupported Node versions reach the explicit runtime check:

```ts
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
```

Create `continuation_jobs`, `continuation_attempts`, and `continuation_outbox` with CHECK constraints matching the closed unions. Use `PRAGMA user_version = 1`. Store all timestamps as ISO strings and all booleans as `0|1` integers.

`initialize()` must run `PRAGMA quick_check` after migration and reject any result other than `ok`.

- [ ] **Step 4: Implement atomic operations**

Use one `BEGIN IMMEDIATE` helper with rollback on exceptions. `claimDue` must select one due row and conditionally update `status`, `row_version`, and lease fields before creating the attempt. `completeStep` must use the claim's row version. Terminal outcomes must insert the unique outbox row in the same transaction.

Map `blocked` to persisted `failed`. Reset `failure_count` after a valid `continue`. `failAttempt` uses `retryDelayMs`, moves exhausted or expired Jobs to `failed`, and creates a terminal outbox for exhausted failures.

- [ ] **Step 5: Implement artifact boundaries and retention**

Reject absolute artifact references and any normalized path that leaves `<artifactsDir>/<jobId>`. Use `0700` directories and enforce `CONTINUATION_LIMITS.managedArtifactBytesPerJob`. `redactTerminal` removes the managed directory and clears objective, acceptance criteria, context, checkpoint, result payload, and outbox payload while retaining Job ID, creator, status, timestamps, and delivery outcome.

- [ ] **Step 6: Run focused checks**

Run: `node --import tsx scripts/continuation-repository-smoke.ts`

Expected: `continuation repository smoke: PASS`.

Run: `npm run check:architecture`

Expected: no new cycle or restricted import.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/continuation/sqlite-repository.ts src/continuation/artifact-store.ts scripts/continuation-repository-smoke.ts scripts/continuation-claim-worker.ts scripts/test.sh
git commit -m "feat: persist continuation jobs in sqlite"
```

### Task 3: Structured Codex Runner and Abort Support

**Files:**
- Create: `src/continuation/codex-runner.ts`
- Create: `scripts/continuation-codex-runner-smoke.ts`
- Modify: `src/codex-exec.ts`
- Modify: `scripts/codex-adapter-smoke.js`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: `ContinuationExecutor`, `ContinuationStepOutcome`, and `ContinuationJob`.
- Produces: generic `CodexExecRequest.outputSchema`, `CodexExecRequest.abortSignal`, `CodexExecRequest.additionalWritableDirs`, and `CodexExecRequest.configOverrides`.
- Produces: `CodexExecAbortedError` and `createContinuationCodexExecutor(options)`.

- [ ] **Step 1: Add failing argument, schema, and abort tests**

Extend runner tests to assert exact arguments:

```ts
const args = buildCodexExecArgs(request, '/tmp/output.txt', '/tmp/outcome-schema.json');
assert.ok(args.includes('--output-schema'));
assert.ok(args.includes('/tmp/outcome-schema.json'));
assert.deepEqual(args.filter((value) => value === '--add-dir').length, 1);
assert.ok(args.includes('approval_policy="never"'));
assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
```

The continuation runner smoke must fake `runCodexExec`, return each valid JSON outcome, reject unknown fields, reject missing conditional fields, pass `traceLogId=jobId`, pass `traceRunId=attemptId`, resume the execution session, force `profile=null`, and force `ignoreUserConfig=true`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`

Expected: FAIL with missing continuation runner module.

- [ ] **Step 3: Extend the generic Codex process adapter**

Write the JSON schema to the existing per-run temporary directory with mode `0600`. Add these arguments before `resume` or the prompt marker:

```ts
if (schemaFile) args.push('--output-schema', schemaFile);
for (const override of request.configOverrides ?? []) args.push('--config', override);
for (const dir of request.additionalWritableDirs ?? []) args.push('--add-dir', dir);
```

Attach one abort listener to the child. On abort, send `SIGTERM`, schedule `SIGKILL` after 10 seconds, remove the listener on process close, and reject with `CodexExecAbortedError`. Timeout behavior remains distinct.

- [ ] **Step 4: Implement continuation outcome validation**

Use a strict Zod discriminated union. Parse `result.text` as JSON, enforce field limits, canonicalize artifact references through the artifact port, and return camelCase domain outcomes. Use these fixed runner controls:

```ts
{
  sandbox: configuredSandbox === 'read-only' ? 'read-only' : 'workspace-write',
  profile: null,
  ignoreUserConfig: true,
  configOverrides: [
    'approval_policy="never"',
    'sandbox_workspace_write.network_access=false',
  ],
  additionalWritableDirs: [artifactDir],
}
```

- [ ] **Step 5: Run focused checks**

Run: `node --import tsx scripts/codex-adapter-smoke.js`

Expected: `codex adapter smoke: PASS`.

Run: `node --import tsx scripts/continuation-codex-runner-smoke.ts`

Expected: `continuation codex runner smoke: PASS`.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/codex-exec.ts src/continuation/codex-runner.ts scripts/codex-adapter-smoke.js scripts/continuation-codex-runner-smoke.ts scripts/test.sh
git commit -m "feat: run structured continuation steps"
```

### Task 4: Worker, Lease Recovery, Cancellation, and Outbox Pump

**Files:**
- Create: `src/continuation/worker.ts`
- Create: `scripts/continuation-worker-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: repository, executor, delivery, clock, and audit ports.
- Produces: `ContinuationWorker.start()`, `ContinuationWorker.tick()`, `ContinuationWorker.stop()`, and `ContinuationWorker.activeCount`.

- [ ] **Step 1: Write deterministic worker tests with fake ports**

Use a fake clock and repository to assert:

```ts
await worker.tick();
assert.equal(executor.calls.length, 1);
assert.equal(repository.completeStepCalls.length, 1);

repository.cancelRequested = true;
await worker.tick();
assert.equal(executor.lastSignal?.aborted, true);
```

Cover max concurrency, heartbeat renewal, `continue` scheduling, retryable error, exhausted retry, blocked outcome, expired lease recovery, resume fallback delegated to the executor, terminal outbox delivery, graceful stop, and no claims after stop begins.

- [ ] **Step 2: Run the worker smoke and verify failure**

Run: `node --import tsx scripts/continuation-worker-smoke.ts`

Expected: FAIL with missing worker module.

- [ ] **Step 3: Implement the claim and execution loop**

`tick()` first calls `recoverExpiredLeases(now)`, then fills available execution slots. Each active claim owns an `AbortController` and heartbeat timer. The timer renews the lease and checks the current Job status; `cancel_requested` aborts the child.

Do not await active Jobs from the scan timer. Track their promises, remove them in `finally`, and trigger another bounded tick after completion.

- [ ] **Step 4: Implement the independent outbox pump**

Claim one pending delivery at a time, call `ContinuationTerminalDelivery.deliver`, and persist the result. A delivery failure must not rerun the Codex step. Stop processing a `delivery_unknown` row until a foreground user creates a new request.

- [ ] **Step 5: Run focused checks**

Run: `node --import tsx scripts/continuation-worker-smoke.ts`

Expected: `continuation worker smoke: PASS`.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/continuation/worker.ts scripts/continuation-worker-smoke.ts scripts/test.sh
git commit -m "feat: execute continuation jobs with leases"
```

### Task 5: Foreground Creation Action and Lifecycle Guard

**Files:**
- Create: `src/continuation/service.ts`
- Create: `scripts/continuation-action-smoke.ts`
- Modify: `src/codex-exec-action-schemas.ts`
- Modify: `src/codex-exec-action-channel.ts`
- Modify: `src/codex-exec-actions.ts`
- Modify: `src/codex-exec-delivery.ts`
- Modify: `scripts/codex-exec-actions-smoke.ts`
- Modify: `scripts/codex-exec-action-channel-smoke.ts`
- Modify: `scripts/codex-exec-delivery-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: `ContinuationRepository` and configuration defaults.
- Produces: `ContinuationService.createFromMessage(action, message, parentSessionId?)`.
- Produces: `CreateContinuationActionSchema` and action result metadata `continuation?: { jobId: string; title: string }`.

- [ ] **Step 1: Add failing action and lifecycle tests**

Assert the schema accepts only execution-brief fields, rejects `chat_id`, `open_id`, `job_id`, and absolute/out-of-root working directories, and rejects two creation actions in one envelope.

Assert the dispatcher derives creator and route from a p2p/group/doc-comment `LarkMessage`, rejects reaction/cronjob sources, and returns the same Job ID for duplicate source-message delivery.

Change lifecycle tests to prove:

```ts
assert.equal(guardCodexExecLifecycleReply('I will continue later.', { continuationCreated: false }).blocked, true);
assert.equal(guardCodexExecLifecycleReply('I will continue later.', { continuationCreated: true }).blocked, false);
```

An unrelated successful action and `[LARK_DEFER]` must not establish continuation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx scripts/continuation-action-smoke.ts`

Expected: FAIL with missing continuation service or action schema.

- [ ] **Step 3: Implement service creation and route derivation**

Derive `creatorOpenId`, `sourceMessageId`, `sourceThreadId`, parent session provenance, selected model, retry defaults, and an opaque route from the message. Derive the idempotency key by hashing the source message ID plus action type. For doc comments persist file token, file type, and comment ID only from `message.docComment`.

- [ ] **Step 4: Register a foreground-only action capability**

Include `create_continuation_job` in the action prompt only for non-reaction `p2p`, `group`, and `doc_comment` messages. The parser remains strict; the dispatcher also enforces the source type so a forged action from cronjob execution fails.

- [ ] **Step 5: Make lifecycle permission depend on committed creation**

Replace `allowFollowupPromise` with `continuationCreated`. After action execution, inspect successful result metadata. On success, replace model-authored continuation prose with exactly:

```text
Background task created: <title>
Job ID: <job_id>
```

On creation failure, preserve useful current-turn output, append the English action failure, and let the guard replace unsupported promises.

- [ ] **Step 6: Run focused checks**

Run: `node --import tsx scripts/codex-exec-action-channel-smoke.ts`

Expected: PASS.

Run: `node --import tsx scripts/codex-exec-actions-smoke.ts`

Expected: PASS.

Run: `node --import tsx scripts/codex-exec-delivery-smoke.ts`

Expected: PASS.

Run: `node --import tsx scripts/continuation-action-smoke.ts`

Expected: `continuation action smoke: PASS`.

- [ ] **Step 7: Commit**

```bash
git add src/continuation/service.ts src/codex-exec-action-schemas.ts src/codex-exec-action-channel.ts src/codex-exec-actions.ts src/codex-exec-delivery.ts scripts/continuation-action-smoke.ts scripts/codex-exec-actions-smoke.ts scripts/codex-exec-action-channel-smoke.ts scripts/codex-exec-delivery-smoke.ts scripts/test.sh
git commit -m "feat: create durable continuation jobs from exec"
```

### Task 6: Parent-Owned `/task` Commands and Authorization

**Files:**
- Create: `src/continuation/command-handler.ts`
- Create: `scripts/continuation-command-smoke.ts`
- Modify: `src/codex-delivery-wiring.ts`
- Modify: `src/codex-model-command.ts`
- Modify: `scripts/codex-model-command-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: `ContinuationService`, trusted `LarkMessage`, owner Open ID, IM reply sender, and doc-comment reply port.
- Produces: `handleContinuationCommand(message): Promise<boolean>`.

- [ ] **Step 1: Write parsing, authorization, and direct-reply tests**

Cover exact forms:

```text
/task list
/task status <job_id>
/task cancel <job_id>
/task retry <job_id>
/task delete <job_id>
```

Assert leading bot mentions are stripped, malformed commands return English usage, commands bypass the Codex runner, creator can operate on owned Jobs, owner can operate on every Job, another group user receives a denial without task details, running delete is denied, retry clones a new Job ID, and `delivery_unknown` retry is denied.

Cover both IM and `doc_comment` command replies.

- [ ] **Step 2: Run the command smoke and verify failure**

Run: `node --import tsx scripts/continuation-command-smoke.ts`

Expected: FAIL with missing command handler module.

- [ ] **Step 3: Implement parsing and service authorization**

Parse only exact `/task` commands after mention stripping. Fetch the Job before mutations. Authorize when `caller === job.creatorOpenId` or `caller === ownerOpenId`. Format list/status with state, Job ID, title, attempts, next run, completion, and delivery state; omit objective and checkpoint from list output.

- [ ] **Step 4: Compose control handlers**

In `registerCodexDeliveryHandlers`, invoke continuation commands before `handleCodexModelCommand`. Keep normal channel admission in `channel.ts`; do not create a second whitelist path. Add `/task` to `/help` from the same command definition used by the parser.

- [ ] **Step 5: Run focused checks**

Run: `node --import tsx scripts/continuation-command-smoke.ts`

Expected: `continuation command smoke: PASS`.

Run: `node --import tsx scripts/codex-model-command-smoke.ts`

Expected: PASS with `/task` shown in user commands.

- [ ] **Step 6: Commit**

```bash
git add src/continuation/command-handler.ts src/codex-delivery-wiring.ts src/codex-model-command.ts scripts/continuation-command-smoke.ts scripts/codex-model-command-smoke.ts scripts/test.sh
git commit -m "feat: add authorized continuation task commands"
```

### Task 7: Lark IM and Document-Comment Terminal Delivery

**Files:**
- Create: `src/continuation/lark-delivery.ts`
- Create: `scripts/continuation-delivery-smoke.ts`
- Modify: `src/lark-transport-contracts.ts`
- Modify: `src/lark-transport-doc-comment-api.ts`
- Modify: `src/lark-transport.ts`
- Modify: `scripts/lark-transport-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: `ContinuationDeliveryClaim` and `LarkTransport`.
- Produces: `createLarkContinuationDelivery(getTransport, clock)`.
- Produces: `LarkTransport.findDocCommentReplyByMarker(request): Promise<{ replyId?: string } | null>`.

- [ ] **Step 1: Write delivery tests before implementation**

Assert IM delivery forces raw transport by supplying a stable UUID, replies to the original source message/thread, records the returned message ID, and retries the same UUID inside one hour.

Assert an ambiguous IM claim older than one hour returns `delivery_unknown` without calling send.

Assert document-comment delivery uses the trusted route, and an ambiguous prior send first calls `findDocCommentReplyByMarker`. A found reply returns delivered; unavailable or failed reconciliation returns `delivery_unknown` and does not call reply again.

- [ ] **Step 2: Run delivery smoke and verify failure**

Run: `node --import tsx scripts/continuation-delivery-smoke.ts`

Expected: FAIL with missing Lark delivery module.

- [ ] **Step 3: Add bounded doc-comment read-back**

Implement the Drive comment reply list endpoint through `feishuApiCall` with `retryTimeout:false`. Limit pagination and response scanning, extract plain text with existing comment element helpers, and match the exact first-line Job marker `Task completed: <job_id>`, `Task failed: <job_id>`, or `Task cancelled: <job_id>`.

- [ ] **Step 4: Implement the delivery adapter**

Classify errors as confirmed pre-send failures versus ambiguous timeout/process/network outcomes. Only the former may return retryable `failed`; the latter follows UUID-window or read-back rules. Never expose provider response bodies or credentials in user output or logs.

- [ ] **Step 5: Run focused checks**

Run: `node --import tsx scripts/continuation-delivery-smoke.ts`

Expected: `continuation delivery smoke: PASS`.

Run: `node --import tsx scripts/lark-transport-smoke.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/continuation/lark-delivery.ts src/lark-transport-contracts.ts src/lark-transport-doc-comment-api.ts src/lark-transport.ts scripts/continuation-delivery-smoke.ts scripts/lark-transport-smoke.ts scripts/test.sh
git commit -m "feat: deliver continuation terminal outcomes"
```

### Task 8: Runtime Composition, Recovery, Retention, and Diagnostics

**Files:**
- Create: `src/continuation/runtime.ts`
- Create: `scripts/continuation-runtime-smoke.ts`
- Create: `scripts/continuation-restart-process-smoke.ts`
- Modify: `src/index.ts`
- Modify: `src/channel-services.ts`
- Modify: `src/codex-delivery-wiring.ts`
- Modify: `src/diagnostic-log-format.ts`
- Modify: `scripts/architecture-check.js`
- Modify: `scripts/test.sh`

**Interfaces:**
- Consumes: configuration, Lark transport provider, action dispatcher wiring, command wiring, repository, executor, and worker.
- Produces: `createContinuationRuntime(options)` returning `{ service, worker, health, close }`.

- [ ] **Step 1: Add startup, degraded-mode, restart, and logging tests**

The runtime smoke must assert:

```ts
const runtime = await createContinuationRuntime(options);
assert.equal(runtime.health.available, true);
await runtime.worker.tick();
await runtime.close();
```

Use a temporary SQLite file to create a Job, persist a `continue` checkpoint, close the first runtime, open a second runtime, and assert completion and one terminal delivery.

Inject repository initialization failure and assert ordinary channel wiring can continue while create and `/task` operations return `Continuation runtime is unavailable.`

Capture debug/audit/trace fields and assert Job ID and attempt ID are present while objective, checkpoint, result body, and a sample Bearer token are absent.

- [ ] **Step 2: Run runtime smoke and verify failure**

Run: `node --import tsx scripts/continuation-runtime-smoke.ts`

Expected: FAIL with missing runtime module.

- [ ] **Step 3: Implement composition and lifecycle**

In dry-run mode, initialize and close a temporary SQLite repository. In normal mode, create the configured repository, recover leases, purge retention candidates, start a 24-hour unref'ed retention timer, and start the worker only after Lark transport is connected. Register worker, timer, and repository cleanup with the existing process lifecycle.

Repository failure produces an unavailable service object rather than throwing from the whole channel startup. Node version failure remains fatal.

- [ ] **Step 4: Strengthen architecture checks**

Add rules that reject imports from `src/domain/continuation.ts` or `src/ports/continuation.ts` to config, channel, Lark transport, Codex exec, scheduler, or continuation infrastructure. Reject imports from `src/continuation/**` to `job-store`, `job-service`, or `scheduler`.

- [ ] **Step 5: Run focused and architectural checks**

Run: `node --import tsx scripts/continuation-runtime-smoke.ts`

Expected: `continuation runtime smoke: PASS`.

Run: `node --import tsx scripts/continuation-restart-process-smoke.ts`

Expected: a child process is terminated after committing a checkpoint, a second child opens the same SQLite database, completes the Job, and prints `continuation restart process smoke: PASS` after exactly one terminal-delivery record is observed.

Run: `npm run check:architecture`

Expected: zero baseline exceptions.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/continuation/runtime.ts src/index.ts src/channel-services.ts src/codex-delivery-wiring.ts src/diagnostic-log-format.ts scripts/architecture-check.js scripts/continuation-runtime-smoke.ts scripts/continuation-restart-process-smoke.ts scripts/test.sh
git commit -m "feat: wire restart-safe continuation runtime"
```

### Task 9: Documentation, Package Sync, Full Review, PR, and v2.0.0 Release

**Files:**
- Modify: `.env.example`
- Modify: `plugins/lark/.env.example`
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/architecture.md`
- Modify: `docs/lark-action-surfaces.md`
- Modify: `docs/transition-compatibility.md`
- Modify: `skills/configure/SKILL.md`
- Modify: `plugins/lark/skills/configure/SKILL.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `plugins/lark/.codex-plugin/plugin.json`
- Modify: all changed counterparts under `plugins/lark/src/`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `plugins/lark/package.json`
- Modify: `plugins/lark/package-lock.json`

**Interfaces:**
- Consumes: every completed runtime surface.
- Produces: released package version `2.0.0` and migration documentation.

- [ ] **Step 1: Document the exact runtime surface**

Add Node 24.15 migration instructions, all six continuation environment variables, storage paths, `/task` commands, creator/owner authorization, session replacement behavior, disabled background capabilities, retention, IM one-hour UUID semantics, doc-comment read-back, and `delivery_unknown` behavior in English and Chinese docs.

Update architecture docs to show the continuation bounded context and state that cronjob imports are forbidden. Update action-surface docs with `create_continuation_job` as a foreground exec action and explicitly state there is no continuation MCP tool.

- [ ] **Step 2: Synchronize package sources and examples**

Mechanically copy every changed `src/**` path to `plugins/lark/src/**`, keep both `.env.example` files identical, and keep both configure skills identical.

Run: `npm run check:plugin-src-sync`

Expected: `plugin source sync check ok`.

Run: `node --import tsx scripts/config-surface-sync-smoke.ts`

Expected: PASS.

- [ ] **Step 3: Run the complete local verification suite**

Run: `npm test`

Expected: every smoke test, typecheck, build, architecture check, dry-run, and runtime-package check passes.

Run: `npm audit --omit=dev --audit-level=high`

Expected: zero high or critical production vulnerabilities.

Run: `npx -y -p node@24.15.0 node --version`

Expected: `v24.15.0`.

Run: `LARK_APP_ID=runtime_node24_test LARK_APP_SECRET=runtime_node24_secret npx -y -p node@24.15.0 node plugins/lark/runtime/index.js --dry-run`

Expected: exit 0, empty stdout, and the dry-run success message on stderr.

- [ ] **Step 4: Perform a fresh self-review**

Review `git diff origin/main...HEAD` for state-transition gaps, leaked route/identity fields, unbounded stored values, retry/lease races, unsupported background capabilities, duplicate delivery, startup coupling, stale docs, generated bundle drift, and changes outside #272. Fix every finding and rerun focused tests plus `npm test`.

- [ ] **Step 5: Bump all release surfaces to 2.0.0**

Set root and plugin package versions, both lockfile root versions, and both plugin manifests to `2.0.0`. Update both README version badges and add `## [2.0.0]` to the changelog.

Run: `npm run check:release-version`

Expected: `release version check ok: 2.0.0`.

- [ ] **Step 6: Commit release-ready changes**

```bash
git add .env.example README.md README_CN.md CHANGELOG.md docs skills plugins .codex-plugin package.json package-lock.json src scripts
git commit -m "release: prepare v2.0.0"
```

- [ ] **Step 7: Push and open the PR**

```bash
git push
gh pr create --title "feat: add persistent continuation runtime" --body-file /tmp/continuation-pr-body.md
```

The PR body must close #272 and state the new layer ownership, transaction and partial-delivery behavior, Node requirement, absence of architecture baseline entries, tests, and direct-cutover migration.

- [ ] **Step 8: Review CI and merge**

Run: `gh pr checks <pr-number> --watch`

Expected: all required checks pass.

Perform a final PR diff review. Fix any finding in a new commit, push, and repeat checks. Merge only when no unresolved finding remains.

- [ ] **Step 9: Tag and publish v2.0.0**

After the PR is merged, update local `main`, verify the merge commit with `npm test`, create annotated tag `v2.0.0`, push the tag, and create the GitHub release from the changelog. Verify the release and plugin marketplace/runtime package expose version `2.0.0` and Node `>=24.15.0`.
