import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import { SqliteWorkspaceCleanupClaims } from '../src/durable-run/workspace-cleanup-claims.js';
import { readWorkspaceCleanupReferences } from '../src/durable-run/workspace-cleanup-references.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-claims-fixture-')));
const databasePath = path.join(work, 'test.sqlite');
const repository = await SqliteDurableRunRepository.open({ databasePath });
const db = new DatabaseSync(databasePath, { timeout: 0 });
const legacy = new DatabaseSync(databasePath, { timeout: 0 });
try {
  for (const name of ['scratch', 'artifacts', 'source']) await fs.mkdir(path.join(work, name), { mode: 0o700 });
  const roots = { scratch: await pinWorkspacePath(work, 'scratch'), artifacts: await pinWorkspacePath(work, 'artifacts') };
  const source = await pinWorkspacePath(work, 'source');
  const owner = { kind: 'cron_prompt', runId: 'claim-fixture' } as const;
  const old = '2026-07-19T00:00:00.000Z';
  const now = '2026-11-22T00:00:00.000Z';
  const store = repository.getManagedWorkspaceStore();
  const input = { owner, roots, createdAt: old, authorizedRoots: [work] as const, project: source,
    dependencyRegistryConfigPath: path.join(work, 'missing.json') };
  const allocation = await store.ensure(input);
  await fs.writeFile(path.join(allocation.artifacts.directory, 'report.txt'), 'preserve report');
  await repository.create({ runId: owner.runId, workloadKind: owner.kind, idempotencyKey: 'fixture:claim',
    inputVersion: 1, input: { job: { workspaceProject: source } }, stateVersion: 1, state: {},
    route: { kind: 'fixture' }, actorOpenId: 'ou_fixture', nextRunAt: old, expiresAt: '2026-07-20T00:00:00.000Z', maxAttempts: 2 }, old);
  db.prepare("UPDATE durable_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ?").run(old, owner.runId);
  db.prepare(`INSERT INTO durable_outbox (outbox_id, run_id, event_key, kind, route_json, idempotency_key, payload_json,
    status, next_attempt_at, message_id, created_at, updated_at)
    VALUES ('fixture-outbox', ?, 'terminal', 'cron_terminal', '{}', 'fixture:delivery', '{}', 'sent', ?, 'om_fixture', ?, ?)`)
    .run(owner.runId, old, old, old);
  // This fixture exercises ledger admission, not filesystem baseline measurement.
  db.prepare('UPDATE workspace_cleanup_evidence SET scratch_baseline = ? WHERE run_id = ?').run('a'.repeat(64), owner.runId);
  db.exec('PRAGMA synchronous = NORMAL;');
  assert.throws(() => new SqliteWorkspaceCleanupClaims(db), /durability/);
  if (process.platform === 'darwin') {
    db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = OFF;');
    assert.throws(() => new SqliteWorkspaceCleanupClaims(db), /durability/);
  }
  db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');
  const claims = new SqliteWorkspaceCleanupClaims(db);
  const observe = () => {
    const observation = claims.observe(roots.scratch, owner);
    assert.ok(observation);
    return { roots, observation, minimumAgeDays: 30, now };
  };
  const original = observe();
  assert.equal(original.observation.reference.owner.runId, owner.runId);

  legacy.prepare("UPDATE durable_outbox SET status = 'pending' WHERE run_id = ?").run(owner.runId);
  assert.equal(claims.reserve(original), undefined, 'a new delivery reference invalidates the observation');
  assert.equal(claims.reserve(observe()), undefined, 'a pending delivery blocks a fresh observation');
  legacy.prepare("UPDATE durable_outbox SET status = 'sent' WHERE run_id = ?").run(owner.runId);
  assert.equal(claims.reserve(original), undefined, 'delivery returning to sent still invalidates an older observation');
  const beforeLocalWrite = observe();
  const recordMessage = db.prepare('UPDATE durable_outbox SET message_id = ? WHERE run_id = ?');
  recordMessage.run('om_replaced', owner.runId);
  recordMessage.run('om_fixture', owner.runId);
  assert.equal(claims.reserve(beforeLocalWrite), undefined, 'same-connection writes also invalidate the observation');
  const request = observe();
  assert.equal(claims.reserve({ ...request, minimumAgeDays: 365 }), undefined);
  assert.equal(claims.reserve({ ...request, roots: { ...roots, artifacts: source } }), undefined, 'wrong layout');
  assert.equal(claims.reserve({ ...request, observation: { ...request.observation,
    reference: { ...request.observation.reference, scratchBaseline: 'b'.repeat(64) } } }), undefined);
  assert.equal(claims.reserve({ ...request, observation: { ...request.observation,
    paths: { ...request.observation.paths, paths: [] } } }), undefined, 'changed protected paths');

  db.exec('CREATE TEMP TABLE workspace_cleanup_claims (run_id TEXT);');
  assert.throws(() => claims.reserve(request), /isolated connection/);
  db.exec('DROP TABLE temp.workspace_cleanup_claims;');

  await repository.create({ runId: 'fixture-referring-job', workloadKind: 'async_task', idempotencyKey: 'fixture:referring-job',
    inputVersion: 1, input: { job: { workingDirectory: allocation.scratch.directory, permissions: { filesystem: { requestedPaths: [] } } } },
    stateVersion: 1, state: {}, route: { kind: 'fixture' }, actorOpenId: 'ou_fixture', nextRunAt: old,
    expiresAt: '2026-07-20T00:00:00.000Z', maxAttempts: 2 }, old);
  const referenced = readWorkspaceCleanupReferences(db, roots.scratch);
  assert.ok(referenced.paths.paths.includes(allocation.scratch.directory));
  assert.equal(claims.reserve(observe()), undefined,
    'current saved references also block reservation, not just a changed observation');
  legacy.prepare("UPDATE durable_runs SET deleted_at = ? WHERE run_id = 'fixture-referring-job'").run(now);

  legacy.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => claims.reserve(request), /locked/i); }
  finally { legacy.exec('ROLLBACK'); }
  const reader = new SqliteManagedWorkspaceStore(legacy);
  const fresh = observe();
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const realpath = fs.realpath.bind(fs);
  const pauseBeforePin = mock.method(fs, 'realpath', async (...args: Parameters<typeof realpath>) => {
    if (args[0] === allocation.scratch.directory) { paused.resolve(); await resume.promise; }
    return realpath(...args);
  });
  const openedDuringClaim = assert.rejects(reader.openDirectory(owner, 'scratch', [work]), { code: 'allocation_transaction' });
  await paused.promise;
  legacy.exec('BEGIN');
  assert.ok(reader.get(owner), 'old WAL snapshot is established');
  const claim = claims.reserve(fresh);
  try {
    resume.resolve();
    await openedDuringClaim;
  } finally { pauseBeforePin.mock.restore(); }
  assert.ok(claim);
  assert.equal(claim.state, 'reserved');
  assert.deepEqual(claim.scratch, allocation.scratch);
  assert.match(claim.nonce, /^[a-f0-9]{32}$/);
  assert.equal(claims.reserve(request), undefined, 'never acquire the same scope twice');
  assert.equal(readWorkspaceCleanupReferences(db, roots.scratch).references[0]?.cleanupClaimed, true);
  await assert.rejects(reader.openDirectory(owner, 'scratch', [work]), { code: 'allocation_transaction' });
  assert.equal(await reader.openDirectory(owner, 'artifacts', [work]), allocation.artifacts.directory);
  legacy.exec('COMMIT');
  const touch = () => legacy.prepare('UPDATE workspace_run_allocations SET last_used_at = last_used_at WHERE run_id = ?').run(owner.runId);
  assert.throws(touch, /workspace_cleanup_claimed/);
  const reserveInstall = () => legacy.prepare(`INSERT INTO workspace_dependency_installs
    (workload_kind, run_id, ecosystem, compatibility_key, nonce) VALUES (?, ?, 'npm', 'fixture', 'fixture')`).run(owner.kind, owner.runId);
  assert.throws(reserveInstall, /workspace_cleanup_claimed/);
  await assert.rejects(store.ensure(input), { code: 'cleanup_claimed' });
  await assert.rejects(store.openDirectory(owner, 'scratch', [work]), { code: 'cleanup_claimed' });
  assert.equal(claims.advance(claim, 'removed', now), undefined, 'no direct purge transition');
  assert.equal(claims.advance({ ...claim, nonce: '0'.repeat(32) }, 'isolated', now), undefined);

  const reopened = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    reopened.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');
    const recovery = new SqliteWorkspaceCleanupClaims(reopened);
    assert.deepEqual(recovery.get(owner), claim);
    const isolated = recovery.advance(claim, 'isolated', now);
    assert.ok(isolated);
    assert.equal(recovery.advance(claim, 'isolated', now), undefined, 'stale transition');
    const removed = recovery.advance(isolated, 'removed', now);
    assert.ok(removed);
    assert.equal(removed.state, 'removed');
    assert.deepEqual(recovery.get(owner), removed);
    assert.throws(touch, /workspace_cleanup_claimed/, 'the tombstone also fences old writers');
    const artifactRoot = await store.openDirectory(owner, 'artifacts', [work]);
    assert.equal(await fs.readFile(path.join(artifactRoot, 'report.txt'), 'utf8'), 'preserve report');
    assert.deepEqual(await fs.readdir(allocation.scratch.directory), [], 'the journal does not perform filesystem mutation');
    assert.equal(await fs.stat(allocation.scratch.directory).then((directory) => directory.isDirectory()), true);
    reopened.exec('DROP TRIGGER workspace_cleanup_fence_claimed');
    assert.throws(() => new SqliteWorkspaceCleanupClaims(reopened), /fences are unavailable/);
    assert.throws(() => recovery.reserve(request), /fences are unavailable/);
    await assert.rejects(store.openDirectory(owner, 'scratch', [work]), { code: 'cleanup_claimed' });
  } finally { reopened.close(); }
} finally {
  legacy.close();
  db.close();
  repository.close();
  await fs.rm(work, { recursive: true, force: true });
}
console.log('workspace cleanup claim journal: PASS');
