import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import {
  seedHistoricalContinuationDatabase,
  type HistoricalContinuationSchemaVersion,
} from './fixtures/continuation-historical-schema.js';

const versions: HistoricalContinuationSchemaVersion[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const now = '2026-07-17T00:00:00.000Z';
const root = await mkdtemp(join(tmpdir(), 'durable-run-migration-'));
const reviewFailures: Error[] = [];

async function reviewRegression(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reviewFailures.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function activateHistoricalFixture(
  databasePath: string,
  fixture: Awaited<ReturnType<typeof seedHistoricalContinuationDatabase>>,
): string {
  const leaseExpiresAt = '2026-07-17T00:10:00.000Z';
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    database.prepare(`
      UPDATE continuation_jobs
      SET status = 'running', completed_at = NULL, lease_owner = 'worker-active-migration',
          lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE job_id = ?
    `).run(leaseExpiresAt, now, now, fixture.terminalJobId);
    database.prepare(`
      UPDATE continuation_attempts
      SET finished_at = NULL, outcome = NULL, heartbeat_at = ?
      WHERE attempt_id = ?
    `).run(now, fixture.terminalAttemptId);
    const outbox = database.prepare(`
      SELECT outbox_id FROM continuation_outbox
      WHERE job_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(fixture.terminalJobId) as { outbox_id?: string } | undefined;
    assert.ok(outbox?.outbox_id);
    database.prepare(`
      UPDATE continuation_outbox
      SET status = 'sending', worker_id = 'delivery-active-migration',
          lease_expires_at = ?, first_attempt_at = ?, last_attempt_at = ?, attempt_count = 1
      WHERE outbox_id = ?
    `).run(leaseExpiresAt, now, now, outbox.outbox_id);
    return outbox.outbox_id;
  } finally {
    database.close();
  }
}

function expectedLegacyStepId(): string {
  return `legacy-step-1-${createHash('sha256').update('legacy step').digest('hex').slice(0, 12)}`;
}

try {
  for (const version of versions) {
    const fixtureRoot = join(root, `v${version}`);
    const databasePath = join(fixtureRoot, 'runtime.sqlite');
    const fixture = await seedHistoricalContinuationDatabase({
      databasePath,
      now,
      version,
      workingDirectory: fixtureRoot,
    });
    const sendingOutboxId = activateHistoricalFixture(databasePath, fixture);

    const repository = await SqliteDurableRunRepository.open({ databasePath });
    const terminalRun = await repository.get(fixture.terminalJobId);
    assert.equal(terminalRun?.runId, fixture.terminalJobId, `v${version} run ID`);
    assert.equal(terminalRun?.workloadKind, 'async_task', `v${version} workload`);
    assert.equal(
      terminalRun?.idempotencyKey,
      version <= 3
        ? `idem-${fixture.terminalJobId}`
        : `idem-authentic-v${version <= 5 ? version : 5}`,
      `v${version} idempotency key`,
    );
    assert.equal(terminalRun?.status, 'running', `v${version} active status`);
    repository.close();

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      assert.equal(
        Number(database.prepare('PRAGMA user_version').get()?.user_version),
        10,
        `v${version} schema version`,
      );
      const baseTables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'continuation_%'
        ORDER BY name
      `).all();
      assert.deepEqual(baseTables, [], `v${version} legacy base tables`);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], `v${version} FK`);

      const attempt = database.prepare(`
        SELECT attempt_id, run_id, execution_phase, finished_at, lease_expires_at
        FROM durable_attempts WHERE attempt_id = ?
      `).get(fixture.terminalAttemptId);
      assert.equal(attempt?.attempt_id, fixture.terminalAttemptId, `v${version} attempt ID`);
      assert.equal(attempt?.run_id, fixture.terminalJobId, `v${version} attempt run`);
      if (version === 9) {
        assert.equal(attempt?.execution_phase, 'execution_started', 'v9 execution phase');
      }
      assert.equal(attempt?.finished_at, null, `v${version} active Attempt`);
      assert.equal(
        attempt?.lease_expires_at,
        '2026-07-17T00:10:00.000Z',
        `v${version} Attempt lease`,
      );

      const sendingOutbox = database.prepare(`
        SELECT status, worker_id, lease_expires_at, attempt_count
        FROM durable_outbox WHERE outbox_id = ?
      `).get(sendingOutboxId);
      assert.deepEqual({ ...sendingOutbox }, {
        status: 'sending',
        worker_id: 'delivery-active-migration',
        lease_expires_at: '2026-07-17T00:10:00.000Z',
        attempt_count: 1,
      }, `v${version} sending outbox`);

      const runCount = Number(database.prepare('SELECT COUNT(*) AS count FROM durable_runs').get()?.count);
      const attemptCount = Number(
        database.prepare('SELECT COUNT(*) AS count FROM durable_attempts').get()?.count,
      );
      const outboxCount = Number(
        database.prepare('SELECT COUNT(*) AS count FROM durable_outbox').get()?.count,
      );
      assert.equal(attemptCount, fixture.expectedAttemptCount, `v${version} attempt count`);
      assert.equal(outboxCount, fixture.expectedOutboxCount, `v${version} outbox count`);
      assert.ok(runCount >= 1, `v${version} run count`);

      if (fixture.operationReceiptId) {
        const receipt = database.prepare(`
          SELECT receipt_id, run_id, attempt_id, operation_key, status
          FROM durable_operation_receipts WHERE receipt_id = ?
        `).get(fixture.operationReceiptId);
        assert.equal(receipt?.receipt_id, fixture.operationReceiptId, `v${version} receipt ID`);
        assert.equal(receipt?.run_id, fixture.terminalJobId, `v${version} receipt run`);
        assert.equal(receipt?.attempt_id, fixture.terminalAttemptId, `v${version} receipt attempt`);
        assert.equal(receipt?.status, 'completed', `v${version} receipt status`);
        await reviewRegression(`v${version} completed receipt keeps migrated step identity`, async () => {
          assert.equal(receipt?.operation_key, expectedLegacyStepId());
        });
      }
      if (fixture.deliveredMessageId) {
        const delivery = database.prepare(`
          SELECT status, message_id FROM durable_outbox WHERE message_id = ?
        `).get(fixture.deliveredMessageId);
        assert.equal(delivery?.status, 'sent', `v${version} delivery status`);
        assert.equal(delivery?.message_id, fixture.deliveredMessageId, `v${version} message ID`);
      }
      if (version >= 6) {
        const retained = database.prepare(`
          SELECT retained FROM durable_runs WHERE run_id = ?
        `).get(fixture.terminalJobId);
        assert.equal(retained?.retained, 1, `v${version} retention`);
      }
      if (fixture.interruptId) {
        const interrupt = database.prepare(`
          SELECT interrupt_id, run_id, attempt_id, status
          FROM durable_interrupts WHERE interrupt_id = ?
        `).get(fixture.interruptId);
        assert.equal(interrupt?.interrupt_id, fixture.interruptId, 'v9 interrupt ID');
        assert.equal(interrupt?.run_id, fixture.terminalJobId, 'v9 interrupt run');
        assert.equal(interrupt?.attempt_id, fixture.terminalAttemptId, 'v9 interrupt attempt');
        assert.equal(interrupt?.status, 'resolved', 'v9 interrupt status');
      }
    } finally {
      database.close();
    }

    if (version >= 2 && version <= 8) {
      await reviewRegression(`v${version} running receipt keeps migrated step identity`, async () => {
        const runningRoot = join(root, `v${version}-running-receipt`);
        const runningPath = join(runningRoot, 'runtime.sqlite');
        const runningFixture = await seedHistoricalContinuationDatabase({
          databasePath: runningPath,
          now,
          version,
          workingDirectory: runningRoot,
        });
        assert.ok(runningFixture.operationReceiptId);
        activateHistoricalFixture(runningPath, runningFixture);
        const legacy = new DatabaseSync(runningPath, { enableForeignKeyConstraints: true });
        try {
          legacy.prepare(`
            UPDATE continuation_tool_calls
            SET status = 'running', result_json = NULL, completed_at = NULL, updated_at = ?
            WHERE call_id = ?
          `).run(now, runningFixture.operationReceiptId);
        } finally {
          legacy.close();
        }
        const runningRepository = await SqliteDurableRunRepository.open({ databasePath: runningPath });
        runningRepository.close();
        const migrated = new DatabaseSync(runningPath, { enableForeignKeyConstraints: true });
        try {
          const receipt = migrated.prepare(`
            SELECT operation_key, status FROM durable_operation_receipts WHERE receipt_id = ?
          `).get(runningFixture.operationReceiptId);
          assert.equal(receipt?.operation_key, expectedLegacyStepId());
          assert.equal(receipt?.status, 'running');
        } finally {
          migrated.close();
        }
      });
    }
  }
  await reviewRegression('route-mismatched sending outbox fails closed', async () => {
    const fixtureRoot = join(root, 'route-mismatch');
    const databasePath = join(fixtureRoot, 'runtime.sqlite');
    const fixture = await seedHistoricalContinuationDatabase({
      databasePath,
      now,
      version: 5,
      workingDirectory: fixtureRoot,
    });
    const mismatchedRoute = JSON.stringify({
      kind: 'message_thread',
      conversationId: 'oc_wrong_legacy_route',
      sourceMessageId: 'om_wrong_legacy_route',
    });
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      legacy.prepare(`
        UPDATE continuation_outbox
        SET route_json = ?, status = 'sending', worker_id = 'delivery-route-mismatch',
            lease_expires_at = '2026-07-17T00:10:00.000Z', attempt_count = 1
        WHERE job_id = ? AND kind = 'terminal'
      `).run(mismatchedRoute, fixture.terminalJobId);
    } finally {
      legacy.close();
    }
    const repository = await SqliteDurableRunRepository.open({ databasePath });
    repository.close();
    const migrated = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      const outbox = migrated.prepare(`
        SELECT route_json, status FROM durable_outbox
        WHERE run_id = ? AND kind = 'terminal'
      `).get(fixture.terminalJobId);
      assert.equal(outbox?.route_json, mismatchedRoute);
      assert.equal(outbox?.status, 'unknown');
    } finally {
      migrated.close();
    }
  });

  await reviewRegression('failed migration rolls back schema and legacy data', async () => {
    const fixtureRoot = join(root, 'rollback');
    const databasePath = join(fixtureRoot, 'runtime.sqlite');
    const fixture = await seedHistoricalContinuationDatabase({
      databasePath,
      now,
      version: 5,
      workingDirectory: fixtureRoot,
    });
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec('PRAGMA foreign_keys = OFF;');
      legacy.prepare(`
        UPDATE continuation_outbox
        SET attempt_id = 'attempt_missing_for_rollback',
            event_key = 'progress:attempt_missing_for_rollback'
        WHERE job_id = ? AND kind = 'progress'
      `).run(fixture.terminalJobId);
    } finally {
      legacy.close();
    }
    await assert.rejects(
      SqliteDurableRunRepository.open({ databasePath }),
      /FOREIGN KEY constraint failed|migration/u,
    );
    const rolledBack = new DatabaseSync(databasePath);
    try {
      assert.equal(Number(rolledBack.prepare('PRAGMA user_version').get()?.user_version), 5);
      assert.equal(Number(rolledBack.prepare(`
        SELECT COUNT(*) AS count FROM continuation_jobs
      `).get()?.count), 1);
      assert.deepEqual(rolledBack.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'durable_%'
      `).all(), []);
    } finally {
      rolledBack.close();
    }
  });

  if (reviewFailures.length > 0) {
    throw new AggregateError(reviewFailures, 'Task 4 migration regressions');
  }
  process.stdout.write('durable run migration smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
