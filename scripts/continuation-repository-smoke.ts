import assert from 'node:assert/strict';
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
import { Worker } from 'node:worker_threads';
import { seedHistoricalContinuationDatabase } from './fixtures/continuation-historical-schema.js';
import type {
  AsyncTaskFactSnapshot,
  AsyncTaskContract,
  ContinuationCreateRequest,
} from '../src/domain/continuation.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import {
  ContinuationInputStore,
  continuationJobId,
} from '../src/continuation/input-store.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';

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

const root = await mkdtemp(join(tmpdir(), 'continuation-repository-'));
const databasePath = join(root, 'runtime', 'jobs.sqlite');
const artifactsDir = join(root, 'runtime', 'artifacts');
const baseNow = '2026-07-17T00:00:00.000Z';

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

  const first = await repository.create(createRequest('first'));
  assert.equal(first.created, true);
  assert.match(first.job.jobId, /^job_[a-f0-9]{24}$/);
  assert.equal(first.job.status, 'queued');
  assert.equal(first.job.rowVersion, 1);
  assert.deepEqual(first.job.permissions, createRequest('first').permissions);

  const duplicate = await secondRepository.create(createRequest('first'));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.jobId, first.job.jobId);

  assert.equal((await repository.listByCreator('ou_creator', 10)).length, 1);
  assert.equal((await repository.listByCreator('ou_other', 10)).length, 0);
  assert.equal((await repository.listAll(10)).length, 1);

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
      checkpoint: {
        summary: 'First slice complete',
        completedSteps: ['inspect inputs'],
        remainingSteps: ['produce result'],
        constraints: ['do not publish'],
        decisions: ['use local data'],
        references: ['artifact.json'],
      },
      nextStep: 'produce result',
      resumeAfterSeconds: 0,
    },
  }, '2026-07-17T00:00:11.000Z');
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
  const recovered = await repository.recoverExpiredLeases('2026-07-17T00:00:31.000Z');
  assert.equal(recovered, 1);
  assert.equal((await repository.get(concurrent.job.jobId))?.status, 'waiting_retry');

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
  await assert.rejects(
    repository.completeStep(runningCancelClaim, {
      outcome: {
        outcome: 'completed',
        finalMessage: 'must not win cancellation',
        artifacts: [],
      },
    }, '2026-07-17T00:00:22.000Z'),
    /stale continuation claim/i,
  );
  await repository.completeCancellation(runningCancelClaim, '2026-07-17T00:00:23.000Z');
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
  rawDatabase.prepare('UPDATE continuation_jobs SET permissions_json = ? WHERE job_id = ?').run(
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
} finally {
  secondRepository.close();
  repository.close();
}

