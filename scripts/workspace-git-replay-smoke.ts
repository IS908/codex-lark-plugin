import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import { buildCodexExecArgs, CodexExecAbortedError, runCodexExecCommand } from '../src/codex-exec.js';
import { appConfig } from '../src/config.js';
import { resolveManagedGitLauncher, resolveSystemGit } from '../src/managed-git-launcher.js';
import { protectLegacyGitWorkspace, withManagedWorkspace } from '../src/managed-workspace-exec.js';
import { parseWorkspaceMountTable, workspaceBackingAliases, workspaceMountLayoutSupported } from '../src/managed-workspace-ancestry.js';
import { gitSnapshotKey, verifyWorkspaceGitCache } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath, workspacePathContains } from '../src/workspace-projects.js';
import { checkManagedGitEntrypoints } from './fixtures/managed-git-entrypoints.js';
import { probeCodexExecWithLoopback } from './fixtures/codex-loopback-exec.js';

const mounts = parseWorkspaceMountTable('1 0 8:1 / / rw - ext4 /dev/fixture rw\n'
  + '2 1 8:1 /workspace/cache/objects /prior-run/bind\\040objects rw - ext4 /dev/fixture rw\n'
  + '3 1 8:1 / /second-root rw - ext4 /dev/fixture rw\n'
  + '4 1 0:4 mnt:[4026532835] /run/fixture/mnt rw shared:3 - nsfs nsfs rw\n'
  + '5 1 0:4 net:[4026532836] /mounted/namespace rw - nsfs nsfs rw\n');
assert.ok(workspaceBackingAliases('/prior-run/bind objects/pack', mounts).includes('/workspace/cache/objects/pack'));
assert.ok(workspaceBackingAliases('/second-root/workspace', mounts).includes('/workspace'));
const overlaps = (stored: string, candidate: string) => workspaceBackingAliases(candidate, mounts).some((alias) =>
  workspacePathContains(alias, stored) || workspacePathContains(stored, alias));
