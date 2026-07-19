import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncTaskKernelAdapter } from '../src/continuation/async-task-kernel-adapter.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { seedHistoricalContinuationDatabase } from './fixtures/continuation-historical-schema.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-durable-cutover-'));
const databasePath = join(root, 'runtime.sqlite');
const options = {
  databasePath,
  artifactsDir: join(root, 'artifacts'),
  inputsDir: join(root, 'inputs'),
};
const now = '2026-07-17T00:00:00.000Z';
const reviewFailures: Error[] = [];

async function reviewRegression(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reviewFailures.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function kernelAdapter(repository: SqliteContinuationRepository): AsyncTaskKernelAdapter {
  return new AsyncTaskKernelAdapter({
    repository,
    executor: {
      async execute() {
        throw new Error('cutover smoke must not execute a malformed persisted task');
      },
    },
    delivery: {
      async deliver() {
        return { status: 'failed', errorCode: 'not_used', errorSummary: 'not used' };
      },
    },
  });
}

async function migratedFixture(name: string): Promise<{
  databasePath: string;
  jobId: string;
  attemptId: string;
  repository: SqliteContinuationRepository;
}> {
  const fixtureRoot = join(root, name);
  const fixtureDatabasePath = join(fixtureRoot, 'runtime.sqlite');
  const fixture = await seedHistoricalContinuationDatabase({
    databasePath: fixtureDatabasePath,
    now,
    version: 9,
    workingDirectory: fixtureRoot,
  });
  const repository = await SqliteContinuationRepository.open({
    databasePath: fixtureDatabasePath,
    artifactsDir: join(fixtureRoot, 'artifacts'),
    inputsDir: join(fixtureRoot, 'inputs'),
  });
  return {
    databasePath: fixtureDatabasePath,
    jobId: fixture.terminalJobId,
    attemptId: fixture.terminalAttemptId,
    repository,
  };
}

function makeRunDue(databasePath: string, jobId: string): void {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    database.prepare(`
      UPDATE durable_runs
      SET status = 'waiting_retry', completed_at = NULL, next_run_at = ?,
          expires_at = '2026-07-18T00:00:00.000Z', lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, row_version = row_version + 1,
          updated_at = ?
      WHERE run_id = ? AND workload_kind = 'async_task'
    `).run(now, now, jobId);
    database.prepare(`DELETE FROM durable_outbox WHERE run_id = ?`).run(jobId);
  } finally {
    database.close();
  }
}

