import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DurableRunCreateRequest,
  DurableRunFailure,
} from '../src/domain/durable-run.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';

const root = await mkdtemp(join(tmpdir(), 'durable-run-repository-'));
const databasePath = join(root, 'runtime.sqlite');
const now = '2026-07-19T00:00:00.000Z';
const lease = '2026-07-19T00:01:00.000Z';

function request(
  runId: string,
  workloadKind: string,
  nextRunAt = now,
): DurableRunCreateRequest {
  return {
    runId,
    workloadKind,
    idempotencyKey: `idem:${runId}`,
    inputVersion: 1,
    input: { schemaVersion: 1, runId, immutable: true },
    stateVersion: 1,
    state: { schemaVersion: 1, step: 0 },
    route: { kind: 'test', target: runId },
    actorOpenId: 'ou_test_actor',
    nextRunAt,
    expiresAt: '2026-07-20T00:00:00.000Z',
    maxAttempts: 3,
  };
}

const failure: DurableRunFailure = {
  category: 'transient',
  retrySafety: 'safe',
  capabilityAvailable: true,
  operationRisk: 'read_only',
  hints: ['Retry after the transient failure.'],
  failedStep: 'fetch',
  diagnostic: 'Transient fetch failure.',
  fingerprint: 'transient-fetch',
};

