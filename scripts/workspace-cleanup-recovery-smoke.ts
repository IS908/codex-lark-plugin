import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ManagedGitSelection } from '../src/domain/managed-workspace.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { SqliteWorkspaceCleanupClaims } from '../src/durable-run/workspace-cleanup-claims.js';
import { observeWorkspaceCleanupTree } from '../src/workspace-cleanup-evidence.js';
import { createWorkspaceCleanupFiles, workspaceCleanupQuarantinePath } from '../src/workspace-cleanup-files.js';
import { recoverWorkspaceCleanupClaim, reserveWorkspaceCleanupCandidate } from '../src/workspace-cleanup-recovery.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { readWorkspaceGitCacheIdentity } from '../src/workspace-git-snapshot.js';

const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-cleanup-recovery-')));
const databasePath = path.join(work, 'state.sqlite');
const repository = await SqliteDurableRunRepository.open({ databasePath });
const open = () => {
  const db = new DatabaseSync(databasePath, { timeout: 0 });
  db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');
  return db;
};
let db = open();
try {
  for (const name of ['scratch', 'artifacts', 'source']) await fs.mkdir(path.join(work, name), { mode: 0o700 });
  const roots = { scratch: await pinWorkspacePath(work, 'scratch'), artifacts: await pinWorkspacePath(work, 'artifacts') };
  const project = await pinWorkspacePath(work, 'source');
  const old = '2026-07-19T00:00:00.000Z';
  const current = '2026-11-22T00:00:00.000Z';
  const databaseInode = await fs.lstat(databasePath, { bigint: true });
  const files = await createWorkspaceCleanupFiles(roots.scratch,
    { directory: databasePath, inode: String(databaseInode.ino), device: String(databaseInode.dev) });
  assert.ok(files);
  const store = repository.getManagedWorkspaceStore();
  const options = () => ({
    claims: new SqliteWorkspaceCleanupClaims(db), files, roots, authorizedRoots: [work] as const,
    minimumAgeDays: 30, now: () => new Date(current), signal: AbortSignal.timeout(20_000), revalidatePolicy: async () => true,
  });
  const fixture = async (runId: string, git?: ManagedGitSelection) => {
    const owner = { kind: 'cron_prompt', runId } as const;
    const allocation = await store.ensure({ owner, roots, createdAt: old, authorizedRoots: [work], project, ...(git ? { git } : {}),
      dependencyRegistryConfigPath: path.join(work, 'missing.json') });
    const report = path.join(allocation.artifacts.directory, 'report.txt');
    await fs.writeFile(report, 'kept');
    await repository.create({ runId, workloadKind: owner.kind, idempotencyKey: `fixture:${runId}`,
      inputVersion: 1, input: { job: { workspaceProject: project } }, stateVersion: 1, state: {},
      route: { kind: 'fixture' }, actorOpenId: 'ou_fixture', nextRunAt: old, expiresAt: '2026-07-20T00:00:00.000Z', maxAttempts: 2 }, old);
    db.prepare("UPDATE durable_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ?").run(old, runId);
    db.prepare(`INSERT INTO durable_outbox (outbox_id, run_id, event_key, kind, route_json, idempotency_key, payload_json,
      status, next_attempt_at, message_id, created_at, updated_at)
      VALUES (?, ?, 'terminal', 'cron_terminal', '{}', ?, '{}', 'sent', ?, ?, ?, ?)`)
      .run(runId, runId, `deliver:${runId}`, old, `om_fixture_${runId}`, old, old);
    const claim = await reserveWorkspaceCleanupCandidate(options(), owner);
    assert.ok(claim);
    return { owner, claim, report };
  };
  const moveBeforeJournal = async (runId: string) => {
    const sample = await fixture(runId);
    const tree = await observeWorkspaceCleanupTree(sample.claim.scratch, undefined, true);
    assert.ok(tree);
    // Simulate a crash between the native rename and the database transition.
    assert.equal(await files.move(sample.claim, tree, () => true), true);
    db.close();
    db = open();
    return sample;
  };

  const renameCrash = await moveBeforeJournal('crash-after-move');
  const resumed = options();
  assert.deepEqual(resumed.claims.pending(roots.scratch, 5), [renameCrash.claim]);
  db.prepare("UPDATE durable_outbox SET status = 'pending' WHERE run_id = ?").run(renameCrash.owner.runId);
  assert.equal(await recoverWorkspaceCleanupClaim(resumed, renameCrash.claim), 'deferred');
  assert.equal(await files.location(renameCrash.claim), 'quarantine');
  db.prepare("UPDATE durable_outbox SET status = 'sent' WHERE run_id = ?").run(renameCrash.owner.runId);
  assert.equal(await recoverWorkspaceCleanupClaim(resumed, renameCrash.claim), 'removed');
  assert.equal(resumed.claims.get(renameCrash.owner)?.state, 'removed');
  assert.equal(await fs.readFile(renameCrash.report, 'utf8'), 'kept');

  const purgeCrash = await moveBeforeJournal('crash-after-purge');
  const journal = options().claims;
  const auth = () => {
    const observation = journal.observe(roots.scratch, purgeCrash.owner);
    assert.ok(observation);
    return { roots, observation, minimumAgeDays: 30, now: current };
  };
  assert.equal(await files.flush(purgeCrash.claim, 'quarantine', () => true), true);
  const isolated = journal.perform(purgeCrash.claim, auth(), 'isolated', () => true);
  assert.ok(isolated);
  const purging = journal.perform(isolated, auth(), 'purging');
  assert.ok(purging);
  const destination = { ...purging.scratch, directory: workspaceCleanupQuarantinePath(roots.scratch, purging) };
  const tree = await observeWorkspaceCleanupTree(destination, undefined, true, purging.scratch.directory);
  assert.ok(tree);
  assert.equal(await files.purge(purging, tree, () => true), true);
  db.close();
  db = open();
  assert.equal(await recoverWorkspaceCleanupClaim(options(), purging), 'removed');
  assert.equal(await fs.readFile(purgeCrash.report, 'utf8'), 'kept');

  const changed = await moveBeforeJournal('changed-quarantine');
  const late = path.join(workspaceCleanupQuarantinePath(roots.scratch, changed.claim), 'later.txt');
  await fs.writeFile(late, 'not baseline data');
  const afterChange = options();
  assert.equal(await recoverWorkspaceCleanupClaim(afterChange, changed.claim), 'held');
  assert.equal(afterChange.claims.get(changed.owner)?.reason, 'quarantine_unverified');
  assert.equal(await fs.readFile(late, 'utf8'), 'not baseline data');
  assert.equal(await fs.readFile(changed.report, 'utf8'), 'kept');

  const vanished = await fixture('missing-before-move');
  await fs.rmdir(vanished.claim.scratch.directory);
  assert.equal(await recoverWorkspaceCleanupClaim(options(), vanished.claim), 'held');
  assert.equal(await fs.readFile(vanished.report, 'utf8'), 'kept');

  const first = await fixture('a-deferred');
  const second = await fixture('b-ready');
  const queue = options().claims;
  assert.deepEqual(queue.pending(roots.scratch, 1), [first.claim]);
  assert.equal(queue.postpone(first.claim, '2026-11-22T00:00:01.000Z'), true);
  assert.deepEqual(queue.pending(roots.scratch, 1), [second.claim]);
  assert.equal(await recoverWorkspaceCleanupClaim(options(), second.claim), 'removed');

  const command = (args: string[], input?: string) => execFileSync('git', args, { input, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  const gitSource = project.directory;
  command(['init', '-q', '--object-format=sha1', gitSource]);
  const tracked = path.join(gitSource, 'tracked.txt');
  await fs.writeFile(tracked, 'original');
  command(['-C', gitSource, 'add', 'tracked.txt']);
  command(['-C', gitSource, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = command(['-C', gitSource, 'rev-parse', 'HEAD']);
  const bare = path.join(work, 'git-cache');
  const pack = path.join(bare, 'objects', 'pack');
  await fs.mkdir(pack, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(bare, 'refs'), { mode: 0o700 });
  await fs.writeFile(path.join(bare, 'HEAD'), `${commit}\n`);
  await fs.writeFile(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  command(['-C', gitSource, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(pack, 'pack')], `${commit}\n`);
  const gitDirectory = await pinWorkspacePath(work, bare);
  const git = { cache: gitDirectory, ...await readWorkspaceGitCacheIdentity({ authorizedRoots: [work], gitDirectory, commit,
    repositoryId: 'b'.repeat(64), scope: 'recovery-fixture' }) };
  const checkout = await fixture('clean-checkout', git);
  assert.equal(await recoverWorkspaceCleanupClaim({ ...options(), revalidatePolicy: async () => false }, checkout.claim), 'deferred');
  assert.equal(await files.location(checkout.claim), 'source');
  assert.equal(await recoverWorkspaceCleanupClaim(options(), checkout.claim), 'removed');
  assert.equal(await fs.readFile(checkout.report, 'utf8'), 'kept');
  assert.equal(await fs.readFile(tracked, 'utf8'), 'original');
  assert.equal(command(['--git-dir', bare, 'show', `${commit}:tracked.txt`]), 'original');
} finally {
  db.close();
  repository.close();
  await fs.rm(work, { recursive: true, force: true });
}
console.log('workspace cleanup recovery: PASS');
