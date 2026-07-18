import assert from 'node:assert/strict';
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
        SELECT attempt_id, run_id, execution_phase
        FROM durable_attempts WHERE attempt_id = ?
      `).get(fixture.terminalAttemptId);
      assert.equal(attempt?.attempt_id, fixture.terminalAttemptId, `v${version} attempt ID`);
      assert.equal(attempt?.run_id, fixture.terminalJobId, `v${version} attempt run`);
      if (version === 9) {
        assert.equal(attempt?.execution_phase, 'execution_started', 'v9 execution phase');
      }

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
          SELECT receipt_id, run_id, attempt_id, status
          FROM durable_operation_receipts WHERE receipt_id = ?
        `).get(fixture.operationReceiptId);
        assert.equal(receipt?.receipt_id, fixture.operationReceiptId, `v${version} receipt ID`);
        assert.equal(receipt?.run_id, fixture.terminalJobId, `v${version} receipt run`);
        assert.equal(receipt?.attempt_id, fixture.terminalAttemptId, `v${version} receipt attempt`);
        assert.equal(receipt?.status, 'completed', `v${version} receipt status`);
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
  }
  process.stdout.write('durable run migration smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
