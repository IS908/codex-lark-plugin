import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { gitSnapshotKey, inspectWorkspaceGitSnapshot } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-git-snapshot-'));
try {
  const base = await fs.realpath(fixture);
  const source = path.join(base, 'source');
  const git = (...args: string[]) => execFileSync('git', args, {
    env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-q', '--object-format=sha1', source);
  await fs.writeFile(path.join(source, 'tracked.txt'), 'committed');
  git('-C', source, 'add', 'tracked.txt');
  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  await fs.writeFile(path.join(source, 'tracked.txt'), 'uncommitted');
  const originalStatus = git('-C', source, 'status', '--porcelain');
  const commit = git('-C', source, 'rev-parse', 'HEAD');
  const tree = git('-C', source, 'rev-parse', 'HEAD^{tree}');
  const gitDirectory = await pinWorkspacePath(base, path.join(source, '.git'));
  const repositoryId = createHash('sha256').update('fixture origin').digest('hex');
  const request = { gitDirectory, authorizedRoots: [base] as const, repositoryId, scope: 'team-a', commit };
  const snapshot = await inspectWorkspaceGitSnapshot(request);
  assert.equal(snapshot.objectFormat, 'sha1');
  assert.equal(snapshot.commit, commit);
  assert.equal(snapshot.key, gitSnapshotKey(snapshot));
  assert.notEqual(snapshot.key, (await inspectWorkspaceGitSnapshot({ ...request, scope: 'team-b' })).key);
  assert.notEqual(snapshot.key, gitSnapshotKey({ ...snapshot, repositoryId: 'e'.repeat(64) }));
  assert.notEqual(snapshot.key, gitSnapshotKey({ ...snapshot, commit: 'd'.repeat(40) }));
  assert.notEqual(snapshot.key, gitSnapshotKey({ ...snapshot, objectFormat: 'sha256', commit: 'd'.repeat(64) }));
  assert.throws(() => gitSnapshotKey({ ...snapshot, objectFormat: 'sha256' }), { code: 'invalid_snapshot' });
  await assert.rejects(inspectWorkspaceGitSnapshot({ ...request, commit: commit.slice(0, 10) }), { code: 'invalid_snapshot' });
  await assert.rejects(inspectWorkspaceGitSnapshot({ ...request, commit: tree }), { code: 'git_commit_unavailable' });
  await assert.rejects(inspectWorkspaceGitSnapshot({ ...request, commit: 'd'.repeat(40) }), { code: 'git_commit_unavailable' });
  assert.equal(git('-C', source, 'status', '--porcelain'), originalStatus);

  const looseCommit = path.join(gitDirectory.directory, 'objects', commit.slice(0, 2), commit.slice(2));
  const originalObject = await fs.readFile(looseCommit);
  const damaged = inflateSync(originalObject);
  damaged[damaged.length - 1] = 0x78;
  const objectMode = (await fs.stat(looseCommit)).mode & 0o777;
  await fs.chmod(looseCommit, 0o600);
  try {
    await fs.writeFile(looseCommit, deflateSync(damaged));
    await assert.rejects(inspectWorkspaceGitSnapshot(request), { code: 'git_commit_unavailable' });
  } finally {
    await fs.writeFile(looseCommit, originalObject);
    await fs.chmod(looseCommit, objectMode);
  }

  const packs = path.join(gitDirectory.directory, 'objects', 'pack');
  await fs.chmod(packs, 0o775);
  try {
    await assert.rejects(inspectWorkspaceGitSnapshot(request), { code: 'git_directory_not_self_contained' });
  } finally {
    await fs.chmod(packs, 0o755);
  }

  const bare = path.join(base, 'bare-cache');
  git('clone', '-q', '--bare', '--no-hardlinks', source, bare);
  git('--git-dir', bare, 'repack', '-ad');
  assert.ok((await fs.readdir(path.join(bare, 'objects', 'pack'))).some((file) => file.endsWith('.pack')));
  const bareRequest = { ...request, gitDirectory: await pinWorkspacePath(base, bare) };
  assert.deepEqual(await inspectWorkspaceGitSnapshot(bareRequest), snapshot);
  git('--git-dir', bare, 'multi-pack-index', 'write');
  assert.deepEqual(await inspectWorkspaceGitSnapshot(bareRequest), snapshot);
  git('--git-dir', bare, 'config', 'core.worktree', source);
  await assert.rejects(inspectWorkspaceGitSnapshot(bareRequest), { code: 'git_directory_not_self_contained' });
  git('--git-dir', bare, 'config', '--unset', 'core.worktree');
  git('--git-dir', bare, 'config', 'include.path', path.join(base, 'not-needed'));
  await assert.rejects(inspectWorkspaceGitSnapshot(bareRequest), { code: 'git_directory_not_self_contained' });

  const sha256Repo = path.join(base, 'sha256-source');
  git('init', '-q', '--object-format=sha256', sha256Repo);
  git('-C', sha256Repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const sha256Commit = git('-C', sha256Repo, 'rev-parse', 'HEAD');
  const sha256 = await inspectWorkspaceGitSnapshot({ ...request,
    gitDirectory: await pinWorkspacePath(base, path.join(sha256Repo, '.git')), commit: sha256Commit });
  assert.equal(sha256.objectFormat, 'sha256');
  assert.equal(sha256.commit.length, 64);
  assert.notEqual(sha256.key, snapshot.key);

  const alternate = path.join(gitDirectory.directory, 'objects', 'info', 'alternates');
  await fs.writeFile(alternate, '', { flag: 'wx' });
  await assert.rejects(inspectWorkspaceGitSnapshot(request), { code: 'git_directory_not_self_contained' });
  await fs.unlink(alternate);
  await fs.rename(source, path.join(base, 'moved-source'));
  git('init', '-q', source);
  await assert.rejects(inspectWorkspaceGitSnapshot(request), { code: 'directory_changed' });
  console.log('workspace git snapshot smoke: PASS');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
