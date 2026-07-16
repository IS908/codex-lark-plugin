import assert from 'node:assert/strict';
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ContinuationCreateRequest } from '../src/domain/continuation.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-repository-'));
const databasePath = join(root, 'runtime', 'jobs.sqlite');
const artifactsDir = join(root, 'runtime', 'artifacts');
const baseNow = '2026-07-17T00:00:00.000Z';

function createRequest(
  suffix: string,
  overrides: Partial<ContinuationCreateRequest> = {},
): ContinuationCreateRequest {
  return {
    idempotencyKey: `idem-${suffix}`,
    creatorOpenId: 'ou_creator',
    route: {
      kind: 'message_thread',
      conversationId: 'oc_continuation',
      sourceMessageId: `om_${suffix}`,
      threadId: 'omt_continuation',
    },
    sourceMessageId: `om_${suffix}`,
    sourceThreadId: 'omt_continuation',
    title: `Continuation ${suffix}`,
    objective: `Complete ${suffix}`,
    acceptanceCriteria: ['terminal result is persisted'],
    contextSnapshot: {
      summary: `Context ${suffix}`,
      completedSteps: [],
      remainingSteps: ['run the task'],
      constraints: ['do not publish'],
      decisions: [],
      references: [],
    },
    requiredTools: [],
    workingDirectory: root,
    maxSteps: 24,
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

  const first = await repository.create(createRequest('first'));
  assert.equal(first.created, true);
  assert.match(first.job.jobId, /^job_[a-f0-9]{24}$/);
  assert.equal(first.job.status, 'queued');
  assert.equal(first.job.rowVersion, 1);

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

  const secondClaim = await repository.claimDue(
    'worker-main',
    '2026-07-17T00:00:11.000Z',
    '2026-07-17T00:00:41.000Z',
  );
  assert.ok(secondClaim);
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

  const delivery = await repository.claimPendingDelivery(
    'delivery-main',
    '2026-07-17T00:00:13.000Z',
  );
  assert.ok(delivery);
  assert.equal(delivery.jobId, first.job.jobId);
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
  assert.ok(purged >= 2, `expected completed/cancelled rows to be redacted, got ${purged}`);
} finally {
  secondRepository.close();
  repository.close();
}

console.log('continuation repository smoke: PASS');
