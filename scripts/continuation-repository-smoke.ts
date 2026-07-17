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
    permissions: {
      profile: 'bounded',
      filesystem: { root, mode: 'workspace-write', requestedPaths: [] },
      hostTools: [],
      network: 'none',
      externalSideEffects: 'denied',
      approval: { mode: 'never' },
    },
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

  const secondClaim = await repository.claimDue(
    'worker-main',
    '2026-07-17T00:00:11.000Z',
    '2026-07-17T00:00:41.000Z',
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
  assert.ok(purged >= 2, `expected completed/cancelled rows to be redacted, got ${purged}`);

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
    job_id TEXT NOT NULL,
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
    job_id TEXT NOT NULL UNIQUE,
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
    job_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
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
  PRAGMA user_version = 3;
`);
versionThreeDatabase.close();
const migratedVersionThreeRepository = await SqliteContinuationRepository.open({
  databasePath: versionThreeDatabasePath,
  artifactsDir: versionThreeArtifactsDir,
});
try {
  const migrated = await migratedVersionThreeRepository.get('job_legacy_v3');
  assert.equal(migrated?.maxAttempts, 5);
  assert.equal(migrated?.status, 'queued');
} finally {
  migratedVersionThreeRepository.close();
}
const migratedVersionThreeDatabase = new DatabaseSync(versionThreeDatabasePath);
const migratedVersionThreeColumns = migratedVersionThreeDatabase
  .prepare('PRAGMA table_info(continuation_jobs)')
  .all() as Array<{ name: string }>;
assert.ok(migratedVersionThreeColumns.some((column) => column.name === 'max_attempts'));
assert.equal(migratedVersionThreeColumns.some((column) => column.name === 'max_steps'), false);
assert.equal(Number(migratedVersionThreeDatabase.prepare('PRAGMA user_version').get()?.user_version), 4);
migratedVersionThreeDatabase.close();

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
const versionOneSeed = await SqliteContinuationRepository.open({
  databasePath: versionOneDatabasePath,
  artifactsDir: versionOneArtifactsDir,
});
const legacyV1Job = await versionOneSeed.create(createRequest('legacy-v1', {
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
versionOneSeed.close();
const versionOneDatabase = new DatabaseSync(versionOneDatabasePath);
versionOneDatabase.exec(`
  ALTER TABLE continuation_jobs DROP COLUMN permissions_json;
  DROP TABLE continuation_tool_calls;
  PRAGMA user_version = 1;
`);
versionOneDatabase.close();
const migratedVersionOneRepository = await SqliteContinuationRepository.open({
  databasePath: versionOneDatabasePath,
  artifactsDir: versionOneArtifactsDir,
});
try {
  await migratedVersionOneRepository.healthCheck();
  assert.deepEqual((await migratedVersionOneRepository.get(legacyV1Job.job.jobId))?.permissions, {
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
  assert.equal(
    (await migratedVersionOneRepository.beginToolCall(
      v1Claim,
      { tool: 'lark_cli', args: [] },
      baseNow,
    )).status,
    'execute',
  );
} finally {
  migratedVersionOneRepository.close();
}

console.log('continuation repository smoke: PASS');
