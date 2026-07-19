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

const reviewFailures: Error[] = [];

async function reviewRegression(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reviewFailures.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

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
  const interrupted = await repository.recoverExpiredLeases(
    ['async_task'],
    '2026-07-19T00:00:06.000Z',
  );
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
    await repository.recoverExpiredLeases(['async_task'], '2026-07-19T00:00:07.000Z'),
    [],
  );

  await reviewRegression('generic transitions preserve semantic metadata and delivery gating', async () => {
    const semanticsPath = join(root, 'transition-semantics.sqlite');
    const semanticsRepository = await SqliteDurableRunRepository.open({ databasePath: semanticsPath });
    try {
      await semanticsRepository.create(request('run-transition-semantics', 'async_task'));
      const claim = await semanticsRepository.claimDue(
        ['async_task'],
        'worker-transition-semantics',
        now,
        lease,
      );
      assert.ok(claim);
      assert.equal(await semanticsRepository.commitTransition(claim, {
        status: 'waiting_retry',
        stateVersion: 1,
        state: { schemaVersion: 1, step: 1 },
        nextRunAt: now,
        attempt: {
          outcome: 'continue',
          executionSessionId: 'session-transition-semantics',
          metadata: { stepId: 'step-1', verification: { status: 'accepted' } },
        },
        deliveries: [{
          outboxId: 'out_transition_semantics',
          eventKey: `progress:${claim.attempt.attemptId}`,
          kind: 'progress',
          attemptId: claim.attempt.attemptId,
          idempotencyKey: 'delivery:run-transition-semantics:progress',
          route: { kind: 'test', target: 'run-transition-semantics' },
          payload: 'progress',
          metadata: { blocksRun: true },
        }],
      }, '2026-07-19T00:00:01.000Z'), 'committed');
      assert.equal(await semanticsRepository.claimDue(
        ['async_task'],
        'worker-transition-blocked',
        '2026-07-19T00:00:02.000Z',
        lease,
      ), null);
      const deliveryClaim = await semanticsRepository.claimDelivery(
        ['async_task'],
        'delivery-transition-semantics',
        '2026-07-19T00:00:02.000Z',
      );
      assert.equal(deliveryClaim?.outboxId, 'out_transition_semantics');
      assert.equal(await semanticsRepository.commitDelivery(
        deliveryClaim!,
        { status: 'sent', messageId: 'om_transition_semantics' },
        '2026-07-19T00:00:03.000Z',
      ), 'committed');
      const nextClaim = await semanticsRepository.claimDue(
        ['async_task'],
        'worker-transition-next',
        '2026-07-19T00:00:04.000Z',
        lease,
      );
      assert.ok(nextClaim);
      assert.equal(await semanticsRepository.commitTransition(nextClaim, {
        status: 'waiting_user',
        stateVersion: 1,
        state: { schemaVersion: 1, step: 2 },
        attempt: {
          outcome: 'waiting_user',
          metadata: { recovery: { lastDecision: 'wait_user' } },
        },
        interrupts: [{
          interruptId: 'int_transition_semantics',
          attemptId: nextClaim.attempt.attemptId,
          prompt: 'Confirm the external outcome.',
        }],
      }, '2026-07-19T00:00:05.000Z'), 'committed');
      const database = new DatabaseSync(semanticsPath, { enableForeignKeyConstraints: true });
      try {
        const firstAttempt = database.prepare(`
          SELECT outcome, execution_session_id, metadata_json
          FROM durable_attempts WHERE attempt_id = ?
        `).get(claim.attempt.attemptId);
        assert.deepEqual({ ...firstAttempt }, {
          outcome: 'continue',
          execution_session_id: 'session-transition-semantics',
          metadata_json: JSON.stringify({
            stepId: 'step-1',
            verification: { status: 'accepted' },
          }),
        });
        const interrupt = database.prepare(`
          SELECT interrupt_id, run_id, attempt_id, status, prompt
          FROM durable_interrupts WHERE interrupt_id = 'int_transition_semantics'
        `).get();
        assert.deepEqual({ ...interrupt }, {
          interrupt_id: 'int_transition_semantics',
          run_id: 'run-transition-semantics',
          attempt_id: nextClaim.attempt.attemptId,
          status: 'pending',
          prompt: 'Confirm the external outcome.',
        });
      } finally {
        database.close();
      }
    } finally {
      semanticsRepository.close();
    }
  });

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
    ['async_task'],
    '2026-07-19T00:00:06.000Z',
  );
  assert.equal(recoveryBeforeCrash.length, 1);
  recoveryBeforeRestart.close();

  const recoveryAfterRestart = await SqliteDurableRunRepository.open({
    databasePath: recoveryRestartDatabasePath,
  });
  assert.deepEqual(
    await recoveryAfterRestart.recoverExpiredLeases(
      ['async_task'],
      '2026-07-19T00:00:35.000Z',
    ),
    [],
  );
  const reclaimedRecovery = await recoveryAfterRestart.recoverExpiredLeases(
    ['async_task'],
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

  await reviewRegression('recovery filters registered workload kinds', async () => {
    const filterDatabasePath = join(root, 'recovery-workload-filter.sqlite');
    const filterRepository = await SqliteDurableRunRepository.open({ databasePath: filterDatabasePath });
    try {
      await filterRepository.create(request('run-filter-async', 'async_task'));
      await filterRepository.create(request('run-filter-cron', 'cron_prompt'));
      assert.ok(await filterRepository.claimDue(
        ['async_task'],
        'worker-filter-async',
        now,
        '2026-07-19T00:00:05.000Z',
      ));
      assert.ok(await filterRepository.claimDue(
        ['cron_prompt'],
        'worker-filter-cron',
        now,
        '2026-07-19T00:00:05.000Z',
      ));
      const recovered = await filterRepository.recoverExpiredLeases(
        ['async_task'],
        '2026-07-19T00:00:06.000Z',
      );
      assert.deepEqual(
        recovered.map((entry) => entry.claim.run.workloadKind),
        ['async_task'],
      );
    } finally {
      filterRepository.close();
    }
  });

  await reviewRegression('expired recovery claimant cannot commit before reclaim', async () => {
    const staleRecoveryPath = join(root, 'stale-recovery.sqlite');
    const staleRecoveryRepository = await SqliteDurableRunRepository.open({
      databasePath: staleRecoveryPath,
    });
    try {
      await staleRecoveryRepository.create(request('run-stale-recovery', 'async_task'));
      const claim = await staleRecoveryRepository.claimDue(
        ['async_task'],
        'worker-stale-recovery',
        now,
        '2026-07-19T00:00:05.000Z',
      );
      assert.ok(claim);
      const [recovered] = await staleRecoveryRepository.recoverExpiredLeases(
        ['async_task'],
        '2026-07-19T00:00:06.000Z',
      );
      assert.ok(recovered);
      assert.equal(await staleRecoveryRepository.commitTransition(recovered.claim, {
        status: 'waiting_retry',
        stateVersion: 1,
        state: { schemaVersion: 1, recovery: 'late' },
        nextRunAt: '2026-07-19T00:00:37.000Z',
      }, '2026-07-19T00:00:37.000Z'), 'stale');
      assert.equal((await staleRecoveryRepository.get('run-stale-recovery'))?.status, 'running');
    } finally {
      staleRecoveryRepository.close();
    }
  });

  await reviewRegression('same-worker stale delivery claimant cannot commit', async () => {
    const staleDeliveryPath = join(root, 'stale-delivery.sqlite');
    const staleDeliveryRepository = await SqliteDurableRunRepository.open({
      databasePath: staleDeliveryPath,
    });
    try {
      await staleDeliveryRepository.create(request('run-stale-delivery', 'async_task'));
      const runClaim = await staleDeliveryRepository.claimDue(
        ['async_task'],
        'worker-stale-delivery-run',
        now,
        lease,
      );
      assert.ok(runClaim);
      assert.equal(await staleDeliveryRepository.commitTransition(runClaim, {
        status: 'completed',
        stateVersion: 1,
        state: { schemaVersion: 1, delivered: true },
        deliveries: [{
          kind: 'terminal',
          idempotencyKey: 'delivery:run-stale-delivery:terminal',
          route: { kind: 'test', target: 'run-stale-delivery' },
          payload: { schemaVersion: 1, text: 'stale delivery fence' },
        }],
      }, '2026-07-19T00:00:01.000Z'), 'committed');
      const staleClaim = await staleDeliveryRepository.claimDelivery(
        ['async_task'],
        'stable-delivery-worker',
        '2026-07-19T00:00:02.000Z',
      );
      assert.ok(staleClaim);
      const currentClaim = await staleDeliveryRepository.claimDelivery(
        ['async_task'],
        'stable-delivery-worker',
        '2026-07-19T00:00:33.000Z',
      );
      assert.ok(currentClaim);
      assert.equal(
        await staleDeliveryRepository.commitDelivery(
          staleClaim,
          { status: 'sent', messageId: 'om_stale_delivery' },
          '2026-07-19T00:00:34.000Z',
        ),
        'stale',
      );
      assert.equal(
        await staleDeliveryRepository.commitDelivery(
          currentClaim,
          { status: 'sent', messageId: 'om_current_delivery' },
          '2026-07-19T00:00:34.000Z',
        ),
        'committed',
      );
    } finally {
      staleDeliveryRepository.close();
    }
  });

  await reviewRegression('claim validation terminalizes invalid persisted envelopes atomically', async () => {
    const validationPath = join(root, 'claim-validation.sqlite');
    const validationRepository = await SqliteDurableRunRepository.open({ databasePath: validationPath });
    try {
      const invalid = request('run-invalid-claim', 'async_task');
      invalid.inputVersion = 2;
      await validationRepository.create(invalid);
      assert.equal(await validationRepository.claimDue(
        ['async_task'],
        'worker-invalid-claim',
        now,
        lease,
        (run) => run.inputVersion === 1 ? null : {
          errorCode: 'continuation_persisted_state_invalid',
          errorSummary: 'Stored task state failed integrity validation.',
        },
      ), null);
      const database = new DatabaseSync(validationPath, { enableForeignKeyConstraints: true });
      try {
        const row = database.prepare(`
          SELECT status, input_version, input_json, attempt_count, error_code
          FROM durable_runs WHERE run_id = 'run-invalid-claim'
        `).get();
        assert.deepEqual({ ...row }, {
          status: 'failed',
          input_version: 2,
          input_json: JSON.stringify(invalid.input),
          attempt_count: 0,
          error_code: 'continuation_persisted_state_invalid',
        });
      } finally {
        database.close();
      }
    } finally {
      validationRepository.close();
    }
  });

  await reviewRegression('persisted-state failure deliveries use bounded transition validation', async () => {
    const validationPath = join(root, 'invalid-failure-deliveries.sqlite');
    const validationRepository = await SqliteDurableRunRepository.open({ databasePath: validationPath });
    try {
      await validationRepository.create(request('run-invalid-failure-deliveries', 'async_task'));
      assert.equal(await validationRepository.claimDue(
        ['async_task'],
        'worker-invalid-failure-deliveries',
        now,
        lease,
        () => ({
          errorCode: 'continuation_persisted_state_invalid',
          errorSummary: 'Stored task state failed integrity validation.',
          deliveries: Array.from({ length: 17 }, (_, index) => ({
            kind: 'terminal',
            idempotencyKey: `invalid-delivery-${index}`,
            route: {},
            payload: {},
          })),
        }),
      ), null);
      const database = new DatabaseSync(validationPath, { enableForeignKeyConstraints: true });
      try {
        const run = database.prepare(`
          SELECT status, error_code FROM durable_runs
          WHERE run_id = 'run-invalid-failure-deliveries'
        `).get();
        assert.deepEqual({ ...run }, {
          status: 'failed',
          error_code: 'durable_run_persisted_state_invalid',
        });
        assert.equal(Number(database.prepare(`
          SELECT COUNT(*) AS count FROM durable_outbox
          WHERE run_id = 'run-invalid-failure-deliveries'
        `).get()?.count), 0);
      } finally {
        database.close();
      }
    } finally {
      validationRepository.close();
    }
  });

  await reviewRegression('delivery intent conflicts roll the Run transition back', async () => {
    const conflictPath = join(root, 'delivery-intent-conflicts.sqlite');
    const conflictRepository = await SqliteDurableRunRepository.open({ databasePath: conflictPath });
    try {
      await conflictRepository.create(request('run-delivery-key-owner', 'async_task'));
      const ownerClaim = await conflictRepository.claimDue(
        ['async_task'],
        'worker-delivery-key-owner',
        now,
        lease,
      );
      assert.ok(ownerClaim);
      assert.equal(await conflictRepository.commitTransition(ownerClaim, {
        status: 'completed',
        stateVersion: 1,
        state: { schemaVersion: 1, completed: true },
        deliveries: [{
          eventKey: 'terminal',
          kind: 'terminal',
          idempotencyKey: 'delivery-key-conflict',
          route: { chatId: 'oc_owner' },
          payload: { text: 'owner' },
        }],
      }, '2026-07-19T00:00:01.000Z'), 'committed');

      await conflictRepository.create(request('run-delivery-key-conflict', 'async_task'));
      const keyConflictClaim = await conflictRepository.claimDue(
        ['async_task'],
        'worker-delivery-key-conflict',
        now,
        lease,
      );
      assert.ok(keyConflictClaim);
      await assert.rejects(
        conflictRepository.commitTransition(keyConflictClaim, {
          status: 'completed',
          stateVersion: 1,
          state: { schemaVersion: 1, completed: true },
          deliveries: [{
            eventKey: 'terminal',
            kind: 'terminal',
            idempotencyKey: 'delivery-key-conflict',
            route: { chatId: 'oc_conflict' },
            payload: { text: 'conflict' },
          }],
        }, '2026-07-19T00:00:01.000Z'),
        /UNIQUE constraint failed/u,
      );
      assert.equal((await conflictRepository.get('run-delivery-key-conflict'))?.status, 'running');

      await conflictRepository.create(request('run-delivery-event-conflict', 'async_task'));
      const firstEventClaim = await conflictRepository.claimDue(
        ['async_task'],
        'worker-delivery-event-first',
        now,
        lease,
      );
      assert.ok(firstEventClaim);
      assert.equal(await conflictRepository.commitTransition(firstEventClaim, {
        status: 'waiting_retry',
        stateVersion: 1,
        state: { schemaVersion: 1, step: 1 },
        nextRunAt: now,
        deliveries: [{
          eventKey: 'stable-event',
          kind: 'progress',
          idempotencyKey: 'delivery-event-first',
          route: { chatId: 'oc_event' },
          payload: { text: 'first' },
        }],
      }, now), 'committed');
      const secondEventClaim = await conflictRepository.claimDue(
        ['async_task'],
        'worker-delivery-event-second',
        now,
        lease,
      );
      assert.ok(secondEventClaim);
      await assert.rejects(
        conflictRepository.commitTransition(secondEventClaim, {
          status: 'completed',
          stateVersion: 1,
          state: { schemaVersion: 1, completed: true },
          deliveries: [{
            eventKey: 'stable-event',
            kind: 'terminal',
            idempotencyKey: 'delivery-event-second',
            route: { chatId: 'oc_event' },
            payload: { text: 'second' },
          }],
        }, '2026-07-19T00:00:01.000Z'),
        /UNIQUE constraint failed/u,
      );
      assert.equal((await conflictRepository.get('run-delivery-event-conflict'))?.status, 'running');
    } finally {
      conflictRepository.close();
    }
  });

  await reviewRegression('recovery validation terminalizes invalid persisted envelopes atomically', async () => {
    const validationPath = join(root, 'recovery-validation.sqlite');
    const validationRepository = await SqliteDurableRunRepository.open({ databasePath: validationPath });
    try {
      await validationRepository.create(request('run-invalid-recovery', 'async_task'));
      const claim = await validationRepository.claimDue(
        ['async_task'],
        'worker-invalid-recovery',
        now,
        '2026-07-19T00:00:05.000Z',
      );
      assert.ok(claim);
      const database = new DatabaseSync(validationPath, { enableForeignKeyConstraints: true });
      try {
        database.prepare(`
          UPDATE durable_runs SET state_version = 2
          WHERE run_id = 'run-invalid-recovery'
        `).run();
      } finally {
        database.close();
      }
      assert.deepEqual(await validationRepository.recoverExpiredLeases(
        ['async_task'],
        '2026-07-19T00:00:06.000Z',
        (run) => run.stateVersion === 1 ? null : {
          errorCode: 'continuation_persisted_state_invalid',
          errorSummary: 'Stored task state failed integrity validation.',
        },
      ), []);
      const persisted = new DatabaseSync(validationPath, { enableForeignKeyConstraints: true });
      try {
        const row = persisted.prepare(`
          SELECT r.status, r.state_version, r.error_code,
                 a.finished_at, a.recovery_pending
          FROM durable_runs r
          JOIN durable_attempts a ON a.run_id = r.run_id
          WHERE r.run_id = 'run-invalid-recovery'
        `).get();
        assert.deepEqual({ ...row }, {
          status: 'failed',
          state_version: 2,
          error_code: 'continuation_persisted_state_invalid',
          finished_at: '2026-07-19T00:00:06.000Z',
          recovery_pending: 0,
        });
      } finally {
        persisted.close();
      }
    } finally {
      validationRepository.close();
    }
  });

  await reviewRegression('child rows reject an Attempt owned by another Run', async () => {
    const ownershipPath = join(root, 'composite-attempt-ownership.sqlite');
    const ownershipRepository = await SqliteDurableRunRepository.open({ databasePath: ownershipPath });
    try {
      await ownershipRepository.create(request('run-owner-a', 'async_task'));
      await ownershipRepository.create(request('run-owner-b', 'cron_prompt'));
      const claimA = await ownershipRepository.claimDue(['async_task'], 'worker-owner-a', now, lease);
      const claimB = await ownershipRepository.claimDue(['cron_prompt'], 'worker-owner-b', now, lease);
      assert.ok(claimA);
      assert.ok(claimB);
      const ownershipDatabase = new DatabaseSync(ownershipPath, { enableForeignKeyConstraints: true });
      try {
        assert.throws(() => ownershipDatabase.prepare(`
          INSERT INTO durable_outbox (
            outbox_id, run_id, event_key, kind, attempt_id, route_json,
            idempotency_key, payload_json, metadata_json, status,
            attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (
            'outbox_cross_run', 'run-owner-a', 'cross-run', 'terminal', ?, '{}',
            'delivery:cross-run', '{}', '{}', 'pending', 0, ?, ?, ?
          )
        `).run(claimB.attempt.attemptId, now, now, now), /FOREIGN KEY constraint failed/u);
      } finally {
        ownershipDatabase.close();
      }
    } finally {
      ownershipRepository.close();
    }
  });

  await reviewRegression('existing v10 schema gains composite Attempt ownership', async () => {
    const upgradePath = join(root, 'v10-composite-upgrade.sqlite');
    const initialRepository = await SqliteDurableRunRepository.open({ databasePath: upgradePath });
    initialRepository.close();
    const legacyV10 = new DatabaseSync(upgradePath);
    try {
      legacyV10.exec(`
        PRAGMA foreign_keys = OFF;
        DROP INDEX durable_outbox_due_idx;
        DROP INDEX durable_outbox_message_id_idx;
        DROP TABLE durable_outbox;
        CREATE TABLE durable_outbox (
          outbox_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
          event_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          attempt_id TEXT REFERENCES durable_attempts(attempt_id),
          route_json TEXT NOT NULL CHECK(json_valid(route_json)),
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'sending', 'sent', 'unknown', 'failed', 'superseded'
          )),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          next_attempt_at TEXT NOT NULL,
          worker_id TEXT,
          lease_expires_at TEXT,
          first_attempt_at TEXT,
          last_attempt_at TEXT,
          message_id TEXT,
          error_code TEXT,
          error_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, event_key)
        ) STRICT;
        CREATE INDEX durable_outbox_due_idx
          ON durable_outbox(status, next_attempt_at, created_at);
        CREATE UNIQUE INDEX durable_outbox_message_id_idx
          ON durable_outbox(message_id) WHERE message_id IS NOT NULL;
      `);
    } finally {
      legacyV10.close();
    }
    const upgradedRepository = await SqliteDurableRunRepository.open({ databasePath: upgradePath });
    try {
      await upgradedRepository.create(request('run-upgrade-owner-a', 'async_task'));
      await upgradedRepository.create(request('run-upgrade-owner-b', 'cron_prompt'));
      const claimA = await upgradedRepository.claimDue(
        ['async_task'],
        'worker-upgrade-owner-a',
        now,
        lease,
      );
      const claimB = await upgradedRepository.claimDue(
        ['cron_prompt'],
        'worker-upgrade-owner-b',
        now,
        lease,
      );
      assert.ok(claimA);
      assert.ok(claimB);
      const upgraded = new DatabaseSync(upgradePath, { enableForeignKeyConstraints: true });
      try {
        assert.throws(() => upgraded.prepare(`
          INSERT INTO durable_outbox (
            outbox_id, run_id, event_key, kind, attempt_id, route_json,
            idempotency_key, payload_json, metadata_json, status,
            attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (
            'outbox_cross_run_upgrade', 'run-upgrade-owner-a', 'cross-run', 'terminal', ?, '{}',
            'delivery:cross-run-upgrade', '{}', '{}', 'pending', 0, ?, ?, ?
          )
        `).run(claimB.attempt.attemptId, now, now, now), /FOREIGN KEY constraint failed/u);
      } finally {
        upgraded.close();
      }
    } finally {
      upgradedRepository.close();
    }
  });

  await reviewRegression('existing v10 schema gains process-safe active concurrency fencing', async () => {
    const upgradePath = join(root, 'v10-concurrency-upgrade.sqlite');
    const seed = await SqliteDurableRunRepository.open({ databasePath: upgradePath });
    seed.close();
    const legacyV10 = new DatabaseSync(upgradePath);
    try {
      legacyV10.exec(`
        DROP INDEX durable_runs_active_concurrency_idx;
        ALTER TABLE durable_runs DROP COLUMN concurrency_key;
      `);
    } finally {
      legacyV10.close();
    }
    const [first, second] = await Promise.all([
      SqliteDurableRunRepository.open({ databasePath: upgradePath }),
      SqliteDurableRunRepository.open({ databasePath: upgradePath }),
    ]);
    try {
      const firstRequest = request('run-concurrency-upgrade-a', 'cron_prompt');
      firstRequest.concurrencyKey = 'cron-job:upgrade';
      const secondRequest = request('run-concurrency-upgrade-b', 'cron_prompt');
      secondRequest.concurrencyKey = 'cron-job:upgrade';
      const created = await Promise.all([
        first.create(firstRequest),
        second.create(secondRequest),
      ]);
      assert.equal(created.filter((result) => result.created).length, 1);
      assert.equal(created[0]?.run.runId, created[1]?.run.runId);
      const upgraded = new DatabaseSync(upgradePath, { enableForeignKeyConstraints: true });
      try {
        assert.ok(upgraded.prepare('PRAGMA table_info(durable_runs)').all()
          .some((column) => column.name === 'concurrency_key'));
        assert.ok(upgraded.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'durable_runs_active_concurrency_idx'
        `).get());
      } finally {
        upgraded.close();
      }
    } finally {
      first.close();
      second.close();
    }
  });

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
  if (reviewFailures.length > 0) throw new AggregateError(reviewFailures, 'Task 4 review regressions');
  process.stdout.write('durable run repository smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
