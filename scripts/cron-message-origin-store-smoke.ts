import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DurableRunCreateRequest } from '../src/domain/durable-run.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { SqliteCronMessageOriginStore } from '../src/cron/message-origin-store.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';

const root = await mkdtemp(join(tmpdir(), 'cron-message-origin-store-'));
const databasePath = join(root, 'durable.sqlite');

function runRequest(runId: string): DurableRunCreateRequest {
  return {
    runId,
    workloadKind: 'cron_prompt',
    idempotencyKey: `idem:${runId}`,
    inputVersion: 1,
    input: { schemaVersion: 1 },
    stateVersion: 1,
    state: { schemaVersion: 1 },
    route: { kind: 'cron_job', jobId: 'daily-report' },
    actorOpenId: 'ou_owner',
    nextRunAt: '2026-11-15T01:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
    maxAttempts: 3,
  };
}

try {
  const durable = await SqliteDurableRunRepository.open({ databasePath });
  await durable.create(runRequest('cron_run_one'));
  await durable.create(runRequest('cron_run_two'));

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON;');
  const store = SqliteCronMessageOriginStore.attach(database, { maxEntries: 2 });
  await store.recordDelivery({
    messageIds: ['om_first', 'om_second', 'om_second'],
    chatId: 'oc_target',
    jobId: 'daily-report',
    runId: 'cron_run_one',
    jobName: 'Daily report',
    jobCreatedAt: '2026-11-01T00:00:00.000Z',
    recordedAt: '2026-11-15T01:00:00.000Z',
  });
  assert.deepEqual(await store.get('om_second'), {
    messageId: 'om_second',
    chatId: 'oc_target',
    jobId: 'daily-report',
    runId: 'cron_run_one',
    jobName: 'Daily report',
    jobCreatedAt: '2026-11-01T00:00:00.000Z',
    recordedAt: '2026-11-15T01:00:00.000Z',
  });

  await store.recordDelivery({
    messageIds: ['om_third'],
    chatId: 'oc_target',
    jobId: 'daily-report',
    runId: 'cron_run_two',
    jobName: 'Daily report',
    jobCreatedAt: '2026-11-01T00:00:00.000Z',
    recordedAt: '2026-11-15T02:00:00.000Z',
  });
  assert.equal(await store.get('om_first'), null, 'oldest mapping should be pruned');
  assert.equal((await store.get('om_third'))?.runId, 'cron_run_two');

  const reopened = SqliteCronMessageOriginStore.attach(database);
  assert.equal((await reopened.get('om_second'))?.jobId, 'daily-report');

  database.prepare('DELETE FROM durable_runs WHERE run_id = ?').run('cron_run_one');
  assert.equal(await reopened.get('om_second'), null, 'deleting a Run should remove its mappings');
  database.close();
  durable.close();

  const continuation = await SqliteContinuationRepository.open({
    databasePath: join(root, 'continuation.sqlite'),
    artifactsDir: join(root, 'artifacts'),
    inputsDir: join(root, 'inputs'),
  });
  assert.ok(
    (continuation as unknown as { cronMessageOrigins?: unknown }).cronMessageOrigins,
    'continuation repository must expose the origin store backed by its database',
  );
  continuation.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('cron message origin store smoke: PASS');
