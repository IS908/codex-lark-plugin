import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncTaskKernelAdapter } from '../src/continuation/async-task-kernel-adapter.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-durable-cutover-'));
const databasePath = join(root, 'runtime.sqlite');
const options = {
  databasePath,
  artifactsDir: join(root, 'artifacts'),
  inputsDir: join(root, 'inputs'),
};

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

  process.stdout.write('continuation durable cutover smoke: PASS\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