const migrationDatabasePath = join(root, 'migration', 'jobs.sqlite');
const migrationArtifactsDir = join(root, 'migration', 'artifacts');
const migrationSeed = await SqliteContinuationRepository.open({
  databasePath: migrationDatabasePath,
  artifactsDir: migrationArtifactsDir,
});
const legacyWorkingDirectory = join(root, 'legacy-working-directory');
await import('node:fs/promises').then(({ mkdir }) => mkdir(legacyWorkingDirectory));
const legacyV2Job = await migrationSeed.create(createRequest('legacy-v2', {
  workingDirectory: legacyWorkingDirectory,
  requiredTools: ['lark_cli'],
  permissions: {
    profile: 'bounded',
    filesystem: { root: root, mode: 'read-only', requestedPaths: [] },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  },
}));
migrationSeed.close();
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
        checkpoint: {
          summary: `Attempt ${ordinal} checkpoint`,
          completedSteps: [`completed ${ordinal}`],
          remainingSteps: ['finish the remaining work'],
          constraints: ['stay within the attempt budget'],
          decisions: ['preserve the checkpoint'],
          references: ['result.md'],
        },
        nextStep: 'finish the remaining work',
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
      checkpoint: {
        summary: 'A progress delivery is in flight.',
        completedSteps: ['completed one bounded step'],
        remainingSteps: ['finish the task'],
        constraints: [],
        decisions: [],
        references: [],
      },
      nextStep: 'finish the task',
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
    outcome: { outcome: 'completed', finalMessage: 'Done.', artifacts: ['report.txt'] },
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
  await writeFile(join(cleanupArtifactRoot, 'report.txt'), 'result', 'utf-8');

  const retainedJob = await retentionRepository.create(createRequest('retention-retained'));
  const retainedClaim = await retentionRepository.claimDue(
    'worker-retention-retained',
    baseNow,
    '2026-07-17T00:01:00.000Z',
  );
  assert.ok(retainedClaim);
  await retentionRepository.completeStep(retainedClaim, {
    outcome: { outcome: 'completed', finalMessage: 'Retained.', artifacts: [] },
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
    outcome: { outcome: 'completed', finalMessage: 'Not delivered.', artifacts: [] },
  }, '2026-07-17T00:00:10.000Z');
  const nonterminalJob = await retentionRepository.create(createRequest('retention-nonterminal'));

  const cleanupResults = await retentionRepository.purgeExpired(
    '2026-07-18T00:00:00.000Z',
    '2026-07-20T00:00:00.000Z',
  );
  assert.deepEqual(cleanupResults, [{
    jobId: cleanupJob.job.jobId,
    creatorOpenId: 'ou_creator',
    status: 'completed',
    completedAt: '2026-07-17T00:00:03.000Z',
    result: 'cleaned',
  }]);
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
    outcome: { outcome: 'completed', finalMessage: 'Retry cleanup.', artifacts: ['retry.txt'] },
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
  await writeFile(join(failedCleanupArtifactRoot, 'retry.txt'), 'retry', 'utf-8');
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
  await retentionRepository.markDeliveryResult(
    heldUndeliveredDelivery!,
    { status: 'delivered', messageId: 'om_retention_undelivered' },
    '2026-07-20T00:00:02.000Z',
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
    'hash_legacy_v3', 'completed', '{"ok":true,"message":"legacy"}',
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
} finally {
  authenticVersionTwoRepository.close();
}
const authenticVersionTwoMigratedDatabase = new DatabaseSync(authenticVersionTwoDatabasePath);
assert.equal(Number(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_attempts WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
assert.equal(Number(authenticVersionTwoMigratedDatabase.prepare(
  'SELECT COUNT(*) AS count FROM continuation_tool_calls WHERE job_id = ?',
).get('job_legacy_v3')?.count), 1);
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
assert.equal(Number(migratedVersionThreeDatabase.prepare('PRAGMA user_version').get()?.user_version), 7);
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
  assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get()?.user_version), 7);
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
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), 7);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
}

await verifyConcurrentHistoricalMigration(1);
await verifyConcurrentHistoricalMigration(4);
await verifyConcurrentHistoricalMigration(5);