try {
  const repository = await SqliteContinuationRepository.open(options);
  repository.close();

  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), 10);
    const durableTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'durable_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(durableTables, [
      'durable_attempts',
      'durable_interrupts',
      'durable_operation_receipts',
      'durable_outbox',
      'durable_runs',
    ]);
    const legacyBaseTables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'continuation_%'
    `).all();
    assert.deepEqual(legacyBaseTables, []);
    const adapterViews = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND name LIKE 'continuation_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(adapterViews, [
      'continuation_attempts',
      'continuation_interrupts',
      'continuation_jobs',
      'continuation_outbox',
      'continuation_tool_calls',
    ]);
    await reviewRegression('compatibility schema is read-only', async () => {
      const writableTriggers = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'continuation_%'
        ORDER BY name
      `).all();
      assert.deepEqual(writableTriggers, []);
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }

  const parseState = AsyncTaskKernelAdapter.prototype.parseState;
  assert.throws(
    () => parseState.call({} as AsyncTaskKernelAdapter, {
      schemaVersion: 1,
      job: {
        jobId: 'job_incomplete',
        idempotencyKey: 'idem-incomplete',
        creatorOpenId: 'ou_incomplete',
        status: 'queued',
        rowVersion: 1,
      },
    }, 1),
    /Invalid Continuation Job|envelope/u,
  );

  await reviewRegression('normal Async claim invokes generic repository API', async () => {
    const fixture = await migratedFixture('generic-claim-spy');
    try {
      makeRunDue(fixture.databasePath, fixture.jobId);
      const prototype = SqliteDurableRunRepository.prototype;
      const original = prototype.claimDue;
      let genericClaimCalls = 0;
      prototype.claimDue = async function (...args) {
        genericClaimCalls += 1;
        return original.apply(this, args);
      };
      try {
        await kernelAdapter(fixture.repository).claimDue(
          ['async_task'],
          'worker-generic-claim-spy',
          now,
          '2026-07-17T00:01:00.000Z',
        );
      } finally {
        prototype.claimDue = original;
      }
      assert.equal(genericClaimCalls, 1);
    } finally {
      fixture.repository.close();
    }
  });

  for (const corruption of [
    { name: 'input version', sql: 'input_version = 2' },
    { name: 'state version', sql: 'state_version = 2' },
    {
      name: 'input/state identity mismatch',
      sql: `input_json = json_set(input_json, '$.job.jobId', 'job_mismatched_input')`,
    },
  ]) {
    await reviewRegression(`normal claim fails closed on bad ${corruption.name}`, async () => {
      const fixture = await migratedFixture(`bad-normal-${corruption.name.replaceAll(/[^a-z]+/gu, '-')}`);
      try {
        makeRunDue(fixture.databasePath, fixture.jobId);
        const database = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
        try {
          database.exec(`
            UPDATE durable_runs SET ${corruption.sql}
            WHERE run_id = '${fixture.jobId}' AND workload_kind = 'async_task';
          `);
        } finally {
          database.close();
        }
        const claim = await kernelAdapter(fixture.repository).claimDue(
          ['async_task'],
          `worker-bad-normal-${corruption.name}`,
          now,
          '2026-07-17T00:01:00.000Z',
        );
        assert.equal(claim, null);
        const persisted = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
        try {
          const run = persisted.prepare(`
            SELECT status, input_version, state_version, error_code
            FROM durable_runs WHERE run_id = ?
          `).get(fixture.jobId);
          assert.equal(run?.status, 'failed');
          assert.equal(run?.error_code, 'continuation_persisted_state_invalid');
          if (corruption.name === 'input version') assert.equal(run?.input_version, 2);
          if (corruption.name === 'state version') assert.equal(run?.state_version, 2);
        } finally {
          persisted.close();
        }
      } finally {
        fixture.repository.close();
      }
    });
  }

  await reviewRegression('recovery fails closed on unsupported persisted input version', async () => {
    const fixture = await migratedFixture('bad-recovery-version');
    try {
      const database = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
      try {
        database.prepare(`
          UPDATE durable_runs
          SET status = 'running', input_version = 2, completed_at = NULL,
              lease_owner = 'worker-bad-recovery', lease_expires_at = '2026-07-16T23:59:00.000Z',
              heartbeat_at = '2026-07-16T23:59:00.000Z', updated_at = ?
          WHERE run_id = ?
        `).run(now, fixture.jobId);
        database.prepare(`
          UPDATE durable_attempts
          SET finished_at = NULL, outcome = NULL, recovery_pending = 0,
              lease_expires_at = '2026-07-16T23:59:00.000Z'
          WHERE attempt_id = ? AND run_id = ?
        `).run(fixture.attemptId, fixture.jobId);
        database.prepare(`DELETE FROM durable_outbox WHERE run_id = ?`).run(fixture.jobId);
      } finally {
        database.close();
      }
      assert.deepEqual(
        await kernelAdapter(fixture.repository).recoverExpiredLeases(['async_task'], now),
        [],
      );
      const persisted = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
      try {
        const run = persisted.prepare(`
          SELECT status, input_version, error_code FROM durable_runs WHERE run_id = ?
        `).get(fixture.jobId);
        assert.deepEqual({ ...run }, {
          status: 'failed',
          input_version: 2,
          error_code: 'continuation_persisted_state_invalid',
        });
      } finally {
        persisted.close();
      }
    } finally {
      fixture.repository.close();
    }
  });

  await reviewRegression('recovered cancellation commits through generic CAS', async () => {
    const fixture = await migratedFixture('recovered-cancel');
    try {
      const database = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
      try {
        database.prepare(`
          UPDATE durable_runs
          SET status = 'cancel_requested', completed_at = NULL,
              lease_owner = 'worker-cancel-before-crash',
              lease_expires_at = '2026-07-16T23:59:00.000Z',
              heartbeat_at = '2026-07-16T23:59:00.000Z',
              row_version = row_version + 1, updated_at = ?
          WHERE run_id = ?
        `).run(now, fixture.jobId);
        database.prepare(`
          UPDATE durable_attempts
          SET finished_at = NULL, outcome = NULL, recovery_pending = 0,
              worker_id = 'worker-cancel-before-crash',
              lease_expires_at = '2026-07-16T23:59:00.000Z'
          WHERE attempt_id = ? AND run_id = ?
        `).run(fixture.attemptId, fixture.jobId);
        database.prepare(`DELETE FROM durable_outbox WHERE run_id = ?`).run(fixture.jobId);
      } finally {
        database.close();
      }
      const adapter = kernelAdapter(fixture.repository);
      const [interrupted] = await adapter.recoverExpiredLeases(['async_task'], now);
      assert.ok(interrupted);
      const transition = adapter.recoverInterruptedAttempt(interrupted);
      assert.equal(transition.status, 'cancelled');
      assert.equal(await adapter.commitTransition(interrupted.claim, transition, now), 'committed');
      const persisted = new DatabaseSync(fixture.databasePath, { enableForeignKeyConstraints: true });
      try {
        const row = persisted.prepare(`
          SELECT r.status, a.recovery_pending, a.finished_at
          FROM durable_runs r JOIN durable_attempts a ON a.run_id = r.run_id
          WHERE r.run_id = ? AND a.attempt_id = ?
        `).get(fixture.jobId, fixture.attemptId);
        assert.equal(row?.status, 'cancelled');
        assert.equal(row?.recovery_pending, 0);
        assert.equal(row?.finished_at, now);
      } finally {
        persisted.close();
      }
    } finally {
      fixture.repository.close();
    }
  });

  if (reviewFailures.length > 0) {
    throw new AggregateError(reviewFailures, 'Task 4 cutover regressions');
  }

  process.stdout.write('continuation durable cutover smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
