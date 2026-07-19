import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as SqliteDatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { seedHistoricalContinuationDatabase } from './fixtures/continuation-historical-schema.js';
import {
  CONTINUATION_LIMITS,
  type AsyncTaskFactSnapshot,
  type AsyncTaskContract,
  type ContinuationCreateRequest,
  type ContinuationCheckpointV2,
} from '../src/domain/continuation.js';
import type { DurableRunInterruptedAttempt } from '../src/domain/durable-run.js';
import { AsyncTaskKernelAdapter } from '../src/continuation/async-task-kernel-adapter.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import {
  ContinuationInputStore,
  continuationJobId,
} from '../src/continuation/input-store.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { installContinuationCompatibilitySchema } from '../src/durable-run/sqlite-migrations.js';
import { currentProcessStartedAt } from '../src/process-identity.js';

if (process.argv[2] === '--hold-managed-input-create') {
  const [childRoot, childJobId, childSource] = process.argv.slice(3);
  if (!childRoot || !childJobId || !childSource) throw new Error('Missing managed-input child arguments.');
  await holdManagedInputCreate(childRoot, childJobId, childSource);
  process.exit(0);
}
if (process.argv[2] === '--reclaim-dead-creation-lock') {
  const [childInputsRoot, childJobId] = process.argv.slice(3);
  if (!childInputsRoot || !childJobId) throw new Error('Missing dead-lock child arguments.');
  const store = new ContinuationInputStore(childInputsRoot);
  await store.withCreationLock(childJobId, async () => {});
  process.stdout.write('DEAD_LOCK_RECLAIMED\n');
  process.exit(0);
}
if (process.argv[2] === '--hold-creation-lock') {
  const [childInputsRoot, childJobId] = process.argv.slice(3);
  if (!childInputsRoot || !childJobId) throw new Error('Missing creation-lock child arguments.');
  const store = new ContinuationInputStore(childInputsRoot);
  await store.withCreationLock(childJobId, async () => {
    process.stdout.write('CREATION_LOCK_HELD\n');
    await new Promise(() => {});
  });
  process.exit(0);
}
if (process.argv[2] === '--reject-blocking-input') {
  const [childInputsRoot, childJobId, childSource] = process.argv.slice(3);
  if (!childInputsRoot || !childJobId || !childSource) throw new Error('Missing FIFO child arguments.');
  const store = new ContinuationInputStore(childInputsRoot);
  try {
    await store.install(childJobId, [{
      sourcePath: childSource,
      fileName: 'blocking.pipe',
      kind: 'message_attachment',
    }]);
    throw new Error('FIFO input was unexpectedly admitted.');
  } catch (error) {
    if (error instanceof Error && error.message === 'FIFO input was unexpectedly admitted.') throw error;
    process.stdout.write('BLOCKING_INPUT_REJECTED\n');
  }
  process.exit(0);
}
if (process.argv[2] === '--open-continuation-repository') {
  const [databasePath, artifactsDir, inputsDir] = process.argv.slice(3);
  if (!databasePath || !artifactsDir || !inputsDir) {
    throw new Error('Missing repository-open child arguments.');
  }
  const repository = await SqliteContinuationRepository.open({
    databasePath,
    artifactsDir,
    inputsDir,
  });
  await repository.healthCheck();
  repository.close();
  process.stdout.write('REPOSITORY_OPENED\n');
  process.exit(0);
}

async function holdManagedInputCreate(rootDir: string, jobId: string, sourcePath: string): Promise<void> {
  const store = new ContinuationInputStore(join(rootDir, 'inputs'));
  await store.withCreationLock(jobId, async () => {
    await store.install(jobId, [{
      sourcePath,
      fileName: 'live.txt',
      kind: 'message_attachment',
    }], 'cross-process-live-create');
    const aged = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(join(rootDir, 'inputs', jobId), aged, aged);
    process.stdout.write('MANAGED_INPUT_INSTALLED\n');
    const releasePath = join(rootDir, `.release-${jobId}`);
    while (true) {
      try {
        await lstat(releasePath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });
}

async function waitForChildMarker(
  child: ReturnType<typeof spawn>,
  marker: string,
  timeoutMs = 5_000,
): Promise<string> {
  let stdout = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timed out before ${marker}: ${stderr}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolve(stderr);
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('exit', (code) => {
      if (!stdout.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(stderr || `child exited ${code} before ${marker}`));
      }
    });
  });
}

function cloneHistoricalContinuationJob(
  database: SqliteDatabaseSync,
  sourceJobId: string,
  overrides: Readonly<Record<string, string | number | null>>,
): void {
  const columns = database.prepare('PRAGMA table_info(continuation_jobs)').all() as Array<{
    name: string;
  }>;
  const values: Array<string | number | null> = [];
  const projection = columns.map(({ name }) => {
    if (!Object.hasOwn(overrides, name)) return `"${name}"`;
    values.push(overrides[name] ?? null);
    return '?';
  });
  database.prepare(`
    INSERT INTO continuation_jobs (${columns.map(({ name }) => `"${name}"`).join(', ')})
    SELECT ${projection.join(', ')} FROM continuation_jobs WHERE job_id = ?
  `).run(...values, sourceJobId);
}

async function verifyConcurrentFreshInitialization(): Promise<void> {
  const initializationRoot = await mkdtemp(join(tmpdir(), 'continuation-init-concurrent-'));
  const initializationDatabasePath = join(initializationRoot, 'jobs.sqlite');
  const initializationArtifactsDir = join(initializationRoot, 'artifacts');
  const initializationInputsDir = join(initializationRoot, 'inputs');
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, [
    '--import',
    'tsx',
    new URL(import.meta.url).pathname,
    '--open-continuation-repository',
    initializationDatabasePath,
    initializationArtifactsDir,
    initializationInputsDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));

  await Promise.all(children.map((child) => (
    waitForChildMarker(child, 'REPOSITORY_OPENED', 10_000)
  )));

  const { DatabaseSync: InitializationDatabaseSync } = await import('node:sqlite');
  const database = new InitializationDatabaseSync(initializationDatabasePath);
  try {
    assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), 10);
    const schema = database.prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name LIKE 'continuation_%'
        AND type IN ('view', 'trigger')
      ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>;
    assert.deepEqual(
      schema.filter((entry) => entry.type === 'view').map((entry) => entry.name),
      [
        'continuation_attempts',
        'continuation_interrupts',
        'continuation_jobs',
        'continuation_outbox',
        'continuation_tool_calls',
      ],
    );
    assert.equal(schema.filter((entry) => entry.type === 'trigger').length, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

    const definitionsBeforeFailure = database.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE name LIKE 'continuation_%' AND type IN ('view', 'trigger')
      ORDER BY type, name
    `).all();
    const failingDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'exec') {
          return (sql: string) => {
            if (sql.includes('CREATE VIEW continuation_outbox AS')) {
              throw new Error('injected compatibility install failure');
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.throws(
      () => installContinuationCompatibilitySchema(failingDatabase),
      /injected compatibility install failure/u,
    );
    assert.deepEqual(database.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE name LIKE 'continuation_%' AND type IN ('view', 'trigger')
      ORDER BY type, name
    `).all(), definitionsBeforeFailure);
  } finally {
    database.close();
    await rm(initializationRoot, { force: true, recursive: true });
  }
}

await verifyConcurrentFreshInitialization();

const root = await mkdtemp(join(tmpdir(), 'continuation-repository-'));
const databasePath = join(root, 'runtime', 'jobs.sqlite');
const artifactsDir = join(root, 'runtime', 'artifacts');
const baseNow = '2026-07-17T00:00:00.000Z';
const artifactStore = new ContinuationArtifactStore(artifactsDir);

function progressCheckpoint(
  overrides: Partial<ContinuationCheckpointV2> = {},
): ContinuationCheckpointV2 {
  return {
    schemaVersion: 2,
    summary: 'Bounded step complete.',
    currentStepId: 'inspect-inputs',
    completedStepIds: ['inspect-inputs'],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps: [{ id: 'produce-result', description: 'Produce the result.' }],
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: ['do not publish'],
    decisions: [],
    nextAction: { id: 'produce-result', description: 'Produce the result.' },
    stopReason: 'One bounded step completed.',
    ...overrides,
  };
}

async function completedCheckpoint(
  jobId: string,
  currentStepId = 'produce-result',
  fileName = 'artifact.json',
  store: ContinuationArtifactStore = artifactStore,
): Promise<ContinuationCheckpointV2> {
  const content = '{"result":"ok"}\n';
  const directory = await store.ensure(jobId);
  await writeFile(join(directory, fileName), content, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  return progressCheckpoint({
    summary: 'Task contract verified.',
    currentStepId,
    completedStepIds: ['inspect-inputs', currentStepId],
    completedCriterionIds: ['result_persisted'],
    completedDeliverableIds: ['result'],
    remainingSteps: [],
    artifacts: [{ id: 'result-artifact', deliverableId: 'result', path: fileName, sha256 }],
    evidence: [{
      id: 'result-evidence',
      requirementId: 'result_exists',
      criterionIds: ['result_persisted'],
      artifactId: 'result-artifact',
    }],
    nextAction: null,
    stopReason: 'All acceptance criteria are verified.',
  });
}

class DelayedArtifactStore extends ContinuationArtifactStore {
  private markVerificationStarted!: () => void;
  private releaseVerification!: () => void;
  readonly verificationStarted = new Promise<void>((resolve) => {
    this.markVerificationStarted = resolve;
  });
  private readonly verificationReleased = new Promise<void>((resolve) => {
    this.releaseVerification = resolve;
  });

  release(): void {
    this.releaseVerification();
  }

  override async canonicalizeReferences(
    jobId: string,
    references: readonly string[],
  ): Promise<string[]> {
    this.markVerificationStarted();
    await this.verificationReleased;
    return super.canonicalizeReferences(jobId, references);
  }
}

function createRequest(
  suffix: string,
  overrides: Partial<ContinuationCreateRequest> = {},
): ContinuationCreateRequest {
  const route = {
    kind: 'message_thread' as const,
    conversationId: 'oc_continuation',
    sourceMessageId: `om_${suffix}`,
    threadId: 'omt_continuation',
  };
  const contextSnapshot = {
    summary: `Context ${suffix}`,
    completedSteps: [],
    remainingSteps: ['run the task'],
    constraints: ['do not publish'],
    decisions: [],
    references: [],
  };
  const permissions = {
    profile: 'bounded' as const,
    filesystem: { root, mode: 'workspace-write' as const, requestedPaths: [] },
    hostTools: [],
    network: 'none' as const,
    externalSideEffects: 'denied' as const,
    approval: { mode: 'never' as const },
  };
  const taskContract: AsyncTaskContract = {
    schemaVersion: 1,
    title: `Continuation ${suffix}`,
    objective: `Complete ${suffix}`,
    deliverables: [{ id: 'result', description: 'A persisted terminal result.', required: true }],
    acceptanceCriteria: [{
      id: 'result_persisted',
      description: 'terminal result is persisted',
      deliverableIds: ['result'],
    }],
    verificationRequirements: [{
      id: 'result_exists',
      description: 'The result artifact exists.',
      kind: 'artifact_exists',
    }],
    initialContext: contextSnapshot,
  };
  const sourceFacts: AsyncTaskFactSnapshot = {
    schemaVersion: 1,
    provenance: 'captured',
    originalUserText: `Complete ${suffix}`,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: 'ou_creator',
    chatId: 'oc_continuation',
    chatType: 'p2p',
    route,
    sourceMessageId: `om_${suffix}`,
    sourceThreadId: 'omt_continuation',
    sourceMessageType: 'text',
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: root,
    model: null,
    permissions,
  };
  return {
    idempotencyKey: `idem-${suffix}`,
    creatorOpenId: 'ou_creator',
    route,
    sourceMessageId: `om_${suffix}`,
    sourceThreadId: 'omt_continuation',
    title: `Continuation ${suffix}`,
    objective: `Complete ${suffix}`,
    acceptanceCriteria: ['terminal result is persisted'],
    contextSnapshot,
    sourceFacts,
    taskContract,
    sourceInputs: [],
    requiredTools: [],
    workingDirectory: root,
    permissions,
    maxAttempts: 5,
    maxRetries: 3,
    timeoutSeconds: 600,
    createdAt: baseNow,
    expiresAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function kernelAdapter(repository: SqliteContinuationRepository): AsyncTaskKernelAdapter {
  return new AsyncTaskKernelAdapter({
    repository,
    executor: { async execute() { throw new Error('unexpected recovery execution'); } },
    delivery: { async deliver() { throw new Error('unexpected recovery delivery'); } },
  });
}

async function recoverAndCommit(
  repository: SqliteContinuationRepository,
  now: string,
): Promise<DurableRunInterruptedAttempt[]> {
  const adapter = kernelAdapter(repository);
  const interrupted = await adapter.recoverExpiredLeases(['async_task'], now);
  for (const attempt of interrupted) {
    assert.equal(
      await adapter.commitTransition(
        attempt.claim,
        adapter.recoverInterruptedAttempt(attempt),
        now,
      ),
      'committed',
    );
  }
  return interrupted;
}

async function claimInWorker(
  workerId: string,
  barrier: SharedArrayBuffer,
): Promise<{ jobId: string; workerId: string } | null> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./continuation-claim-worker.ts', import.meta.url), {
      workerData: {
        databasePath,
        artifactsDir,
        workerId,
        now: baseNow,
        leaseExpiresAt: '2026-07-17T00:00:30.000Z',
        barrier,
      },
      execArgv: ['--import', 'tsx'],
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`claim worker ${workerId} exited ${code}`));
    });
  });
}

const genericLifecycleCalls = {
  create: 0,
  claimDue: 0,
  markExecutionStarted: 0,
  heartbeat: 0,
  commitTransition: 0,
  failAttempt: 0,
  claimDelivery: 0,
  commitDelivery: 0,
};
const genericPrototype = SqliteDurableRunRepository.prototype;
const originalGenericCreate = genericPrototype.create;
const originalGenericClaimDue = genericPrototype.claimDue;
const originalGenericMarkExecutionStarted = genericPrototype.markExecutionStarted;
const originalGenericHeartbeat = genericPrototype.heartbeat;
const originalGenericCommitTransition = genericPrototype.commitTransition;
const originalGenericFailAttempt = genericPrototype.failAttempt;
const originalGenericClaimDelivery = genericPrototype.claimDelivery;
const originalGenericCommitDelivery = genericPrototype.commitDelivery;
genericPrototype.create = async function (...args) {
  genericLifecycleCalls.create += 1;
  return originalGenericCreate.apply(this, args);
};
genericPrototype.claimDue = async function (...args) {
  genericLifecycleCalls.claimDue += 1;
  return originalGenericClaimDue.apply(this, args);
};
genericPrototype.markExecutionStarted = async function (...args) {
  genericLifecycleCalls.markExecutionStarted += 1;
  return originalGenericMarkExecutionStarted.apply(this, args);
};
genericPrototype.heartbeat = async function (...args) {
  genericLifecycleCalls.heartbeat += 1;
  return originalGenericHeartbeat.apply(this, args);
};
genericPrototype.commitTransition = async function (...args) {
  genericLifecycleCalls.commitTransition += 1;
  return originalGenericCommitTransition.apply(this, args);
};
genericPrototype.failAttempt = async function (...args) {
  genericLifecycleCalls.failAttempt += 1;
  return originalGenericFailAttempt.apply(this, args);
};
genericPrototype.claimDelivery = async function (...args) {
  genericLifecycleCalls.claimDelivery += 1;
  return originalGenericClaimDelivery.apply(this, args);
};
genericPrototype.commitDelivery = async function (...args) {
  genericLifecycleCalls.commitDelivery += 1;
  return originalGenericCommitDelivery.apply(this, args);
};

const repository = await SqliteContinuationRepository.open({
  databasePath,
  artifactsDir,
  jitter: () => 0,
});
const secondRepository = await SqliteContinuationRepository.open({
  databasePath,
  artifactsDir,
  jitter: () => 0,
});