const versionTwoDatabase = new DatabaseSync(migrationDatabasePath);
const v2Columns = versionTwoDatabase.prepare('PRAGMA table_info(continuation_jobs)').all() as Array<{ name: string }>;
if (v2Columns.some((column) => column.name === 'permissions_json')) {
  versionTwoDatabase.exec('ALTER TABLE continuation_jobs DROP COLUMN permissions_json;');
}
versionTwoDatabase.exec('PRAGMA user_version = 2;');
versionTwoDatabase.close();
const migratedRepository = await SqliteContinuationRepository.open({
  databasePath: migrationDatabasePath,
  artifactsDir: migrationArtifactsDir,
});
try {
  await migratedRepository.healthCheck();
  assert.deepEqual((await migratedRepository.get(legacyV2Job.job.jobId))?.permissions, {
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
assert.equal(Number(migratedVersionOneDatabase.prepare('PRAGMA user_version').get()?.user_version), 7);
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
const versionSixSeed = await SqliteContinuationRepository.open({
  databasePath: versionSixDatabasePath,
  artifactsDir: versionSixArtifactsDir,
});
const legacyV6Job = await versionSixSeed.create(createRequest('legacy-v6', {
  taskContract: {
    ...createRequest('legacy-v6').taskContract,
    acceptanceCriteria: [{
      id: 'old_id_not_available_to_v6',
      description: 'Legacy criterion text.',
      deliverableIds: ['result'],
    }],
  },
}));
versionSixSeed.close();
const versionSixDatabase = new DatabaseSync(versionSixDatabasePath);
versionSixDatabase.exec(`
  ALTER TABLE continuation_jobs DROP COLUMN source_facts_json;
  ALTER TABLE continuation_jobs DROP COLUMN task_contract_json;
  PRAGMA user_version = 6;
`);
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
  const migratedV6 = await migratedVersionSixRepository.get(legacyV6Job.job.jobId);
  assert.equal(migratedV6?.sourceFacts.provenance, 'legacy_unavailable');
  assert.equal(migratedV6?.sourceFacts.originalUserText, null);
  assert.deepEqual(migratedV6?.sourceFacts.inputs, []);
  assert.match(migratedV6?.taskContract.acceptanceCriteria[0].id ?? '', /^criterion_1_[a-f0-9]{12}$/);
  assert.equal(migratedV6?.taskContract.acceptanceCriteria[0].description, 'Legacy criterion text.');
  assert.deepEqual(migratedV6?.acceptanceCriteria, ['Legacy criterion text.']);
  assert.ok(await migratedVersionSixRepository.claimDue(
    'worker-v6-migrated',
    baseNow,
    '2026-07-17T00:00:30.000Z',
  ));
} finally {
  migratedVersionSixRepository.close();
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
assert.equal((await reopenedManagedRepository.get(expectedManagedJobId))?.jobId, expectedManagedJobId);
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
  UPDATE continuation_jobs SET source_facts_json = ? WHERE job_id = ?
`).run('{not-json', expectedManagedJobId);
const invalidJsonTombstone = await reopenedManagedRepository.get(expectedManagedJobId);
assert.equal(invalidJsonTombstone?.status, 'failed');
assert.equal(invalidJsonTombstone?.errorCode, 'continuation_persisted_state_invalid');

const invalidContractJob = await reopenedManagedRepository.create(createRequest(
  'invalid-persisted-contract',
));
managedDatabase.prepare(`
  UPDATE continuation_jobs SET task_contract_json = '{}' WHERE job_id = ?
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
  UPDATE continuation_jobs SET source_facts_json = ? WHERE job_id = ?
`).run(JSON.stringify(managedFactsWithUnknownField), unknownFactsJob.job.jobId);
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
    UPDATE continuation_jobs SET status = 'queued' WHERE job_id = ?
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
const deadRedactionToken = `2147483647-${'f'.repeat(16)}`;
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
crashAdoptionDatabase.prepare('DELETE FROM continuation_jobs WHERE job_id = ?').run(
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
await assert.rejects(
  inputValidationStore.install('job_collision', [
    { sourcePath: shortA, fileName: 'same.txt', kind: 'message_attachment' },
    { sourcePath: shortB, fileName: 'same.txt', kind: 'message_image' },
  ]),
  /duplicate.*file name|collision/i,
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
  nonce: reusedPidNonce,
  createdAt: new Date().toISOString(),
}), 'utf8');
const reusedPidReclaimer = spawn(process.execPath, [
  '--import',
  'tsx',
  new URL(import.meta.url).pathname,
  '--reclaim-dead-creation-lock',
  deadLockInputsRoot,
  reusedPidLockJobId,
], { stdio: ['ignore', 'pipe', 'pipe'] });
await assert.rejects(
  waitForChildMarker(reusedPidReclaimer, 'DEAD_LOCK_RECLAIMED', 500),
  /timed out/i,
);
assert.equal((await lstat(reusedPidLockDirectory)).isDirectory(), true);
await rm(reusedPidLockDirectory, { recursive: true, force: true });

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

// If managed input admission succeeds but the database insert fails, creation compensates by
// removing only the tree installed by this request and leaves no partial staging directory.
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
await assert.rejects(failedCommitRepository.create(failedCommitRequest), /foreign key/i);
assert.equal(await failedCommitRepository.get(continuationJobId(failedCommitRequest.idempotencyKey)), null);
const failedCommitEntries = await readdir(failedCommitOptions.inputsDir);
assert.equal(
  failedCommitEntries.some((entry) =>
    entry === continuationJobId(failedCommitRequest.idempotencyKey) || entry.startsWith('.staging-')),
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

// One corrupt trusted snapshot must fail closed without blocking the next due Job.
const corruptStateRoot = await mkdtemp(join(tmpdir(), 'continuation-corrupt-state-'));
const corruptStateDatabasePath = join(corruptStateRoot, 'jobs.sqlite');
const corruptStateRepository = await SqliteContinuationRepository.open({
  databasePath: corruptStateDatabasePath,
  artifactsDir: join(corruptStateRoot, 'artifacts'),
  inputsDir: join(corruptStateRoot, 'inputs'),
  jitter: () => 0,
});
const corruptStateJob = await corruptStateRepository.create(createRequest('corrupt-state', {
  createdAt: '2026-07-16T23:59:58.000Z',
}));
const healthyStateJob = await corruptStateRepository.create(createRequest('healthy-after-corrupt-state', {
  createdAt: '2026-07-16T23:59:59.000Z',
}));
const corruptStateDatabase = new DatabaseSync(corruptStateDatabasePath);
const corruptFactsJson = corruptStateDatabase.prepare(`
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
`).get(corruptStateJob.job.jobId) as { source_facts_json: string };
corruptStateDatabase.prepare(`
  UPDATE continuation_jobs SET source_facts_json = ? WHERE job_id = ?
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
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
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
  UPDATE continuation_jobs SET route_json = ?, source_facts_json = ? WHERE job_id = ?
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
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
`).get(commentBindingJob.job.jobId) as { source_facts_json: string };
const wrongCommentRoute = {
  ...expectedCommentRoute,
  commentId: 'comment_persisted_wrong',
};
routeMismatchDatabase.prepare(`
  UPDATE continuation_jobs SET route_json = ?, source_facts_json = ? WHERE job_id = ?
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
const terminalCorruptRepository = await SqliteContinuationRepository.open({
  databasePath: terminalCorruptDatabasePath,
  artifactsDir: join(terminalCorruptRoot, 'artifacts'),
  inputsDir: terminalCorruptInputsDir,
  inputStore: {
    ensureRoot: () => terminalCorruptDelegate.ensureRoot(),
    withCreationLock: (...args: Parameters<ContinuationInputStore['withCreationLock']>) =>
      terminalCorruptDelegate.withCreationLock(...args),
    install: (...args: Parameters<ContinuationInputStore['install']>) =>
      terminalCorruptDelegate.install(...args),
    clone: (...args: Parameters<ContinuationInputStore['clone']>) =>
      terminalCorruptDelegate.clone(...args),
    verify: (...args: Parameters<ContinuationInputStore['verify']>) =>
      terminalCorruptDelegate.verify(...args),
    resolve: (...args: Parameters<ContinuationInputStore['resolve']>) =>
      terminalCorruptDelegate.resolve(...args),
    async remove(...args: Parameters<ContinuationInputStore['remove']>) {
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
  SELECT source_facts_json FROM continuation_jobs WHERE job_id = ?
`).get(terminalCorruptCreated.job.jobId) as { source_facts_json: string };
terminalCorruptDatabase.prepare(`
  UPDATE continuation_jobs SET source_facts_json = ? WHERE job_id = ?
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
const cleanedTerminalTombstone = await terminalCorruptRepository.get(
  terminalCorruptCreated.job.jobId,
);
assert.equal(cleanedTerminalTombstone?.retained, false);
assert.doesNotMatch(cleanedTerminalTombstone?.errorSummary ?? '', /cleanup is pending/i);
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

// A corrupt due input terminates before an attempt/lease, emits one logical terminal event,
// and does not prevent the next healthy due Job from being claimed.
const integrityRoot = await mkdtemp(join(tmpdir(), 'continuation-integrity-'));
const integrityDatabasePath = join(integrityRoot, 'jobs.sqlite');
const integrityArtifactsDir = join(integrityRoot, 'artifacts');
const integrityInputsDir = join(integrityRoot, 'inputs');
const corruptSource = join(integrityRoot, 'corrupt-source.txt');
const healthySource = join(integrityRoot, 'healthy-source.txt');
await writeFile(corruptSource, 'before tamper', 'utf8');
await writeFile(healthySource, 'healthy', 'utf8');
const integrityRepository = await SqliteContinuationRepository.open({
  databasePath: integrityDatabasePath,
  artifactsDir: integrityArtifactsDir,
  inputsDir: integrityInputsDir,
  jitter: () => 0,
});
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
const corruptedJob = await reopenedIntegrityRepository.get(corruptCreated.job.jobId);
assert.equal(corruptedJob?.status, 'failed');
assert.equal(corruptedJob?.errorCode, 'continuation_input_integrity_failed');
assert.equal(corruptedJob?.attemptCount, 0);
assert.equal(corruptedJob?.leaseOwner, undefined);
assert.equal(corruptedJob?.leaseExpiresAt, undefined);
assert.equal(corruptedJob?.deliveryEvents?.filter((event) => event.kind === 'terminal').length, 1);
const integrityOutboxDatabase = new DatabaseSync(integrityDatabasePath);
integrityOutboxDatabase.prepare(`
  UPDATE continuation_outbox SET route_json = ? WHERE job_id = ? AND kind = 'terminal'
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
  UPDATE continuation_outbox
  SET route_json = ?, status = 'pending', error_code = NULL, error_summary = NULL
  WHERE job_id = ? AND kind = 'terminal'
`).run(JSON.stringify(corruptCreated.job.route), corruptCreated.job.jobId);
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
reopenedIntegrityRepository.close();

// Unexpected input I/O failures are retryable scan failures, not terminal integrity verdicts.
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
await assert.rejects(
  unavailableRepository.claimDue('worker-unavailable', baseNow, '2026-07-17T00:00:30.000Z'),
  /EACCES|permission denied/i,
);
const stillDueAfterIoFailure = await unavailableRepository.get(unavailableJob.job.jobId);
assert.equal(stillDueAfterIoFailure?.status, 'queued');
assert.equal(stillDueAfterIoFailure?.attemptCount, 0);
assert.equal(stillDueAfterIoFailure?.deliveryEvents?.length, 0);
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
  'cancelled',
);
delayedCancelStore.releaseVerification();
assert.equal(await pendingCancelClaim, null);
const cancelledDuringVerification = await cancelRaceMutationRepository.get(cancelRaceJob.job.jobId);
assert.equal(cancelledDuringVerification?.status, 'cancelled');
assert.equal(cancelledDuringVerification?.attemptCount, 0);
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
assert.equal(expiredDuringVerification?.attemptCount, 0);
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
assert.equal(failedAfterPriorAttempt?.attemptCount, 1);
assert.equal(failedAfterPriorAttempt?.errorCode, 'continuation_input_integrity_failed');
priorAttemptRepository.close();

// Retry owns an actual copy, remains valid after source cleanup, and rejects a corrupt source tree.
const retryRoot = await mkdtemp(join(tmpdir(), 'continuation-retry-inputs-'));
const retrySourcePath = join(retryRoot, 'retry-source.txt');
await writeFile(retrySourcePath, 'retry input', 'utf8');
const retryInputsDir = join(retryRoot, 'inputs');
const retryRepository = await SqliteContinuationRepository.open({
  databasePath: join(retryRoot, 'jobs.sqlite'),
  artifactsDir: join(retryRoot, 'artifacts'),
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

console.log('continuation repository smoke: PASS');