assert.ok(overlaps('/prior-run', '/workspace/cache'));
assert.ok(overlaps('/workspace/cache', '/prior-run'));
assert.ok(!overlaps('/unrelated', '/workspace/cache'));
assert.ok(workspaceMountLayoutSupported(['/workspace'], mounts));
assert.ok(!workspaceMountLayoutSupported(['/mounted'], mounts));
assert.ok(!workspaceMountLayoutSupported(['/mounted/namespace'], mounts));
assert.deepEqual(workspaceBackingAliases('/mounted/namespace', mounts), ['/mounted/namespace']);
assert.throws(() => parseWorkspaceMountTable('6 1 8:1 relative /mount rw - ext4 /dev/fixture rw\n'), /Unsupported mount table/);
assert.throws(() => parseWorkspaceMountTable('6 1 0:4 mnt:[bad] /mount rw - nsfs nsfs rw\n'), /Unsupported mount table/);

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-managed-git-replay-'));
try {
  const base = path.join(await fs.realpath(fixture), 'workspace');
  await fs.mkdir(base);
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
  git(['-C', source, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(cache, 'objects', 'pack', 'pack')], `${commit}\n`);

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
  const codexHome = path.join(base, 'isolated-codex-home');
  await fs.mkdir(codexHome);
  const execRequest = { cwd: source, prompt: 'Fixture.', sandbox: 'workspace-write' as const,
    extraEnv: { CODEX_HOME: codexHome, GIT_DIR: path.join(source, '.git') },
    workspaceDirectory: { binding: request.project, authorizedRoots } };
  const operator = path.join(path.dirname(base), 'operator');
  await fs.mkdir(operator, { mode: 0o700 });
  const gitRegistry = { configPath: path.join(operator, 'managed-workspace.json') };
  const registryFile = path.join(operator, 'workspace-git-sources.json');
  const writeRegistry = () => fs.writeFile(registryFile, JSON.stringify({ version: 1, projects: [{ source, cache,
    repositoryId: request.git.repositoryId, scope: request.git.scope, commit }] }), { mode: 0o600 });
  await writeRegistry();
  const legacy = { prompt: 'Fixture.', sandbox: 'workspace-write' as const };
  assert.deepEqual((await protectLegacyGitWorkspace(legacy, gitRegistry.configPath)).configOverrides, [
    'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true',
  ]);
  await assert.rejects(protectLegacyGitWorkspace({ ...legacy, sandbox: 'danger-full-access' }, gitRegistry.configPath),
    { code: 'git_sandbox_layers_unsupported' });
  const prepared = await withManagedWorkspace(execRequest, first, gitRegistry);
  await fs.unlink(registryFile);
  assert.equal(await protectLegacyGitWorkspace(legacy, gitRegistry.configPath), legacy);
  await assert.rejects(runCodexExecCommand({ ...prepared, command: '/does-not-exist' }), { code: 'git_selection_revoked' });
  await writeRegistry();
  assert.equal(prepared.cwd, checkout);
  assert.equal(prepared.workspaceDirectory?.binding.directory, checkout);
  assert.equal(prepared.extraEnv?.GIT_DIR, undefined);
  const argv = buildCodexExecArgs(prepared, path.join(base, 'out'));
  assert.ok(argv.includes('--strict-config'));
  assert.ok(argv.includes('default_permissions="lark-managed-git"'));
  assert.ok(!argv.includes('--sandbox') && !argv.includes('--add-dir') && !argv.includes('--ignore-rules'));
  const legacyTools = path.join(base, 'other-workspace-tools');
  await fs.mkdir(legacyTools, { mode: 0o700 });
  const otherExecutable = path.join(legacyTools, 'native-fixture');
  await fs.copyFile('/usr/bin/true', otherExecutable);
  await fs.chmod(otherExecutable, 0o700);
  assert.ok(prepared.validateManagedGitLaunch);
  await assert.rejects(prepared.validateManagedGitLaunch(otherExecutable, { PATH: '/usr/bin' }), { code: 'git_launcher_untrusted' });
  const asyncOnlyRoot = path.join(path.dirname(base), 'other-async-root');
  await fs.mkdir(asyncOnlyRoot, { mode: 0o700 });
  const asyncExecutable = path.join(asyncOnlyRoot, 'native-fixture');
  await fs.copyFile(otherExecutable, asyncExecutable);
  const originalAsyncRoot = appConfig.continuationWorkingRoot;
  try {
    Object.assign(appConfig, { continuationWorkingRoot: asyncOnlyRoot });
    await assert.rejects(prepared.validateManagedGitLaunch(asyncExecutable, { PATH: '/usr/bin' }), { code: 'git_launcher_untrusted' });
  } finally {
    Object.assign(appConfig, { continuationWorkingRoot: originalAsyncRoot });
  }
  assert.equal(await resolveSystemGit(), await fs.realpath('/usr/bin/git'));
  const launcher = await resolveManagedGitLauncher('/usr/bin/true', { PATH: legacyTools }, [first.scratch]);
  assert.equal(launcher.env.PATH, '/usr/bin:/bin');
  const wrapper = path.join(operator, 'codex-wrapper');
  await fs.writeFile(wrapper, '#!/usr/bin/env node\n', { mode: 0o700 });
  await assert.rejects(resolveManagedGitLauncher(wrapper, { PATH: '/usr/bin:/bin' }, [first.scratch]),
    { code: 'git_launcher_untrusted' });
  await assert.rejects(resolveManagedGitLauncher('codex', { PATH: '.' }, [request.project, first.scratch]), { code: 'git_launcher_untrusted' });
  await assert.rejects(resolveManagedGitLauncher('./codex', { PATH: '/usr/bin' }, [first.scratch]), { code: 'git_launcher_untrusted' });
  await assert.rejects(resolveManagedGitLauncher('codex', { PATH: '' }, [first.scratch]), { code: 'git_launcher_untrusted' });
  const directoryWithDelimiter = path.join(base, 'path:segment');
  const launcherAlias = path.join(base, 'launcher-alias');
  await fs.mkdir(directoryWithDelimiter);
  await fs.symlink(directoryWithDelimiter, launcherAlias, 'dir');
  await assert.rejects(resolveManagedGitLauncher('codex', { PATH: launcherAlias }, [first.scratch]), { code: 'git_launcher_untrusted' });
  if (process.geteuid?.() !== 0) {
    const nonExecutable = path.join(base, 'non-executable-tools');
    await fs.mkdir(nonExecutable);
    const commandStub = path.join(nonExecutable, 'codex');
    await fs.writeFile(commandStub, 'fixture');
    await fs.chmod(commandStub, 0o010);
    await assert.rejects(resolveManagedGitLauncher('codex', { PATH: nonExecutable }, [first.scratch]), { code: 'git_launcher_untrusted' });
  }
  const abort = new AbortController();
  await assert.rejects(runCodexExecCommand({ prompt: 'Cancel before launch.', cwd: checkout, command: '/does-not-exist',
    abortSignal: abort.signal, validateManagedGitLaunch: async (command, env) => {
      abort.abort();
      return { command, env, prefix: [] };
    } }), CodexExecAbortedError);
  await assert.rejects(withManagedWorkspace({ ...execRequest, profile: 'existing-profile' }, first, gitRegistry), { code: 'git_sandbox_invalid' });
  await assert.rejects(withManagedWorkspace({ ...execRequest, additionalWritableDirs: [source] }, first, gitRegistry), { code: 'git_sandbox_invalid' });
  await fs.mkdir(path.join(codexHome, 'rules'));
  await fs.writeFile(path.join(codexHome, 'rules', 'operator.rules'), '# fixture operator policy\n');
  await assert.rejects(withManagedWorkspace(execRequest, first, gitRegistry), { code: 'git_sandbox_layers_unsupported' });
  await assert.rejects(runCodexExecCommand({ ...prepared, command: '/does-not-exist' }), { code: 'git_sandbox_layers_unsupported' });
  await fs.unlink(path.join(codexHome, 'rules', 'operator.rules'));
  if (process.env.LARK_TEST_GIT_CHECKOUT_CODEX_SANDBOX === '1') {
    const command = process.env.LARK_TEST_CODEX_NATIVE_BINARY;
    if (command) assert.ok(path.isAbsolute(command));
    const env = { ...Object.fromEntries(Object.keys(process.env).map((name) => [name, undefined])),
      CODEX_HOME: codexHome, HOME: base, PATH: process.env.PATH };
    const launch = await withManagedWorkspace({ ...execRequest, extraEnv: env, command }, first, gitRegistry);
    const marker = 'LARK_SHARED_LAUNCH_SUCCESS';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(checkout, 'launcher-proof.txt'), 'shared launcher');
    await probeCodexExecWithLoopback({ cwd: checkout, env, overrides: [], marker, command: [
      'set -eu', '/usr/bin/git add launcher-proof.txt',
      "/usr/bin/git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'launcher fixture'",
      `if /usr/bin/touch ${quote(path.join(cache, 'denied-from-launcher'))} 2>/dev/null; then exit 1; fi`,
      `if /usr/bin/touch ${quote(path.join(source, 'denied-from-launcher'))} 2>/dev/null; then exit 2; fi`,
      `printf '%s\\n' ${quote(marker)}`,
    ].join('\n'), launch: async (transport) => (await runCodexExecCommand({ ...launch, timeoutMs: 40_000,
      configOverrides: [...launch.configOverrides ?? [], ...transport] })).text });
    assert.equal(git(['-C', checkout, 'show', 'HEAD:launcher-proof.txt']), 'shared launcher');
    console.log('workspace Git production launcher loopback probe: PASS');
  }
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
    await checkManagedGitEntrypoints({ base, project: request.project, roots: request.roots, git: request.git, codexHome, store });
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
