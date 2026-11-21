import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import { parseWorkspaceMountTable, workspaceBackingAliases } from '../src/managed-workspace-ancestry.js';
import { gitSnapshotKey, verifyWorkspaceGitCache } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath, workspacePathContains } from '../src/workspace-projects.js';

const mounts = parseWorkspaceMountTable('1 0 8:1 / / rw - ext4 /dev/fixture rw\n'
  + '2 1 8:1 /workspace/cache/objects /prior-run/bind\\040objects rw - ext4 /dev/fixture rw\n'
  + '3 1 8:1 / /second-root rw - ext4 /dev/fixture rw\n');
assert.ok(workspaceBackingAliases('/prior-run/bind objects/pack', mounts).includes('/workspace/cache/objects/pack'));
assert.ok(workspaceBackingAliases('/second-root/workspace', mounts).includes('/workspace'));
const overlaps = (stored: string, candidate: string) => workspaceBackingAliases(candidate, mounts).some((alias) =>
  workspacePathContains(alias, stored) || workspacePathContains(stored, alias));
assert.ok(overlaps('/prior-run', '/workspace/cache'));
assert.ok(overlaps('/workspace/cache', '/prior-run'));
assert.ok(!overlaps('/unrelated', '/workspace/cache'));

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-managed-git-replay-'));
try {
  const base = await fs.realpath(fixture);
  const source = path.join(base, 'source');
  const scratch = path.join(base, 'scratch');
  const artifacts = path.join(base, 'artifacts');
  const cache = path.join(base, 'cache');
  const databasePath = path.join(base, 'workspace.sqlite');
  const git = (argv: string[], input?: string) => execFileSync('git', argv, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  await Promise.all([scratch, artifacts, path.join(cache, 'objects', 'pack'), path.join(cache, 'refs')]
    .map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  git(['init', '--quiet', '--object-format=sha1', source]);
  await fs.writeFile(path.join(source, 'fixture.txt'), 'selected');
  git(['-C', source, 'add', 'fixture.txt']);
  const commitArgs = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm'];
  git(['-C', source, ...commitArgs, 'source']);
  const commit = git(['-C', source, 'rev-parse', 'HEAD']);
  await fs.writeFile(path.join(cache, 'HEAD'), `${commit}\n`);
  await fs.writeFile(path.join(cache, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  git(['-C', source, 'pack-objects', '--revs', path.join(cache, 'objects', 'pack', 'pack')], `${commit}\n`);

  const authorizedRoots = [base] as const;
  const gitDirectory = await pinWorkspacePath(base, cache);
  const verified = await verifyWorkspaceGitCache({ authorizedRoots, gitDirectory, repositoryId: 'f'.repeat(64), scope: 'team', commit });
  const request = {
    authorizedRoots,
    roots: { scratch: await pinWorkspacePath(base, scratch), artifacts: await pinWorkspacePath(base, artifacts) },
    project: await pinWorkspacePath(base, source),
    git: { ...verified, cache: gitDirectory },
    owner: { kind: 'async_task', runId: 'snapshot-job' } as const,
    createdAt: '2026-11-21T12:00:00.000Z',
  };
  const db = new DatabaseSync(databasePath);
  let first;
  try {
    const store = new SqliteManagedWorkspaceStore(db);
    const stale = { ...request, git: { ...request.git, storeFingerprint: '0'.repeat(64) },
      owner: { kind: 'async_task', runId: 'stale-first-selection' } } as const;
    await assert.rejects(store.ensure(stale), { code: 'git_cache_mismatch' });
    assert.equal(store.get(stale.owner), null);
    assert.deepEqual(await fs.readdir(scratch), []);
    const interrupted = { ...request, owner: { kind: 'async_task', runId: 'interrupted-materialization' } } as const;
    const writeFile = fs.writeFile.bind(fs);
    const interposer = mock.method(fs, 'writeFile', (...args: Parameters<typeof writeFile>) =>
      typeof args[0] === 'string' && path.basename(args[0]) === 'alternates'
        ? Promise.reject(new Error('Fixture write failure.')) : writeFile(...args));
    try {
      await assert.rejects(store.ensure(interrupted), { code: 'git_checkout_failed' });
    } finally {
      interposer.mock.restore();
    }
    assert.throws(() => store.get(interrupted.owner), { code: 'allocation_incomplete' });
    assert.equal(db.prepare('SELECT count(*) AS count FROM workspace_git_caches').get()?.count, 0);
    const config = path.join(cache, 'config');
    await fs.rename(config, path.join(base, 'first-config'));
    await fs.copyFile(path.join(base, 'first-config'), config);
    request.git.storeFingerprint = (await verifyWorkspaceGitCache({ authorizedRoots, gitDirectory,
      repositoryId: request.git.repositoryId, scope: request.git.scope, commit })).storeFingerprint;
    first = await store.ensure(request);
    assert.deepEqual(store.get(request.owner)?.allocation, first);
    assert.deepEqual(first.git, request.git);
    assert.ok(first.gitCheckout);
    const competing = await store.ensure({ ...request, owner: { kind: 'cron_prompt', runId: 'concurrent-cron' } });
    assert.deepEqual(competing.git, first.git);
    assert.notEqual(competing.gitCheckout?.checkout.inode, first.gitCheckout.checkout.inode);
    const otherScope = { ...request.git, scope: 'another-team' };
    const mismatched = { ...request, git: { ...otherScope, key: gitSnapshotKey(otherScope) }, owner: { kind: 'async_task', runId: 'wrong-scope' } } as const;
    await assert.rejects(store.ensure(mismatched), { code: 'git_cache_conflict' });
    assert.equal(store.get(mismatched.owner), null);
    await assert.rejects(store.ensure({ ...request, git: undefined, roots: { ...request.roots, artifacts: gitDirectory },
      owner: { kind: 'async_task', runId: 'cache-as-artifacts' } }), { code: 'overlapping_git_cache' });
    await assert.rejects(store.ensure({ ...request, git: undefined, project: gitDirectory,
      owner: { kind: 'async_task', runId: 'cache-as-project' } }), { code: 'overlapping_git_cache' });

    const otherScratch = path.join(base, 'other-scratch');
    const otherArtifacts = path.join(base, 'other-artifacts');
    const badCache = path.join(scratch, 'sibling-of-prior-run');
    await fs.mkdir(otherScratch);
    await fs.mkdir(otherArtifacts);
    await fs.cp(cache, badCache, { recursive: true });
    const embedded = await pinWorkspacePath(base, badCache);
    const embeddedCache = await verifyWorkspaceGitCache({ authorizedRoots, gitDirectory: embedded,
      repositoryId: request.git.repositoryId, scope: 'embedded', commit });
    const inExistingRoot = { ...request, git: { ...embeddedCache, cache: embedded }, owner: { kind: 'async_task', runId: 'inside-old-root' },
      roots: { scratch: await pinWorkspacePath(base, otherScratch), artifacts: await pinWorkspacePath(base, otherArtifacts) } } as const;
    await assert.rejects(store.ensure(inExistingRoot), { code: 'overlapping_runs' });
    assert.equal(store.get(inExistingRoot.owner), null);
  } finally {
    db.close();
  }
  const checkout = first.gitCheckout.checkout.directory;
  const localGit = first.gitCheckout.gitDirectory.directory;
  await fs.writeFile(path.join(checkout, 'fixture.txt'), 'local edits');
  await fs.writeFile(path.join(checkout, 'draft.txt'), 'local draft');
  git(['-C', checkout, 'add', 'fixture.txt']);
  git(['-C', checkout, ...commitArgs, 'local']);
  const localCommit = git(['-C', checkout, 'rev-parse', 'HEAD']);
  await fs.writeFile(path.join(source, 'fixture.txt'), 'source advanced');
  git(['-C', source, 'add', 'fixture.txt']);
  git(['-C', source, ...commitArgs, 'source advanced']);
  const restarted = new DatabaseSync(databasePath);
  try {
    const store = new SqliteManagedWorkspaceStore(restarted);
    const later = '2026-11-21T13:00:00.000Z';
    assert.deepEqual(await store.ensure({ ...request, usedAt: later }), first);
    assert.equal(git(['-C', checkout, 'rev-parse', 'HEAD']), localCommit);
    assert.equal(await fs.readFile(path.join(checkout, 'draft.txt'), 'utf8'), 'local draft');
    assert.equal(await fs.readFile(path.join(checkout, 'fixture.txt'), 'utf8'), 'local edits');
    assert.equal(await fs.readFile(path.join(source, 'fixture.txt'), 'utf8'), 'source advanced');
    await assert.rejects(store.ensure({ ...request, git: undefined }), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...request, authorizedRoots: [scratch] }), { code: 'outside_authorized_root' });

    const alternate = path.join(localGit, 'objects', 'info', 'alternates');
    const original = await fs.readFile(alternate);
    await fs.writeFile(alternate, '');
    await assert.rejects(store.ensure(request), { code: 'git_checkout_changed' });
    await fs.writeFile(alternate, original);
    await fs.rename(cache, path.join(base, 'displaced-cache'));
    await assert.rejects(store.ensure(request), { code: 'unavailable_directory' });
    await fs.rename(path.join(base, 'displaced-cache'), cache);
    const config = path.join(cache, 'config');
    const contents = await fs.readFile(config);
    await fs.rename(config, path.join(base, 'previous-config'));
    await fs.writeFile(config, contents);
    await assert.rejects(store.ensure(request), { code: 'git_cache_mismatch' });
    await fs.rename(path.join(base, 'previous-config'), config);
    await fs.rename(localGit, path.join(checkout, 'displaced-git'));
    await fs.mkdir(localGit);
    await assert.rejects(store.ensure(request), { code: 'directory_changed' });
    assert.equal(await store.openDirectory(request.owner, 'artifacts', authorizedRoots), first.artifacts.directory);
    assert.equal(store.get(request.owner)?.lastUsedAt, later);
  } finally {
    restarted.close();
  }
  console.log('workspace Git replay smoke: PASS');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
