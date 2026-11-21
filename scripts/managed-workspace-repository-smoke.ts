import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import { allocateManagedRunDirectories, readManagedWorkspaceRoots } from '../src/managed-workspace-storage.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-managed-ledger-'));
try {
  const base = await fs.realpath(fixture);
  const allowed = path.join(base, 'workspace');
  const scratchRoot = path.join(allowed, 'runs');
  const artifactRoot = path.join(allowed, 'artifacts');
  for (const dir of [scratchRoot, artifactRoot]) await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(base, 'operator.json');
  const authorizedRoots = [allowed] as const;
  const configure = (scratchRoot: string, artifactRoot: string) => fs.writeFile(configPath,
    JSON.stringify({ version: 1, scratchRoot, artifactRoot }));
  await configure(scratchRoot, artifactRoot);
  const roots = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
  assert.ok(roots);

  const owner = { kind: 'async_task', runId: 'job-1' } as const;
  const createdAt = '2026-11-21T12:00:00.000Z';
  const request = { roots, owner, createdAt, authorizedRoots };
  const databasePath = path.join(base, 'host.sqlite');
  const conflicted = { ...request, owner: { ...owner, runId: 'conflicted' } };
  const db1 = new DatabaseSync(databasePath);
  const db2 = new DatabaseSync(databasePath);
  let allocation;
  try {
    const store1 = new SqliteManagedWorkspaceStore(db1);
    const store2 = new SqliteManagedWorkspaceStore(db2);
    const results = await Promise.allSettled([store1.ensure(request), store2.ensure(request)]);
    const ready = results.find((result) => result.status === 'fulfilled');
    assert.ok(ready);
    allocation = ready.value;
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.code, 'allocation_incomplete');
      else assert.deepEqual(result.value, allocation);
    }
    assert.deepEqual(store2.get(owner), { allocation, lastUsedAt: createdAt });
    assert.equal((await fs.readdir(scratchRoot)).length, 1);
    const unknown = await allocateManagedRunDirectories(conflicted);
    await fs.writeFile(path.join(unknown.scratch.directory, 'existing.txt'), 'do not adopt');
    await assert.rejects(store1.ensure(conflicted), { code: 'allocation_conflict' });
    assert.equal(await fs.readFile(path.join(unknown.scratch.directory, 'existing.txt'), 'utf8'), 'do not adopt');

    const denied = { ...request, owner: { ...owner, runId: 'denied' } };
    await assert.rejects(store1.ensure({ ...denied, authorizedRoots: [scratchRoot] }), { code: 'outside_authorized_root' });
    assert.equal(store1.get(denied.owner), null, 'failed authorization must not reserve the ID');

    const insideTransaction = { ...request, owner: { ...owner, runId: 'inside-transaction' } };
    db1.exec('BEGIN');
    try {
      await assert.rejects(store1.ensure(insideTransaction), { code: 'allocation_transaction' });
    } finally {
      db1.exec('ROLLBACK');
    }
    assert.equal(store1.get(insideTransaction.owner), null);
    assert.equal((await fs.readdir(scratchRoot)).length, 2, 'no directories were allocated by rejected requests');

    const nestedArtifactRoot = path.join(allocation.scratch.directory, 'nested-artifacts');
    const newScratchRoot = path.join(allowed, 'new-runs');
    await fs.mkdir(nestedArtifactRoot);
    await fs.mkdir(newScratchRoot);
    await configure(newScratchRoot, nestedArtifactRoot);
    const nestedRoots = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
    assert.ok(nestedRoots);
    const nested = { ...request, roots: nestedRoots, owner: { ...owner, runId: 'nested' } };
    await assert.rejects(store2.ensure(nested), { code: 'overlapping_runs' });
    assert.equal(store1.get(nested.owner), null);
    assert.deepEqual(await fs.readdir(nestedArtifactRoot), []);

    const alias = path.join(allowed, 'alias-of-owned-run');
    await fs.mkdir(alias, { mode: 0o700 });
    const stat = fs.stat.bind(fs);
    const originalScratch = await stat(allocation.scratch.directory, { bigint: true });
    const simulatedMount = mock.method(fs, 'stat', (...args: Parameters<typeof stat>) =>
      args[0] === alias ? Promise.resolve(originalScratch) : stat(...args));
    const lstat = fs.lstat.bind(fs);
    const simulatedMountLstat = mock.method(fs, 'lstat', (...args: Parameters<typeof lstat>) =>
      args[0] === alias ? Promise.resolve(originalScratch) : lstat(...args));
    try {
      await configure(newScratchRoot, alias);
      const aliasedRoots = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
      assert.ok(aliasedRoots);
      const aliased = { ...request, roots: aliasedRoots, owner: { ...owner, runId: 'aliased' } };
      await assert.rejects(store2.ensure(aliased), { code: 'overlapping_runs' });
      assert.equal(store1.get(aliased.owner), null);
      assert.deepEqual(await fs.readdir(newScratchRoot), []);
    } finally {
      simulatedMount.mock.restore();
      simulatedMountLstat.mock.restore();
    }
  } finally {
    db1.close();
    db2.close();
  }

  const db3 = new DatabaseSync(databasePath);
  try {
    await configure(artifactRoot, scratchRoot);
    const changed = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
    assert.ok(changed);
    const store = new SqliteManagedWorkspaceStore(db3);
    await assert.rejects(store.ensure({ ...conflicted, roots: changed }), { code: 'allocation_incomplete' });
    const later = '2026-11-21T13:00:00.000Z';
    await assert.rejects(store.ensure({ ...request, roots: changed, usedAt: later }), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...request, createdAt: later }), { code: 'invalid_binding' });
    assert.deepEqual(await store.ensure({ ...request, usedAt: later }), allocation);
    assert.deepEqual(store.get(owner), { allocation, lastUsedAt: later });
    await store.ensure({ ...request, usedAt: '2026-11-21T14:00:00Z' });
    await store.ensure({ ...request, usedAt: '2026-11-21T14:00:00.001Z' });
    assert.equal(store.get(owner)?.lastUsedAt, '2026-11-21T14:00:00.001Z');
    const project = path.join(allowed, 'prior-project');
    const insideProject = path.join(project, 'work');
    await fs.mkdir(insideProject, { recursive: true });
    await store.ensure({ ...request, owner: { ...owner, runId: 'uses-source' }, project: await pinWorkspacePath(allowed, project) });
    await configure(insideProject, artifactRoot);
    const colliding = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
    assert.ok(colliding);
    await assert.rejects(store.ensure({ ...request, roots: colliding, owner: { ...owner, runId: 'other-project' } }),
      { code: 'overlapping_source' });
    assert.deepEqual(await fs.readdir(insideProject), []);
    const legacySource = path.join(allowed, 'previous-legacy-project');
    await fs.mkdir(legacySource);
    const oldProject = await pinWorkspacePath(allowed, legacySource);
    store.rememberUnmanagedForeground('earlier-foreground', { sessionKey: 'legacy-session', project: oldProject });
    await configure(scratchRoot, legacySource);
    const collidingLegacy = await readManagedWorkspaceRoots({ configPath, authorizedRoots });
    assert.ok(collidingLegacy);
    await assert.rejects(store.ensure({ ...request, roots: collidingLegacy, owner: { ...owner, runId: 'with-legacy-source' } }),
      { code: 'overlapping_source' });
    assert.deepEqual(await fs.readdir(legacySource), []);

    const missingOwner = { ...owner, runId: 'unowned' };
    assert.equal(store.get(missingOwner), null);
    await fs.writeFile(path.join(allocation.artifacts.directory, 'result.txt'), 'result');
    await fs.rename(allocation.scratch.directory, path.join(scratchRoot, 'unavailable'));
    await assert.rejects(store.ensure({ ...request, usedAt: later }), { code: 'unavailable_directory' });
    const formal = await store.openDirectory(owner, 'artifacts', authorizedRoots);
    assert.equal(await fs.readFile(path.join(formal, 'result.txt'), 'utf8'), 'result');
  } finally {
    db3.close();
  }
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