try {
  const repository = await SqliteDurableRunRepository.open({ databasePath });

  const mutableRequest = request('run-async', 'async_task');
  const first = await repository.create(mutableRequest);
  assert.equal(first.created, true);
  mutableRequest.input = { schemaVersion: 1, runId: 'mutated' };
  mutableRequest.state = { schemaVersion: 1, step: 99 };
  assert.deepEqual((await repository.get('run-async'))?.input, {
    schemaVersion: 1,
    runId: 'run-async',
    immutable: true,
  });
  assert.deepEqual((await repository.get('run-async'))?.state, {
    schemaVersion: 1,
    step: 0,
  });

  const duplicate = await repository.create(request('run-async', 'async_task'));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.runId, 'run-async');
  const sameKey = request('run-conflicting-id', 'async_task');
  sameKey.idempotencyKey = 'idem:run-async';
  const idempotentByKey = await repository.create(sameKey);
  assert.equal(idempotentByKey.created, false);
  assert.equal(idempotentByKey.run.runId, 'run-async');

  await repository.create(request('run-cron', 'cron_prompt'));
  assert.equal(await repository.claimDue(['missing'], 'worker-none', now, lease), null);
  const cronClaim = await repository.claimDue(['cron_prompt'], 'worker-cron', now, lease);
  assert.equal(cronClaim?.run.runId, 'run-cron');
  assert.equal(cronClaim?.attempt.ordinal, 1);
  assert.equal(cronClaim?.attempt.workerId, 'worker-cron');
  assert.equal(await repository.markExecutionStarted(cronClaim!, now), 'committed');
  assert.equal(await repository.markExecutionStarted(cronClaim!, now), 'stale');
  assert.equal(
    await repository.heartbeat(
      cronClaim!,
      '2026-07-19T00:00:10.000Z',
      '2026-07-19T00:02:00.000Z',
    ),
    true,
  );
  assert.equal(await repository.commitTransition(cronClaim!, {
    status: 'completed',
    stateVersion: 1,
    state: { schemaVersion: 1, step: 1, report: 'done' },
    deliveries: [{
      kind: 'terminal',
      idempotencyKey: 'delivery:run-cron:terminal',
      route: { kind: 'test', target: 'run-cron' },
      payload: { schemaVersion: 1, text: 'done' },
    }],
  }, '2026-07-19T00:00:20.000Z'), 'committed');
  assert.equal(await repository.commitTransition(cronClaim!, {
    status: 'failed',
    stateVersion: 1,
    state: { schemaVersion: 1, step: 2 },
  }, '2026-07-19T00:00:21.000Z'), 'stale');
  assert.equal((await repository.get('run-cron'))?.status, 'completed');

  assert.equal(
    await repository.claimDelivery(['async_task'], 'delivery-wrong', now),
    null,
  );
  const delivery = await repository.claimDelivery(
    ['cron_prompt'],
    'delivery-worker',
    '2026-07-19T00:00:21.000Z',
  );
  assert.equal(delivery?.runId, 'run-cron');
  assert.equal(delivery?.idempotencyKey, 'delivery:run-cron:terminal');
  assert.deepEqual(delivery?.payload, { schemaVersion: 1, text: 'done' });
  await repository.commitDelivery(
    delivery!,
    { status: 'sent', messageId: 'om_durable_run_terminal' },
    '2026-07-19T00:00:22.000Z',
  );

  const asyncClaim = await repository.claimDue(['async_task'], 'worker-async', now, lease);
  assert.equal(asyncClaim?.run.runId, 'run-async');
  assert.equal(await repository.failAttempt(asyncClaim!, failure, now), 'committed');
  assert.equal(await repository.failAttempt(asyncClaim!, failure, now), 'stale');
  assert.equal((await repository.get('run-async'))?.status, 'failed');

  await repository.create(request('run-recovery', 'async_task'));
  const recoveryClaim = await repository.claimDue(
    ['async_task'],
    'worker-recovery',
    now,
    '2026-07-19T00:00:05.000Z',
  );
  assert.equal(await repository.markExecutionStarted(recoveryClaim!, now), 'committed');
  const interrupted = await repository.recoverExpiredLeases('2026-07-19T00:00:06.000Z');
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.claim.run.runId, 'run-recovery');
  assert.equal(interrupted[0]?.executionPhase, 'execution_started');
  assert.equal(interrupted[0]?.operationRisk, 'unknown');
  assert.equal(interrupted[0]?.recoveredAt, '2026-07-19T00:00:06.000Z');
  assert.equal(
    await repository.commitTransition(interrupted[0]!.claim, {
      status: 'blocked',
      stateVersion: 1,
      state: { schemaVersion: 1, step: 0, recovery: 'unknown_outcome' },
      errorCode: 'interrupted_unknown_outcome',
      errorSummary: 'Execution was interrupted after opaque work started.',
      failure: {
        ...failure,
        retrySafety: 'unknown',
        operationRisk: interrupted[0]!.operationRisk,
      },
    }, '2026-07-19T00:00:06.000Z'),
    'committed',
  );
  assert.deepEqual(
    await repository.recoverExpiredLeases('2026-07-19T00:00:07.000Z'),
    [],
  );

  const recoveryRestartDatabasePath = join(root, 'recovery-restart.sqlite');
  const recoveryBeforeRestart = await SqliteDurableRunRepository.open({
    databasePath: recoveryRestartDatabasePath,
  });
  await recoveryBeforeRestart.create(request('run-recovery-restart', 'async_task'));
  const recoveryRestartClaim = await recoveryBeforeRestart.claimDue(
    ['async_task'],
    'worker-recovery-restart',
    now,
    '2026-07-19T00:00:05.000Z',
  );
  assert.equal(await recoveryBeforeRestart.markExecutionStarted(recoveryRestartClaim!, now), 'committed');
  const recoveryBeforeCrash = await recoveryBeforeRestart.recoverExpiredLeases(
    '2026-07-19T00:00:06.000Z',
  );
  assert.equal(recoveryBeforeCrash.length, 1);
  recoveryBeforeRestart.close();

  const recoveryAfterRestart = await SqliteDurableRunRepository.open({
    databasePath: recoveryRestartDatabasePath,
  });
  assert.deepEqual(
    await recoveryAfterRestart.recoverExpiredLeases('2026-07-19T00:00:35.000Z'),
    [],
  );
  const reclaimedRecovery = await recoveryAfterRestart.recoverExpiredLeases(
    '2026-07-19T00:00:37.000Z',
  );
  assert.equal(reclaimedRecovery.length, 1);
  assert.equal(reclaimedRecovery[0]?.claim.attempt.attemptId, recoveryBeforeCrash[0]?.claim.attempt.attemptId);
  assert.ok(
    (reclaimedRecovery[0]?.claim.claimedRowVersion ?? 0)
      > (recoveryBeforeCrash[0]?.claim.claimedRowVersion ?? 0),
  );
  assert.equal(
    await recoveryAfterRestart.commitTransition(reclaimedRecovery[0]!.claim, {
      status: 'waiting_retry',
      stateVersion: 1,
      state: { schemaVersion: 1, step: 0, recovery: 'restart_reclaimed' },
      nextRunAt: '2026-07-19T00:00:37.000Z',
    }, '2026-07-19T00:00:37.000Z'),
    'committed',
  );
  recoveryAfterRestart.close();

  repository.close();

  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const outbox = database.prepare(`
      SELECT status, message_id FROM durable_outbox WHERE run_id = 'run-cron'
    `).get();
    assert.equal(outbox?.status, 'sent');
    assert.equal(outbox?.message_id, 'om_durable_run_terminal');
    const attempts = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM durable_attempts
    `).get()?.count);
    assert.equal(attempts, 3);
  } finally {
    database.close();
  }
  process.stdout.write('durable run repository smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