try {
  await repository.healthCheck();
  assert.equal(modeBits((await stat(databasePath)).mode), 0o600);
  assert.equal(modeBits((await stat(artifactsDir)).mode), 0o700);

  await assert.rejects(
    repository.create(createRequest('message-thread-mismatch', {
      sourceThreadId: 'omt_other_thread',
    })),
    /does not match the source thread/i,
  );
  const commentThreadMismatch = createRequest('comment-thread-mismatch');
  const commentRoute = {
    kind: 'comment_thread' as const,
    documentToken: 'doc_thread_binding',
    commentId: 'comment_expected',
    fileType: 'docx',
  };
  await assert.rejects(repository.create({
    ...commentThreadMismatch,
    route: commentRoute,
    sourceMessageId: 'comment_message',
    sourceThreadId: 'comment_other',
    sourceFacts: {
      ...commentThreadMismatch.sourceFacts,
      chatId: 'doc:doc_thread_binding',
      chatType: 'doc_comment',
      route: commentRoute,
      sourceMessageId: 'comment_message',
      sourceThreadId: 'comment_other',
    },
  }), /does not match the source thread/i);

  const objectiveBoundary = createRequest('objective-byte-boundary');
  const boundaryObjective = 'x'.repeat(CONTINUATION_LIMITS.objectiveBytes - 1);
  const objectiveBoundaryCreated = await repository.create({
    ...objectiveBoundary,
    objective: boundaryObjective,
    createdAt: '2026-07-17T01:00:00.000Z',
    taskContract: {
      ...objectiveBoundary.taskContract,
      objective: boundaryObjective,
    },
  });
  assert.equal(objectiveBoundaryCreated.job.objective.length, 16_383);

  const first = await repository.create(createRequest('first'));
  assert.equal(first.created, true);
  assert.match(first.job.jobId, /^job_[a-f0-9]{24}$/);
  assert.equal(first.job.status, 'queued');
  assert.equal(first.job.rowVersion, 1);
  assert.deepEqual(first.job.permissions, createRequest('first').permissions);
  const persistedFirstJob = JSON.parse(JSON.stringify(first.job)) as unknown;
  assert.throws(() => kernelAdapter(repository).parseState({
    schemaVersion: 1,
    job: persistedFirstJob,
    commit: { kind: 'step', result: { unexpected: true } },
  }, 1), /Invalid Async Task kernel commit/u);
  const { DatabaseSync: EnvelopeDatabaseSync } = await import('node:sqlite');
  const envelopeDatabase = new EnvelopeDatabaseSync(databasePath);
  const persistedEnvelope = envelopeDatabase.prepare(`
    SELECT input_version, input_json, state_version, state_json
    FROM durable_runs WHERE run_id = ?
  `).get(first.job.jobId) as {
    input_version: number;
    input_json: string;
    state_version: number;
    state_json: string;
  };
  envelopeDatabase.close();
  kernelAdapter(repository).parseInput(
    JSON.parse(persistedEnvelope.input_json),
    persistedEnvelope.input_version,
  );
  kernelAdapter(repository).parseState(
    JSON.parse(persistedEnvelope.state_json),
    persistedEnvelope.state_version,
  );

  const duplicate = await secondRepository.create(createRequest('first'));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.jobId, first.job.jobId);

  assert.equal((await repository.listByCreator('ou_creator', 10)).length, 2);
  assert.equal((await repository.listByCreator('ou_other', 10)).length, 0);
  assert.equal((await repository.listAll(10)).length, 2);

  const firstClaim = await repository.claimDue(
    'worker-main',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.ok(firstClaim);
  assert.equal(firstClaim.job.status, 'running');
  assert.equal(firstClaim.attempt.ordinal, 1);
  assert.equal(
    await repository.heartbeat(
      first.job.jobId,
      'worker-main',
      '2026-07-17T00:00:10.000Z',
      '2026-07-17T00:00:40.000Z',
    ),
    true,
  );

  const toolRequest = { tool: 'lark_cli', args: ['doc', 'get', '--token', 'doc_1'] };
  const newToolCall = await repository.beginToolCall(
    firstClaim,
    toolRequest,
    '2026-07-17T00:00:10.100Z',
  );
  assert.equal(newToolCall.status, 'execute');
  assert.match(newToolCall.callId, /^call_[a-f0-9]{24}$/);
  await repository.completeToolCall(
    firstClaim,
    newToolCall.callId,
    { ok: true, message: '{"document":"ok"}' },
    '2026-07-17T00:00:10.200Z',
  );
  assert.deepEqual(await repository.inspectToolCall(firstClaim), {
    status: 'completed',
    tool: 'lark_cli',
    result: { ok: true, message: '{"document":"ok"}' },
  });
  assert.deepEqual(
    await repository.beginToolCall(firstClaim, toolRequest, '2026-07-17T00:00:10.300Z'),
    {
      status: 'replay',
      callId: newToolCall.callId,
      result: { ok: true, message: '{"document":"ok"}' },
    },
  );
  assert.equal(
    (await repository.beginToolCall(
      firstClaim,
      { ...toolRequest, args: ['doc', 'get', '--token', 'doc_2'] },
      '2026-07-17T00:00:10.400Z',
    )).status,
    'conflict',
  );

  await repository.completeStep(firstClaim, {
    executionSessionId: 'session-continuation-1',
    outcome: {
      outcome: 'continue',
      checkpoint: progressCheckpoint({
        summary: 'First slice complete',
        decisions: ['use local data'],
      }),
      resumeAfterSeconds: 0,
    },
  }, '2026-07-17T00:00:11.000Z');
  assert.equal(
    await repository.heartbeat(
      first.job.jobId,
      'worker-main',
      '2026-07-17T00:00:11.001Z',
      '2026-07-17T00:00:41.001Z',
    ),
    false,
  );
  const checkpointed = await repository.get(first.job.jobId);
  assert.equal(checkpointed?.status, 'waiting_retry');
  assert.equal(checkpointed?.stepCount, 1);
  assert.equal(checkpointed?.failureCount, 0);
  assert.equal(checkpointed?.checkpoint?.summary, 'First slice complete');
  assert.equal(checkpointed?.executionSessionId, 'session-continuation-1');
  assert.deepEqual(checkpointed?.deliveryEvents?.map((event) => ({
    eventKey: event.eventKey,
    kind: event.kind,
    attemptId: event.attemptId,
    status: event.status,
  })), [{
    eventKey: `progress:${firstClaim.attempt.attemptId}`,
    kind: 'progress',
    attemptId: firstClaim.attempt.attemptId,
    status: 'pending',
  }]);

  assert.equal(await repository.claimDue(
    'worker-main',
    '2026-07-17T00:00:11.000Z',
    '2026-07-17T00:00:41.000Z',
  ), null);
  const progressDelivery = await repository.claimPendingDelivery(
    'delivery-progress',
    '2026-07-17T00:00:11.000Z',
  );
  assert.ok(progressDelivery);
  assert.equal(progressDelivery.kind, 'progress');
  assert.equal(progressDelivery.eventKey, `progress:${firstClaim.attempt.attemptId}`);
  assert.equal(progressDelivery.attemptId, firstClaim.attempt.attemptId);
  assert.match(progressDelivery.payload, new RegExp(
    `^Task progress: ${first.job.jobId} \\(${firstClaim.attempt.attemptId}\\)`,
  ));
  assert.match(progressDelivery.payload, /Attempt: 1 \/ 5/);
  assert.match(progressDelivery.payload, /First slice complete/);
  await repository.markDeliveryResult(
    progressDelivery,
    { status: 'delivered', messageId: 'om_progress' },
    '2026-07-17T00:00:11.050Z',
  );

  const secondClaim = await repository.claimDue(
    'worker-main',
    '2026-07-17T00:00:11.050Z',
    '2026-07-17T00:00:41.050Z',
  );
  assert.ok(secondClaim);
  const unfinishedToolCall = await repository.beginToolCall(
    secondClaim,
    { tool: 'lark_cli', args: ['message', 'send'] },
    '2026-07-17T00:00:11.100Z',
  );
  assert.equal(unfinishedToolCall.status, 'execute');
  assert.deepEqual(await repository.inspectToolCall(secondClaim), {
    status: 'unknown',
    tool: 'lark_cli',
  });
  assert.deepEqual(
    await repository.beginToolCall(
      secondClaim,
      { tool: 'lark_cli', args: ['message', 'send'] },
      '2026-07-17T00:00:11.200Z',
    ),
    { status: 'unknown', callId: unfinishedToolCall.callId },
  );
  await repository.completeStep(secondClaim, {
    executionSessionId: 'session-continuation-1',
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(first.job.jobId),
      finalMessage: 'Complete result',
      resultSummary: 'Complete',
      artifacts: ['artifact.json'],
    },
  }, '2026-07-17T00:00:12.000Z');
  const completed = await repository.get(first.job.jobId);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.deliveryStatus, 'pending');
  assert.deepEqual(completed?.deliveryEvents?.map((event) => ({
    eventKey: event.eventKey,
    kind: event.kind,
    status: event.status,
  })), [
    { eventKey: 'terminal', kind: 'terminal', status: 'pending' },
    {
      eventKey: `progress:${firstClaim.attempt.attemptId}`,
      kind: 'progress',
      status: 'delivered',
    },
  ]);

  const delivery = await repository.claimPendingDelivery(
    'delivery-main',
    '2026-07-17T00:00:13.000Z',
  );
  assert.ok(delivery);
  assert.equal(delivery.jobId, first.job.jobId);
  assert.equal(delivery.eventKey, 'terminal');
  assert.equal(delivery.kind, 'terminal');
  assert.equal(delivery.payload, `Task completed: ${first.job.jobId}\nComplete result`);
  await repository.markDeliveryResult(
    delivery,
    { status: 'delivered', messageId: 'om_terminal' },
    '2026-07-17T00:00:14.000Z',
  );
  assert.equal((await repository.get(first.job.jobId))?.deliveryStatus, 'delivered');

  const concurrent = await repository.create(createRequest('concurrent'));
  const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(barrierBuffer);
  const workerA = claimInWorker('worker-a', barrierBuffer);
  const workerB = claimInWorker('worker-b', barrierBuffer);
  while (Atomics.load(barrier, 0) < 2) {
    Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 10);
  }
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, 2);
  const raceClaims = await Promise.all([workerA, workerB]);
  assert.equal(raceClaims.filter(Boolean).length, 1);
  assert.equal(raceClaims.find(Boolean)?.jobId, concurrent.job.jobId);

  const runningConcurrent = await repository.get(concurrent.job.jobId);
  assert.equal(runningConcurrent?.status, 'running');
  const raceWinner = raceClaims.find(Boolean);
  assert.ok(raceWinner);
  const recovered = await recoverAndCommit(repository, '2026-07-17T00:00:31.000Z');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.claim.run.runId, concurrent.job.jobId);
  assert.equal(recovered[0]?.claim.workerId, raceWinner.workerId);
  assert.equal(recovered[0]?.executionPhase, 'claimed');
  assert.equal(recovered[0]?.operationRisk, 'unknown');
  assert.equal((await repository.get(concurrent.job.jobId))?.status, 'waiting_retry');

  const opaqueExecution = await repository.create(createRequest('opaque-execution-lease'));
  const opaqueClaim = await repository.claimDue(
    'worker-opaque',
    '2026-07-17T00:00:31.000Z',
    '2026-07-17T00:00:40.000Z',
  );
  assert.equal(opaqueClaim?.job.jobId, opaqueExecution.job.jobId);
  await repository.markExecutionStarted(opaqueClaim!, '2026-07-17T00:00:31.100Z');
  const recoveredOpaque = await recoverAndCommit(repository, '2026-07-17T00:00:41.000Z');
  assert.equal(recoveredOpaque.length, 1);
  assert.equal(recoveredOpaque[0]?.claim.attempt.attemptId, opaqueClaim?.attempt.attemptId);
  assert.equal(recoveredOpaque[0]?.executionPhase, 'execution_started');
  assert.equal(recoveredOpaque[0]?.operationRisk, 'unknown');
  const interruptedOpaqueExecution = await repository.get(opaqueExecution.job.jobId);
  assert.equal(interruptedOpaqueExecution?.status, 'waiting_user');
  assert.equal(interruptedOpaqueExecution?.recovery?.failure.category, 'unknown');
  assert.equal(interruptedOpaqueExecution?.recovery?.failure.retrySafety, 'unknown');
  assert.equal(interruptedOpaqueExecution?.currentInterrupt?.status, 'pending');
  assert.equal(await repository.claimDue(
    'worker-opaque-replay',
    '2026-07-17T00:00:41.000Z',
    '2026-07-17T00:01:11.000Z',
  ), null);

  const opaqueFailure = await repository.create(createRequest('opaque-execution-failure'));
  const opaqueFailureClaim = await repository.claimDue(
    'worker-opaque-failure',
    '2026-07-17T00:00:41.000Z',
    '2026-07-17T00:01:11.000Z',
  );
  assert.equal(opaqueFailureClaim?.job.jobId, opaqueFailure.job.jobId);
  await repository.markExecutionStarted(opaqueFailureClaim!, '2026-07-17T00:00:41.100Z');
  await repository.failAttempt(opaqueFailureClaim!, {
    errorCode: 'continuation_timeout',
    errorSummary: 'The continuation step timed out.',
    retryable: true,
  }, '2026-07-17T00:00:42.000Z');
  const interruptedOpaqueFailure = await repository.get(opaqueFailure.job.jobId);
  assert.equal(interruptedOpaqueFailure?.status, 'waiting_user');
  assert.equal(interruptedOpaqueFailure?.recovery?.failure.category, 'unknown');
  assert.equal(interruptedOpaqueFailure?.recovery?.failure.retrySafety, 'unknown');

  const readOnlyRequest = createRequest('read-only-execution-failure');
  const readOnlyPermissions = {
    ...readOnlyRequest.permissions,
    filesystem: { ...readOnlyRequest.permissions.filesystem, mode: 'read-only' as const },
  };
  readOnlyRequest.permissions = readOnlyPermissions;
  readOnlyRequest.sourceFacts = {
    ...readOnlyRequest.sourceFacts,
    permissions: readOnlyPermissions,
  };
  const readOnlyFailure = await repository.create(readOnlyRequest);
  const readOnlyFailureClaim = await repository.claimDue(
    'worker-read-only-failure',
    '2026-07-17T00:00:42.000Z',
    '2026-07-17T00:01:12.000Z',
  );
  assert.equal(readOnlyFailureClaim?.job.jobId, readOnlyFailure.job.jobId);
  await repository.markExecutionStarted(readOnlyFailureClaim!, '2026-07-17T00:00:42.100Z');
  await repository.failAttempt(readOnlyFailureClaim!, {
    errorCode: 'continuation_timeout',
    errorSummary: 'The read-only continuation step timed out.',
    retryable: true,
  }, '2026-07-17T00:00:43.000Z');
  assert.equal((await repository.get(readOnlyFailure.job.jobId))?.status, 'waiting_retry');

  const modelRetry = await repository.create(createRequest('model-retry-opaque'));
  const modelRetryClaim = await repository.claimDue(
    'worker-model-retry',
    '2026-07-17T00:00:43.000Z',
    '2026-07-17T00:01:13.000Z',
  );
  assert.equal(modelRetryClaim?.job.jobId, modelRetry.job.jobId);
  await repository.markExecutionStarted(modelRetryClaim!, '2026-07-17T00:00:43.100Z');
  await repository.completeStep(modelRetryClaim!, {
    outcome: {
      outcome: 'failed',
      checkpoint: progressCheckpoint({
        summary: 'The publish step returned a retryable error.',
        currentStepId: 'publish-result',
        remainingSteps: [{ id: 'publish-result', description: 'Publish the result.' }],
        nextAction: { id: 'publish-result', description: 'Publish the result.' },
      }),
      errorCode: 'temporary_publish_failure',
      errorSummary: 'The model requested another publish attempt.',
      retryable: true,
      completedWork: [],
      unperformedWork: ['Publish the result.'],
    },
  }, '2026-07-17T00:00:44.000Z');
  const guardedModelRetry = await repository.get(modelRetry.job.jobId);
  assert.equal(guardedModelRetry?.status, 'waiting_user');
  assert.equal(guardedModelRetry?.recovery?.failure.category, 'unknown');
  assert.equal(guardedModelRetry?.recovery?.failure.retrySafety, 'unknown');
  assert.equal(guardedModelRetry?.recovery?.failure.failedStep, 'publish-result');

  const queuedCancel = await repository.create(createRequest('queued-cancel'));
  assert.equal(
    await repository.requestCancel(queuedCancel.job.jobId, '2026-07-17T00:00:20.000Z'),
    'cancelled',
  );
  assert.equal((await repository.get(queuedCancel.job.jobId))?.status, 'cancelled');
  const preSendDelivery = await repository.claimPendingDelivery(
    'delivery-pre-send',
    '2026-07-17T00:00:20.000Z',
  );
  assert.ok(preSendDelivery);
  assert.equal(preSendDelivery.jobId, queuedCancel.job.jobId);
  assert.equal(preSendDelivery.attemptCount, 1);
  await repository.markDeliveryResult(
    preSendDelivery,
    {
      status: 'retry',
      errorCode: 'lark_pre_send_unavailable',
      errorSummary: 'Lark was unavailable before sending.',
    },
    '2026-07-17T00:00:21.000Z',
  );
  const deliveryAfterPreSend = await repository.claimPendingDelivery(
    'delivery-pre-send-retry',
    '2026-07-17T00:00:51.000Z',
  );
  assert.ok(deliveryAfterPreSend);
  assert.equal(deliveryAfterPreSend.jobId, queuedCancel.job.jobId);
  assert.equal(deliveryAfterPreSend.eventKey, preSendDelivery.eventKey);
  assert.equal(deliveryAfterPreSend.idempotencyKey, preSendDelivery.idempotencyKey);
  assert.equal(deliveryAfterPreSend.attemptCount, 1);
  assert.equal(deliveryAfterPreSend.firstAttemptAt, '2026-07-17T00:00:51.000Z');
  await repository.markDeliveryResult(
    deliveryAfterPreSend,
    { status: 'delivered', messageId: 'om_cancelled' },
    '2026-07-17T00:00:52.000Z',
  );

  const runningCancel = await repository.create(createRequest('running-cancel'));
  const runningCancelClaim = await repository.claimDue(
    'worker-cancel',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.ok(runningCancelClaim);
  assert.equal(runningCancelClaim.job.jobId, runningCancel.job.jobId);
  assert.equal(
    await repository.requestCancel(runningCancel.job.jobId, '2026-07-17T00:00:21.000Z'),
    'cancel_requested',
  );
  assert.equal(
    await repository.completeStep(runningCancelClaim, {
      outcome: {
        outcome: 'completed',
        finalMessage: 'must not win cancellation',
        artifacts: [],
      },
    }, '2026-07-17T00:00:22.000Z'),
    'stale',
  );
  assert.equal(
    await repository.completeCancellation(runningCancelClaim, '2026-07-17T00:00:23.000Z'),
    'committed',
  );
  assert.equal((await repository.get(runningCancel.job.jobId))?.status, 'cancelled');

  const expiredQueued = await repository.create(createRequest('expired-queued', {
    expiresAt: '2026-07-17T00:00:05.000Z',
  }));
  assert.equal(await repository.expireOverdue('2026-07-17T00:00:06.000Z'), 1);
  assert.equal((await repository.get(expiredQueued.job.jobId))?.status, 'failed');
  assert.equal((await repository.get(expiredQueued.job.jobId))?.deliveryStatus, 'pending');

  const exhausted = await repository.create(createRequest('exhausted', { maxRetries: 0 }));
  const exhaustedClaim = await repository.claimDue(
    'worker-exhausted',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.equal(exhaustedClaim?.job.jobId, exhausted.job.jobId);
  assert.ok(exhaustedClaim);
  await repository.failAttempt(exhaustedClaim, {
    errorCode: 'provider_unavailable',
    errorSummary: 'Provider unavailable.',
    retryable: true,
  }, '2026-07-17T00:00:24.000Z');
  assert.equal((await repository.get(exhausted.job.jobId))?.status, 'failed');
  assert.equal((await repository.get(exhausted.job.jobId))?.deliveryStatus, 'pending');

  const retry = await repository.cloneForRetry(
    queuedCancel.job.jobId,
    'manual-retry-1',
    '2026-07-17T00:01:00.000Z',
  );
  assert.notEqual(retry.jobId, queuedCancel.job.jobId);
  assert.equal(retry.retryOfJobId, queuedCancel.job.jobId);
  assert.equal(retry.status, 'queued');

  assert.equal(await repository.redactTerminal(first.job.jobId, '2026-07-17T00:02:00.000Z'), true);
  const redacted = await repository.get(first.job.jobId);
  assert.equal(redacted?.deletedAt, '2026-07-17T00:02:00.000Z');
  assert.equal(redacted?.objective, '');
  assert.equal(redacted?.contextSnapshot.summary, '');
  assert.deepEqual(redacted?.permissions, {
    profile: 'bounded',
    filesystem: { root: '', mode: 'read-only', requestedPaths: [] },
    hostTools: [],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  });

  const artifactStore = new ContinuationArtifactStore(artifactsDir, 4);
  const artifactRoot = await artifactStore.ensure('job_artifact_test');
  assert.equal(modeBits((await stat(artifactRoot)).mode), 0o700);
  const validArtifact = artifactStore.resolve('job_artifact_test', 'report.txt');
  await writeFile(validArtifact, '1234', 'utf-8');
  await artifactStore.assertWithinLimit('job_artifact_test');
  await writeFile(validArtifact, '12345', 'utf-8');
  await assert.rejects(
    artifactStore.assertWithinLimit('job_artifact_test'),
    /artifact byte limit/i,
  );
  const entryLimitedStore = new ContinuationArtifactStore(artifactsDir, 1_024, 2, 4);
  const entryLimitedRoot = await entryLimitedStore.ensure('job_artifact_entries');
  await writeFile(join(entryLimitedRoot, 'one.txt'), '', 'utf8');
  await writeFile(join(entryLimitedRoot, 'two.txt'), '', 'utf8');
  await writeFile(join(entryLimitedRoot, 'three.txt'), '', 'utf8');
  await assert.rejects(
    entryLimitedStore.assertWithinLimit('job_artifact_entries'),
    /artifact entry limit/i,
  );
  const depthLimitedStore = new ContinuationArtifactStore(artifactsDir, 1_024, 10, 1);
  const depthLimitedRoot = await depthLimitedStore.ensure('job_artifact_depth');
  await mkdir(join(depthLimitedRoot, 'level-one', 'level-two'), { recursive: true });
  await assert.rejects(
    depthLimitedStore.assertWithinLimit('job_artifact_depth'),
    /artifact directory depth/i,
  );
  assert.throws(() => artifactStore.resolve('job_artifact_test', '../escape.txt'), /outside job directory/i);
  assert.throws(() => artifactStore.resolve('job_artifact_test', '/tmp/escape.txt'), /relative/i);
  await chmod(artifactRoot, 0o700);
  await artifactStore.remove('job_artifact_test');
  await assert.rejects(stat(artifactRoot), /ENOENT/);

  const purged = await repository.purgeExpired(
    '2026-07-17T00:00:30.000Z',
    '2026-07-17T00:03:00.000Z',
  );
  assert.ok(
    purged.some((result) => result.result === 'cleaned'),
    `expected at least one delivered terminal row to be redacted, got ${JSON.stringify(purged)}`,
  );

  const legacyEnvelope = await repository.create(createRequest('legacy-envelope'));
  const { DatabaseSync } = await import('node:sqlite');
  const rawDatabase = new DatabaseSync(databasePath);
  rawDatabase.prepare(`
    UPDATE durable_runs
    SET input_json = json_set(input_json, '$.job.permissions', json(?)),
        state_json = json_set(state_json, '$.job.permissions', json(?))
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run(
    JSON.stringify({
      filesystem: { root, mode: 'workspace-write' },
      hostTools: [],
      network: 'none',
      approval: { mode: 'never' },
    }),
    JSON.stringify({
      filesystem: { root, mode: 'workspace-write' },
      hostTools: [],
      network: 'none',
      approval: { mode: 'never' },
    }),
    legacyEnvelope.job.jobId,
  );
  rawDatabase.close();
  assert.deepEqual((await repository.get(legacyEnvelope.job.jobId))?.permissions, {
    profile: 'bounded',
    filesystem: { root, mode: 'workspace-write', requestedPaths: [] },
    hostTools: [],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(genericLifecycleCalls).map(([name, count]) => [name, count > 0])),
    {
      create: true,
      claimDue: true,
      markExecutionStarted: true,
      heartbeat: true,
      commitTransition: true,
      failAttempt: true,
      claimDelivery: true,
      commitDelivery: true,
    },
  );
} finally {
  secondRepository.close();
  repository.close();
  genericPrototype.create = originalGenericCreate;
  genericPrototype.claimDue = originalGenericClaimDue;
  genericPrototype.markExecutionStarted = originalGenericMarkExecutionStarted;
  genericPrototype.heartbeat = originalGenericHeartbeat;
  genericPrototype.commitTransition = originalGenericCommitTransition;
  genericPrototype.failAttempt = originalGenericFailAttempt;
  genericPrototype.claimDelivery = originalGenericClaimDelivery;
  genericPrototype.commitDelivery = originalGenericCommitDelivery;
}

// Maintenance scans isolate corrupt rows without blocking healthy lease, expiry, or budget work.
const maintenanceRoot = await mkdtemp(join(tmpdir(), 'continuation-maintenance-corrupt-'));
const maintenanceDatabasePath = join(maintenanceRoot, 'jobs.sqlite');
const maintenanceRepository = await SqliteContinuationRepository.open({
  databasePath: maintenanceDatabasePath,
  artifactsDir: join(maintenanceRoot, 'artifacts'),
  inputsDir: join(maintenanceRoot, 'inputs'),
  jitter: () => 0,
});
const { DatabaseSync: MaintenanceDatabaseSync } = await import('node:sqlite');
const maintenanceDatabase = new MaintenanceDatabaseSync(maintenanceDatabasePath);
const corruptMaintenanceFacts = (jobId: string) => {
  maintenanceDatabase.prepare(`
    UPDATE durable_runs
    SET input_json = json_set(
          input_json,
          '$.job.sourceFacts.unexpected',
          'maintenance corruption'
        ),
        state_json = json_set(
          state_json,
          '$.job.sourceFacts.unexpected',
          'maintenance corruption'
        )
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run(jobId);
};

const corruptLeaseJob = await maintenanceRepository.create(createRequest(
  'maintenance-corrupt-lease',
  { createdAt: '2026-07-16T23:59:57.000Z' },
));
const healthyLeaseJob = await maintenanceRepository.create(createRequest(
  'maintenance-healthy-lease',
  { createdAt: '2026-07-16T23:59:58.000Z' },
));
assert.equal((await maintenanceRepository.claimDue(
  'maintenance-worker-corrupt',
  baseNow,
  '2026-07-17T00:00:05.000Z',
))?.job.jobId, corruptLeaseJob.job.jobId);
assert.equal((await maintenanceRepository.claimDue(
  'maintenance-worker-healthy',
  baseNow,
  '2026-07-17T00:00:05.000Z',
))?.job.jobId, healthyLeaseJob.job.jobId);
corruptMaintenanceFacts(corruptLeaseJob.job.jobId);
const maintenanceRecovered = await recoverAndCommit(
  maintenanceRepository,
  '2026-07-17T00:00:06.000Z',
);
assert.equal(maintenanceRecovered.length, 1);
assert.equal(maintenanceRecovered[0]?.claim.run.runId, healthyLeaseJob.job.jobId);
assert.equal(
  (await maintenanceRepository.get(corruptLeaseJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
assert.equal(
  (await maintenanceRepository.get(healthyLeaseJob.job.jobId))?.status,
  'waiting_retry',
);

const corruptOverdueJob = await maintenanceRepository.create(createRequest(
  'maintenance-corrupt-overdue',
  { expiresAt: '2026-07-17T00:00:07.000Z' },
));
const healthyOverdueJob = await maintenanceRepository.create(createRequest(
  'maintenance-healthy-overdue',
  { expiresAt: '2026-07-17T00:00:07.000Z' },
));
corruptMaintenanceFacts(corruptOverdueJob.job.jobId);
assert.equal(await maintenanceRepository.expireOverdue(
  '2026-07-17T00:00:08.000Z',
), 2);
assert.equal(
  (await maintenanceRepository.get(corruptOverdueJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
assert.equal(
  (await maintenanceRepository.get(healthyOverdueJob.job.jobId))?.errorCode,
  'continuation_expired',
);

const corruptBudgetJob = await maintenanceRepository.create(createRequest(
  'maintenance-corrupt-budget',
  { maxAttempts: 1 },
));
const healthyBudgetJob = await maintenanceRepository.create(createRequest(
  'maintenance-healthy-budget',
  { maxAttempts: 1 },
));
const insertBudgetAttempt = maintenanceDatabase.prepare(`
  INSERT INTO durable_attempts (
    attempt_id, run_id, ordinal, worker_id, claimed_at, heartbeat_at,
    lease_expires_at, execution_phase, operation_risk, metadata_json,
    finished_at, outcome, error_code, error_summary
  ) VALUES (?, ?, 1, 'maintenance-worker', ?, ?, ?, 'claimed', 'unknown', '{}',
    ?, 'error', 'test', 'test')
`);
for (const [attemptId, jobId] of [
  ['attempt_maintenance_corrupt', corruptBudgetJob.job.jobId],
  ['attempt_maintenance_healthy', healthyBudgetJob.job.jobId],
]) {
  insertBudgetAttempt.run(attemptId, jobId, baseNow, baseNow, baseNow, baseNow);
  maintenanceDatabase.prepare(`
    UPDATE durable_runs SET attempt_count = 1
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run(jobId);
}
corruptMaintenanceFacts(corruptBudgetJob.job.jobId);
assert.equal(await maintenanceRepository.claimDue(
  'maintenance-budget-worker',
  baseNow,
  '2026-07-17T00:00:30.000Z',
), null);
assert.equal(
  (await maintenanceRepository.get(corruptBudgetJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
assert.equal(
  (await maintenanceRepository.get(healthyBudgetJob.job.jobId))?.status,
  'queued',
);
assert.equal(
  maintenanceDatabase.prepare(`
    SELECT attempt_count FROM durable_runs WHERE run_id = ?
  `).get(healthyBudgetJob.job.jobId)?.attempt_count,
  1,
);
maintenanceDatabase.close();
maintenanceRepository.close();

const migrationDatabasePath = join(root, 'migration', 'jobs.sqlite');
const migrationArtifactsDir = join(root, 'migration', 'artifacts');
const legacyWorkingDirectory = join(root, 'legacy-working-directory');
await import('node:fs/promises').then(({ mkdir }) => mkdir(legacyWorkingDirectory));
const legacyV2Fixture = await seedHistoricalContinuationDatabase({
  databasePath: migrationDatabasePath,
  now: baseNow,
  version: 2,
  workingDirectory: legacyWorkingDirectory,
});
const { DatabaseSync } = await import('node:sqlite');

const convergenceDatabasePath = join(root, 'convergence', 'jobs.sqlite');
const convergenceArtifactsDir = join(root, 'convergence', 'artifacts');
const convergenceRepository = await SqliteContinuationRepository.open({
  databasePath: convergenceDatabasePath,
  artifactsDir: convergenceArtifactsDir,
  jitter: () => 0,
});
try {
  const convergence = await convergenceRepository.create(createRequest('convergence'));
  for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
    const seconds = String(ordinal).padStart(2, '0');
    const now = `2026-07-17T00:10:${seconds}.000Z`;
    const claim = await convergenceRepository.claimDue(
      'worker-convergence',
      now,
      `2026-07-17T00:11:${seconds}.000Z`,
    );
    assert.ok(claim);
    assert.equal(claim.attempt.ordinal, ordinal);
    await convergenceRepository.completeStep(claim, {
      executionSessionId: 'session-convergence',
      outcome: {
        outcome: 'continue',
        checkpoint: progressCheckpoint({
          summary: `Attempt ${ordinal} checkpoint`,
          currentStepId: `step-${ordinal}`,
          completedStepIds: Array.from({ length: ordinal }, (_, index) => `step-${index + 1}`),
          remainingSteps: ordinal < 5
            ? [{ id: `step-${ordinal + 1}`, description: 'finish the remaining work' }]
            : [{ id: 'post-budget', description: 'finish the remaining work' }],
          constraints: ['stay within the attempt budget'],
          decisions: ['preserve the checkpoint'],
          nextAction: ordinal < 5
            ? { id: `step-${ordinal + 1}`, description: 'finish the remaining work' }
            : { id: 'post-budget', description: 'finish the remaining work' },
        }),
      },
    }, now);
    assert.equal(
      (await convergenceRepository.get(convergence.job.jobId))?.status,
      ordinal < 5 ? 'waiting_retry' : 'partial',
    );
    if (ordinal < 5) {
      const progress = await convergenceRepository.claimPendingDelivery(
        'delivery-convergence-progress',
        now,
      );
      assert.equal(progress?.kind, 'progress');
      assert.equal(progress?.attemptId, claim.attempt.attemptId);
      await convergenceRepository.markDeliveryResult(
        progress!,
        { status: 'delivered', messageId: `om_progress_${ordinal}` },
        now,
      );
    }
  }
  assert.equal(await convergenceRepository.claimDue(
    'worker-convergence',
    '2026-07-17T00:12:00.000Z',
    '2026-07-17T00:13:00.000Z',
  ), null);
  const partialDelivery = await convergenceRepository.claimPendingDelivery(
    'delivery-convergence',
    '2026-07-17T00:12:00.000Z',
  );
  assert.ok(partialDelivery);
  assert.equal(partialDelivery.jobId, convergence.job.jobId);
  assert.match(partialDelivery.payload, /^Task partially completed:/);
  assert.match(partialDelivery.payload, /Attempt 5 checkpoint/);

  const blocked = await convergenceRepository.create(createRequest('blocked'));
  const blockedClaim = await convergenceRepository.claimDue(
    'worker-blocked',
    '2026-07-17T00:12:01.000Z',
    '2026-07-17T00:13:01.000Z',
  );
  assert.equal(blockedClaim?.job.jobId, blocked.job.jobId);
  assert.ok(blockedClaim);
  await convergenceRepository.completeStep(blockedClaim, {
    outcome: {
      outcome: 'blocked',
      checkpoint: progressCheckpoint({
        summary: 'Local validation completed before the blocker.',
        currentStepId: 'production-validation',
        completedStepIds: ['local-validation'],
        remainingSteps: [{ id: 'production-validation', description: 'run production validation' }],
        nextAction: { id: 'production-validation', description: 'run production validation' },
      }),
      errorCode: 'missing_capability',
      errorSummary: 'A required capability is unavailable.',
      requiredCapability: 'production credentials',
      completedWork: ['validated the local implementation'],
      unperformedWork: ['run production validation'],
    },
  }, '2026-07-17T00:12:02.000Z');
  const blockedResult = await convergenceRepository.get(blocked.job.jobId);
  assert.equal(blockedResult?.status, 'blocked');
  assert.equal(blockedResult?.errorCode, 'missing_capability');
  assert.equal(blockedResult?.deliveryStatus, 'pending');
} finally {
  convergenceRepository.close();
}

const outcomePolicyArtifacts = new ContinuationArtifactStore(
  join(root, 'outcome-policy', 'artifacts'),
);
const outcomePolicyRepository = await SqliteContinuationRepository.open({
  databasePath: join(root, 'outcome-policy', 'jobs.sqlite'),
  artifactsDir: join(root, 'outcome-policy', 'artifacts'),
  artifactStore: outcomePolicyArtifacts,
  jitter: () => 0,
});
try {
  const revisionJob = await outcomePolicyRepository.create(createRequest('verification-revision'));
  const rejectedClaim = await outcomePolicyRepository.claimDue(
    'worker-verification-revision',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(rejectedClaim);
  await outcomePolicyRepository.completeStep(rejectedClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: progressCheckpoint({ nextAction: null }),
      finalMessage: 'Unverified completion must not be accepted.',
      artifacts: [],
    },
  }, '2026-07-17T00:00:01.000Z');
  const recovering = await outcomePolicyRepository.get(revisionJob.job.jobId);
  assert.equal(recovering?.status, 'recovering');
  assert.equal(recovering?.lastVerification?.status, 'revision_required');
  assert.equal(recovering?.lastAttemptDelta?.stepId, 'inspect-inputs');
  assert.equal(recovering?.lastAttemptDelta?.stateChanged, false);
  assert.equal(recovering?.noProgressCount, 1);
  assert.ok(recovering?.lastVerification?.findings.some((finding) =>
    finding.includes('Required deliverable result')));

  const revisionClaim = await outcomePolicyRepository.claimDue(
    'worker-verification-revision',
    '2026-07-17T00:00:02.000Z',
    '2026-07-17T00:01:02.000Z',
  );
  assert.ok(revisionClaim);
  assert.equal(revisionClaim.job.status, 'running');
  await outcomePolicyRepository.completeStep(revisionClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        revisionJob.job.jobId,
        'legacy-step-1',
        'verified.json',
        outcomePolicyArtifacts,
      ),
      finalMessage: 'Verified completion.',
      artifacts: ['verified.json'],
    },
  }, '2026-07-17T00:00:03.000Z');
  const revised = await outcomePolicyRepository.get(revisionJob.job.jobId);
  assert.equal(revised?.status, 'completed');
  assert.equal(revised?.attemptCount, 2);
  assert.equal(revised?.lastVerification?.status, 'accepted');
  const revisionDelivery = await outcomePolicyRepository.claimPendingDelivery(
    'delivery-verification-revision',
    '2026-07-17T00:00:03.500Z',
  );
  assert.equal(revisionDelivery?.kind, 'terminal');
  await outcomePolicyRepository.markDeliveryResult(
    revisionDelivery!,
    { status: 'delivered', messageId: 'om_verification_revision' },
    '2026-07-17T00:00:03.600Z',
  );

  const checksumJob = await outcomePolicyRepository.create(createRequest('checksum-revision'));
  const checksumClaim = await outcomePolicyRepository.claimDue(
    'worker-checksum-revision',
    '2026-07-17T00:00:03.700Z',
    '2026-07-17T00:01:03.700Z',
  );
  assert.equal(checksumClaim?.job.jobId, checksumJob.job.jobId);
  const checksumCheckpoint = await completedCheckpoint(
    checksumJob.job.jobId,
    'produce-result',
    'checksum.json',
    outcomePolicyArtifacts,
  );
  checksumCheckpoint.artifacts[0].sha256 = '0'.repeat(64);
  await outcomePolicyRepository.completeStep(checksumClaim!, {
    outcome: {
      outcome: 'completed',
      checkpoint: checksumCheckpoint,
      finalMessage: 'A mismatched checksum must not complete.',
      artifacts: ['checksum.json'],
    },
  }, '2026-07-17T00:00:03.800Z');
  const checksumRevision = await outcomePolicyRepository.get(checksumJob.job.jobId);
  assert.equal(checksumRevision?.status, 'recovering');
  assert.ok(checksumRevision?.lastVerification?.findings.some((finding) =>
    finding.includes('checksum does not match')));
  assert.equal(await outcomePolicyRepository.requestCancel(
    checksumJob.job.jobId,
    '2026-07-17T00:00:03.900Z',
  ), 'cancelled');
  const checksumTerminal = await outcomePolicyRepository.claimPendingDelivery(
    'delivery-checksum-revision',
    '2026-07-17T00:00:03.950Z',
  );
  assert.equal(checksumTerminal?.kind, 'terminal');
  await outcomePolicyRepository.markDeliveryResult(
    checksumTerminal!,
    { status: 'delivered', messageId: 'om_checksum_revision' },
    '2026-07-17T00:00:03.960Z',
  );

  const stalledJob = await outcomePolicyRepository.create(createRequest('no-progress-stall'));
  const firstStallClaim = await outcomePolicyRepository.claimDue(
    'worker-no-progress',
    '2026-07-17T00:00:04.000Z',
    '2026-07-17T00:01:04.000Z',
  );
  assert.ok(firstStallClaim);
  const stableCheckpoint = progressCheckpoint();
  await outcomePolicyRepository.completeStep(firstStallClaim, {
    outcome: { outcome: 'continue', checkpoint: stableCheckpoint },
  }, '2026-07-17T00:00:05.000Z');
  for (let ordinal = 2; ordinal <= 3; ordinal += 1) {
    const deliverySecond = String(6 + (ordinal - 2) * 3).padStart(2, '0');
    const claimSecond = String(7 + (ordinal - 2) * 3).padStart(2, '0');
    const completeSecond = String(8 + (ordinal - 2) * 3).padStart(2, '0');
    if (ordinal === 2) {
      const delivery = await outcomePolicyRepository.claimPendingDelivery(
        `delivery-no-progress-${ordinal}`,
        `2026-07-17T00:00:${deliverySecond}.000Z`,
      );
      assert.equal(delivery?.kind, 'progress');
      await outcomePolicyRepository.markDeliveryResult(
        delivery!,
        { status: 'delivered', messageId: `om_no_progress_${ordinal}` },
        `2026-07-17T00:00:${deliverySecond}.100Z`,
      );
    }
    const claim = await outcomePolicyRepository.claimDue(
      'worker-no-progress',
      `2026-07-17T00:00:${claimSecond}.000Z`,
      `2026-07-17T00:01:${claimSecond}.000Z`,
    );
    assert.ok(claim);
    await outcomePolicyRepository.completeStep(claim, {
      outcome: {
        outcome: 'continue',
        checkpoint: progressCheckpoint({
          currentStepId: 'produce-result',
          completedStepIds: stableCheckpoint.completedStepIds,
        }),
      },
    }, `2026-07-17T00:00:${completeSecond}.000Z`);
  }
  const stalledResult = await outcomePolicyRepository.get(stalledJob.job.jobId);
  assert.equal(stalledResult?.status, 'failed');
  assert.equal(stalledResult?.errorCode, 'continuation_stalled');
  assert.equal(stalledResult?.attemptCount, 3);
  assert.equal(stalledResult?.noProgressCount, 2);
} finally {
  outcomePolicyRepository.close();
}

const deliveryRaceRepository = await SqliteContinuationRepository.open({
  databasePath: join(root, 'delivery-race', 'jobs.sqlite'),
  artifactsDir: join(root, 'delivery-race', 'artifacts'),
  jitter: () => 0,
});
try {
  const raceJob = await deliveryRaceRepository.create(createRequest('delivery-race'));
  const raceClaim = await deliveryRaceRepository.claimDue(
    'worker-delivery-race',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(raceClaim);
  await deliveryRaceRepository.completeStep(raceClaim, {
    outcome: {
      outcome: 'continue',
      checkpoint: progressCheckpoint({
        summary: 'A progress delivery is in flight.',
        constraints: [],
        decisions: [],
      }),
    },
  }, '2026-07-17T00:00:01.000Z');
  const inFlightProgress = await deliveryRaceRepository.claimPendingDelivery(
    'delivery-race-worker',
    '2026-07-17T00:00:02.000Z',
  );
  assert.equal(inFlightProgress?.kind, 'progress');
  assert.equal(await deliveryRaceRepository.requestCancel(
    raceJob.job.jobId,
    '2026-07-17T00:00:03.000Z',
  ), 'cancelled');
  await deliveryRaceRepository.markDeliveryResult(inFlightProgress!, {
    status: 'retry',
    errorCode: 'lark_pre_send_unavailable',
    errorSummary: 'The request was not sent.',
  }, '2026-07-17T00:00:04.000Z');
  const raceResult = await deliveryRaceRepository.get(raceJob.job.jobId);
  assert.deepEqual(raceResult?.deliveryEvents?.map((event) => ({
    kind: event.kind,
    status: event.status,
  })), [
    { kind: 'terminal', status: 'pending' },
    { kind: 'progress', status: 'superseded' },
  ]);
  assert.equal((await deliveryRaceRepository.claimPendingDelivery(
    'delivery-race-terminal',
    '2026-07-17T00:00:05.000Z',
  ))?.kind, 'terminal');
} finally {
  deliveryRaceRepository.close();
}

const retentionDatabasePath = join(root, 'retention', 'jobs.sqlite');
const retentionArtifactsDir = join(root, 'retention', 'artifacts');
class FailingDiscardArtifactStore extends ContinuationArtifactStore {
  failDiscard = false;

  override async discardQuarantine(jobId: string, token: string): Promise<void> {
    if (this.failDiscard) throw new Error('simulated artifact quarantine cleanup failure');
    await super.discardQuarantine(jobId, token);
  }
}
class FailingDiscardInputStore extends ContinuationInputStore {
  failDiscard = false;

  override async discardQuarantine(jobId: string, token: string): Promise<void> {
    if (this.failDiscard) throw new Error('simulated input quarantine cleanup failure');
    await super.discardQuarantine(jobId, token);
  }
}
const retentionArtifacts = new FailingDiscardArtifactStore(retentionArtifactsDir);
const retentionInputsDir = join(root, 'retention', 'inputs');
const retentionInputs = new FailingDiscardInputStore(retentionInputsDir);
const retentionRepository = await SqliteContinuationRepository.open({
  databasePath: retentionDatabasePath,
  artifactsDir: retentionArtifactsDir,
  artifactStore: retentionArtifacts,
  inputsDir: retentionInputsDir,
  inputStore: retentionInputs,
  jitter: () => 0,
});
try {
  const cleanupJob = await retentionRepository.create(createRequest('retention-cleanup'));
  const cleanupClaim = await retentionRepository.claimDue(
    'worker-retention-cleanup',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(cleanupClaim);
  const cleanupToolCall = await retentionRepository.beginToolCall(
    cleanupClaim,
    { tool: 'lark_cli', args: ['doc', 'get'] },
    '2026-07-17T00:00:01.000Z',
  );
  assert.equal(cleanupToolCall.status, 'execute');
  await retentionRepository.completeToolCall(
    cleanupClaim,
    cleanupToolCall.callId,
    { ok: true, message: 'done' },
    '2026-07-17T00:00:02.000Z',
  );
  await retentionRepository.completeStep(cleanupClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        cleanupJob.job.jobId,
        'produce-result',
        'report.txt',
        retentionArtifacts,
      ),
      finalMessage: 'Done.',
      artifacts: ['report.txt'],
    },
  }, '2026-07-17T00:00:03.000Z');
  const cleanupDelivery = await retentionRepository.claimPendingDelivery(
    'delivery-retention-cleanup',
    '2026-07-17T00:00:04.000Z',
  );
  assert.equal(cleanupDelivery?.jobId, cleanupJob.job.jobId);
  await retentionRepository.markDeliveryResult(
    cleanupDelivery!,
    { status: 'delivered', messageId: 'om_retention_cleanup' },
    '2026-07-17T00:00:05.000Z',
  );
  const cleanupArtifactRoot = await retentionArtifacts.ensure(cleanupJob.job.jobId);

  const retainedJob = await retentionRepository.create(createRequest('retention-retained'));
  const retainedClaim = await retentionRepository.claimDue(
    'worker-retention-retained',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(retainedClaim);
  await retentionRepository.completeStep(retainedClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        retainedJob.job.jobId,
        'produce-result',
        'retained.txt',
        retentionArtifacts,
      ),
      finalMessage: 'Retained.',
      artifacts: ['retained.txt'],
    },
  }, '2026-07-17T00:00:06.000Z');
  const retainedDelivery = await retentionRepository.claimPendingDelivery(
    'delivery-retention-retained',
    '2026-07-17T00:00:07.000Z',
  );
  await retentionRepository.markDeliveryResult(
    retainedDelivery!,
    { status: 'delivered', messageId: 'om_retention_retained' },
    '2026-07-17T00:00:08.000Z',
  );
  assert.equal(await retentionRepository.setRetained(
    retainedJob.job.jobId,
    true,
    '2026-07-17T00:00:09.000Z',
  ), true);
  assert.equal((await retentionRepository.get(retainedJob.job.jobId))?.retained, true);

  const undeliveredJob = await retentionRepository.create(createRequest('retention-undelivered'));
  const undeliveredClaim = await retentionRepository.claimDue(
    'worker-retention-undelivered',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(undeliveredClaim);
  await retentionRepository.completeStep(undeliveredClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        undeliveredJob.job.jobId,
        'produce-result',
        'undelivered.txt',
        retentionArtifacts,
      ),
      finalMessage: 'Not delivered.',
      artifacts: ['undelivered.txt'],
    },
  }, '2026-07-17T00:00:10.000Z');
  const nonterminalJob = await retentionRepository.create(createRequest('retention-nonterminal'));

  const cleanupResults = await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:00.000Z',
  );
  assert.equal(cleanupResults.length, 1);
  assert.deepEqual({ ...cleanupResults[0], completedAt: undefined }, {
    jobId: cleanupJob.job.jobId,
    creatorOpenId: 'ou_creator',
    status: 'completed',
    completedAt: undefined,
    result: 'cleaned',
  });
  assert.ok(
    Date.parse(cleanupResults[0]!.completedAt) >= Date.parse('2026-07-17T00:00:03.000Z'),
  );
  assert.equal((await retentionRepository.get(cleanupJob.job.jobId))?.deletedAt,
    '2026-07-20T00:00:00.000Z');
  assert.equal((await retentionRepository.get(retainedJob.job.jobId))?.deletedAt, undefined);
  assert.equal((await retentionRepository.get(undeliveredJob.job.jobId))?.deletedAt, undefined);
  assert.equal((await retentionRepository.get(nonterminalJob.job.jobId))?.deletedAt, undefined);
  await assert.rejects(stat(cleanupArtifactRoot), /ENOENT/);

  const retentionDatabase = new DatabaseSync(retentionDatabasePath);
  assert.equal(Number(retentionDatabase.prepare(
    'SELECT COUNT(*) AS count FROM continuation_attempts WHERE job_id = ?',
  ).get(cleanupJob.job.jobId)?.count), 0);
  assert.equal(Number(retentionDatabase.prepare(
    'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
  ).get(cleanupJob.job.jobId)?.count), 0);
  assert.equal(Number(retentionDatabase.prepare(
    "SELECT COUNT(*) AS count FROM continuation_outbox WHERE job_id = ? AND kind = 'progress'",
  ).get(cleanupJob.job.jobId)?.count), 0);
  assert.equal(retentionDatabase.prepare(
    "SELECT payload FROM continuation_outbox WHERE job_id = ? AND kind = 'terminal'",
  ).get(cleanupJob.job.jobId)?.payload, '');
  retentionDatabase.close();

  const heldUndeliveredDelivery = await retentionRepository.claimPendingDelivery(
    'delivery-retention-held',
    '2026-07-17T00:00:10.500Z',
  );
  assert.equal(heldUndeliveredDelivery?.jobId, undeliveredJob.job.jobId);

  const failedCleanupJob = await retentionRepository.create(createRequest(
    'retention-cleanup-retry',
    {
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-21T00:00:00.000Z',
    },
  ));
  const failedCleanupClaim = await retentionRepository.claimDue(
    'worker-retention-cleanup-retry',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.equal(failedCleanupClaim?.job.jobId, failedCleanupJob.job.jobId);
  await retentionRepository.completeStep(failedCleanupClaim!, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        failedCleanupJob.job.jobId,
        'produce-result',
        'retry.txt',
        retentionArtifacts,
      ),
      finalMessage: 'Retry cleanup.',
      artifacts: ['retry.txt'],
    },
  }, '2026-07-17T00:00:11.000Z');
  const failedCleanupDelivery = await retentionRepository.claimPendingDelivery(
    'delivery-retention-cleanup-retry',
    '2026-07-17T00:00:12.000Z',
  );
  assert.equal(failedCleanupDelivery?.jobId, failedCleanupJob.job.jobId);
  await retentionRepository.markDeliveryResult(
    failedCleanupDelivery!,
    { status: 'delivered', messageId: 'om_retention_cleanup_retry' },
    '2026-07-17T00:00:13.000Z',
  );
  const failedCleanupArtifactRoot = await retentionArtifacts.ensure(failedCleanupJob.job.jobId);
  retentionArtifacts.failDiscard = true;
  retentionInputs.failDiscard = true;
  const failedCleanupResults = await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:00.000Z',
  );
  retentionArtifacts.failDiscard = false;
  retentionInputs.failDiscard = false;
  assert.equal(failedCleanupResults.length, 1);
  assert.equal(failedCleanupResults[0]?.jobId, failedCleanupJob.job.jobId);
  assert.equal(failedCleanupResults[0]?.result, 'error');
  assert.equal(
    (await retentionRepository.get(failedCleanupJob.job.jobId))?.deletedAt,
    '2026-07-20T00:00:00.000Z',
  );
  await assert.rejects(stat(failedCleanupArtifactRoot), /ENOENT/);
  assert.equal((await readdir(retentionArtifactsDir)).some(
    (entry) => entry.startsWith(`.redacting-${failedCleanupJob.job.jobId}-`),
  ), true);
  assert.equal((await readdir(retentionInputsDir)).some(
    (entry) => entry.startsWith(`.redacting-${failedCleanupJob.job.jobId}-`),
  ), true);
  assert.deepEqual(await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:01.000Z',
  ), []);
  assert.equal((await readdir(retentionArtifactsDir)).some(
    (entry) => entry.startsWith(`.redacting-${failedCleanupJob.job.jobId}-`),
  ), false);
  assert.equal((await readdir(retentionInputsDir)).some(
    (entry) => entry.startsWith(`.redacting-${failedCleanupJob.job.jobId}-`),
  ), false);

  assert.equal(await retentionRepository.setRetained(
    retainedJob.job.jobId,
    false,
    '2026-07-20T00:00:01.000Z',
  ), true);
  await assert.rejects(
    retentionRepository.markDeliveryResult(
      heldUndeliveredDelivery!,
      { status: 'delivered', messageId: 'om_retention_undelivered' },
      '2026-07-20T00:00:02.000Z',
    ),
    /stale continuation delivery claim/i,
  );
  const reclaimedUndeliveredDelivery = await retentionRepository.claimPendingDelivery(
    'delivery-retention-reclaimed',
    '2026-07-20T00:00:02.000Z',
  );
  assert.equal(reclaimedUndeliveredDelivery?.outboxId, heldUndeliveredDelivery?.outboxId);
  await retentionRepository.markDeliveryResult(
    reclaimedUndeliveredDelivery!,
    { status: 'delivered', messageId: 'om_retention_undelivered' },
    '2026-07-20T00:00:02.001Z',
  );
  assert.equal((await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:03.000Z',
  )).length, 2);
  assert.deepEqual(await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:04.000Z',
  ), []);
} finally {
  retentionRepository.close();
}

const versionThreeDatabasePath = join(root, 'migration-v3', 'jobs.sqlite');
const versionThreeArtifactsDir = join(root, 'migration-v3', 'artifacts');
await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'migration-v3'), { recursive: true }));
const versionThreeDatabase = new DatabaseSync(versionThreeDatabasePath);
const legacyV3RequestHash = createHash('sha256')
  .update(JSON.stringify({ tool: 'lark_cli', args: [] }))
  .digest('hex');
versionThreeDatabase.exec(`
  CREATE TABLE continuation_jobs (
    job_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    retry_of_job_id TEXT,
    creator_open_id TEXT NOT NULL,
    origin_kind TEXT NOT NULL,
    route_json TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_thread_id TEXT,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL,
    context_snapshot_json TEXT NOT NULL,
    required_tools_json TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    model TEXT,
    parent_session_id TEXT,
    max_steps INTEGER NOT NULL,
    max_retries INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    row_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    execution_session_id TEXT,
    checkpoint_json TEXT,
    step_count INTEGER NOT NULL,
    failure_count INTEGER NOT NULL,
    next_run_at TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    result_summary TEXT,
    result_artifacts_json TEXT NOT NULL,
    error_code TEXT,
    error_summary TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  ) STRICT;
  CREATE TABLE continuation_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
    ordinal INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    execution_session_id TEXT,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    error_code TEXT,
    error_summary TEXT,
    UNIQUE(job_id, ordinal)
  ) STRICT;
  CREATE TABLE continuation_outbox (
    outbox_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES continuation_jobs(job_id),
    route_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    next_attempt_at TEXT NOT NULL,
    worker_id TEXT,
    lease_expires_at TEXT,
    first_attempt_at TEXT,
    last_attempt_at TEXT,
    message_id TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE continuation_tool_calls (
    call_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
    step_index INTEGER NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES continuation_attempts(attempt_id),
    tool_name TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id, step_index)
  ) STRICT;
  INSERT INTO continuation_jobs (
    job_id, idempotency_key, creator_open_id, origin_kind, route_json,
    source_message_id, title, objective, acceptance_criteria_json,
    context_snapshot_json, required_tools_json, working_directory,
    permissions_json, max_steps, max_retries, timeout_seconds, created_at,
    expires_at, row_version, status, step_count, failure_count, next_run_at,
    result_artifacts_json, updated_at
  ) VALUES (
    'job_legacy_v3', 'idem-legacy-v3', 'ou_creator', 'message_thread',
    '{"kind":"message_thread","conversationId":"oc_legacy","sourceMessageId":"om_legacy"}',
    'om_legacy', 'Legacy v3', 'Migrate this job', '[]',
    '{"summary":"","completedSteps":[],"remainingSteps":[],"constraints":[],"decisions":[],"references":[]}',
    '[]', '${root.replaceAll("'", "''")}',
    '{"profile":"bounded","filesystem":{"root":"${root.replaceAll("'", "''")}","mode":"workspace-write","requestedPaths":[]},"hostTools":[],"network":"none","externalSideEffects":"denied","approval":{"mode":"never"}}',
    24, 3, 600, '${baseNow}', '2026-07-18T00:00:00.000Z', 1, 'queued',
    0, 0, '${baseNow}', '[]', '${baseNow}'
  );
  INSERT INTO continuation_attempts (
    attempt_id, job_id, ordinal, worker_id, started_at, heartbeat_at,
    finished_at, outcome
  ) VALUES (
    'attempt_legacy_v3', 'job_legacy_v3', 1, 'worker_legacy', '${baseNow}',
    '${baseNow}', '${baseNow}', 'continue'
  );
  INSERT INTO continuation_tool_calls (
    call_id, job_id, step_index, attempt_id, tool_name, request_hash,
    status, result_json, started_at, completed_at, updated_at
  ) VALUES (
    'call_legacy_v3', 'job_legacy_v3', 0, 'attempt_legacy_v3', 'lark_cli',
    '${legacyV3RequestHash}', 'completed', '{"ok":true,"message":"legacy"}',
    '${baseNow}', '${baseNow}', '${baseNow}'
  );
  INSERT INTO continuation_outbox (
    outbox_id, job_id, route_json, idempotency_key, payload, status,
    attempt_count, next_attempt_at, created_at, updated_at
  ) VALUES (
    'outbox_legacy_v3', 'job_legacy_v3',
    '{"kind":"message_thread","conversationId":"oc_legacy","sourceMessageId":"om_legacy"}',
    'continuation:job_legacy_v3:terminal', 'legacy terminal payload', 'pending',
    0, '${baseNow}', '${baseNow}', '${baseNow}'
  );
  PRAGMA user_version = 3;
`);
versionThreeDatabase.close();

const runningReceiptV3Root = join(root, 'migration-v3-running-receipt');
const runningReceiptV3Path = join(runningReceiptV3Root, 'jobs.sqlite');
await mkdir(runningReceiptV3Root, { recursive: true });
await copyFile(versionThreeDatabasePath, runningReceiptV3Path);
const runningReceiptV3Database = new DatabaseSync(runningReceiptV3Path);
runningReceiptV3Database.prepare(`
  UPDATE continuation_tool_calls
  SET status = 'running', result_json = NULL, completed_at = NULL
  WHERE call_id = 'call_legacy_v3'
`).run();
runningReceiptV3Database.close();
const runningReceiptV3Repository = await SqliteContinuationRepository.open({
  databasePath: runningReceiptV3Path,
  artifactsDir: join(runningReceiptV3Root, 'artifacts'),
});
try {
  const claim = await runningReceiptV3Repository.claimDue(
    'worker-legacy-v3-running-receipt',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.equal(claim?.job.jobId, 'job_legacy_v3');
  assert.deepEqual(await runningReceiptV3Repository.beginToolCall(
    claim!,
    { tool: 'lark_cli', args: [] },
    baseNow,
  ), { status: 'unknown', callId: 'call_legacy_v3' });
} finally {
  runningReceiptV3Repository.close();
}

// Historical schema upgrades remain process-safe when two plugin instances start together.
for (let index = 0; index < 4; index += 1) {
  const concurrentMigrationRoot = join(root, `migration-concurrent-v3-${index}`);
  const concurrentMigrationDatabasePath = join(concurrentMigrationRoot, 'jobs.sqlite');
  await mkdir(concurrentMigrationRoot, { recursive: true });
  await copyFile(versionThreeDatabasePath, concurrentMigrationDatabasePath);
  const concurrentMigrationOptions = {
    databasePath: concurrentMigrationDatabasePath,
    artifactsDir: join(concurrentMigrationRoot, 'artifacts'),
  };
  const [migrationA, migrationB] = await Promise.all([
    SqliteContinuationRepository.open(concurrentMigrationOptions),
    SqliteContinuationRepository.open(concurrentMigrationOptions),
  ]);
  assert.equal((await migrationA.get('job_legacy_v3'))?.status, 'queued');
  assert.equal((await migrationB.get('job_legacy_v3'))?.status, 'queued');
  migrationA.close();
  migrationB.close();
}

// Preserve a byte-for-byte v3 database before migrating it, then remove the v3-only
// permissions column to exercise the independently deployable v2 -> v7 chain.
const authenticVersionTwoRoot = join(root, 'migration-authentic-v2');
const authenticVersionTwoDatabasePath = join(authenticVersionTwoRoot, 'jobs.sqlite');
const authenticVersionTwoArtifactsDir = join(authenticVersionTwoRoot, 'artifacts');
await mkdir(authenticVersionTwoRoot, { recursive: true });
await copyFile(versionThreeDatabasePath, authenticVersionTwoDatabasePath);
const authenticVersionTwoDatabase = new DatabaseSync(authenticVersionTwoDatabasePath);
authenticVersionTwoDatabase.exec(`
  ALTER TABLE continuation_jobs DROP COLUMN permissions_json;
  PRAGMA user_version = 2;
`);
authenticVersionTwoDatabase.close();

const authenticVersionTwoRepository = await SqliteContinuationRepository.open({
  databasePath: authenticVersionTwoDatabasePath,
  artifactsDir: authenticVersionTwoArtifactsDir,
});
try {
  const migrated = await authenticVersionTwoRepository.get('job_legacy_v3');
  assert.equal(migrated?.maxAttempts, 5);
  assert.equal(migrated?.attemptCount, 1);
  assert.equal(migrated?.deliveryEvents?.[0]?.kind, 'terminal');
  assert.equal(migrated?.permissions.filesystem.root, root);
  const claim = await authenticVersionTwoRepository.claimDue(
    'worker-legacy-v2-receipt',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.equal(claim?.job.jobId, 'job_legacy_v3');
  assert.deepEqual(await authenticVersionTwoRepository.beginToolCall(
    claim!,
    { tool: 'lark_cli', args: [] },
    baseNow,
  ), {
    status: 'replay',
    callId: 'call_legacy_v3',
    result: { ok: true, message: 'legacy' },
  });
} finally {
  authenticVersionTwoRepository.close();
}
const authenticVersionTwoMigratedDatabase = new DatabaseSync(authenticVersionTwoDatabasePath);
assert.equal(Number(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_attempts WHERE job_id = ?',
).get('job_legacy_v3')?.count), 2);
assert.equal(Number(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
assert.equal(String(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT step_id FROM continuation_tool_calls WHERE job_id = ?',
).get('job_legacy_v3')?.step_id), 'initial-step');
assert.equal(Number(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_outbox WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
assert.equal(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT payload FROM continuation_outbox WHERE job_id = ?',
).get('job_legacy_v3')?.payload, 'legacy terminal payload');
assert.deepEqual(authenticVersionTwoMigratedDatabase.prepare('PRAGMA foreign_key_check').all(), []);
authenticVersionTwoMigratedDatabase.close();

const migratedVersionThreeRepository = await SqliteContinuationRepository.open({
  databasePath: versionThreeDatabasePath,
  artifactsDir: versionThreeArtifactsDir,
});
try {
  const migrated = await migratedVersionThreeRepository.get('job_legacy_v3');
  assert.equal(migrated?.maxAttempts, 5);
  assert.equal(migrated?.status, 'queued');
  assert.equal(migrated?.retained, false);
  assert.equal(migrated?.attemptCount, 1);
  assert.equal(migrated?.deliveryEvents?.[0]?.kind, 'terminal');
} finally {
  migratedVersionThreeRepository.close();
}
const migratedVersionThreeDatabase = new DatabaseSync(versionThreeDatabasePath);
const migratedVersionThreeColumns = migratedVersionThreeDatabase
  .prepare('PRAGMA table_info(continuation_jobs)')
  .all() as Array<{ name: string }>;
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'max_attempts'));
assert.equal(migratedVersionThreeColumns.some((column) => column.name === 'max_steps'), false);
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'retain'));
assert.equal(Number(migratedVersionThreeDatabase.prepare('PRAGMA user_version').get()?.user_version), 10);
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'no_progress_count'));
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'source_facts_json'));
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'task_contract_json'));
const migratedOutboxColumns = migratedVersionThreeDatabase
  .prepare('PRAGMA table_info(continuation_outbox)')
  .all() as Array<{ name: string }>;
assert.ok(migratedOutboxColumns.some((column) => column.name === 'event_key'));
assert.ok(migratedOutboxColumns.some((column) => column.name === 'kind'));
assert.ok(migratedOutboxColumns.some((column) => column.name === 'attempt_id'));
assert.equal(Number(migratedVersionThreeDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_attempts WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
assert.equal(Number(migratedVersionThreeDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
assert.deepEqual(migratedVersionThreeDatabase.prepare('PRAGMA foreign_key_check').all(), []);
migratedVersionThreeDatabase.close();

async function verifyIntermediateMigration(version: 4 | 5): Promise<void> {
  const migrationRoot = join(root, `migration-v${version}`);
  const migrationOptions = {
    databasePath: join(migrationRoot, 'jobs.sqlite'),
    artifactsDir: join(migrationRoot, 'artifacts'),
  };
  // v4/v5 are seeded from the exact historical DDL, not reconstructed by
  // deleting newer columns from a v7 database.
  const fixture = await seedHistoricalContinuationDatabase({
    databasePath: migrationOptions.databasePath,
    now: baseNow,
    version,
    workingDirectory: root,
  });

  const migrated = await SqliteContinuationRepository.open(migrationOptions);
  try {
    const job = await migrated.get(fixture.terminalJobId);
    assert.equal(job?.maxAttempts, 5);
    assert.equal(job?.attemptCount, 1);
    assert.equal(job?.deliveryEvents?.length, fixture.expectedOutboxCount);
    assert.equal(job?.deliveryEvents?.some((event) => event.kind === 'terminal'), true);
    assert.equal(job?.sourceFacts.provenance, 'legacy_unavailable');
    const delivery = await migrated.claimPendingDelivery(
      `delivery-v${version}`,
      '2026-07-17T00:00:04.000Z',
    );
    assert.equal(delivery?.jobId, fixture.terminalJobId);
    assert.match(delivery?.payload ?? '', new RegExp(`v${version} terminal payload$`));
  } finally {
    migrated.close();
  }
  const migratedDatabase = new DatabaseSync(migrationOptions.databasePath);
  assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get()?.user_version), 10);
  assert.equal(Number(migratedDatabase.prepare(
    'SELECT COUNT(*) AS count FROM continuation_attempts WHERE job_id = ?',
  ).get(fixture.terminalJobId)?.count), fixture.expectedAttemptCount);
  assert.equal(Number(migratedDatabase.prepare(
    'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
  ).get(fixture.terminalJobId)?.count), 1);
  assert.equal(Number(migratedDatabase.prepare(
    'SELECT COUNT(*) AS count FROM continuation_outbox WHERE job_id = ?',
  ).get(fixture.terminalJobId)?.count), fixture.expectedOutboxCount);
  assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), []);
  migratedDatabase.close();
}

await verifyIntermediateMigration(4);
await verifyIntermediateMigration(5);

async function verifyConcurrentHistoricalMigration(version: 1 | 4 | 5): Promise<void> {
  const migrationRoot = join(root, `migration-concurrent-v${version}`);
  const databasePath = join(migrationRoot, 'jobs.sqlite');
  const artifactsDir = join(migrationRoot, 'artifacts');
  const inputsDir = join(migrationRoot, 'inputs');
  const fixture = await seedHistoricalContinuationDatabase({
    databasePath,
    now: baseNow,
    version,
    workingDirectory: root,
  });
  const openChild = () => spawn(process.execPath, [
    '--import',
    'tsx',
    new URL(import.meta.url).pathname,
    '--open-continuation-repository',
    databasePath,
    artifactsDir,
    inputsDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const first = openChild();
  const second = openChild();
  await Promise.all([
    waitForChildMarker(first, 'REPOSITORY_OPENED', 5_000),
    waitForChildMarker(second, 'REPOSITORY_OPENED', 5_000),
  ]);
  const repository = await SqliteContinuationRepository.open({ databasePath, artifactsDir, inputsDir });
  try {
    await repository.healthCheck();
    assert.equal((await repository.get(fixture.terminalJobId))?.jobId, fixture.terminalJobId);
  } finally {
    repository.close();
  }
  const database = new DatabaseSync(databasePath);
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), 10);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
}

await verifyConcurrentHistoricalMigration(1);
await verifyConcurrentHistoricalMigration(4);
await verifyConcurrentHistoricalMigration(5);

const migratedRepository = await SqliteContinuationRepository.open({
  databasePath: migrationDatabasePath,
  artifactsDir: migrationArtifactsDir,
});
try {
  await migratedRepository.healthCheck();
  assert.deepEqual((await migratedRepository.get(legacyV2Fixture.terminalJobId))?.permissions, {
    profile: 'bounded',
    filesystem: { root: legacyWorkingDirectory, mode: 'workspace-write', requestedPaths: [] },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  });
  const migratedJob = await migratedRepository.create(createRequest('migrated', {
    requiredTools: ['lark_cli'],
    permissions: {
      profile: 'bounded',
      filesystem: { root, mode: 'workspace-write', requestedPaths: [] },
      hostTools: ['lark_cli'],
      network: 'none',
      externalSideEffects: 'denied',
      approval: { mode: 'never' },
    },
  }));
  const migratedClaim = await migratedRepository.claimDue(
    'worker-migrated',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.ok(migratedClaim);
  assert.equal(
    (await migratedRepository.beginToolCall(
      migratedClaim,
      { tool: 'lark_cli', args: [] },
      baseNow,
    )).status,
    'execute',
  );
} finally {
  migratedRepository.close();
}

const versionOneDatabasePath = join(root, 'migration-v1', 'jobs.sqlite');
const versionOneArtifactsDir = join(root, 'migration-v1', 'artifacts');
const versionOneFixture = await seedHistoricalContinuationDatabase({
  databasePath: versionOneDatabasePath,
  now: baseNow,
  version: 1,
  workingDirectory: root,
});
const migratedVersionOneRepository = await SqliteContinuationRepository.open({
  databasePath: versionOneDatabasePath,
  artifactsDir: versionOneArtifactsDir,
});
try {
  await migratedVersionOneRepository.healthCheck();
  const migratedV1Due = await migratedVersionOneRepository.get(versionOneFixture.dueJobId!);
  assert.equal(migratedV1Due?.maxAttempts, 5);
  assert.equal(migratedV1Due?.attemptCount, 1);
  assert.deepEqual(migratedV1Due?.permissions, {
    profile: 'bounded',
    filesystem: { root, mode: 'workspace-write', requestedPaths: [] },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  });
  const v1Claim = await migratedVersionOneRepository.claimDue(
    'worker-v1-migrated',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  );
  assert.ok(v1Claim);
  assert.equal(v1Claim.job.jobId, versionOneFixture.dueJobId);
  assert.equal(v1Claim.attempt.ordinal, 2);
  assert.equal(
    (await migratedVersionOneRepository.beginToolCall(
      v1Claim,
      { tool: 'lark_cli', args: [] },
      baseNow,
    )).status,
    'execute',
  );
  const v1Delivery = await migratedVersionOneRepository.claimPendingDelivery(
    'delivery-v1-migrated',
    baseNow,
  );
  assert.equal(v1Delivery?.jobId, versionOneFixture.terminalJobId);
  assert.equal(v1Delivery?.payload, 'legacy v1 terminal payload');
} finally {
  migratedVersionOneRepository.close();
}
const migratedVersionOneDatabase = new DatabaseSync(versionOneDatabasePath);
assert.equal(Number(migratedVersionOneDatabase.prepare('PRAGMA user_version').get()?.user_version), 10);
assert.equal(Number(migratedVersionOneDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_attempts',
).get()?.count), 3);
assert.equal(Number(migratedVersionOneDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
).get(versionOneFixture.dueJobId)?.count), 1);
assert.equal(Number(migratedVersionOneDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_outbox WHERE job_id = ?',
).get(versionOneFixture.terminalJobId)?.count), versionOneFixture.expectedOutboxCount);
assert.deepEqual(migratedVersionOneDatabase.prepare('PRAGMA foreign_key_check').all(), []);
migratedVersionOneDatabase.close();

const versionSixRoot = join(root, 'migration-v6');
const versionSixDatabasePath = join(versionSixRoot, 'jobs.sqlite');
const versionSixArtifactsDir = join(versionSixRoot, 'artifacts');
const versionSixFixture = await seedHistoricalContinuationDatabase({
  databasePath: versionSixDatabasePath,
  now: baseNow,
  version: 6,
  workingDirectory: versionSixRoot,
});
const legacyV6JobId = 'job_legacy_v6_due';
const legacyV6MessageMismatchId = 'job_legacy_v6_message_route_mismatch';
const legacyV6MalformedId = 'job_legacy_v6_malformed';
const legacyV6CommentMismatchId = 'job_legacy_v6_comment_route_mismatch';
const legacyV6CommentRoute = {
  kind: 'comment_thread',
  documentToken: 'doc_legacy_v6_mismatch',
  commentId: 'comment_legacy_v6_expected',
  fileType: 'docx',
};
const versionSixDatabase = new DatabaseSync(versionSixDatabasePath);
cloneHistoricalContinuationJob(versionSixDatabase, versionSixFixture.terminalJobId, {
  job_id: legacyV6JobId,
  idempotency_key: 'idem-legacy-v6-due',
  acceptance_criteria_json: JSON.stringify(['Legacy criterion text.']),
  status: 'queued',
  execution_session_id: null,
  checkpoint_json: null,
  step_count: 0,
  failure_count: 0,
  next_run_at: baseNow,
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
  result_summary: null,
  result_artifacts_json: '[]',
  error_code: null,
  error_summary: null,
  started_at: null,
  completed_at: null,
  deleted_at: null,
});
cloneHistoricalContinuationJob(versionSixDatabase, legacyV6JobId, {
  job_id: legacyV6MessageMismatchId,
  idempotency_key: 'idem-legacy-v6-message-route-mismatch',
  route_json: JSON.stringify({
    kind: 'message_thread',
    conversationId: 'oc_legacy',
    sourceMessageId: 'om_legacy_v5',
    threadId: 'omt_legacy_v6_conflicting_route',
  }),
});
cloneHistoricalContinuationJob(versionSixDatabase, legacyV6JobId, {
  job_id: legacyV6MalformedId,
  idempotency_key: 'idem-legacy-v6-malformed',
  permissions_json: '{malformed-json',
});
cloneHistoricalContinuationJob(versionSixDatabase, legacyV6JobId, {
  job_id: legacyV6CommentMismatchId,
  idempotency_key: 'idem-legacy-v6-comment-route-mismatch',
  origin_kind: 'comment_thread',
  route_json: JSON.stringify(legacyV6CommentRoute),
  source_message_id: 'comment_legacy_v6_source',
  source_thread_id: 'comment_legacy_v6_conflicting_source',
});
versionSixDatabase.prepare(`
  UPDATE continuation_jobs SET route_json = ? WHERE job_id = ?
`).run(JSON.stringify({
  kind: 'message_thread',
  conversationId: 'oc_legacy',
  sourceMessageId: 'om_legacy_v5',
  threadId: 'omt_legacy_v6_conflicting_route',
}), legacyV6MessageMismatchId);
versionSixDatabase.close();
const versionSixInputsDir = join(versionSixRoot, 'inputs');
const concurrentVersionSixOpen = () => spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--open-continuation-repository',
  versionSixDatabasePath,
  versionSixArtifactsDir,
  versionSixInputsDir,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const versionSixOpenA = concurrentVersionSixOpen();
const versionSixOpenB = concurrentVersionSixOpen();
await Promise.all([
  waitForChildMarker(versionSixOpenA, 'REPOSITORY_OPENED', 5_000),
  waitForChildMarker(versionSixOpenB, 'REPOSITORY_OPENED', 5_000),
]);
const migratedVersionSixRepository = await SqliteContinuationRepository.open({
  databasePath: versionSixDatabasePath,
  artifactsDir: versionSixArtifactsDir,
  inputsDir: versionSixInputsDir,
});
try {
  const migratedV6 = await migratedVersionSixRepository.get(legacyV6JobId);
  assert.equal(migratedV6?.sourceFacts.provenance, 'legacy_unavailable');
  assert.equal(migratedV6?.sourceFacts.originalUserText, null);
  assert.deepEqual(migratedV6?.sourceFacts.inputs, []);
  assert.match(migratedV6?.taskContract.acceptanceCriteria[0].id ?? '', /^criterion_1_[a-f0-9]{12}$/);
  assert.equal(migratedV6?.taskContract.acceptanceCriteria[0].description, 'Legacy criterion text.');
  assert.deepEqual(migratedV6?.acceptanceCriteria, ['Legacy criterion text.']);
  for (const corruptLegacyId of [
    legacyV6MessageMismatchId,
    legacyV6CommentMismatchId,
    legacyV6MalformedId,
  ]) {
    const tombstone = await migratedVersionSixRepository.get(corruptLegacyId);
    assert.equal(tombstone?.status, 'failed');
    assert.equal(tombstone?.errorCode, 'continuation_persisted_state_invalid');
    assert.deepEqual(tombstone?.route, {
      kind: 'message_thread',
      conversationId: '',
      sourceMessageId: '',
    });
  }
  assert.ok(await migratedVersionSixRepository.claimDue(
    'worker-v6-migrated',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  ));
} finally {
  migratedVersionSixRepository.close();
}

const interruptedFactsMigrationRoot = join(root, 'migration-v70');
const interruptedFactsMigrationDatabasePath = join(interruptedFactsMigrationRoot, 'jobs.sqlite');
const interruptedFactsMigrationArtifactsDir = join(interruptedFactsMigrationRoot, 'artifacts');
const interruptedFactsMigrationInputsDir = join(interruptedFactsMigrationRoot, 'inputs');
const interruptedFactsFixture = await seedHistoricalContinuationDatabase({
  databasePath: interruptedFactsMigrationDatabasePath,
  now: baseNow,
  version: 7,
  workingDirectory: interruptedFactsMigrationRoot,
});
const interruptedFactsMigrationDatabase = new DatabaseSync(interruptedFactsMigrationDatabasePath);
interruptedFactsMigrationDatabase.prepare(`
  UPDATE continuation_jobs SET source_facts_json = ? WHERE job_id = ?
`).run('{', interruptedFactsFixture.terminalJobId);
interruptedFactsMigrationDatabase.exec('PRAGMA user_version = 70;');
interruptedFactsMigrationDatabase.close();
const resumedFactsMigrationRepository = await SqliteContinuationRepository.open({
  databasePath: interruptedFactsMigrationDatabasePath,
  artifactsDir: interruptedFactsMigrationArtifactsDir,
  inputsDir: interruptedFactsMigrationInputsDir,
});
try {
  const resumedTombstone = await resumedFactsMigrationRepository.get(
    interruptedFactsFixture.terminalJobId,
  );
  assert.equal(resumedTombstone?.errorCode, 'continuation_persisted_state_invalid');
  const resumedFactsMigrationDatabase = new DatabaseSync(interruptedFactsMigrationDatabasePath);
  assert.equal(
    Number(resumedFactsMigrationDatabase.prepare('PRAGMA user_version').get()?.user_version),
    10,
  );
  resumedFactsMigrationDatabase.close();
} finally {
  resumedFactsMigrationRepository.close();
}

// v7 immutable facts and managed inputs are deterministic and survive source deletion.
const managedRoot = await mkdtemp(join(tmpdir(), 'continuation-managed-inputs-'));
const managedDatabasePath = join(managedRoot, 'runtime', 'jobs.sqlite');
const managedArtifactsDir = join(managedRoot, 'runtime', 'artifacts');
const managedInputsDir = join(managedRoot, 'runtime', 'inputs');
const admittedSource = join(managedRoot, 'source-report.txt');
await writeFile(admittedSource, 'managed input contents', 'utf8');
const managedRepository = await SqliteContinuationRepository.open({
  databasePath: managedDatabasePath,
  artifactsDir: managedArtifactsDir,
  inputsDir: managedInputsDir,
  jitter: () => 0,
});
const managedBaseRequest = createRequest('managed-input');
const managedRequest = createRequest('managed-input', {
  idempotencyKey: 'idem-managed-stable',
  sourceFacts: {
    ...managedBaseRequest.sourceFacts,
    sourceTimestamp: '2026-07-18T08:30:00.000Z',
    originalUserText: 'Use github_pat_123456789012345678901234567890 to process the admitted file.',
    quotedMessageText: 'Quoted xapp-123456789012345678901234567890.',
  },
  taskContract: {
    ...managedBaseRequest.taskContract,
    objective: 'Use sk-proj-123456789012345678901234567890 without persisting it.',
    deliverables: [{
      ...managedBaseRequest.taskContract.deliverables[0],
      description: 'Do not expose AWS_SECRET_ACCESS_KEY=managed-db-secret.',
    }],
  },
  sourceInputs: [{
    sourcePath: admittedSource,
    fileName: 'quarterly-github_pat_123456789012345678901234567890.pdf',
    kind: 'message_attachment',
  }],
});
const expectedManagedJobId = continuationJobId(managedRequest.idempotencyKey);
assert.doesNotMatch(expectedManagedJobId, /managed|message|om_/i);
const managedCreated = await managedRepository.create(managedRequest);
assert.equal(managedCreated.job.jobId, expectedManagedJobId);
assert.equal(managedCreated.job.sourceFacts.provenance, 'captured');
assert.equal(managedCreated.job.sourceFacts.inputs.length, 1);
assert.match(managedCreated.job.sourceFacts.inputs[0].sha256, /^[a-f0-9]{64}$/);
assert.equal(managedCreated.job.sourceFacts.inputs[0].fileName, 'input_001.pdf');
assert.equal(managedCreated.job.sourceFacts.inputs[0].relativePath, 'input_001.pdf');
assert.equal('sourcePath' in managedCreated.job.sourceFacts.inputs[0], false);
assert.equal(managedCreated.job.taskContract.acceptanceCriteria[0].id, 'result_persisted');
assert.deepEqual(managedCreated.job.acceptanceCriteria, ['terminal result is persisted']);
assert.doesNotMatch(JSON.stringify(managedCreated.job.sourceFacts), /github_pat_|xapp-/);
assert.doesNotMatch(JSON.stringify(managedCreated.job.taskContract), /sk-proj-|managed-db-secret/);
const managedInputStore = new ContinuationInputStore(managedInputsDir);
const managedPath = managedInputStore.resolve(
  managedCreated.job.jobId,
  managedCreated.job.sourceFacts.inputs[0].relativePath,
);
assert.equal(await readFile(managedPath, 'utf8'), 'managed input contents');
assert.equal(modeBits((await stat(managedPath)).mode), 0o400);
assert.equal(modeBits((await stat(join(managedInputsDir, managedCreated.job.jobId))).mode), 0o500);
await rm(admittedSource);
assert.deepEqual(await managedInputStore.verify(
  managedCreated.job.jobId,
  managedCreated.job.sourceFacts.inputs,
), { ok: true });

const sameWrite = await managedRepository.create({
  ...managedRequest,
  title: 'Conflicting later title',
  taskContract: { ...managedRequest.taskContract, title: 'Conflicting later title' },
  sourceInputs: [{
    sourcePath: join(managedRoot, 'missing-later-source'),
    fileName: 'different.txt',
    kind: 'message_attachment',
  }],
});
assert.equal(sameWrite.created, false);
assert.equal(sameWrite.job.jobId, managedCreated.job.jobId);
assert.equal(sameWrite.job.title, managedCreated.job.title, 'same idempotency key is first-write-wins');
managedRepository.close();

const existingRowDelegate = new ContinuationInputStore(managedInputsDir);
let existingRowLockCalls = 0;
const existingRowRepository = await SqliteContinuationRepository.open({
  databasePath: managedDatabasePath,
  artifactsDir: managedArtifactsDir,
  inputsDir: managedInputsDir,
  inputStore: {
    ensureRoot: () => existingRowDelegate.ensureRoot(),
    async withCreationLock() {
      existingRowLockCalls += 1;
      throw new Error('existing same-key row must bypass the filesystem lock');
    },
    install: (...args: Parameters<ContinuationInputStore['install']>) => existingRowDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) => existingRowDelegate.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) => existingRowDelegate.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) => existingRowDelegate.resolve(...args),
    remove: (...args: Parameters<ContinuationInputStore['remove']>) => existingRowDelegate.remove(...args),
    quarantine: (...args: Parameters<ContinuationInputStore['quarantine']>) =>
      existingRowDelegate.quarantine(...args),
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      existingRowDelegate.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      existingRowDelegate.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      existingRowDelegate.cleanupOrphans(...args),
  },
});
const existingWithoutLock = await existingRowRepository.create(managedRequest);
assert.equal(existingWithoutLock.created, false);
assert.equal(existingWithoutLock.job.jobId, expectedManagedJobId);
assert.equal(existingRowLockCalls, 0);
existingRowRepository.close();

const reopenedManagedRepository = await SqliteContinuationRepository.open({
  databasePath: managedDatabasePath,
  artifactsDir: managedArtifactsDir,
  inputsDir: managedInputsDir,
  jitter: () => 0,
});
const reopenedManagedJob = await reopenedManagedRepository.get(expectedManagedJobId);
assert.equal(reopenedManagedJob?.jobId, expectedManagedJobId);
assert.equal(reopenedManagedJob?.sourceFacts.sourceTimestamp, '2026-07-18T08:30:00.000Z');
const managedDatabase = new DatabaseSync(managedDatabasePath);
const managedRaw = managedDatabase.prepare(`
  SELECT source_facts_json, task_contract_json FROM continuation_jobs WHERE job_id = ?
`).get(expectedManagedJobId) as { source_facts_json: string; task_contract_json: string };
assert.doesNotMatch(managedRaw.source_facts_json, new RegExp(managedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.doesNotMatch(managedRaw.source_facts_json, /github_pat_|xapp-|quarterly-|super-secret|source-report/);
assert.doesNotMatch(
  managedRaw.task_contract_json,
  /github_pat_|xapp-|sk-proj-|managed-db-secret|quarterly-|super-secret|source-report/,
);
const managedManifest = await readFile(join(
  managedInputsDir,
  expectedManagedJobId,
  '.manifest.json',
), 'utf8');
assert.doesNotMatch(managedManifest, /github_pat_|quarterly-|source-report/);
assert.match(managedManifest, /input_001\.pdf/);
managedDatabase.prepare(`
  UPDATE durable_runs
  SET state_json = json_set(state_json, '$.job.sourceFacts', ?)
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run('{not-json', expectedManagedJobId);
const invalidJsonTombstone = await reopenedManagedRepository.get(expectedManagedJobId);
assert.equal(invalidJsonTombstone?.status, 'failed');
assert.equal(invalidJsonTombstone?.errorCode, 'continuation_persisted_state_invalid');

const invalidContractJob = await reopenedManagedRepository.create(createRequest(
  'invalid-persisted-contract',
));
managedDatabase.prepare(`
  UPDATE durable_runs
  SET input_json = json_set(input_json, '$.job.taskContract', json('{}')),
      state_json = json_set(state_json, '$.job.taskContract', json('{}'))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(invalidContractJob.job.jobId);
assert.equal(
  (await reopenedManagedRepository.get(invalidContractJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);

const unknownFactsJob = await reopenedManagedRepository.create(createRequest(
  'unknown-persisted-facts-field',
));
const unknownFactsRaw = managedDatabase.prepare(`
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
`).get(unknownFactsJob.job.jobId) as { source_facts_json: string };
const managedFactsWithUnknownField = {
  ...JSON.parse(unknownFactsRaw.source_facts_json) as Record<string, unknown>,
  unexpected: 'must not reach the runner prompt',
};
managedDatabase.prepare(`
  UPDATE durable_runs
  SET input_json = json_set(input_json, '$.job.sourceFacts', json(?)),
      state_json = json_set(state_json, '$.job.sourceFacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(
  JSON.stringify(managedFactsWithUnknownField),
  JSON.stringify(managedFactsWithUnknownField),
  unknownFactsJob.job.jobId,
);
assert.equal(
  (await reopenedManagedRepository.get(unknownFactsJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
const requestWithUnknownPermission = createRequest('unknown-permission-field');
(requestWithUnknownPermission.permissions as unknown as Record<string, unknown>).unexpected = true;
await assert.rejects(
  reopenedManagedRepository.create(requestWithUnknownPermission),
  /permission envelope is invalid/i,
);
const requestWithoutEvidenceContract = createRequest('missing-evidence-contract');
requestWithoutEvidenceContract.taskContract = {
  ...requestWithoutEvidenceContract.taskContract,
  deliverables: [],
  acceptanceCriteria: [],
  verificationRequirements: [],
};
await assert.rejects(
  reopenedManagedRepository.create(requestWithoutEvidenceContract),
  /contract requirements must not be empty/i,
);
managedDatabase.close();
reopenedManagedRepository.close();

// A failed redaction CAS must not strand a still-visible Job without its managed inputs.
const redactionRollbackRoot = await mkdtemp(join(tmpdir(), 'continuation-redaction-rollback-'));
const redactionRollbackOptions = {
  databasePath: join(redactionRollbackRoot, 'jobs.sqlite'),
  artifactsDir: join(redactionRollbackRoot, 'artifacts'),
  inputsDir: join(redactionRollbackRoot, 'inputs'),
};
const redactionRollbackSource = join(redactionRollbackRoot, 'source.txt');
await writeFile(redactionRollbackSource, 'restore me after failed redaction', 'utf8');
const redactionRollbackSeed = await SqliteContinuationRepository.open(redactionRollbackOptions);
const redactionRollbackCreated = await redactionRollbackSeed.create(createRequest('redaction-rollback', {
  sourceInputs: [{
    sourcePath: redactionRollbackSource,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }],
}));
const redactionRollbackArtifacts = new ContinuationArtifactStore(redactionRollbackOptions.artifactsDir);
const redactionRollbackArtifactRoot = await redactionRollbackArtifacts.ensure(
  redactionRollbackCreated.job.jobId,
);
await writeFile(join(redactionRollbackArtifactRoot, 'result.txt'), 'restore artifact after rollback', 'utf8');
assert.equal(await redactionRollbackSeed.requestCancel(
  redactionRollbackCreated.job.jobId,
  '2026-07-17T00:00:01.000Z',
), 'cancelled');
redactionRollbackSeed.close();

const redactionRollbackDelegate = new ContinuationInputStore(redactionRollbackOptions.inputsDir);
let redactionRaceInjected = false;
const injectRedactionRace = (): void => {
  if (redactionRaceInjected) return;
  redactionRaceInjected = true;
  const concurrent = new DatabaseSync(redactionRollbackOptions.databasePath);
  concurrent.prepare(`
    UPDATE durable_runs
    SET status = 'queued'
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run(redactionRollbackCreated.job.jobId);
  concurrent.close();
};
const redactionRollbackRepository = await SqliteContinuationRepository.open({
  ...redactionRollbackOptions,
  inputStore: {
    ensureRoot: () => redactionRollbackDelegate.ensureRoot(),
    withCreationLock: (...args: Parameters<ContinuationInputStore['withCreationLock']>) =>
      redactionRollbackDelegate.withCreationLock(...args),
    install: (...args: Parameters<ContinuationInputStore['install']>) =>
      redactionRollbackDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) =>
      redactionRollbackDelegate.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) =>
      redactionRollbackDelegate.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) =>
      redactionRollbackDelegate.resolve(...args),
    remove: (...args: Parameters<ContinuationInputStore['remove']>) =>
      redactionRollbackDelegate.remove(...args),
    async quarantine(...args: Parameters<ContinuationInputStore['quarantine']>) {
      const token = await redactionRollbackDelegate.quarantine(...args);
      injectRedactionRace();
      return token;
    },
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      redactionRollbackDelegate.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      redactionRollbackDelegate.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      redactionRollbackDelegate.cleanupOrphans(...args),
  },
});
assert.equal(await redactionRollbackRepository.redactTerminal(
  redactionRollbackCreated.job.jobId,
  '2026-07-17T00:00:02.000Z',
), false);
const redactionRollbackJob = await redactionRollbackRepository.get(redactionRollbackCreated.job.jobId);
assert.equal(redactionRollbackJob?.deletedAt, undefined);
assert.equal(redactionRollbackJob?.sourceFacts.inputs.length, 1);
assert.equal(await readFile(redactionRollbackDelegate.resolve(
  redactionRollbackCreated.job.jobId,
  redactionRollbackCreated.job.sourceFacts.inputs[0].relativePath,
), 'utf8'), 'restore me after failed redaction');
assert.equal(
  await readFile(join(redactionRollbackArtifactRoot, 'result.txt'), 'utf8'),
  'restore artifact after rollback',
);
redactionRollbackRepository.close();

// Restart restores a quarantine left by a crash before the database redaction committed.
const liveRedactionToken = await redactionRollbackDelegate.quarantine(
  redactionRollbackCreated.job.jobId,
);
const liveArtifactRedactionToken = await redactionRollbackArtifacts.quarantine(
  redactionRollbackCreated.job.jobId,
);
assert.ok(liveRedactionToken);
assert.ok(liveArtifactRedactionToken);
await redactionRollbackDelegate.cleanupOrphans(new Set([redactionRollbackCreated.job.jobId]));
await redactionRollbackArtifacts.cleanupOrphans(new Set([redactionRollbackCreated.job.jobId]));
await assert.rejects(lstat(join(
  redactionRollbackOptions.inputsDir,
  redactionRollbackCreated.job.jobId,
)));
await assert.rejects(lstat(redactionRollbackArtifactRoot));
await mkdir(join(redactionRollbackOptions.inputsDir, redactionRollbackCreated.job.jobId));
await mkdir(redactionRollbackArtifactRoot);
await writeFile(join(
  redactionRollbackOptions.inputsDir,
  redactionRollbackCreated.job.jobId,
  'restore-blocker',
), 'block replacement', 'utf8');
await writeFile(join(redactionRollbackArtifactRoot, 'restore-blocker'), 'block replacement', 'utf8');
await assert.rejects(
  redactionRollbackDelegate.restoreQuarantine(
    redactionRollbackCreated.job.jobId,
    liveRedactionToken,
  ),
  /EACCES|EEXIST|exist|not empty|permission denied/i,
);
await assert.rejects(
  redactionRollbackArtifacts.restoreQuarantine(
    redactionRollbackCreated.job.jobId,
    liveArtifactRedactionToken,
  ),
  /EACCES|EEXIST|exist|not empty|permission denied/i,
);
await rm(join(redactionRollbackOptions.inputsDir, redactionRollbackCreated.job.jobId), {
  recursive: true,
  force: true,
});
await rm(redactionRollbackArtifactRoot, { recursive: true, force: true });
await redactionRollbackDelegate.cleanupOrphans(new Set([redactionRollbackCreated.job.jobId]));
await redactionRollbackArtifacts.cleanupOrphans(new Set([redactionRollbackCreated.job.jobId]));
assert.equal(await readFile(redactionRollbackDelegate.resolve(
  redactionRollbackCreated.job.jobId,
  redactionRollbackCreated.job.sourceFacts.inputs[0].relativePath,
), 'utf8'), 'restore me after failed redaction');
assert.equal(
  await readFile(join(redactionRollbackArtifactRoot, 'result.txt'), 'utf8'),
  'restore artifact after rollback',
);
const crashRedactionToken = await redactionRollbackDelegate.quarantine(
  redactionRollbackCreated.job.jobId,
);
const crashArtifactRedactionToken = await redactionRollbackArtifacts.quarantine(
  redactionRollbackCreated.job.jobId,
);
assert.ok(crashRedactionToken);
assert.ok(crashArtifactRedactionToken);
const deadRedactionToken = `${process.pid}.1-${'f'.repeat(16)}`;
await rename(
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${crashRedactionToken}`,
  ),
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${deadRedactionToken}`,
  ),
);
await rename(
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${crashArtifactRedactionToken}`,
  ),
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${deadRedactionToken}`,
  ),
);
const redactionCrashRecovery = await SqliteContinuationRepository.open(redactionRollbackOptions);
assert.equal(await readFile(redactionRollbackDelegate.resolve(
  redactionRollbackCreated.job.jobId,
  redactionRollbackCreated.job.sourceFacts.inputs[0].relativePath,
), 'utf8'), 'restore me after failed redaction');
assert.equal((await readdir(redactionRollbackOptions.inputsDir)).some(
  (entry) => entry.startsWith(`.redacting-${redactionRollbackCreated.job.jobId}-`),
), false);
assert.equal(
  await readFile(join(redactionRollbackArtifactRoot, 'result.txt'), 'utf8'),
  'restore artifact after rollback',
);
assert.equal((await readdir(redactionRollbackOptions.artifactsDir)).some(
  (entry) => entry.startsWith(`.redacting-${redactionRollbackCreated.job.jobId}-`),
), false);
redactionCrashRecovery.close();

const concurrentRecoveryInputToken = await redactionRollbackDelegate.quarantine(
  redactionRollbackCreated.job.jobId,
);
const concurrentRecoveryArtifactToken = await redactionRollbackArtifacts.quarantine(
  redactionRollbackCreated.job.jobId,
);
assert.ok(concurrentRecoveryInputToken);
assert.ok(concurrentRecoveryArtifactToken);
const concurrentRecoveryDeadToken = `2147483646.1-${'e'.repeat(16)}`;
await rename(
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${concurrentRecoveryInputToken}`,
  ),
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${concurrentRecoveryDeadToken}`,
  ),
);
await rename(
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${concurrentRecoveryArtifactToken}`,
  ),
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${concurrentRecoveryDeadToken}`,
  ),
);
const liveRedactionJobs = new Set([redactionRollbackCreated.job.jobId]);
await Promise.all([
  redactionRollbackDelegate.cleanupOrphans(liveRedactionJobs),
  redactionRollbackDelegate.cleanupOrphans(liveRedactionJobs),
  redactionRollbackArtifacts.cleanupOrphans(liveRedactionJobs),
  redactionRollbackArtifacts.cleanupOrphans(liveRedactionJobs),
]);
assert.equal(await readFile(redactionRollbackDelegate.resolve(
  redactionRollbackCreated.job.jobId,
  redactionRollbackCreated.job.sourceFacts.inputs[0].relativePath,
), 'utf8'), 'restore me after failed redaction');
assert.equal(
  await readFile(join(redactionRollbackArtifactRoot, 'result.txt'), 'utf8'),
  'restore artifact after rollback',
);

// A stale reconciliation snapshot must not restore quarantines after the current
// database state says the Job was deleted or sanitized as corrupt. New tokens
// also carry quarantine creation time instead of inheriting an old tree mtime.
const oldQuarantineTime = new Date(Date.now() - 2 * 60 * 60 * 1_000);
await utimes(
  join(redactionRollbackOptions.inputsDir, redactionRollbackCreated.job.jobId),
  oldQuarantineTime,
  oldQuarantineTime,
);
await utimes(redactionRollbackArtifactRoot, oldQuarantineTime, oldQuarantineTime);
const quarantineStartedAt = Date.now();
const staleSnapshotInputToken = await redactionRollbackDelegate.quarantine(
  redactionRollbackCreated.job.jobId,
);
const staleSnapshotArtifactToken = await redactionRollbackArtifacts.quarantine(
  redactionRollbackCreated.job.jobId,
);
assert.ok(staleSnapshotInputToken);
assert.ok(staleSnapshotArtifactToken);
const inputQuarantineCreatedAt = /^(?:\d+)\.(?:\d+)\.(\d+)-/.exec(staleSnapshotInputToken)?.[1];
const artifactQuarantineCreatedAt = /^(?:\d+)\.(?:\d+)\.(\d+)-/.exec(staleSnapshotArtifactToken)?.[1];
assert.ok(inputQuarantineCreatedAt);
assert.ok(artifactQuarantineCreatedAt);
assert.ok(Number(inputQuarantineCreatedAt) >= quarantineStartedAt);
assert.ok(Number(artifactQuarantineCreatedAt) >= quarantineStartedAt);
const staleSnapshotDeadToken = `2147483646.1.${Date.now()}-${'d'.repeat(16)}`;
await rename(
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${staleSnapshotInputToken}`,
  ),
  join(
    redactionRollbackOptions.inputsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${staleSnapshotDeadToken}`,
  ),
);
await rename(
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${staleSnapshotArtifactToken}`,
  ),
  join(
    redactionRollbackOptions.artifactsDir,
    `.redacting-${redactionRollbackCreated.job.jobId}-${staleSnapshotDeadToken}`,
  ),
);
await redactionRollbackDelegate.cleanupOrphans(
  liveRedactionJobs,
  Date.now(),
  async () => false,
);
await redactionRollbackArtifacts.cleanupOrphans(
  liveRedactionJobs,
  Date.now(),
  async () => false,
  (jobId, operation) => redactionRollbackDelegate.withCreationLock(jobId, operation),
);
await assert.rejects(lstat(join(
  redactionRollbackOptions.inputsDir,
  redactionRollbackCreated.job.jobId,
)), /ENOENT/);
await assert.rejects(lstat(redactionRollbackArtifactRoot), /ENOENT/);
assert.equal((await readdir(redactionRollbackOptions.inputsDir)).some(
  (entry) => entry.startsWith(`.redacting-${redactionRollbackCreated.job.jobId}-`),
), false);
assert.equal((await readdir(redactionRollbackOptions.artifactsDir)).some(
  (entry) => entry.startsWith(`.redacting-${redactionRollbackCreated.job.jobId}-`),
), false);

// Separate repository instances serialize redaction through the cross-process Job lock.
// The loser must observe the committed DB state and must never restore the winner's quarantines.
const concurrentRedactionRoot = await mkdtemp(join(tmpdir(), 'continuation-redaction-concurrent-'));
const concurrentRedactionOptions = {
  databasePath: join(concurrentRedactionRoot, 'jobs.sqlite'),
  artifactsDir: join(concurrentRedactionRoot, 'artifacts'),
  inputsDir: join(concurrentRedactionRoot, 'inputs'),
};
const concurrentRedactionSource = join(concurrentRedactionRoot, 'source.txt');
await writeFile(concurrentRedactionSource, 'concurrent redaction input', 'utf8');
const concurrentRedactionSeed = await SqliteContinuationRepository.open(concurrentRedactionOptions);
const concurrentRedactionJob = await concurrentRedactionSeed.create(createRequest(
  'redaction-concurrent',
  {
    sourceInputs: [{
      sourcePath: concurrentRedactionSource,
      fileName: 'source.txt',
      kind: 'message_attachment',
    }],
  },
));
const concurrentRedactionArtifacts = new ContinuationArtifactStore(
  concurrentRedactionOptions.artifactsDir,
);
const concurrentRedactionArtifactRoot = await concurrentRedactionArtifacts.ensure(
  concurrentRedactionJob.job.jobId,
);
await writeFile(join(concurrentRedactionArtifactRoot, 'result.txt'), 'concurrent result', 'utf8');
assert.equal(await concurrentRedactionSeed.requestCancel(
  concurrentRedactionJob.job.jobId,
  '2026-07-17T00:00:01.000Z',
), 'cancelled');
concurrentRedactionSeed.close();

const concurrentRedactionInputs = new ContinuationInputStore(concurrentRedactionOptions.inputsDir);
let releaseConcurrentRedaction!: () => void;
let markConcurrentQuarantine!: () => void;
const concurrentQuarantineStarted = new Promise<void>((resolve) => {
  markConcurrentQuarantine = resolve;
});
const concurrentQuarantineReleased = new Promise<void>((resolve) => {
  releaseConcurrentRedaction = resolve;
});
const concurrentRedactionA = await SqliteContinuationRepository.open({
  ...concurrentRedactionOptions,
  inputStore: {
    ensureRoot: () => concurrentRedactionInputs.ensureRoot(),
    withCreationLock: <T>(jobId: string, operation: () => Promise<T>) =>
      concurrentRedactionInputs.withCreationLock(jobId, operation),
    install: (...args: Parameters<ContinuationInputStore['install']>) =>
      concurrentRedactionInputs.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) =>
      concurrentRedactionInputs.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) =>
      concurrentRedactionInputs.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) =>
      concurrentRedactionInputs.resolve(...args),
    remove: (...args: Parameters<ContinuationInputStore['remove']>) =>
      concurrentRedactionInputs.remove(...args),
    async quarantine(...args: Parameters<ContinuationInputStore['quarantine']>) {
      const token = await concurrentRedactionInputs.quarantine(...args);
      markConcurrentQuarantine();
      await concurrentQuarantineReleased;
      return token;
    },
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      concurrentRedactionInputs.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      concurrentRedactionInputs.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      concurrentRedactionInputs.cleanupOrphans(...args),
  },
});
const concurrentRedactionB = await SqliteContinuationRepository.open(concurrentRedactionOptions);
const redactionA = concurrentRedactionA.redactTerminal(
  concurrentRedactionJob.job.jobId,
  '2026-07-17T00:00:02.000Z',
);
await concurrentQuarantineStarted;
let redactionBSettled = false;
const redactionB = concurrentRedactionB.redactTerminal(
  concurrentRedactionJob.job.jobId,
  '2026-07-17T00:00:03.000Z',
).finally(() => { redactionBSettled = true; });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(redactionBSettled, false);
releaseConcurrentRedaction();
assert.equal(await redactionA, true);
assert.equal(await redactionB, false);
assert.ok((await concurrentRedactionB.get(concurrentRedactionJob.job.jobId))?.deletedAt);
await assert.rejects(stat(concurrentRedactionArtifactRoot), /ENOENT/);
await assert.rejects(stat(join(
  concurrentRedactionOptions.inputsDir,
  concurrentRedactionJob.job.jobId,
)), /ENOENT/);
assert.equal((await readdir(concurrentRedactionOptions.artifactsDir)).some(
  (entry) => entry.startsWith(`.redacting-${concurrentRedactionJob.job.jobId}-`),
), false);
assert.equal((await readdir(concurrentRedactionOptions.inputsDir)).some(
  (entry) => entry.startsWith(`.redacting-${concurrentRedactionJob.job.jobId}-`),
), false);
concurrentRedactionA.close();
concurrentRedactionB.close();

// A crash after input rename but before DB commit leaves exactly a committed input tree and no
// database row. Construct that durable state directly: pausing in the few instructions between
// rename and INSERT would require a production fault-injection hook, while killing earlier/later
// would be nondeterministic and would not improve state-transition coverage.
const crashAdoptionRoot = await mkdtemp(join(tmpdir(), 'continuation-crash-adoption-'));
const crashAdoptionOptions = {
  databasePath: join(crashAdoptionRoot, 'jobs.sqlite'),
  artifactsDir: join(crashAdoptionRoot, 'artifacts'),
  inputsDir: join(crashAdoptionRoot, 'inputs'),
};
const crashAdoptionSource = join(crashAdoptionRoot, 'source.txt');
await writeFile(crashAdoptionSource, 'crash adoption bytes', 'utf8');
const crashAdoptionRequest = createRequest('crash-adoption', {
  sourceInputs: [{ sourcePath: crashAdoptionSource, fileName: 'source.txt', kind: 'message_attachment' }],
});
const crashAdoptionSeed = await SqliteContinuationRepository.open(crashAdoptionOptions);
const crashAdoptionCreated = await crashAdoptionSeed.create(crashAdoptionRequest);
crashAdoptionSeed.close();
const crashAdoptionDatabase = new DatabaseSync(crashAdoptionOptions.databasePath);
crashAdoptionDatabase.prepare(`
  DELETE FROM durable_runs WHERE run_id = ? AND workload_kind = 'async_task'
`).run(
  crashAdoptionCreated.job.jobId,
);
crashAdoptionDatabase.close();
const crashAdoptionRepository = await SqliteContinuationRepository.open(crashAdoptionOptions);
const crashAdopted = await crashAdoptionRepository.create({
  ...crashAdoptionRequest,
  sourceInputs: [{
    ...crashAdoptionRequest.sourceInputs[0],
    fileName: 'source-downloaded-after-restart.txt',
  }],
  parentSessionId: 'session-after-restart',
  maxAttempts: crashAdoptionRequest.maxAttempts + 1,
  maxRetries: crashAdoptionRequest.maxRetries + 1,
  timeoutSeconds: crashAdoptionRequest.timeoutSeconds + 1,
  createdAt: '2026-07-17T00:01:00.000Z',
  expiresAt: '2026-07-18T00:01:00.000Z',
});
assert.equal(crashAdopted.created, true);
assert.equal(crashAdopted.job.jobId, crashAdoptionCreated.job.jobId);
crashAdoptionRepository.close();

// Input admission rejects unsafe files, collisions, and quota overflow without a partial final tree.
const inputValidationRoot = join(managedRoot, 'input-validation');
const inputValidationStore = new ContinuationInputStore(inputValidationRoot, {
  maxFiles: 2,
  maxFileBytes: 8,
  maxTotalBytes: 12,
});
const shortA = join(managedRoot, 'short-a.txt');
const shortB = join(managedRoot, 'short-b.txt');
const large = join(managedRoot, 'large.txt');
const mediumA = join(managedRoot, 'medium-a.txt');
const mediumB = join(managedRoot, 'medium-b.txt');
const directoryInput = join(managedRoot, 'directory-input');
const symlinkInput = join(managedRoot, 'symlink-input');
await writeFile(shortA, 'aaaa', 'utf8');
await writeFile(shortB, 'bbbb', 'utf8');
await writeFile(large, '123456789', 'utf8');
await writeFile(mediumA, '1234567', 'utf8');
await writeFile(mediumB, '7654321', 'utf8');
await mkdir(directoryInput);
await symlink(shortA, symlinkInput);
await assert.rejects(
  inputValidationStore.install('job_symlink', [{
    sourcePath: symlinkInput,
    fileName: 'link.txt',
    kind: 'message_attachment',
  }]),
  /symbolic|regular file/i,
);
await assert.rejects(
  inputValidationStore.install('job_directory', [{
    sourcePath: directoryInput,
    fileName: 'directory',
    kind: 'message_attachment',
  }]),
  /regular file/i,
);
const duplicateNames = await inputValidationStore.install('job_duplicate_names', [
  { sourcePath: shortA, fileName: 'same.txt', kind: 'message_attachment' },
  { sourcePath: shortB, fileName: 'same.txt', kind: 'message_image' },
]);
assert.deepEqual(
  duplicateNames.artifacts.map((artifact) => artifact.relativePath),
  ['input_001.txt', 'input_002.txt'],
);
assert.equal(await readFile(inputValidationStore.resolve(
  'job_duplicate_names',
  duplicateNames.artifacts[0].relativePath,
), 'utf8'), 'aaaa');
assert.equal(await readFile(inputValidationStore.resolve(
  'job_duplicate_names',
  duplicateNames.artifacts[1].relativePath,
), 'utf8'), 'bbbb');

const corruptAdoption = await inputValidationStore.install('job_corrupt_adoption', [{
  sourcePath: shortA,
  fileName: 'source.txt',
  kind: 'message_attachment',
}], 'corrupt-adoption-fingerprint');
const corruptAdoptionPath = inputValidationStore.resolve(
  'job_corrupt_adoption',
  corruptAdoption.artifacts[0].relativePath,
);
await chmod(corruptAdoptionPath, 0o600);
await writeFile(corruptAdoptionPath, 'zzzz', 'utf8');
await chmod(corruptAdoptionPath, 0o400);
await assert.rejects(
  inputValidationStore.install('job_corrupt_adoption', [{
    sourcePath: shortA,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }], 'corrupt-adoption-fingerprint'),
  /integrity|modified|managed input/i,
);
await assert.rejects(
  inputValidationStore.install('job_bad_name', [{
    sourcePath: shortA,
    fileName: '../escape.txt',
    kind: 'message_attachment',
  }]),
  /file name/i,
);
await assert.rejects(
  inputValidationStore.install('job_too_many', [
    { sourcePath: shortA, fileName: 'a.txt', kind: 'message_attachment' },
    { sourcePath: shortB, fileName: 'b.txt', kind: 'message_attachment' },
    { sourcePath: shortA, fileName: 'c.txt', kind: 'message_attachment' },
  ]),
  /count|files/i,
);
await assert.rejects(
  inputValidationStore.install('job_file_large', [{
    sourcePath: large,
    fileName: 'large.txt',
    kind: 'message_attachment',
  }]),
  /file.*byte|too large/i,
);
await assert.rejects(
  inputValidationStore.install('job_total_large', [
    { sourcePath: mediumA, fileName: 'medium-a.txt', kind: 'message_attachment' },
    { sourcePath: mediumB, fileName: 'medium-b.txt', kind: 'message_attachment' },
  ]),
  /total byte/i,
);
await assert.rejects(
  inputValidationStore.install('job_all_or_nothing', [
    { sourcePath: shortA, fileName: 'a.txt', kind: 'message_attachment' },
    { sourcePath: join(managedRoot, 'missing-input'), fileName: 'missing.txt', kind: 'message_attachment' },
  ]),
  /input|ENOENT|read/i,
);
await assert.rejects(lstat(join(inputValidationRoot, 'job_all_or_nothing')));

const deadLockInputsRoot = join(managedRoot, 'dead-lock-inputs');
const deadLockStore = new ContinuationInputStore(deadLockInputsRoot);
await deadLockStore.ensureRoot();
const ownerlessLockJobId = continuationJobId('ownerless-lock-grace');
await mkdir(join(deadLockInputsRoot, `.creating-${ownerlessLockJobId}`));
const ownerlessReclaimer = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  ownerlessLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await assert.rejects(
  waitForChildMarker(ownerlessReclaimer, 'DEAD_LOCK_RECLAIMED', 500),
  /timed out/i,
);
const staleOwnerlessTime = new Date(Date.now() - 60_000);
await utimes(
  join(deadLockInputsRoot, `.creating-${ownerlessLockJobId}`),
  staleOwnerlessTime,
  staleOwnerlessTime,
);
const staleOwnerlessReclaimer = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  ownerlessLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await waitForChildMarker(staleOwnerlessReclaimer, 'DEAD_LOCK_RECLAIMED', 1_000);

const staleReclaimJobId = continuationJobId('stale-reclaim-recovery');
const staleReclaimPath = join(
  deadLockInputsRoot,
  `.reclaim-.creating-${staleReclaimJobId}-2147483647-${'f'.repeat(16)}`,
);
await writeFile(staleReclaimPath, 'stale reclaimed lock', 'utf8');
await utimes(staleReclaimPath, staleOwnerlessTime, staleOwnerlessTime);
const staleReclaimChild = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  staleReclaimJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await waitForChildMarker(staleReclaimChild, 'DEAD_LOCK_RECLAIMED', 1_000);
await assert.rejects(lstat(staleReclaimPath), /ENOENT/);

const reclaimCleanupNow = Date.now();
const staleReclaimCreatedAt = reclaimCleanupNow - 60_000;
const staleIdentityReclaimPath = join(
  deadLockInputsRoot,
  `.reclaim-.creating-${continuationJobId('stale-identity-reclaim')}-2147483647.1.${staleReclaimCreatedAt}-${'a'.repeat(16)}`,
);
const staleIdentityReleasePath = join(
  deadLockInputsRoot,
  `.reclaim-release-.creating-${continuationJobId('stale-identity-release')}-2147483647.1.${staleReclaimCreatedAt}-${'b'.repeat(32)}`,
);
const staleLegacyReleasePath = join(
  deadLockInputsRoot,
  `.reclaim-release-.creating-${continuationJobId('stale-legacy-release')}-2147483647-${'c'.repeat(32)}`,
);
const staleDirectoryReclaimPath = join(
  deadLockInputsRoot,
  `.reclaim-.creating-${continuationJobId('stale-directory-reclaim')}-2147483647.1.${staleReclaimCreatedAt}-${'e'.repeat(16)}`,
);
const activeReclaimPath = join(
  deadLockInputsRoot,
  `.reclaim-.creating-${continuationJobId('active-identity-reclaim')}-${process.pid}.${currentProcessStartedAt()}.${reclaimCleanupNow}-${'d'.repeat(16)}`,
);
const malformedReclaimPath = join(deadLockInputsRoot, '.reclaim-unrecognized-state');
for (const candidate of [
  staleIdentityReclaimPath,
  staleIdentityReleasePath,
  staleLegacyReleasePath,
  activeReclaimPath,
  malformedReclaimPath,
]) {
  await writeFile(candidate, 'reclaim marker', 'utf8');
}
await mkdir(staleDirectoryReclaimPath);
await utimes(staleIdentityReclaimPath, staleOwnerlessTime, staleOwnerlessTime);
await utimes(staleIdentityReleasePath, staleOwnerlessTime, staleOwnerlessTime);
await utimes(staleLegacyReleasePath, staleOwnerlessTime, staleOwnerlessTime);
await utimes(staleDirectoryReclaimPath, staleOwnerlessTime, staleOwnerlessTime);
await deadLockStore.cleanupOrphans(new Set(), reclaimCleanupNow);
await assert.rejects(lstat(staleIdentityReclaimPath), /ENOENT/);
await assert.rejects(lstat(staleIdentityReleasePath), /ENOENT/);
await assert.rejects(lstat(staleLegacyReleasePath), /ENOENT/);
await assert.rejects(lstat(staleDirectoryReclaimPath), /ENOENT/);
assert.equal((await lstat(activeReclaimPath)).isFile(), true);
assert.equal((await lstat(malformedReclaimPath)).isFile(), true);

const atomicLockJobId = continuationJobId('atomic-lock-owner');
await deadLockStore.withCreationLock(atomicLockJobId, async () => {
  const lockMetadata = await lstat(join(deadLockInputsRoot, `.creating-${atomicLockJobId}`));
  assert.equal(lockMetadata.isFile(), true);
});
await assert.rejects(lstat(join(deadLockInputsRoot, `.creating-${atomicLockJobId}`)), /ENOENT/);

const deadLockJobId = continuationJobId('dead-lock-immediate-recovery');
const deadLockDirectory = join(deadLockInputsRoot, `.creating-${deadLockJobId}`);
await mkdir(deadLockDirectory);
await writeFile(join(deadLockDirectory, 'owner.json'), JSON.stringify({
  pid: 2_147_483_647,
  createdAt: new Date().toISOString(),
}), 'utf8');
const deadLockChild = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  deadLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await waitForChildMarker(deadLockChild, 'DEAD_LOCK_RECLAIMED', 1_000);

const reusedPidLockJobId = continuationJobId('reused-pid-lock-recovery');
const reusedPidLockDirectory = join(deadLockInputsRoot, `.creating-${reusedPidLockJobId}`);
const reusedPidNonce = 'a'.repeat(32);
await mkdir(reusedPidLockDirectory);
await writeFile(join(reusedPidLockDirectory, 'owner.json'), JSON.stringify({
  pid: process.pid,
  startedAt: 1,
  nonce: reusedPidNonce,
  createdAt: new Date().toISOString(),
}), 'utf8');
await deadLockStore.withCreationLock(reusedPidLockJobId, async () => {});
await assert.rejects(lstat(reusedPidLockDirectory), /ENOENT/);

// Exercise the actual crash path: the first process owns the lock directory and
// owner.json, then dies without cleanup. A fresh process must reclaim it without
// waiting for the normal lock timeout.
const killedLockJobId = continuationJobId('killed-creation-lock-recovery');
const killedLockOwner = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--hold-creation-lock',
  deadLockInputsRoot,
  killedLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const killedLockStderr = await waitForChildMarker(
  killedLockOwner,
  'CREATION_LOCK_HELD',
  1_000,
);
const killedLockExit = new Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>((resolve) => killedLockOwner.once('exit', (code, signal) => resolve({ code, signal })));
assert.equal(killedLockOwner.kill('SIGKILL'), true);
const killedLockResult = await killedLockExit;
assert.equal(killedLockResult.signal, 'SIGKILL', killedLockStderr);
const reclaimStartedAt = Date.now();
const killedLockReclaimer = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  killedLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await waitForChildMarker(killedLockReclaimer, 'DEAD_LOCK_RECLAIMED', 1_000);
assert.ok(Date.now() - reclaimStartedAt < 1_000, 'dead process lock is reclaimed promptly');

const fifoPath = join(managedRoot, 'blocking-input.pipe');
const mkfifo = spawn('mkfifo', [fifoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
const mkfifoExit = await new Promise<number | null>((resolve) => mkfifo.once('close', resolve));
assert.equal(mkfifoExit, 0);
const fifoChild = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reject-blocking-input',
  join(managedRoot, 'fifo-inputs'),
  'job_fifo_rejection',
  fifoPath,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await waitForChildMarker(fifoChild, 'BLOCKING_INPUT_REJECTED', 1_000);

// Missing retry parents fail before managed input admission. A later artifact preparation failure
// still compensates the tree installed by that request and leaves no partial staging directory.
const failedCommitRoot = await mkdtemp(join(tmpdir(), 'continuation-failed-commit-'));
const failedCommitSource = join(failedCommitRoot, 'source.txt');
await writeFile(failedCommitSource, 'valid admitted bytes', 'utf8');
const failedCommitOptions = {
  databasePath: join(failedCommitRoot, 'jobs.sqlite'),
  artifactsDir: join(failedCommitRoot, 'artifacts'),
  inputsDir: join(failedCommitRoot, 'inputs'),
};
const failedCommitRepository = await SqliteContinuationRepository.open(failedCommitOptions);
const failedCommitRequest = createRequest('failed-commit', {
  retryOfJobId: 'job_missing_retry_source',
  sourceInputs: [{
    sourcePath: failedCommitSource,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }],
});
await assert.rejects(failedCommitRepository.create(failedCommitRequest), /retry source/i);
assert.equal(await failedCommitRepository.get(continuationJobId(failedCommitRequest.idempotencyKey)), null);
const compensatedCreateRequest = createRequest('failed-after-input-install', {
  sourceInputs: [{
    sourcePath: failedCommitSource,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }],
  resumeCheckpoint: progressCheckpoint({
    artifacts: [{
      id: 'missing-artifact',
      deliverableId: 'result',
      path: 'missing.txt',
      sha256: 'a'.repeat(64),
    }],
  }),
  resumeArtifactSourceJobId: 'job_missing_artifact_source',
});
await assert.rejects(
  failedCommitRepository.create(compensatedCreateRequest),
  (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT',
);
assert.equal(
  await failedCommitRepository.get(continuationJobId(compensatedCreateRequest.idempotencyKey)),
  null,
);
const failedCommitEntries = await readdir(failedCommitOptions.inputsDir);
assert.equal(
  failedCommitEntries.some((entry) =>
    entry === continuationJobId(failedCommitRequest.idempotencyKey)
    || entry === continuationJobId(compensatedCreateRequest.idempotencyKey)
    || entry.startsWith('.staging-')),
  false,
);
failedCommitRepository.close();

// Separate repository instances converge on one deterministic row/tree. A young final tree is
// never treated as an orphan while another process may still be committing its database row.
const concurrentCreateRoot = await mkdtemp(join(tmpdir(), 'continuation-concurrent-create-'));
const concurrentCreateSource = join(concurrentCreateRoot, 'source.txt');
await writeFile(concurrentCreateSource, 'same concurrent source', 'utf8');
const concurrentCreateOptions = {
  databasePath: join(concurrentCreateRoot, 'jobs.sqlite'),
  artifactsDir: join(concurrentCreateRoot, 'artifacts'),
  inputsDir: join(concurrentCreateRoot, 'inputs'),
  jitter: () => 0,
};
const concurrentCreateA = await SqliteContinuationRepository.open(concurrentCreateOptions);
const concurrentCreateB = await SqliteContinuationRepository.open(concurrentCreateOptions);
const concurrentRequest = createRequest('concurrent-create', {
  sourceInputs: [{
    sourcePath: concurrentCreateSource,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }],
});
const [concurrentResultA, concurrentResultB] = await Promise.all([
  concurrentCreateA.create(concurrentRequest),
  concurrentCreateB.create(concurrentRequest),
]);
assert.equal(concurrentResultA.job.jobId, concurrentResultB.job.jobId);
assert.equal(Number(concurrentResultA.created) + Number(concurrentResultB.created), 1);
const concurrentEntries = await readdir(join(concurrentCreateRoot, 'inputs'));
assert.equal(concurrentEntries.filter((entry) => entry === concurrentResultA.job.jobId).length, 1);
assert.equal(concurrentEntries.some((entry) => entry.startsWith('.staging-')), false);
const concurrentStore = new ContinuationInputStore(join(concurrentCreateRoot, 'inputs'));
await concurrentStore.cleanupOrphans(new Set(), Date.now());
assert.equal((await lstat(join(concurrentCreateRoot, 'inputs', concurrentResultA.job.jobId))).isDirectory(), true);
concurrentCreateA.close();
concurrentCreateB.close();

const liveCleanupJobId = continuationJobId('live-cleanup-create');
const liveCreateChild = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--hold-managed-input-create',
  concurrentCreateRoot,
  liveCleanupJobId,
  concurrentCreateSource,
], { stdio: ['ignore', 'pipe', 'pipe'] });
const liveCreateStderr = await waitForChildMarker(liveCreateChild, 'MANAGED_INPUT_INSTALLED');
await concurrentStore.cleanupOrphans(new Set(), Date.now());
assert.equal((await lstat(join(concurrentCreateRoot, 'inputs', liveCleanupJobId))).isDirectory(), true);
const liveCreateExit = new Promise<number | null>((resolve) => liveCreateChild.once('close', resolve));
await writeFile(join(concurrentCreateRoot, `.release-${liveCleanupJobId}`), 'release', 'utf8');
assert.equal(await liveCreateExit, 0, liveCreateStderr);

const concurrentOrphan = join(concurrentCreateRoot, 'inputs', 'job_concurrent_orphan');
await mkdir(join(concurrentOrphan, 'nested'), { recursive: true });
for (let index = 0; index < 20; index += 1) {
  await writeFile(join(concurrentOrphan, 'nested', `file-${index}.txt`), 'orphan', 'utf8');
}
const agedOrphan = new Date(Date.now() - 2 * 60 * 60 * 1_000);
await utimes(concurrentOrphan, agedOrphan, agedOrphan);
await Promise.all([
  concurrentStore.cleanupOrphans(new Set(), Date.now()),
  concurrentStore.cleanupOrphans(new Set(), Date.now()),
]);
await assert.rejects(lstat(concurrentOrphan), /ENOENT/);

const adoptedOrphanJobId = continuationJobId('adopted-orphan-recheck');
const adoptedOrphan = await concurrentStore.install(adoptedOrphanJobId, [{
  sourcePath: concurrentCreateSource,
  fileName: 'adopted.txt',
  kind: 'message_attachment',
}], 'adopted-orphan-fingerprint');
const adoptedOrphanDirectory = join(concurrentCreateRoot, 'inputs', adoptedOrphanJobId);
await utimes(adoptedOrphanDirectory, agedOrphan, agedOrphan);
await concurrentStore.cleanupOrphans(
  new Set(),
  Date.now(),
  async (jobId) => jobId === adoptedOrphanJobId,
);
assert.deepEqual(await concurrentStore.verify(adoptedOrphanJobId, adoptedOrphan.artifacts), { ok: true });

// One corrupt trusted snapshot must fail closed without blocking the next due Job.
const corruptStateRoot = await mkdtemp(join(tmpdir(), 'continuation-corrupt-state-'));
const corruptStateDatabasePath = join(corruptStateRoot, 'jobs.sqlite');
const corruptStateRepository = await SqliteContinuationRepository.open({
  databasePath: corruptStateDatabasePath,
  artifactsDir: join(corruptStateRoot, 'artifacts'),
  inputsDir: join(corruptStateRoot, 'inputs'),
  jitter: () => 0,
});
const corruptInputCountJob = await corruptStateRepository.create(createRequest(
  'corrupt-input-count-state',
  { createdAt: '2026-07-16T23:59:53.000Z' },
));
const corruptInputDuplicateJob = await corruptStateRepository.create(createRequest(
  'corrupt-input-duplicate-state',
  { createdAt: '2026-07-16T23:59:54.000Z' },
));
const corruptInputSizeJob = await corruptStateRepository.create(createRequest(
  'corrupt-input-size-state',
  { createdAt: '2026-07-16T23:59:55.000Z' },
));
const corruptCheckpointJob = await corruptStateRepository.create(createRequest(
  'corrupt-checkpoint-state',
  { createdAt: '2026-07-16T23:59:56.000Z' },
));
const corruptArtifactsJob = await corruptStateRepository.create(createRequest(
  'corrupt-artifacts-state',
  { createdAt: '2026-07-16T23:59:57.000Z' },
));
const corruptStateJob = await corruptStateRepository.create(createRequest('corrupt-state', {
  createdAt: '2026-07-16T23:59:58.000Z',
}));
const healthyStateJob = await corruptStateRepository.create(createRequest('healthy-after-corrupt-state', {
  createdAt: '2026-07-16T23:59:59.000Z',
}));
const corruptStateDatabase = new DatabaseSync(corruptStateDatabasePath);
const persistedInput = (index: number, sizeBytes = 1) => ({
  id: `input_${String(index).padStart(3, '0')}`,
  kind: 'message_attachment',
  fileName: `input_${String(index).padStart(3, '0')}.bin`,
  relativePath: `input_${String(index).padStart(3, '0')}.bin`,
  sha256: 'a'.repeat(64),
  sizeBytes,
});
const overwritePersistedInputs = (jobId: string, inputs: unknown[]) => {
  const row = corruptStateDatabase.prepare(`
    SELECT json_extract(state_json, '$.job.sourceFacts') AS source_facts_json
    FROM durable_runs
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).get(jobId) as { source_facts_json: string };
  corruptStateDatabase.prepare(`
    UPDATE durable_runs
    SET state_json = json_set(state_json, '$.job.sourceFacts', json(?))
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run(JSON.stringify({
    ...JSON.parse(row.source_facts_json) as Record<string, unknown>,
    inputs,
  }), jobId);
};
overwritePersistedInputs(corruptInputCountJob.job.jobId, Array.from(
  { length: CONTINUATION_LIMITS.inputFileCount + 1 },
  (_, index) => persistedInput(index + 1),
));
overwritePersistedInputs(corruptInputDuplicateJob.job.jobId, [persistedInput(1), persistedInput(1)]);
overwritePersistedInputs(corruptInputSizeJob.job.jobId, [
  persistedInput(1, CONTINUATION_LIMITS.inputBytesPerFile + 1),
]);
assert.equal(
  (await corruptStateRepository.get(corruptInputDuplicateJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
assert.equal(
  (await corruptStateRepository.listAll(20)).find(
    (job) => job.jobId === corruptInputSizeJob.job.jobId,
  )?.errorCode,
  'continuation_persisted_state_invalid',
);
corruptStateDatabase.prepare(`
  UPDATE durable_runs
  SET state_json = json_set(state_json, '$.job.checkpoint', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(JSON.stringify({
  summary: 'x'.repeat(CONTINUATION_LIMITS.checkpointBytes),
  completedSteps: [],
  remainingSteps: [],
  constraints: [],
  decisions: [],
  references: [],
}), corruptCheckpointJob.job.jobId);
corruptStateDatabase.prepare(`
  UPDATE durable_runs
  SET state_json = json_set(state_json, '$.job.resultArtifacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(JSON.stringify(Array.from(
  { length: CONTINUATION_LIMITS.artifactCount + 1 },
  (_, index) => `artifact-${index}`,
)), corruptArtifactsJob.job.jobId);
assert.equal(
  (await corruptStateRepository.get(corruptCheckpointJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
assert.equal(
  (await corruptStateRepository.listAll(10)).find(
    (job) => job.jobId === corruptArtifactsJob.job.jobId,
  )?.errorCode,
  'continuation_persisted_state_invalid',
);
const corruptFactsJson = corruptStateDatabase.prepare(`
  SELECT json_extract(state_json, '$.job.sourceFacts') AS source_facts_json
  FROM durable_runs
  WHERE run_id = ? AND workload_kind = 'async_task'
`).get(corruptStateJob.job.jobId) as { source_facts_json: string };
corruptStateDatabase.prepare(`
  UPDATE durable_runs
  SET state_json = json_set(state_json, '$.job.sourceFacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(JSON.stringify({
  ...JSON.parse(corruptFactsJson.source_facts_json) as Record<string, unknown>,
  unexpected: 'github_pat_must_not_leak',
}), corruptStateJob.job.jobId);
const healthyStateClaim = await corruptStateRepository.claimDue(
  'worker-after-corrupt-state',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.equal(healthyStateClaim?.job.jobId, healthyStateJob.job.jobId);
assert.equal(
  (await corruptStateRepository.get(corruptInputCountJob.job.jobId))?.errorCode,
  'continuation_persisted_state_invalid',
);
const corruptStateRow = corruptStateDatabase.prepare(`
  SELECT status, error_code, lease_owner FROM continuation_jobs WHERE job_id = ?
`).get(corruptStateJob.job.jobId) as {
  status: string;
  error_code: string;
  lease_owner: string | null;
};
assert.equal(corruptStateRow.status, 'failed');
assert.equal(corruptStateRow.error_code, 'continuation_persisted_state_invalid');
assert.equal(corruptStateRow.lease_owner, null);
const corruptStateTombstone = await corruptStateRepository.get(corruptStateJob.job.jobId);
assert.equal(corruptStateTombstone?.status, 'failed');
assert.equal(corruptStateTombstone?.sourceFacts.provenance, 'legacy_unavailable');
assert.equal(corruptStateTombstone?.sourceFacts.originalUserText, null);
assert.deepEqual(corruptStateTombstone?.sourceFacts.inputs, []);
assert.ok((await corruptStateRepository.listAll(10)).some(
  (job) => job.jobId === corruptStateJob.job.jobId,
));
const tombstoneRaw = corruptStateDatabase.prepare(`
  SELECT source_facts_json, task_contract_json FROM continuation_jobs WHERE job_id = ?
`).get(corruptStateJob.job.jobId) as {
  source_facts_json: string;
  task_contract_json: string;
};
assert.doesNotMatch(
  `${tombstoneRaw.source_facts_json}\n${tombstoneRaw.task_contract_json}`,
  /github_pat|unexpected|must_not_leak/i,
);
const corruptStateDelivery = await corruptStateRepository.claimPendingDelivery(
  'delivery-corrupt-state',
  baseNow,
);
assert.equal(corruptStateDelivery?.jobId, corruptStateJob.job.jobId);
assert.doesNotMatch(corruptStateDelivery?.payload ?? '', /github_pat|unexpected|source_facts/i);
await corruptStateRepository.markDeliveryResult(
  corruptStateDelivery!,
  { status: 'delivered', messageId: 'om_corrupt_state_failure' },
  baseNow,
);
const corruptStateCleanup = await corruptStateRepository.purgeExpired(
  '2026-07-17T00:00:01.000Z',
  '2026-07-17T00:02:00.000Z',
);
assert.ok(corruptStateCleanup.some((entry) =>
  entry.jobId === corruptStateJob.job.jobId && entry.result === 'cleaned'));
assert.equal((await corruptStateRepository.get(corruptStateJob.job.jobId))?.deletedAt,
  '2026-07-17T00:02:00.000Z');
corruptStateDatabase.close();
corruptStateRepository.close();

// Divergent route copies are never used for remote delivery; the Job becomes a local tombstone.
const routeMismatchRoot = await mkdtemp(join(tmpdir(), 'continuation-route-mismatch-'));
const routeMismatchDatabasePath = join(routeMismatchRoot, 'jobs.sqlite');
const routeMismatchInputsDir = join(routeMismatchRoot, 'inputs');
const routeMismatchArtifactsDir = join(routeMismatchRoot, 'artifacts');
const routeMismatchSource = join(routeMismatchRoot, 'source.txt');
await writeFile(routeMismatchSource, 'sensitive managed input', 'utf8');
const routeMismatchRepository = await SqliteContinuationRepository.open({
  databasePath: routeMismatchDatabasePath,
  artifactsDir: routeMismatchArtifactsDir,
  inputsDir: routeMismatchInputsDir,
  jitter: () => 0,
});
const routeMismatchJob = await routeMismatchRepository.create(createRequest('route-mismatch', {
  createdAt: '2026-07-16T23:59:58.000Z',
  sourceInputs: [{
    sourcePath: routeMismatchSource,
    fileName: 'source.txt',
    kind: 'message_attachment',
  }],
}));
const routeMismatchArtifactStore = new ContinuationArtifactStore(routeMismatchArtifactsDir);
await writeFile(
  join(await routeMismatchArtifactStore.ensure(routeMismatchJob.job.jobId), 'result.txt'),
  'sensitive result',
  'utf8',
);
const routeMismatchHealthy = await routeMismatchRepository.create(createRequest(
  'healthy-after-route-mismatch',
  { createdAt: '2026-07-16T23:59:59.000Z' },
));
const routeMismatchDatabase = new DatabaseSync(routeMismatchDatabasePath);
const routeMismatchFacts = routeMismatchDatabase.prepare(`
  SELECT json_extract(state_json, '$.job.sourceFacts') AS source_facts_json
  FROM durable_runs
  WHERE run_id = ? AND workload_kind = 'async_task'
`).get(routeMismatchJob.job.jobId) as { source_facts_json: string };
const wrongThreadRoute = {
  kind: 'message_thread',
  conversationId: routeMismatchJob.job.route.kind === 'message_thread'
    ? routeMismatchJob.job.route.conversationId
    : '',
  sourceMessageId: routeMismatchJob.job.sourceMessageId,
  threadId: 'omt_wrong_thread',
};
routeMismatchDatabase.prepare(`
  UPDATE durable_runs
  SET route_json = ?,
      state_json = json_set(state_json, '$.job.sourceFacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(
  JSON.stringify(wrongThreadRoute),
  JSON.stringify({
    ...JSON.parse(routeMismatchFacts.source_facts_json) as Record<string, unknown>,
    route: wrongThreadRoute,
  }),
  routeMismatchJob.job.jobId,
);
const routeMismatchTombstone = await routeMismatchRepository.get(routeMismatchJob.job.jobId);
assert.equal(routeMismatchTombstone?.status, 'failed');
assert.equal(routeMismatchTombstone?.errorCode, 'continuation_persisted_state_invalid');
const routeMismatchHealthyClaim = await routeMismatchRepository.claimDue(
  'worker-after-route-mismatch',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.equal(routeMismatchHealthyClaim?.job.jobId, routeMismatchHealthy.job.jobId);
assert.deepEqual(routeMismatchTombstone?.route, {
  kind: 'message_thread',
  conversationId: '',
  sourceMessageId: '',
});
assert.equal(await routeMismatchRepository.claimPendingDelivery(
  'delivery-route-mismatch',
  baseNow,
), null);
await assert.rejects(lstat(join(routeMismatchInputsDir, routeMismatchJob.job.jobId)), /ENOENT/);
await assert.rejects(lstat(join(routeMismatchArtifactsDir, routeMismatchJob.job.jobId)), /ENOENT/);
assert.doesNotMatch(String(routeMismatchDatabase.prepare(`
  SELECT route_json FROM continuation_jobs WHERE job_id = ?
`).get(routeMismatchJob.job.jobId)?.route_json ?? ''), /omt_wrong_thread/);
assert.ok((await routeMismatchRepository.listAll(10)).some(
  (job) => job.jobId === routeMismatchJob.job.jobId,
));
const commentBindingBase = createRequest('persisted-comment-thread-binding', {
  createdAt: '2026-07-16T23:59:57.000Z',
});
const expectedCommentRoute = {
  kind: 'comment_thread' as const,
  documentToken: 'doc_persisted_binding',
  commentId: 'comment_persisted_expected',
  fileType: 'docx',
};
const commentBindingJob = await routeMismatchRepository.create({
  ...commentBindingBase,
  route: expectedCommentRoute,
  sourceMessageId: 'comment_source_message',
  sourceThreadId: expectedCommentRoute.commentId,
  sourceFacts: {
    ...commentBindingBase.sourceFacts,
    chatId: 'doc:doc_persisted_binding',
    chatType: 'doc_comment',
    route: expectedCommentRoute,
    sourceMessageId: 'comment_source_message',
    sourceThreadId: expectedCommentRoute.commentId,
  },
});
const commentBindingFacts = routeMismatchDatabase.prepare(`
  SELECT json_extract(state_json, '$.job.sourceFacts') AS source_facts_json
  FROM durable_runs
  WHERE run_id = ? AND workload_kind = 'async_task'
`).get(commentBindingJob.job.jobId) as { source_facts_json: string };
const wrongCommentRoute = {
  ...expectedCommentRoute,
  commentId: 'comment_persisted_wrong',
};
routeMismatchDatabase.prepare(`
  UPDATE durable_runs
  SET route_json = ?,
      state_json = json_set(state_json, '$.job.sourceFacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(
  JSON.stringify(wrongCommentRoute),
  JSON.stringify({
    ...JSON.parse(commentBindingFacts.source_facts_json) as Record<string, unknown>,
    route: wrongCommentRoute,
  }),
  commentBindingJob.job.jobId,
);
const commentBindingTombstone = await routeMismatchRepository.get(commentBindingJob.job.jobId);
assert.equal(commentBindingTombstone?.status, 'failed');
assert.equal(commentBindingTombstone?.errorCode, 'continuation_persisted_state_invalid');
assert.equal(await routeMismatchRepository.claimPendingDelivery(
  'delivery-comment-thread-mismatch',
  baseNow,
), null);
routeMismatchDatabase.close();
routeMismatchRepository.close();

// Corrupt terminal rows heal through list/get, cannot retry, and retry originally retained cleanup.
const terminalCorruptRoot = await mkdtemp(join(tmpdir(), 'continuation-terminal-corrupt-'));
const terminalCorruptDatabasePath = join(terminalCorruptRoot, 'jobs.sqlite');
const terminalCorruptInputsDir = join(terminalCorruptRoot, 'inputs');
const terminalCorruptSource = join(terminalCorruptRoot, 'source.txt');
await writeFile(terminalCorruptSource, 'terminal corrupt input', 'utf8');
const terminalCorruptDelegate = new ContinuationInputStore(terminalCorruptInputsDir);
let terminalCorruptRemoveFailures = 2;
let terminalCorruptLockDepth = 0;
const terminalCorruptRemoveLockStates: boolean[] = [];
const terminalCorruptRepository = await SqliteContinuationRepository.open({
  databasePath: terminalCorruptDatabasePath,
  artifactsDir: join(terminalCorruptRoot, 'artifacts'),
  inputsDir: terminalCorruptInputsDir,
  inputStore: {
    ensureRoot: () => terminalCorruptDelegate.ensureRoot(),
    withCreationLock: <T>(jobId: string, operation: () => Promise<T>) =>
      terminalCorruptDelegate.withCreationLock(jobId, async () => {
        terminalCorruptLockDepth += 1;
        try {
          return await operation();
        } finally {
          terminalCorruptLockDepth -= 1;
        }
      }),
    install: (...args: Parameters<ContinuationInputStore['install']>) =>
      terminalCorruptDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) =>
      terminalCorruptDelegate.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) =>
      terminalCorruptDelegate.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) =>
      terminalCorruptDelegate.resolve(...args),
    async remove(...args: Parameters<ContinuationInputStore['remove']>) {
      terminalCorruptRemoveLockStates.push(terminalCorruptLockDepth > 0);
      if (terminalCorruptRemoveFailures > 0) {
        terminalCorruptRemoveFailures -= 1;
        throw new Error('injected corrupt storage cleanup failure');
      }
      return terminalCorruptDelegate.remove(...args);
    },
    quarantine: (...args: Parameters<ContinuationInputStore['quarantine']>) =>
      terminalCorruptDelegate.quarantine(...args),
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      terminalCorruptDelegate.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      terminalCorruptDelegate.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      terminalCorruptDelegate.cleanupOrphans(...args),
  },
});
const terminalCorruptCreated = await terminalCorruptRepository.create(createRequest(
  'terminal-corrupt-state',
  {
    sourceInputs: [{
      sourcePath: terminalCorruptSource,
      fileName: 'source.txt',
      kind: 'message_attachment',
    }],
  },
));
assert.equal(await terminalCorruptRepository.setRetained(
  terminalCorruptCreated.job.jobId,
  true,
  baseNow,
), true);
assert.equal(await terminalCorruptRepository.requestCancel(
  terminalCorruptCreated.job.jobId,
  baseNow,
), 'cancelled');
const terminalCorruptDatabase = new DatabaseSync(terminalCorruptDatabasePath);
const terminalCorruptFacts = terminalCorruptDatabase.prepare(`
  SELECT json_extract(state_json, '$.job.sourceFacts') AS source_facts_json
  FROM durable_runs
  WHERE run_id = ? AND workload_kind = 'async_task'
`).get(terminalCorruptCreated.job.jobId) as { source_facts_json: string };
terminalCorruptDatabase.prepare(`
  UPDATE durable_runs
  SET state_json = json_set(state_json, '$.job.sourceFacts', json(?))
  WHERE run_id = ? AND workload_kind = 'async_task'
`).run(JSON.stringify({
  ...JSON.parse(terminalCorruptFacts.source_facts_json) as Record<string, unknown>,
  unexpected: 'must_be_scrubbed',
}), terminalCorruptCreated.job.jobId);
const terminalCorruptList = await terminalCorruptRepository.listAll(10);
const listedTerminalTombstone = terminalCorruptList.find(
  (job) => job.jobId === terminalCorruptCreated.job.jobId,
);
assert.equal(listedTerminalTombstone?.status, 'failed');
assert.equal(listedTerminalTombstone?.errorCode, 'continuation_persisted_state_invalid');
assert.match(listedTerminalTombstone?.errorSummary ?? '', /cleanup is pending/i);
const stillPendingTerminalTombstone = await terminalCorruptRepository.get(
  terminalCorruptCreated.job.jobId,
);
assert.match(stillPendingTerminalTombstone?.errorSummary ?? '', /cleanup is pending/i);
const cleanedTerminalTombstone = await terminalCorruptRepository.get(
  terminalCorruptCreated.job.jobId,
);
assert.equal(cleanedTerminalTombstone?.retained, false);
assert.doesNotMatch(cleanedTerminalTombstone?.errorSummary ?? '', /cleanup is pending/i);
assert.ok(terminalCorruptRemoveLockStates.length >= 3);
assert.ok(terminalCorruptRemoveLockStates.every(Boolean));
await assert.rejects(
  lstat(join(terminalCorruptInputsDir, terminalCorruptCreated.job.jobId)),
  /ENOENT/,
);
await assert.rejects(
  terminalCorruptRepository.cloneForRetry(
    terminalCorruptCreated.job.jobId,
    'retry-corrupt-tombstone',
    baseNow,
  ),
  /stored task state failed integrity validation/i,
);
terminalCorruptDatabase.close();
terminalCorruptRepository.close();

// Read-side repair rechecks after taking the storage lock, but claim-time typed validation is
// authoritative: once a corrupt persisted envelope reaches admission it fails closed atomically.
const recoveryRaceRoot = await mkdtemp(join(tmpdir(), 'continuation-corrupt-recovery-race-'));
const recoveryRaceDatabasePath = join(recoveryRaceRoot, 'jobs.sqlite');
const recoveryRaceInputsDir = join(recoveryRaceRoot, 'inputs');
const recoveryRaceSource = join(recoveryRaceRoot, 'source.txt');
await writeFile(recoveryRaceSource, 'recovery race input', 'utf8');
const recoveryRaceDelegate = new ContinuationInputStore(recoveryRaceInputsDir);
let recoveryRaceDatabase: DatabaseSync | undefined;
let recoveryRaceJobId = '';
let recoveryRaceHealthyFacts = '';
let restoreHealthyRowOnLock = false;
let recoveryRaceRemoveCount = 0;
const recoveryRaceRepository = await SqliteContinuationRepository.open({
  databasePath: recoveryRaceDatabasePath,
  artifactsDir: join(recoveryRaceRoot, 'artifacts'),
  inputsDir: recoveryRaceInputsDir,
  inputStore: {
    ensureRoot: () => recoveryRaceDelegate.ensureRoot(),
    withCreationLock: <T>(jobId: string, operation: () => Promise<T>) =>
      recoveryRaceDelegate.withCreationLock(jobId, async () => {
        if (restoreHealthyRowOnLock && recoveryRaceDatabase && jobId === recoveryRaceJobId) {
          restoreHealthyRowOnLock = false;
          recoveryRaceDatabase.prepare(`
            UPDATE durable_runs
            SET state_json = json_set(state_json, '$.job.sourceFacts', json(?))
            WHERE run_id = ? AND workload_kind = 'async_task'
          `).run(recoveryRaceHealthyFacts, recoveryRaceJobId);
        }
        return operation();
      }),
    install: (...args: Parameters<ContinuationInputStore['install']>) =>
      recoveryRaceDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) =>
      recoveryRaceDelegate.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) =>
      recoveryRaceDelegate.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) =>
      recoveryRaceDelegate.resolve(...args),
    async remove(...args: Parameters<ContinuationInputStore['remove']>) {
      recoveryRaceRemoveCount += 1;
      return recoveryRaceDelegate.remove(...args);
    },
    quarantine: (...args: Parameters<ContinuationInputStore['quarantine']>) =>
      recoveryRaceDelegate.quarantine(...args),
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      recoveryRaceDelegate.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      recoveryRaceDelegate.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      recoveryRaceDelegate.cleanupOrphans(...args),
  },
});
const recoveryRaceCreated = await recoveryRaceRepository.create(createRequest(
  'corrupt-recovery-race',
  {
    sourceInputs: [{
      sourcePath: recoveryRaceSource,
      fileName: 'source.txt',
      kind: 'message_attachment',
    }],
  },
));
recoveryRaceJobId = recoveryRaceCreated.job.jobId;
recoveryRaceDatabase = new DatabaseSync(recoveryRaceDatabasePath);
recoveryRaceHealthyFacts = String(recoveryRaceDatabase.prepare(`
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
`).get(recoveryRaceJobId)?.source_facts_json ?? '');
const corruptRecoveryRaceRow = (): void => {
  recoveryRaceDatabase?.prepare(`
    UPDATE durable_runs
    SET state_json = json_set(state_json, '$.job.sourceFacts', ?)
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).run('{', recoveryRaceJobId);
  restoreHealthyRowOnLock = true;
};
corruptRecoveryRaceRow();
assert.equal((await recoveryRaceRepository.get(recoveryRaceJobId))?.status, 'queued');
corruptRecoveryRaceRow();
assert.ok((await recoveryRaceRepository.listAll(10)).some(
  (job) => job.jobId === recoveryRaceJobId && job.status === 'queued',
));
corruptRecoveryRaceRow();
assert.equal(await recoveryRaceRepository.claimDue(
  'worker-corrupt-recovery-race',
  baseNow,
  '2026-07-17T00:00:30.000Z',
), null);
const failedRecoveryRace = await recoveryRaceRepository.get(recoveryRaceJobId);
assert.equal(failedRecoveryRace?.status, 'failed');
assert.equal(failedRecoveryRace?.errorCode, 'continuation_persisted_state_invalid');
assert.equal(recoveryRaceRemoveCount, 1);
await assert.rejects(lstat(join(recoveryRaceInputsDir, recoveryRaceJobId)), /ENOENT/);
recoveryRaceDatabase.close();
recoveryRaceRepository.close();

// A corrupt due input closes its generic admission Attempt, emits one logical terminal event,
// and does not prevent the next healthy due Job from being claimed.
const integrityRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-'));
const integrityDatabasePath = join(integrityRoot, 'jobs.sqlite');
const integrityArtifactsDir = join(integrityRoot, 'artifacts');
const integrityInputsDir = join(integrityRoot, 'inputs');
const corruptSource = join(integrityRoot, 'corrupt-source.txt');
const unreadableSource = join(integrityRoot, 'unreadable-source.txt');
const healthySource = join(integrityRoot, 'healthy-source.txt');
await writeFile(corruptSource, 'before tamper', 'utf8');
await writeFile(unreadableSource, 'unreadable', 'utf8');
await writeFile(healthySource, 'healthy', 'utf8');
const integrityRepository = await SqliteContinuationRepository.open({
  databasePath: integrityDatabasePath,
  artifactsDir: integrityArtifactsDir,
  inputsDir: integrityInputsDir,
  jitter: () => 0,
});
const unreadableCreated = await integrityRepository.create(createRequest('integrity-unreadable', {
  createdAt: '2026-07-16T23:59:57.000Z',
  sourceInputs: [{
    sourcePath: unreadableSource,
    fileName: 'unreadable.txt',
    kind: 'message_attachment',
  }],
}));
const corruptCreated = await integrityRepository.create(createRequest('integrity-corrupt', {
  createdAt: '2026-07-16T23:59:58.000Z',
  sourceInputs: [{ sourcePath: corruptSource, fileName: 'corrupt.txt', kind: 'message_attachment' }],
}));
const healthyCreated = await integrityRepository.create(createRequest('integrity-healthy', {
  createdAt: '2026-07-16T23:59:59.000Z',
  sourceInputs: [{ sourcePath: healthySource, fileName: 'healthy.txt', kind: 'message_attachment' }],
}));
const integrityStore = new ContinuationInputStore(integrityInputsDir);
const corruptManagedPath = integrityStore.resolve(
  corruptCreated.job.jobId,
  corruptCreated.job.sourceFacts.inputs[0].relativePath,
);
const unreadableManagedPath = integrityStore.resolve(
  unreadableCreated.job.jobId,
  unreadableCreated.job.sourceFacts.inputs[0].relativePath,
);
await chmod(unreadableManagedPath, 0o000);
await chmod(corruptManagedPath, 0o600);
await writeFile(corruptManagedPath, 'tampered', 'utf8');
await chmod(corruptManagedPath, 0o400);
integrityRepository.close();
const reopenedIntegrityRepository = await SqliteContinuationRepository.open({
  databasePath: integrityDatabasePath,
  artifactsDir: integrityArtifactsDir,
  inputsDir: integrityInputsDir,
  jitter: () => 0,
});
const healthyClaim = await reopenedIntegrityRepository.claimDue(
  'worker-after-integrity',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.equal(healthyClaim?.job.jobId, healthyCreated.job.jobId);
const unreadableJob = await reopenedIntegrityRepository.get(unreadableCreated.job.jobId);
assert.equal(unreadableJob?.status, 'failed');
assert.equal(unreadableJob?.errorCode, 'continuation_input_integrity_failed');
const corruptedJob = await reopenedIntegrityRepository.get(corruptCreated.job.jobId);
assert.equal(corruptedJob?.status, 'failed');
assert.equal(corruptedJob?.errorCode, 'continuation_input_integrity_failed');
assert.equal(corruptedJob?.attemptCount, 1);
assert.equal(corruptedJob?.leaseOwner, undefined);
assert.equal(corruptedJob?.leaseExpiresAt, undefined);
assert.equal(corruptedJob?.deliveryEvents?.filter((event) => event.kind === 'terminal').length, 1);
const unreadableDelivery = await reopenedIntegrityRepository.claimPendingDelivery(
  'delivery-unreadable-input',
  baseNow,
);
assert.equal(unreadableDelivery?.jobId, unreadableCreated.job.jobId);
await reopenedIntegrityRepository.markDeliveryResult(
  unreadableDelivery!,
  { status: 'delivered', messageId: 'om_unreadable_input_failure' },
  baseNow,
);
const integrityOutboxDatabase = new DatabaseSync(integrityDatabasePath);
integrityOutboxDatabase.prepare(`
  UPDATE durable_outbox SET route_json = ? WHERE run_id = ? AND kind = 'terminal'
`).run(JSON.stringify({
  kind: 'message_thread',
  conversationId: corruptCreated.job.route.kind === 'message_thread'
    ? corruptCreated.job.route.conversationId
    : '',
  sourceMessageId: corruptCreated.job.sourceMessageId,
  threadId: 'omt_wrong_outbox_thread',
}), corruptCreated.job.jobId);
assert.equal(await reopenedIntegrityRepository.claimPendingDelivery(
  'delivery-invalid-route',
  baseNow,
), null);
const invalidRouteOutbox = integrityOutboxDatabase.prepare(`
  SELECT status, error_code FROM continuation_outbox WHERE job_id = ? AND kind = 'terminal'
`).get(corruptCreated.job.jobId) as { status: string; error_code: string };
assert.equal(invalidRouteOutbox.status, 'failed');
assert.equal(invalidRouteOutbox.error_code, 'continuation_delivery_route_invalid');
integrityOutboxDatabase.prepare(`
  UPDATE durable_outbox
  SET route_json = ?, status = 'pending', error_code = NULL, error_summary = NULL
  WHERE run_id = ? AND kind = 'terminal'
`).run(JSON.stringify(corruptCreated.job.route), corruptCreated.job.jobId);
const validIntegrityPayload = integrityOutboxDatabase.prepare(`
  SELECT payload_json FROM durable_outbox
  WHERE run_id = ? AND kind = 'terminal'
`).get(corruptCreated.job.jobId)?.payload_json as string;
integrityOutboxDatabase.prepare(`
  UPDATE durable_outbox SET payload_json = json('{}')
  WHERE run_id = ? AND kind = 'terminal'
`).run(corruptCreated.job.jobId);
assert.equal(await reopenedIntegrityRepository.claimPendingDelivery(
  'delivery-invalid-envelope',
  baseNow,
), null);
const invalidEnvelopeOutbox = integrityOutboxDatabase.prepare(`
  SELECT status, error_code FROM continuation_outbox WHERE job_id = ? AND kind = 'terminal'
`).get(corruptCreated.job.jobId) as { status: string; error_code: string };
assert.equal(invalidEnvelopeOutbox.status, 'failed');
assert.equal(invalidEnvelopeOutbox.error_code, 'continuation_delivery_envelope_invalid');
integrityOutboxDatabase.prepare(`
  UPDATE durable_outbox
  SET payload_json = ?, status = 'pending', error_code = NULL, error_summary = NULL
  WHERE run_id = ? AND kind = 'terminal'
`).run(validIntegrityPayload, corruptCreated.job.jobId);
integrityOutboxDatabase.close();
const integrityDelivery = await reopenedIntegrityRepository.claimPendingDelivery(
  'delivery-integrity',
  baseNow,
);
assert.equal(integrityDelivery?.jobId, corruptCreated.job.jobId);
assert.doesNotMatch(integrityDelivery?.payload ?? '', /corrupt\.txt|continuation-integrity|tampered/i);
await reopenedIntegrityRepository.markDeliveryResult(
  integrityDelivery!,
  { status: 'delivered', messageId: 'om_integrity_failure' },
  baseNow,
);
assert.equal(
  (await reopenedIntegrityRepository.get(corruptCreated.job.jobId))?.deliveryEvents
    ?.filter((event) => event.kind === 'terminal').length,
  1,
);

const routeInvalidCleanupSource = join(integrityRoot, 'route-invalid-cleanup.txt');
await writeFile(routeInvalidCleanupSource, 'route invalid cleanup input', 'utf8');
const routeInvalidCleanupJob = await reopenedIntegrityRepository.create(createRequest(
  'route-invalid-terminal-cleanup',
  {
    sourceInputs: [{
      sourcePath: routeInvalidCleanupSource,
      fileName: 'cleanup.txt',
      kind: 'message_attachment',
    }],
  },
));
const routeInvalidCleanupArtifacts = new ContinuationArtifactStore(integrityArtifactsDir);
await writeFile(
  join(await routeInvalidCleanupArtifacts.ensure(routeInvalidCleanupJob.job.jobId), 'result.txt'),
  'route invalid result',
  'utf8',
);
assert.equal(await reopenedIntegrityRepository.requestCancel(
  routeInvalidCleanupJob.job.jobId,
  '2026-07-17T00:00:01.000Z',
), 'cancelled');
const routeInvalidCleanupDatabase = new DatabaseSync(integrityDatabasePath);
routeInvalidCleanupDatabase.prepare(`
  UPDATE durable_outbox SET route_json = ? WHERE run_id = ? AND kind = 'terminal'
`).run(JSON.stringify({
  ...routeInvalidCleanupJob.job.route,
  threadId: 'omt_route_invalid_cleanup',
}), routeInvalidCleanupJob.job.jobId);
routeInvalidCleanupDatabase.close();
assert.equal(await reopenedIntegrityRepository.claimPendingDelivery(
  'delivery-route-invalid-cleanup',
  '2026-07-17T00:00:01.000Z',
), null);
const routeInvalidStateDatabase = new DatabaseSync(integrityDatabasePath);
const routeInvalidState = routeInvalidStateDatabase.prepare(`
  SELECT j.status, j.completed_at, j.retain, o.status AS delivery_status,
         o.error_code AS delivery_error_code
  FROM continuation_jobs j
  JOIN continuation_outbox o ON o.job_id = j.job_id AND o.kind = 'terminal'
  WHERE j.job_id = ?
`).get(routeInvalidCleanupJob.job.jobId);
routeInvalidStateDatabase.close();
assert.deepEqual({ ...routeInvalidState }, {
  status: 'cancelled',
  completed_at: '2026-07-17T00:00:01.000Z',
  retain: 0,
  delivery_status: 'failed',
  delivery_error_code: 'continuation_delivery_route_invalid',
});
const routeInvalidCleanup = await reopenedIntegrityRepository.purgeExpired(
  '2026-07-17T00:00:02.000Z',
  '2026-07-17T00:00:03.000Z',
);
assert.ok(routeInvalidCleanup.some((entry) =>
  entry.jobId === routeInvalidCleanupJob.job.jobId && entry.result === 'cleaned'),
JSON.stringify(routeInvalidCleanup));
await assert.rejects(
  lstat(join(integrityInputsDir, routeInvalidCleanupJob.job.jobId)),
  /ENOENT/,
);
await assert.rejects(
  lstat(join(integrityArtifactsDir, routeInvalidCleanupJob.job.jobId)),
  /ENOENT/,
);
reopenedIntegrityRepository.close();

// Persistent input I/O failures become terminal integrity failures instead of starving scans.
const unavailableRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-unavailable-'));
const unavailableSource = join(unavailableRoot, 'source.txt');
await writeFile(unavailableSource, 'temporarily unreadable', 'utf8');
const unavailableInputsDir = join(unavailableRoot, 'inputs');
const unavailableRepository = await SqliteContinuationRepository.open({
  databasePath: join(unavailableRoot, 'jobs.sqlite'),
  artifactsDir: join(unavailableRoot, 'artifacts'),
  inputsDir: unavailableInputsDir,
});
const unavailableJob = await unavailableRepository.create(createRequest('integrity-unavailable', {
  sourceInputs: [{ sourcePath: unavailableSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
const unavailableStore = new ContinuationInputStore(unavailableInputsDir);
const unavailableManagedPath = unavailableStore.resolve(
  unavailableJob.job.jobId,
  unavailableJob.job.sourceFacts.inputs[0].relativePath,
);
await chmod(unavailableManagedPath, 0o000);
assert.equal(
  await unavailableRepository.claimDue(
    'worker-unavailable',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  ),
  null,
);
const failedAfterIoFailure = await unavailableRepository.get(unavailableJob.job.jobId);
assert.equal(failedAfterIoFailure?.status, 'failed');
assert.equal(failedAfterIoFailure?.errorCode, 'continuation_input_integrity_failed');
assert.equal(failedAfterIoFailure?.attemptCount, 1);
assert.equal(failedAfterIoFailure?.deliveryEvents?.length, 1);
await chmod(unavailableManagedPath, 0o400);
unavailableRepository.close();

async function makeDelayedInputStore(rootDir: string) {
  const delegate = new ContinuationInputStore(rootDir);
  let releaseVerification!: () => void;
  let markStarted!: () => void;
  const verificationStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
  return {
    store: {
      ensureRoot: () => delegate.ensureRoot(),
      withCreationLock: <T>(jobId: string, operation: () => Promise<T>) =>
        delegate.withCreationLock(jobId, operation),
      install: (...args: Parameters<ContinuationInputStore['install']>) => delegate.install(...args),
      clone: (...args: Parameters<ContinuationInputStore['clone']>) => delegate.clone(...args),
      async verify(...args: Parameters<ContinuationInputStore['verify']>) {
        markStarted();
        await verificationReleased;
        return delegate.verify(...args);
      },
      resolve: (...args: Parameters<ContinuationInputStore['resolve']>) => delegate.resolve(...args),
      remove: (...args: Parameters<ContinuationInputStore['remove']>) => delegate.remove(...args),
      quarantine: (...args: Parameters<ContinuationInputStore['quarantine']>) =>
        delegate.quarantine(...args),
      restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
        delegate.restoreQuarantine(...args),
      discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
        delegate.discardQuarantine(...args),
      cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
        delegate.cleanupOrphans(...args),
    },
    verificationStarted,
    releaseVerification,
  };
}

// Cancellation wins a row-version race while integrity verification is outside the transaction.
const cancelRaceRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-cancel-race-'));
const cancelRaceSource = join(cancelRaceRoot, 'source.txt');
await writeFile(cancelRaceSource, 'cancel race', 'utf8');
const cancelRaceOptions = {
  databasePath: join(cancelRaceRoot, 'jobs.sqlite'),
  artifactsDir: join(cancelRaceRoot, 'artifacts'),
  inputsDir: join(cancelRaceRoot, 'inputs'),
  jitter: () => 0,
};
const cancelRaceSeed = await SqliteContinuationRepository.open(cancelRaceOptions);
const cancelRaceJob = await cancelRaceSeed.create(createRequest('cancel-race', {
  sourceInputs: [{ sourcePath: cancelRaceSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
cancelRaceSeed.close();
const delayedCancelStore = await makeDelayedInputStore(cancelRaceOptions.inputsDir);
const cancelRaceClaimRepository = await SqliteContinuationRepository.open({
  ...cancelRaceOptions,
  inputStore: delayedCancelStore.store,
});
const cancelRaceMutationRepository = await SqliteContinuationRepository.open(cancelRaceOptions);
const pendingCancelClaim = cancelRaceClaimRepository.claimDue(
  'worker-cancel-race',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
await delayedCancelStore.verificationStarted;
assert.equal(
  await cancelRaceMutationRepository.requestCancel(cancelRaceJob.job.jobId, baseNow),
  'cancel_requested',
);
delayedCancelStore.releaseVerification();
assert.equal(await pendingCancelClaim, null);
const cancelledDuringVerification = await cancelRaceMutationRepository.get(cancelRaceJob.job.jobId);
assert.equal(cancelledDuringVerification?.status, 'cancelled');
assert.equal(cancelledDuringVerification?.attemptCount, 1);
assert.equal(cancelledDuringVerification?.deliveryEvents?.filter((event) => event.kind === 'terminal').length, 1);
cancelRaceClaimRepository.close();
cancelRaceMutationRepository.close();

// Expiry likewise wins the CAS and remains the sole terminal transition.
const expireRaceRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-expire-race-'));
const expireRaceSource = join(expireRaceRoot, 'source.txt');
await writeFile(expireRaceSource, 'expire race', 'utf8');
const expireRaceOptions = {
  databasePath: join(expireRaceRoot, 'jobs.sqlite'),
  artifactsDir: join(expireRaceRoot, 'artifacts'),
  inputsDir: join(expireRaceRoot, 'inputs'),
  jitter: () => 0,
};
const expireRaceSeed = await SqliteContinuationRepository.open(expireRaceOptions);
const expireRaceJob = await expireRaceSeed.create(createRequest('expire-race', {
  expiresAt: '2026-07-17T00:00:05.000Z',
  sourceInputs: [{ sourcePath: expireRaceSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
expireRaceSeed.close();
const delayedExpireStore = await makeDelayedInputStore(expireRaceOptions.inputsDir);
const expireRaceClaimRepository = await SqliteContinuationRepository.open({
  ...expireRaceOptions,
  inputStore: delayedExpireStore.store,
});
const expireRaceMutationRepository = await SqliteContinuationRepository.open(expireRaceOptions);
const pendingExpireClaim = expireRaceClaimRepository.claimDue(
  'worker-expire-race',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
await delayedExpireStore.verificationStarted;
assert.equal(
  await expireRaceMutationRepository.expireOverdue('2026-07-17T00:00:06.000Z'),
  1,
);
delayedExpireStore.releaseVerification();
assert.equal(await pendingExpireClaim, null);
const expiredDuringVerification = await expireRaceMutationRepository.get(expireRaceJob.job.jobId);
assert.equal(expiredDuringVerification?.status, 'failed');
assert.equal(expiredDuringVerification?.errorCode, 'continuation_expired');
assert.equal(expiredDuringVerification?.attemptCount, 1);
assert.equal(expiredDuringVerification?.deliveryEvents?.filter((event) => event.kind === 'terminal').length, 1);
expireRaceClaimRepository.close();
expireRaceMutationRepository.close();

// Two workers can verify the same candidate, but only one CAS creates an attempt and lease.
const claimRaceRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-claim-race-'));
const claimRaceSource = join(claimRaceRoot, 'source.txt');
await writeFile(claimRaceSource, 'claim race', 'utf8');
const claimRaceOptions = {
  databasePath: join(claimRaceRoot, 'jobs.sqlite'),
  artifactsDir: join(claimRaceRoot, 'artifacts'),
  inputsDir: join(claimRaceRoot, 'inputs'),
  jitter: () => 0,
};
const claimRaceA = await SqliteContinuationRepository.open(claimRaceOptions);
const claimRaceB = await SqliteContinuationRepository.open(claimRaceOptions);
const claimRaceJob = await claimRaceA.create(createRequest('claim-race', {
  sourceInputs: [{ sourcePath: claimRaceSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
const competingClaims = await Promise.all([
  claimRaceA.claimDue('worker-claim-a', baseNow, '2026-07-17T00:00:30.000Z'),
  claimRaceB.claimDue('worker-claim-b', baseNow, '2026-07-17T00:00:30.000Z'),
]);
assert.equal(competingClaims.filter(Boolean).length, 1);
assert.equal((await claimRaceA.get(claimRaceJob.job.jobId))?.attemptCount, 1);
claimRaceA.close();
claimRaceB.close();

// Claim-bound mutations fence identity, row version, owner, and lease in the repository.
const ownershipFenceRoot = await mkdtemp(join(tmpdir(), 'continuation-ownership-fence-'));
const ownershipFenceRepository = await SqliteContinuationRepository.open({
  databasePath: join(ownershipFenceRoot, 'jobs.sqlite'),
  artifactsDir: join(ownershipFenceRoot, 'artifacts'),
  jitter: () => 0,
});

const identityFenceJob = await ownershipFenceRepository.create(createRequest('identity-fence'));
const identityFenceClaim = await ownershipFenceRepository.claimDue(
  'worker-identity-fence',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.equal(identityFenceClaim?.job.jobId, identityFenceJob.job.jobId);
assert.ok(identityFenceClaim);
assert.equal(await ownershipFenceRepository.markExecutionStarted({
  ...identityFenceClaim,
  job: { ...identityFenceClaim.job, rowVersion: identityFenceClaim.job.rowVersion + 1 },
}, '2026-07-17T00:00:01.000Z'), 'stale');
assert.equal((await ownershipFenceRepository.get(identityFenceJob.job.jobId))?.status, 'running');
assert.equal(
  await ownershipFenceRepository.claimPendingDelivery(
    'delivery-identity-fence',
    '2026-07-17T00:00:01.000Z',
  ),
  null,
);
assert.equal(
  await ownershipFenceRepository.markExecutionStarted(
    identityFenceClaim,
    '2026-07-17T00:00:01.100Z',
  ),
  'committed',
);
assert.equal(await ownershipFenceRepository.failAttempt(identityFenceClaim, {
  errorCode: 'identity_fence_cleanup',
  errorSummary: 'Release the identity-fence claim.',
  retryable: true,
}, '2026-07-17T00:00:01.200Z'), 'committed');
const identityFenceCleanupDelivery = await ownershipFenceRepository.claimPendingDelivery(
  'delivery-identity-fence-cleanup',
  '2026-07-17T00:00:01.300Z',
);
assert.equal(identityFenceCleanupDelivery?.jobId, identityFenceJob.job.jobId);
assert.ok(identityFenceCleanupDelivery);
await ownershipFenceRepository.markDeliveryResult(
  identityFenceCleanupDelivery,
  { status: 'delivered', messageId: 'om_identity_fence_cleanup' },
  '2026-07-17T00:00:01.400Z',
);

const expiredMarkJob = await ownershipFenceRepository.create(createRequest('expired-mark-fence'));
const expiredMarkClaim = await ownershipFenceRepository.claimDue(
  'worker-expired-mark',
  '2026-07-17T00:00:02.000Z',
  '2026-07-17T00:00:03.000Z',
);
assert.equal(expiredMarkClaim?.job.jobId, expiredMarkJob.job.jobId);
assert.ok(expiredMarkClaim);
assert.equal(
  await ownershipFenceRepository.markExecutionStarted(
    expiredMarkClaim,
    '2026-07-17T00:00:04.000Z',
  ),
  'stale',
);
assert.equal((await ownershipFenceRepository.get(expiredMarkJob.job.jobId))?.status, 'running');
assert.equal(
  await ownershipFenceRepository.claimPendingDelivery(
    'delivery-expired-mark',
    '2026-07-17T00:00:04.000Z',
  ),
  null,
);
const expiredMarkRecovery = await recoverAndCommit(
  ownershipFenceRepository,
  '2026-07-17T00:00:04.000Z',
);
assert.equal(expiredMarkRecovery.length, 1);
assert.equal(expiredMarkRecovery[0]?.claim.run.runId, expiredMarkJob.job.jobId);

const expiredFailureJob = await ownershipFenceRepository.create(createRequest('expired-fail-fence'));
const expiredFailureClaim = await ownershipFenceRepository.claimDue(
  'worker-expired-fail',
  '2026-07-17T00:00:05.000Z',
  '2026-07-17T00:00:06.000Z',
);
assert.equal(expiredFailureClaim?.job.jobId, expiredFailureJob.job.jobId);
assert.ok(expiredFailureClaim);
assert.equal(await ownershipFenceRepository.failAttempt(expiredFailureClaim, {
  errorCode: 'must_not_commit',
  errorSummary: 'The expired owner must not persist this failure.',
  retryable: false,
}, '2026-07-17T00:00:07.000Z'), 'stale');
assert.equal((await ownershipFenceRepository.get(expiredFailureJob.job.jobId))?.status, 'running');
assert.equal(
  await ownershipFenceRepository.claimPendingDelivery(
    'delivery-expired-fail',
    '2026-07-17T00:00:07.000Z',
  ),
  null,
);
const expiredFailureRecovery = await recoverAndCommit(
  ownershipFenceRepository,
  '2026-07-17T00:00:07.000Z',
);
assert.equal(expiredFailureRecovery.length, 1);
assert.equal(expiredFailureRecovery[0]?.claim.run.runId, expiredFailureJob.job.jobId);

const staleCommitJob = await ownershipFenceRepository.create(createRequest('stale-commit-fence'));
const staleCommitClaim = await ownershipFenceRepository.claimDue(
  'worker-stale-commit',
  '2026-07-17T00:00:08.000Z',
  '2026-07-17T00:00:38.000Z',
);
assert.equal(staleCommitClaim?.job.jobId, staleCommitJob.job.jobId);
assert.ok(staleCommitClaim);
assert.equal(
  await ownershipFenceRepository.requestCancel(
    staleCommitJob.job.jobId,
    '2026-07-17T00:00:09.000Z',
  ),
  'cancel_requested',
);
assert.equal(await ownershipFenceRepository.completeStep(staleCommitClaim, {
  outcome: {
    outcome: 'completed',
    finalMessage: 'The stale completion must not win.',
    artifacts: [],
  },
}, '2026-07-17T00:00:10.000Z'), 'stale');
assert.equal(
  (await ownershipFenceRepository.get(staleCommitJob.job.jobId))?.status,
  'cancel_requested',
);
assert.equal(
  await ownershipFenceRepository.claimPendingDelivery(
    'delivery-stale-commit',
    '2026-07-17T00:00:10.000Z',
  ),
  null,
);
assert.equal(
  await ownershipFenceRepository.completeCancellation(
    staleCommitClaim,
    '2026-07-17T00:00:10.100Z',
  ),
  'committed',
);
assert.equal((await ownershipFenceRepository.get(staleCommitJob.job.jobId))?.status, 'cancelled');
ownershipFenceRepository.close();

// A successful heartbeat renews the persisted lease; completion and failure must not
// be rejected merely because the immutable claim still carries the original expiry.
const renewedLeaseRoot = await mkdtemp(join(tmpdir(), 'continuation-renewed-lease-'));
const renewedLeaseArtifacts = new ContinuationArtifactStore(join(renewedLeaseRoot, 'artifacts'));
const renewedLeaseRepository = await SqliteContinuationRepository.open({
  databasePath: join(renewedLeaseRoot, 'jobs.sqlite'),
  artifactsDir: join(renewedLeaseRoot, 'artifacts'),
  artifactStore: renewedLeaseArtifacts,
  jitter: () => 0,
});
const renewedCompletionJob = await renewedLeaseRepository.create(createRequest('renewed-complete-fence'));
const renewedCompletionClaim = await renewedLeaseRepository.claimDue(
  'worker-renewed-complete',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.ok(renewedCompletionClaim);
assert.equal(
  await renewedLeaseRepository.heartbeat(
    renewedCompletionJob.job.jobId,
    'worker-renewed-complete',
    '2026-07-17T00:00:10.000Z',
    '2026-07-17T00:00:40.000Z',
  ),
  true,
);
assert.equal(
  await renewedLeaseRepository.completeStep(renewedCompletionClaim, {
    outcome: {
      outcome: 'completed',
      checkpoint: await completedCheckpoint(
        renewedCompletionJob.job.jobId,
        'produce-result',
        'renewed-complete.json',
        renewedLeaseArtifacts,
      ),
      finalMessage: 'Completion committed under the renewed lease.',
      resultSummary: 'completed after heartbeat',
      artifacts: ['renewed-complete.json'],
    },
  }, '2026-07-17T00:00:35.000Z'),
  'committed',
);
assert.equal((await renewedLeaseRepository.get(renewedCompletionJob.job.jobId))?.status, 'completed');
const renewedDeliveryClaim = await renewedLeaseRepository.claimPendingDelivery(
  'worker-renewed-delivery',
  '2026-07-17T00:00:36.000Z',
  '2026-07-17T00:00:50.000Z',
);
assert.ok(renewedDeliveryClaim?.durableClaim);
assert.equal(
  renewedDeliveryClaim.durableClaim.leaseExpiresAt,
  '2026-07-17T00:00:50.000Z',
);
const renewedDeliveryHeartbeat = await renewedLeaseRepository.durableRuns.heartbeatDelivery?.(
  renewedDeliveryClaim.durableClaim,
  '2026-07-17T00:00:40.000Z',
  '2026-07-17T00:01:00.000Z',
);
assert.equal(renewedDeliveryHeartbeat?.leaseExpiresAt, '2026-07-17T00:01:00.000Z');

const renewedFailureJob = await renewedLeaseRepository.create(createRequest('renewed-fail-fence'));
const renewedFailureClaim = await renewedLeaseRepository.claimDue(
  'worker-renewed-fail',
  '2026-07-17T00:01:00.000Z',
  '2026-07-17T00:01:30.000Z',
);
assert.ok(renewedFailureClaim);
assert.equal(
  await renewedLeaseRepository.heartbeat(
    renewedFailureJob.job.jobId,
    'worker-renewed-fail',
    '2026-07-17T00:01:10.000Z',
    '2026-07-17T00:01:40.000Z',
  ),
  true,
);
assert.equal(
  await renewedLeaseRepository.failAttempt(renewedFailureClaim, {
    errorCode: 'renewed_lease_failure',
    errorSummary: 'Failure committed under the renewed lease.',
    retryable: false,
  }, '2026-07-17T00:01:35.000Z'),
  'committed',
);
assert.equal((await renewedLeaseRepository.get(renewedFailureJob.job.jobId))?.status, 'failed');
renewedLeaseRepository.close();

// The final completeStep transaction rechecks the lease after asynchronous verification.
const delayedCommitRoot = await mkdtemp(join(tmpdir(), 'continuation-delayed-commit-fence-'));
const delayedCommitStore = new DelayedArtifactStore(join(delayedCommitRoot, 'artifacts'));
const delayedCommitRepository = await SqliteContinuationRepository.open({
  databasePath: join(delayedCommitRoot, 'jobs.sqlite'),
  artifactsDir: join(delayedCommitRoot, 'artifacts'),
  artifactStore: delayedCommitStore,
  jitter: () => 0,
});
const delayedCommitJob = await delayedCommitRepository.create(createRequest('delayed-commit'));
const delayedCommitClaim = await delayedCommitRepository.claimDue(
  'worker-delayed-commit',
  baseNow,
  '2026-07-17T00:00:00.020Z',
);
assert.equal(delayedCommitClaim?.job.jobId, delayedCommitJob.job.jobId);
assert.ok(delayedCommitClaim);
const delayedCommitCheckpoint = await completedCheckpoint(
  delayedCommitJob.job.jobId,
  'produce-result',
  'artifact.json',
  delayedCommitStore,
);
const delayedCommit = delayedCommitRepository.completeStep(delayedCommitClaim, {
  outcome: {
    outcome: 'completed',
    checkpoint: delayedCommitCheckpoint,
    finalMessage: 'This completion crossed the lease deadline.',
    resultSummary: 'stale',
    artifacts: ['artifact.json'],
  },
}, baseNow);
await delayedCommitStore.verificationStarted;
await new Promise((resolve) => setTimeout(resolve, 35));
delayedCommitStore.release();
assert.equal(await delayedCommit, 'stale');
assert.equal((await delayedCommitRepository.get(delayedCommitJob.job.jobId))?.status, 'running');
assert.equal(
  await delayedCommitRepository.claimPendingDelivery(
    'delivery-delayed-commit',
    '2026-07-17T00:00:00.035Z',
  ),
  null,
);
delayedCommitRepository.close();

// A later integrity failure preserves prior attempts and adds no failed-gate attempt.
const priorAttemptRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-prior-attempt-'));
const priorAttemptSource = join(priorAttemptRoot, 'source.txt');
await writeFile(priorAttemptSource, 'prior attempt', 'utf8');
const priorAttemptInputsDir = join(priorAttemptRoot, 'inputs');
const priorAttemptRepository = await SqliteContinuationRepository.open({
  databasePath: join(priorAttemptRoot, 'jobs.sqlite'),
  artifactsDir: join(priorAttemptRoot, 'artifacts'),
  inputsDir: priorAttemptInputsDir,
  jitter: () => 0,
});
const priorAttemptJob = await priorAttemptRepository.create(createRequest('prior-attempt', {
  sourceInputs: [{ sourcePath: priorAttemptSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
const priorClaim = await priorAttemptRepository.claimDue(
  'worker-prior-attempt',
  baseNow,
  '2026-07-17T00:00:30.000Z',
);
assert.ok(priorClaim);
await priorAttemptRepository.failAttempt(priorClaim, {
  errorCode: 'transient_test',
  errorSummary: 'Retry later.',
  retryable: true,
}, baseNow);
const priorAttemptStore = new ContinuationInputStore(priorAttemptInputsDir);
const priorManagedPath = priorAttemptStore.resolve(
  priorAttemptJob.job.jobId,
  priorAttemptJob.job.sourceFacts.inputs[0].relativePath,
);
await chmod(priorManagedPath, 0o600);
await writeFile(priorManagedPath, 'tampered after attempt', 'utf8');
await chmod(priorManagedPath, 0o400);
assert.equal(await priorAttemptRepository.claimDue(
  'worker-prior-attempt-2',
  '2026-07-17T00:01:00.000Z',
  '2026-07-17T00:01:30.000Z',
), null);
const failedAfterPriorAttempt = await priorAttemptRepository.get(priorAttemptJob.job.jobId);
assert.equal(failedAfterPriorAttempt?.status, 'failed');
assert.equal(failedAfterPriorAttempt?.attemptCount, 2);
assert.equal(failedAfterPriorAttempt?.errorCode, 'continuation_input_integrity_failed');
priorAttemptRepository.close();

// Retry owns an actual copy, remains valid after source cleanup, and rejects a corrupt source tree.
const retryRoot = await mkdtemp(join(tmpdir(), 'continuation-retry-inputs-'));
const retrySourcePath = join(retryRoot, 'retry-source.txt');
await writeFile(retrySourcePath, 'retry input', 'utf8');
const retryInputsDir = join(retryRoot, 'inputs');
const retryArtifactsDir = join(retryRoot, 'artifacts');
const retryArtifactStore = new ContinuationArtifactStore(retryArtifactsDir);
const retryRepository = await SqliteContinuationRepository.open({
  databasePath: join(retryRoot, 'jobs.sqlite'),
  artifactsDir: retryArtifactsDir,
  artifactStore: retryArtifactStore,
  inputsDir: retryInputsDir,
  jitter: () => 0,
});
const retrySourceJob = await retryRepository.create(createRequest('retry-copy', {
  sourceInputs: [{ sourcePath: retrySourcePath, fileName: 'retry.txt', kind: 'message_attachment' }],
}));
await rm(retrySourcePath);
assert.equal(await retryRepository.requestCancel(retrySourceJob.job.jobId, baseNow), 'cancelled');
const retryClone = await retryRepository.cloneForRetry(
  retrySourceJob.job.jobId,
  'copy-request',
  '2026-07-17T00:00:01.000Z',
);
const retryStore = new ContinuationInputStore(retryInputsDir);
const originalManaged = retryStore.resolve(
  retrySourceJob.job.jobId,
  retrySourceJob.job.sourceFacts.inputs[0].relativePath,
);
const clonedManaged = retryStore.resolve(
  retryClone.jobId,
  retryClone.sourceFacts.inputs[0].relativePath,
);
assert.notEqual((await stat(originalManaged)).ino, (await stat(clonedManaged)).ino);
assert.equal(await readFile(clonedManaged, 'utf8'), 'retry input');
assert.equal(await retryRepository.redactTerminal(retrySourceJob.job.jobId, '2026-07-17T00:00:02.000Z'), true);
assert.deepEqual(await retryStore.verify(retryClone.jobId, retryClone.sourceFacts.inputs), { ok: true });
assert.equal((await retryRepository.cloneForRetry(
  retrySourceJob.job.jobId,
  'copy-request',
  '2026-07-17T00:00:03.000Z',
)).jobId, retryClone.jobId);

const resumableSource = await retryRepository.create(createRequest('retry-checkpoint-artifact'));
const resumableClaim = await retryRepository.claimDue(
  'worker-retry-checkpoint-artifact',
  '2026-07-17T00:00:04.000Z',
  '2026-07-17T00:01:04.000Z',
);
assert.equal(resumableClaim?.job.jobId, resumableSource.job.jobId);
const resumableCheckpoint = {
  ...await completedCheckpoint(
    resumableSource.job.jobId,
    'produce-result',
    'resume.json',
    retryArtifactStore,
  ),
  completedCriterionIds: [],
  remainingSteps: [{ id: 'deliver-result', description: 'Deliver the verified result.' }],
  nextAction: { id: 'deliver-result', description: 'Deliver the verified result.' },
  stopReason: 'Artifact is ready; delivery remains.',
};
await retryRepository.completeStep(resumableClaim!, {
  outcome: {
    outcome: 'partial',
    checkpoint: resumableCheckpoint,
    completedWork: ['Created and verified the result artifact.'],
    keyFindings: ['The artifact is ready for delivery.'],
    unperformedWork: ['Deliver the verified result.'],
    risks: [],
    nextSteps: ['Deliver the verified result.'],
    artifacts: ['resume.json'],
  },
}, '2026-07-17T00:00:05.000Z');
const resumableClone = await retryRepository.cloneForRetry(
  resumableSource.job.jobId,
  'checkpoint-artifact-copy',
  '2026-07-17T00:00:06.000Z',
);
assert.deepEqual(resumableClone.checkpoint, resumableCheckpoint);
const originalArtifact = retryArtifactStore.resolve(resumableSource.job.jobId, 'resume.json');
const clonedArtifact = retryArtifactStore.resolve(resumableClone.jobId, 'resume.json');
assert.notEqual((await stat(originalArtifact)).ino, (await stat(clonedArtifact)).ino);
assert.equal(await readFile(clonedArtifact, 'utf8'), await readFile(originalArtifact, 'utf8'));

const corruptRetrySourcePath = join(retryRoot, 'corrupt-retry-source.txt');
await writeFile(corruptRetrySourcePath, 'corrupt retry input', 'utf8');
const corruptRetrySource = await retryRepository.create(createRequest('retry-corrupt', {
  sourceInputs: [{
    sourcePath: corruptRetrySourcePath,
    fileName: 'corrupt-retry.txt',
    kind: 'message_attachment',
  }],
}));
assert.equal(await retryRepository.requestCancel(corruptRetrySource.job.jobId, baseNow), 'cancelled');
const corruptRetryManaged = retryStore.resolve(
  corruptRetrySource.job.jobId,
  corruptRetrySource.job.sourceFacts.inputs[0].relativePath,
);
await chmod(corruptRetryManaged, 0o600);
await writeFile(corruptRetryManaged, 'changed', 'utf8');
await chmod(corruptRetryManaged, 0o400);
await assert.rejects(
  retryRepository.cloneForRetry(
    corruptRetrySource.job.jobId,
    'corrupt-copy-request',
    '2026-07-17T00:00:03.000Z',
  ),
  /integrity/i,
);
retryRepository.close();

// Retry binds the copy to the checksum/size verified before creation, so a verify/copy race fails.
const toctouRoot = await mkdtemp(join(tmpdir(), 'continuation-retry-toctou-'));
const toctouSource = join(toctouRoot, 'source.txt');
await writeFile(toctouSource, 'toctou original', 'utf8');
const toctouOptions = {
  databasePath: join(toctouRoot, 'jobs.sqlite'),
  artifactsDir: join(toctouRoot, 'artifacts'),
  inputsDir: join(toctouRoot, 'inputs'),
};
const toctouSeed = await SqliteContinuationRepository.open(toctouOptions);
const toctouJob = await toctouSeed.create(createRequest('retry-toctou', {
  sourceInputs: [{ sourcePath: toctouSource, fileName: 'source.txt', kind: 'message_attachment' }],
}));
assert.equal(await toctouSeed.requestCancel(toctouJob.job.jobId, baseNow), 'cancelled');
toctouSeed.close();
const toctouDelegate = new ContinuationInputStore(toctouOptions.inputsDir);
let toctouTampered = false;
const toctouRepository = await SqliteContinuationRepository.open({
  ...toctouOptions,
  inputStore: {
    ensureRoot: () => toctouDelegate.ensureRoot(),
    withCreationLock: <T>(jobId: string, operation: () => Promise<T>) =>
      toctouDelegate.withCreationLock(jobId, operation),
    install: (...args: Parameters<ContinuationInputStore['install']>) => toctouDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) => toctouDelegate.clone(...args),
    async verify(jobId, artifacts) {
      const result = await toctouDelegate.verify(jobId, artifacts);
      if (result.ok && !toctouTampered && artifacts[0]) {
        const managedPath = toctouDelegate.resolve(jobId, artifacts[0].relativePath);
        await chmod(managedPath, 0o600);
        await writeFile(managedPath, 'toctou mutated after verify', 'utf8');
        await chmod(managedPath, 0o400);
        toctouTampered = true;
      }
      return result;
    },
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) => toctouDelegate.resolve(...args),
    remove: (...args: Parameters<ContinuationInputStore['remove']>) => toctouDelegate.remove(...args),
    quarantine: (...args: Parameters<ContinuationInputStore['quarantine']>) =>
      toctouDelegate.quarantine(...args),
    restoreQuarantine: (...args: Parameters<ContinuationInputStore['restoreQuarantine']>) =>
      toctouDelegate.restoreQuarantine(...args),
    discardQuarantine: (...args: Parameters<ContinuationInputStore['discardQuarantine']>) =>
      toctouDelegate.discardQuarantine(...args),
    cleanupOrphans: (...args: Parameters<ContinuationInputStore['cleanupOrphans']>) =>
      toctouDelegate.cleanupOrphans(...args),
  },
});
await assert.rejects(
  toctouRepository.cloneForRetry(
    toctouJob.job.jobId,
    'toctou-copy-request',
    '2026-07-17T00:00:05.000Z',
  ),
  /integrity|checksum|size/i,
);
const toctouTargetJobId = continuationJobId(`manual-retry:${toctouJob.job.jobId}:toctou-copy-request`);
assert.equal(await toctouRepository.get(toctouTargetJobId), null);
await assert.rejects(lstat(join(toctouOptions.inputsDir, toctouTargetJobId)));
toctouRepository.close();

// Recoverable user interrupts are durable, delivered once, and resume the same Job atomically.
const interruptRoot = await mkdtemp(join(tmpdir(), 'continuation-interrupt-'));
const interruptOptions = {
  databasePath: join(interruptRoot, 'jobs.sqlite'),
  artifactsDir: join(interruptRoot, 'artifacts'),
  jitter: () => 0,
};
let interruptRepository = await SqliteContinuationRepository.open(interruptOptions);
const interrupted = await interruptRepository.create(createRequest('waiting-user'));
const interruptedClaim = await interruptRepository.claimDue(
  'worker-interrupt',
  baseNow,
  '2026-07-17T00:01:00.000Z',
);
assert.equal(interruptedClaim?.job.jobId, interrupted.job.jobId);
await interruptRepository.completeStep(interruptedClaim!, {
  outcome: {
    outcome: 'waiting_user',
    checkpoint: progressCheckpoint({
      summary: 'Publication needs authorization.',
      currentStepId: 'publish-result',
      remainingSteps: [{ id: 'publish-result', description: 'Publish the result.' }],
      nextAction: { id: 'publish-result', description: 'Publish the result.' },
    }),
    failure: {
      category: 'permission_required',
      retrySafety: 'unsafe',
      capabilityAvailable: true,
      operationRisk: 'external_side_effect',
      hints: ['Authorize publication, then resume.'],
      failedStep: 'publish-result',
      diagnostic: 'Publication requires authorization.',
      fingerprint: 'permission-publish',
    },
    prompt: 'Authorize publication, then resume with the approval result.',
    reason: 'Publication requires authorization.',
  },
}, '2026-07-17T00:00:01.000Z');
let waitingUser = await interruptRepository.get(interrupted.job.jobId);
assert.equal(waitingUser?.status, 'waiting_user');
assert.equal(waitingUser?.recovery?.totalAttempts, 1);
assert.equal(waitingUser?.recovery?.fingerprintAttempts, 1);
assert.equal(waitingUser?.currentInterrupt?.status, 'pending');
const interruptId = waitingUser?.currentInterrupt?.interruptId;
assert.ok(interruptId);

const interruptDelivery = await interruptRepository.claimPendingDelivery(
  'delivery-interrupt',
  '2026-07-17T00:00:02.000Z',
);
assert.equal(interruptDelivery?.kind, 'interrupt');
assert.equal(interruptDelivery?.interruptId, interruptId);
assert.match(interruptDelivery?.payload ?? '', /Failed step: publish-result/);
assert.match(interruptDelivery?.payload ?? '', /Failure category: permission_required/);
assert.match(interruptDelivery?.payload ?? '', /Recovery attempts: 1 for this failure, 1 total/);
assert.match(interruptDelivery?.payload ?? '', /Diagnostic: Publication requires authorization\./);
await interruptRepository.markDeliveryResult(
  interruptDelivery!,
  { status: 'delivered', messageId: 'om_interrupt_prompt' },
  '2026-07-17T00:00:03.000Z',
);
interruptRepository.close();

interruptRepository = await SqliteContinuationRepository.open(interruptOptions);
waitingUser = await interruptRepository.get(interrupted.job.jobId);
assert.equal(waitingUser?.currentInterrupt?.deliveredMessageId, 'om_interrupt_prompt');
assert.deepEqual(await interruptRepository.listPendingInterrupts(), [{
  interruptId,
  jobId: interrupted.job.jobId,
  route: interrupted.job.route,
  deliveredMessageId: 'om_interrupt_prompt',
}]);
const maxResumeInput = '😀'.repeat(4_096);
assert.equal(await interruptRepository.resumeWaitingUser(
  interrupted.job.jobId,
  interruptId!,
  maxResumeInput,
  '2026-07-17T00:00:04.000Z',
), 'resumed');
assert.equal(await interruptRepository.resumeWaitingUser(
  interrupted.job.jobId,
  interruptId!,
  'Duplicate input must lose.',
  '2026-07-17T00:00:05.000Z',
), 'stale');
const resumed = await interruptRepository.get(interrupted.job.jobId);
assert.equal(resumed?.status, 'recovering');
assert.equal(resumed?.recovery?.userInput, maxResumeInput);
assert.equal(resumed?.recovery?.lastDecision, 'retry');
const resumedClaim = await interruptRepository.claimDue(
  'worker-resumed',
  '2026-07-17T00:00:04.000Z',
  '2026-07-17T00:01:04.000Z',
);
assert.equal(resumedClaim?.job.jobId, interrupted.job.jobId);
await interruptRepository.completeStep(resumedClaim!, {
  outcome: {
    outcome: 'completed',
    checkpoint: await completedCheckpoint(
      interrupted.job.jobId,
      'publish-result',
      'artifact.json',
      new ContinuationArtifactStore(interruptOptions.artifactsDir),
    ),
    finalMessage: 'Publication completed after authorization.',
    artifacts: ['artifact.json'],
  },
}, '2026-07-17T00:00:05.000Z');
const completedAfterResume = await interruptRepository.get(interrupted.job.jobId);
assert.equal(completedAfterResume?.status, 'completed');
assert.equal(completedAfterResume?.recovery, undefined);
assert.equal(completedAfterResume?.recoveryTotalCount, 1);
interruptRepository.close();

// v8 did not persist execution phase. Treat unfinished attempts as execution_started
// so migration never blindly replays a potentially completed external operation.
const activeMigrationRoot = await mkdtemp(join(tmpdir(), 'continuation-v8-active-migration-'));
const activeMigrationOptions = {
  databasePath: join(activeMigrationRoot, 'jobs.sqlite'),
  artifactsDir: join(activeMigrationRoot, 'artifacts'),
  jitter: () => 0,
};
const activeMigrationFixture = await seedHistoricalContinuationDatabase({
  databasePath: activeMigrationOptions.databasePath,
  now: baseNow,
  version: 8,
  workingDirectory: activeMigrationRoot,
});
const activeMigrationDatabase = new DatabaseSync(activeMigrationOptions.databasePath);
activeMigrationDatabase.prepare(`
  UPDATE continuation_jobs
  SET status = 'running', execution_session_id = 'session-v8-active',
      lease_owner = 'worker-v8-active', lease_expires_at = ?, heartbeat_at = ?,
      result_summary = NULL, result_artifacts_json = '[]', error_code = NULL,
      error_summary = NULL, completed_at = NULL, deleted_at = NULL
  WHERE job_id = ?
`).run(
  '2026-07-17T00:00:05.000Z',
  baseNow,
  activeMigrationFixture.terminalJobId,
);
activeMigrationDatabase.prepare(`
  UPDATE continuation_attempts
  SET worker_id = 'worker-v8-active', execution_session_id = 'session-v8-active',
      heartbeat_at = ?, finished_at = NULL, outcome = NULL,
      error_code = NULL, error_summary = NULL
  WHERE attempt_id = ?
`).run(baseNow, activeMigrationFixture.terminalAttemptId);
activeMigrationDatabase.close();
const activeMigrationRepository = await SqliteContinuationRepository.open(activeMigrationOptions);
const activeMigrationRecovery = await recoverAndCommit(
  activeMigrationRepository,
  '2026-07-17T00:00:06.000Z',
);
assert.equal(activeMigrationRecovery.length, 1);
assert.equal(activeMigrationRecovery[0]?.claim.run.runId, activeMigrationFixture.terminalJobId);
assert.equal(activeMigrationRecovery[0]?.executionPhase, 'execution_started');
assert.equal(
  (await activeMigrationRepository.get(activeMigrationFixture.terminalJobId))?.status,
  'waiting_user',
);
activeMigrationRepository.close();

const failedToolRoot = await mkdtemp(join(tmpdir(), 'continuation-failed-tool-replay-'));
const failedToolRepository = await SqliteContinuationRepository.open({
  databasePath: join(failedToolRoot, 'jobs.sqlite'),
  artifactsDir: join(failedToolRoot, 'artifacts'),
});
const failedToolRequest = createRequest('failed-tool-replay');
const failedToolPermissions = {
  ...failedToolRequest.permissions,
  hostTools: ['generic_cli'],
};
failedToolRequest.requiredTools = ['generic_cli'];
failedToolRequest.permissions = failedToolPermissions;
failedToolRequest.sourceFacts = {
  ...failedToolRequest.sourceFacts,
  permissions: failedToolPermissions,
};
const failedToolJob = await failedToolRepository.create(failedToolRequest);
const failedToolClaim = await failedToolRepository.claimDue(
  'worker-failed-tool',
  baseNow,
  '2026-07-17T00:01:00.000Z',
);
assert.equal(failedToolClaim?.job.jobId, failedToolJob.job.jobId);
const staleToolRequest = { tool: 'generic_cli', args: ['stale-form'] };
const firstFailedCall = await failedToolRepository.beginToolCall(
  failedToolClaim!,
  staleToolRequest,
  '2026-07-17T00:00:01.000Z',
);
assert.equal(firstFailedCall.status, 'execute');
const persistedInvalidInvocation = {
  ok: false,
  message: 'The invocation was rejected before execution.',
  failure: {
    category: 'invalid_invocation' as const,
    retrySafety: 'safe' as const,
    capabilityAvailable: true,
    operationRisk: 'external_side_effect' as const,
    hints: ['Use corrected-form.'],
    failedStep: 'initial-step',
    diagnostic: 'The invocation was rejected before execution.',
    fingerprint: 'failed-tool-replay',
  },
};
await failedToolRepository.completeToolCall(
  failedToolClaim!,
  firstFailedCall.status === 'execute' ? firstFailedCall.callId : '',
  persistedInvalidInvocation,
  '2026-07-17T00:00:02.000Z',
);
assert.deepEqual(await failedToolRepository.beginToolCall(
  failedToolClaim!,
  staleToolRequest,
  '2026-07-17T00:00:03.000Z',
), {
  status: 'replay',
  callId: firstFailedCall.status === 'execute' ? firstFailedCall.callId : '',
  result: persistedInvalidInvocation,
});
assert.equal((await failedToolRepository.beginToolCall(
  failedToolClaim!,
  { tool: 'generic_cli', args: ['corrected-form'] },
  '2026-07-17T00:00:04.000Z',
)).status, 'execute');
failedToolRepository.close();

// A safe transient recovery retries the same request, while invalid invocations require correction.
const transientToolRoot = await mkdtemp(join(tmpdir(), 'continuation-transient-tool-retry-'));
const transientToolRepository = await SqliteContinuationRepository.open({
  databasePath: join(transientToolRoot, 'jobs.sqlite'),
  artifactsDir: join(transientToolRoot, 'artifacts'),
  jitter: () => 0,
});
const transientRequest = createRequest('transient-tool-retry');
const transientPermissions = {
  ...transientRequest.permissions,
  hostTools: ['generic_cli'],
};
transientRequest.requiredTools = ['generic_cli'];
transientRequest.permissions = transientPermissions;
transientRequest.sourceFacts = {
  ...transientRequest.sourceFacts,
  permissions: transientPermissions,
};
const transientJob = await transientToolRepository.create(transientRequest);
const firstTransientClaim = await transientToolRepository.claimDue(
  'worker-transient-tool-1',
  baseNow,
  '2026-07-17T00:01:00.000Z',
);
assert.equal(firstTransientClaim?.job.jobId, transientJob.job.jobId);
const repeatedTransientRequest = { tool: 'generic_cli', args: ['fetch'] };
const firstTransientCall = await transientToolRepository.beginToolCall(
  firstTransientClaim!,
  repeatedTransientRequest,
  '2026-07-17T00:00:01.000Z',
);
assert.equal(firstTransientCall.status, 'execute');
const transientFailure = {
  category: 'transient' as const,
  retrySafety: 'safe' as const,
  capabilityAvailable: true,
  operationRisk: 'read_only' as const,
  hints: ['Retry after a short delay.'],
  failedStep: 'initial-step',
  diagnostic: 'The upstream service temporarily failed.',
  fingerprint: 'transient-tool-retry',
};
await transientToolRepository.completeToolCall(
  firstTransientClaim!,
  firstTransientCall.status === 'execute' ? firstTransientCall.callId : '',
  { ok: false, message: 'Temporary upstream failure.', failure: transientFailure },
  '2026-07-17T00:00:02.000Z',
);
await transientToolRepository.completeStep(firstTransientClaim!, {
  outcome: {
    outcome: 'recovering',
    checkpoint: progressCheckpoint({
      summary: 'The read-only fetch will be retried.',
      currentStepId: 'initial-step',
      remainingSteps: [{ id: 'initial-step', description: 'Fetch the upstream data.' }],
      nextAction: { id: 'initial-step', description: 'Fetch the upstream data.' },
    }),
    failure: transientFailure,
    delaySeconds: 0,
    reason: 'The transient failure is safe to retry.',
  },
}, '2026-07-17T00:00:03.000Z');
const secondTransientClaim = await transientToolRepository.claimDue(
  'worker-transient-tool-2',
  '2026-07-17T00:00:03.000Z',
  '2026-07-17T00:01:03.000Z',
);
assert.equal(secondTransientClaim?.job.jobId, transientJob.job.jobId);
const retriedTransientCall = await transientToolRepository.beginToolCall(
  secondTransientClaim!,
  repeatedTransientRequest,
  '2026-07-17T00:00:04.000Z',
);
assert.equal(retriedTransientCall.status, 'execute');
assert.equal(
  retriedTransientCall.status === 'execute' ? retriedTransientCall.callId : '',
  firstTransientCall.status === 'execute' ? firstTransientCall.callId : '',
);
transientToolRepository.close();

// Terminal recovery decisions retain normalized diagnostics in both Job state and final delivery.
for (const terminalCase of [
  {
    suffix: 'terminal-recovery-blocked',
    expectedStatus: 'blocked',
    expectedDecision: 'block',
    failure: {
      category: 'capability_unavailable' as const,
      retrySafety: 'safe' as const,
      capabilityAvailable: false,
      operationRisk: 'read_only' as const,
      hints: ['Install the configured capability.'],
      failedStep: 'inspect-result',
      diagnostic: 'The configured capability is unavailable.',
      fingerprint: 'capability-inspect-result',
    },
  },
  {
    suffix: 'terminal-recovery-failed',
    expectedStatus: 'failed',
    expectedDecision: 'fail',
    failure: {
      category: 'terminal' as const,
      retrySafety: 'unsafe' as const,
      capabilityAvailable: true,
      operationRisk: 'external_side_effect' as const,
      hints: ['Inspect the terminal failure before retrying.'],
      failedStep: 'publish-result',
      diagnostic: 'The operation failed terminally.',
      fingerprint: 'terminal-publish-result',
    },
  },
] as const) {
  const terminalRoot = await mkdtemp(join(tmpdir(), `${terminalCase.suffix}-`));
  const terminalRepository = await SqliteContinuationRepository.open({
    databasePath: join(terminalRoot, 'jobs.sqlite'),
    artifactsDir: join(terminalRoot, 'artifacts'),
    jitter: () => 0,
  });
  const terminalJob = await terminalRepository.create(createRequest(terminalCase.suffix));
  const terminalClaim = await terminalRepository.claimDue(
    `worker-${terminalCase.suffix}`,
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.equal(terminalClaim?.job.jobId, terminalJob.job.jobId);
  const checkpoint = progressCheckpoint({
    summary: 'Work stopped at a durable terminal failure.',
    currentStepId: terminalCase.failure.failedStep,
    remainingSteps: [{
      id: terminalCase.failure.failedStep,
      description: 'Resolve the terminal failure.',
    }],
    nextAction: {
      id: terminalCase.failure.failedStep,
      description: 'Resolve the terminal failure.',
    },
  });
  await terminalRepository.completeStep(terminalClaim!, {
    outcome: terminalCase.expectedStatus === 'blocked'
      ? {
          outcome: 'blocked',
          checkpoint,
          errorCode: 'continuation_capability_unavailable',
          errorSummary: 'The required capability is unavailable.',
          requiredCapability: 'generic_cli',
          completedWork: [],
          unperformedWork: ['Resolve the terminal failure.'],
          recoveryFailure: terminalCase.failure,
        }
      : {
          outcome: 'failed',
          checkpoint,
          errorCode: 'continuation_recovery_failed',
          errorSummary: 'The operation cannot be recovered automatically.',
          retryable: false,
          completedWork: [],
          unperformedWork: ['Resolve the terminal failure.'],
          recoveryFailure: terminalCase.failure,
        },
  }, '2026-07-17T00:00:01.000Z');
  const persistedTerminal = await terminalRepository.get(terminalJob.job.jobId);
  assert.equal(persistedTerminal?.status, terminalCase.expectedStatus);
  assert.equal(persistedTerminal?.recovery?.lastDecision, terminalCase.expectedDecision);
  assert.equal(persistedTerminal?.recovery?.failure.category, terminalCase.failure.category);
  assert.equal(persistedTerminal?.recoveryTotalCount, 1);
  const terminalDelivery = await terminalRepository.claimPendingDelivery(
    `delivery-${terminalCase.suffix}`,
    '2026-07-17T00:00:02.000Z',
  );
  assert.equal(terminalDelivery?.kind, 'terminal');
  assert.match(terminalDelivery?.payload ?? '', new RegExp(`Failed step: ${terminalCase.failure.failedStep}`));
  assert.match(terminalDelivery?.payload ?? '', new RegExp(`Failure category: ${terminalCase.failure.category}`));
  assert.match(terminalDelivery?.payload ?? '', /Recovery attempts: 1 for this failure, 1 total/);
  assert.match(terminalDelivery?.payload ?? '', new RegExp(`Diagnostic: ${terminalCase.failure.diagnostic}`));
  terminalRepository.close();
}

console.log('continuation repository smoke: PASS');
