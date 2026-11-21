import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { createWorkspaceGitCheckout, gitSnapshotKey, inspectWorkspaceGitSnapshot, readWorkspaceGitDependencyInputs, verifyWorkspaceGitCache } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { createManagedGitSandboxOptions } from '../src/managed-git-sandbox.js';
import { workspaceMountLayoutSupported } from '../src/managed-workspace-ancestry.js';
import { probeCodexExecWithLoopback } from './fixtures/codex-loopback-exec.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-git-snapshot-'));
const fixtureMounts = [{ device: '1:1', root: '/', directory: '/' }, { device: '1:2', root: '/', directory: '/ipc/unrelated' },
  { device: '1:1', root: '/other/cache', directory: '/bind' }];
assert.ok(!workspaceMountLayoutSupported(['/ipc'], fixtureMounts));
assert.ok(!workspaceMountLayoutSupported(['/bind/child'], fixtureMounts));
assert.ok(workspaceMountLayoutSupported(['/workspace'], fixtureMounts));
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

  async function makeCache(name: string, revisions: string[], selected = commit, origin = source) {
    const directory = path.join(base, name);
    await fs.mkdir(path.join(directory, 'objects', 'pack'), { recursive: true });
    await fs.mkdir(path.join(directory, 'refs'));
    await fs.writeFile(path.join(directory, 'HEAD'), selected + '\n');
    const cacheConfig = selected.length === 40 ? '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'
      : '[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n';
    await fs.writeFile(path.join(directory, 'config'), cacheConfig);
    execFileSync('git', ['-C', origin, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(directory, 'objects', 'pack', 'pack')], {
      env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      input: revisions.join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ...request, commit: selected, gitDirectory: await pinWorkspacePath(base, directory) };
  }
  const cache = await makeCache('normalized cache', [commit]);
  const verified = await verifyWorkspaceGitCache(cache);
  assert.equal(verified.key, snapshot.key);
  assert.match(verified.storeFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(await verifyWorkspaceGitCache(cache), verified);
  const dependencySource = path.join(base, 'dependency-source');
  git('init', '-q', '--object-format=sha1', dependencySource);
  await fs.mkdir(path.join(dependencySource, 'deps'));
  const lockPath = path.join(dependencySource, 'deps', 'requirements.lock');
  await fs.writeFile(lockPath, 'pinned dependency bytes\n');
  await fs.writeFile(path.join(dependencySource, 'package.json'), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(dependencySource, 'oversized.lock'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await fs.symlink('package.json', path.join(dependencySource, 'linked.lock'));
  git('-C', dependencySource, 'add', 'deps/requirements.lock', 'package.json', 'linked.lock', 'oversized.lock');
  git('-C', dependencySource, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'dependencies');
  await fs.writeFile(lockPath, 'mutable dependency bytes\n');
  const dependencyCommit = git('-C', dependencySource, 'rev-parse', 'HEAD');
  const dependencyCache = await makeCache('dependency cache', [dependencyCommit], dependencyCommit, dependencySource);
  const dependencySelection = await verifyWorkspaceGitCache(dependencyCache);
  const dependencyBytes = await readWorkspaceGitDependencyInputs(dependencyCache, dependencySelection, ['deps/requirements.lock', 'package.json']);
  assert.deepEqual([...dependencyBytes], [['deps/requirements.lock', Buffer.from('pinned dependency bytes\n')],
    ['package.json', Buffer.from('{"name":"fixture"}\n')]]);
  for (const bad of ['linked.lock', 'missing.lock', '../requirements.lock', 'deps', 'deps/*', 'oversized.lock']) {
    await assert.rejects(readWorkspaceGitDependencyInputs(dependencyCache, dependencySelection, [bad]), { code: 'git_dependency_input_unavailable' });
  }
  await assert.rejects(readWorkspaceGitDependencyInputs(dependencyCache, { ...dependencySelection, storeFingerprint: 'a'.repeat(64) }, ['package.json']),
    { code: 'git_cache_mismatch' });
  const sourceBinding = await pinWorkspacePath(base, source);
  async function isolatedScratch(name: string) {
    await fs.mkdir(path.join(base, name), { mode: 0o700 });
    return pinWorkspacePath(base, name);
  }
  const [firstScratch, secondScratch] = await Promise.all([isolatedScratch('run-a'), isolatedScratch('run-b')]);
  const selection = { cache, expected: verified, source: sourceBinding };
  const [first, second] = await Promise.all([
    createWorkspaceGitCheckout({ ...selection, scratch: firstScratch }),
    createWorkspaceGitCheckout({ ...selection, scratch: secondScratch }),
  ]);
  const a = first.checkout.directory;
  const b = second.checkout.directory;
  assert.notEqual(first.checkout.inode, second.checkout.inode);
  assert.notEqual(first.gitDirectory.inode, second.gitDirectory.inode);
  for (const directory of [a, b]) {
    assert.equal(git('-C', directory, 'rev-parse', 'HEAD'), commit);
    assert.equal(git('-C', directory, 'remote'), '');
    assert.equal(await fs.readFile(path.join(directory, 'tracked.txt'), 'utf8'), 'committed');
    assert.equal(await fs.readFile(path.join(directory, '.git', 'objects', 'info', 'alternates'), 'utf8'),
      path.join(cache.gitDirectory.directory, 'objects') + '\n');
    assert.deepEqual(await fs.readdir(path.join(directory, '.git', 'objects', 'pack')), []);
  }
  assert.notEqual((await fs.stat(path.join(a, '.git', 'index'))).ino, (await fs.stat(path.join(b, '.git', 'index'))).ino);
  await fs.writeFile(path.join(a, 'tracked.txt'), 'first run only');
  await fs.writeFile(path.join(a, 'untracked.txt'), 'first run only');
  git('-C', a, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'isolated write');
  const firstLocalCommit = git('-C', a, 'rev-parse', 'HEAD');
  assert.throws(() => git('-C', b, 'cat-file', '-t', firstLocalCommit));
  assert.throws(() => git('-C', source, 'cat-file', '-t', firstLocalCommit));
  assert.equal(git('-C', b, 'status', '--porcelain'), '');
  assert.equal(await fs.readFile(path.join(b, 'tracked.txt'), 'utf8'), 'committed');
  assert.equal(git('-C', source, 'status', '--porcelain'), originalStatus);
  assert.equal(await fs.readFile(path.join(source, 'tracked.txt'), 'utf8'), 'uncommitted');
  const sandboxArtifacts = await isolatedScratch('run-sandbox-artifacts');
  const sandboxPolicy = { mode: 'workspace-write' as const, source: sourceBinding, cache: cache.gitDirectory, scratch: firstScratch,
    artifacts: sandboxArtifacts, checkout: first, authorizedRoots: cache.authorizedRoots };
  const compiled = await createManagedGitSandboxOptions(sandboxPolicy);
  assert.ok(compiled.overrides.includes('approval_policy="never"'));
  await assert.rejects(createManagedGitSandboxOptions({ ...sandboxPolicy, additionalWritable: [sourceBinding] }), { code: 'git_sandbox_invalid' });
  await assert.rejects(createManagedGitSandboxOptions({ ...sandboxPolicy, additionalWritable: [cache.gitDirectory] }), { code: 'git_sandbox_invalid' });
  const globLike = await isolatedScratch('run-literal-[ipc]');
  await assert.rejects(createManagedGitSandboxOptions({ ...sandboxPolicy, additionalWritable: [globLike] }), { code: 'git_sandbox_invalid' });
  const readOnly = await createManagedGitSandboxOptions({ ...sandboxPolicy, mode: 'read-only', networkEnabled: true });
  assert.ok(readOnly.overrides.every((entry) => !entry.includes('="write"')));
  assert.ok(readOnly.overrides.some((entry) => entry.includes('network={enabled=false}')));
  if (process.platform === 'darwin' && process.env.LARK_TEST_GIT_CHECKOUT_SEATBELT === '1') {
    const profile = `(version 1) (allow default) (deny network*)\n`
      + `(deny file-write* (require-not (require-any (subpath ${JSON.stringify(a)}) (literal "/dev/null"))))`;
    const constrained = (executable: string, args: string[], input?: string) => execFileSync('/usr/bin/sandbox-exec',
      ['-p', profile, executable, ...args], {
        cwd: a, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    // An ordinary Git write of an existing blob must succeed without refreshing the shared pack.
    assert.equal(constrained('/usr/bin/git', ['hash-object', '-w', '--stdin'], 'committed'), git('-C', a, 'rev-parse', `${commit}:tracked.txt`));
    const packDir = path.join(cache.gitDirectory.directory, 'objects', 'pack');
    const pack = (await fs.readdir(packDir)).find((file) => file.endsWith('.pack'))!;
    assert.throws(() => constrained('/usr/bin/touch', ['-m', path.join(packDir, pack)]));
    constrained('/usr/bin/touch', [path.join(a, 'seatbelt-can-write-here')]);
    assert.deepEqual(await verifyWorkspaceGitCache(cache), verified);
    console.log('workspace Git cache read-only Seatbelt probe: PASS');
  }
  if (process.env.LARK_TEST_GIT_CHECKOUT_CODEX_SANDBOX === '1') {
    const nativeScratch = await isolatedScratch('native-sandbox-run');
    const nativeCheckout = await createWorkspaceGitCheckout({ ...selection, scratch: nativeScratch });
    const nativeCwd = nativeCheckout.checkout.directory;
    const codexHome = path.join(base, 'codex-sandbox-home');
    const artifactsDir = path.join(base, 'codex-sandbox-artifacts');
    const ipcDir = path.join(base, 'codex-sandbox-ipc');
    const ambientTmp = path.join(base, 'codex-sandbox-ambient-tmp');
    await Promise.all([codexHome, artifactsDir, ipcDir, ambientTmp, ...['.agents', '.codex', '.aws'].map((dir) => path.join(nativeCwd, dir))]
      .map((dir) => fs.mkdir(dir, { mode: 0o700 })));
    const env = { CODEX_HOME: codexHome, HOME: base, TMPDIR: ambientTmp, PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const runSandbox = (profile: string, overrides: string[], argv: string[], input?: string) => execFileSync('codex', [
      'sandbox', '-P', profile, '-C', nativeCwd, ...overrides.flatMap((entry) => ['--config', entry]), '--', ...argv,
    ], {
      cwd: nativeCwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
      env,
    }).trim();
    const legacy = ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      'sandbox_workspace_write.exclude_slash_tmp=true'];
    await fs.writeFile(path.join(nativeCwd, 'native.txt'), 'native checkout');
    assert.throws(() => runSandbox(':workspace', legacy, ['/usr/bin/git', 'add', 'native.txt']), /index\.lock|Operation not permitted|Permission denied/);

    const named = await createManagedGitSandboxOptions({ ...sandboxPolicy, scratch: nativeScratch, checkout: nativeCheckout,
      artifacts: await pinWorkspacePath(base, artifactsDir), additionalWritable: [await pinWorkspacePath(base, ipcDir)] });
    const permissions = named.overrides;
    const native = (argv: string[], input?: string) => runSandbox(named.profile, permissions, argv, input);
    native(['/usr/bin/git', 'add', 'native.txt']);
    native(['/usr/bin/git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'native sandbox write']);
    assert.equal(git('-C', nativeCwd, 'show', 'HEAD:native.txt'), 'native checkout');
    for (const directory of [nativeScratch.directory, artifactsDir, ipcDir]) {
      const target = path.join(directory, 'local-write');
      native(['/usr/bin/touch', target]);
      assert.ok((await fs.stat(target)).isFile());
    }
    const packDir = path.join(cache.gitDirectory.directory, 'objects', 'pack');
    const pack = (await fs.readdir(packDir)).find((file) => file.endsWith('.pack'))!;
    assert.equal(native(['/usr/bin/git', 'hash-object', '-w', '--stdin'], 'committed'),
      git('-C', nativeCwd, 'rev-parse', `${commit}:tracked.txt`));
    assert.throws(() => native(['/usr/bin/touch', '-m', path.join(packDir, pack)]), /Operation not permitted|Permission denied/);
    assert.throws(() => native(['/usr/bin/git', 'config', '--local', 'user.name', 'must remain unchanged']),
      /Operation not permitted|Permission denied/);
    for (const directory of [base, source, a, b, ambientTmp, ...['.agents', '.codex', '.aws'].map((dir) => path.join(nativeCwd, dir))]) {
      assert.throws(() => native(['/usr/bin/touch', path.join(directory, 'denied-write')]), /Operation not permitted|Permission denied/);
    }
    assert.deepEqual(await verifyWorkspaceGitCache(cache), verified);
    console.log('workspace Git native Codex sandbox probe: PASS');

    const marker = 'MANAGED_GIT_FIXTURE_SUCCESS';
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\n'
      + `writable_roots = [${JSON.stringify(source)}]\n`);
    await fs.writeFile(path.join(nativeCwd, 'exec-probe.txt'), 'actual exec tool');
    await probeCodexExecWithLoopback({ cwd: nativeCwd, env, overrides: permissions, marker, command: [
      'set -eu',
      '/usr/bin/git add exec-probe.txt',
      "/usr/bin/git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'exec sandbox write'",
      `if /usr/bin/touch ${quote(path.join(source, 'exec-denied'))} 2>/dev/null; then exit 1; fi`,
      `if /usr/bin/touch -m ${quote(path.join(packDir, pack))} 2>/dev/null; then exit 2; fi`,
      `if /usr/bin/touch ${quote(path.join(ambientTmp, 'exec-denied'))} 2>/dev/null; then exit 3; fi`,
      `/usr/bin/touch ${quote(path.join(artifactsDir, 'exec-allowed'))}`,
      `printf '%s\\n' ${quote(marker)}`,
    ].join('\n') });
    assert.equal(git('-C', nativeCwd, 'show', 'HEAD:exec-probe.txt'), 'actual exec tool');
    assert.ok((await fs.stat(path.join(artifactsDir, 'exec-allowed'))).isFile());
    assert.deepEqual(await verifyWorkspaceGitCache(cache), verified);
    console.log('workspace Git Codex exec loopback probe: PASS');
  }
  await assert.rejects(createWorkspaceGitCheckout({ ...selection, scratch: firstScratch }),
    { code: 'allocation_conflict' });
  assert.equal(git('-C', a, 'rev-parse', 'HEAD'), firstLocalCommit);
  assert.equal(await fs.readFile(path.join(a, 'untracked.txt'), 'utf8'), 'first run only');
  assert.deepEqual(await verifyWorkspaceGitCache(cache), verified);

  const wrongScratch = await isolatedScratch('run-cache-mismatch');
  await assert.rejects(createWorkspaceGitCheckout({ ...selection, scratch: wrongScratch,
    expected: { ...verified, storeFingerprint: '0'.repeat(64) } }), { code: 'git_cache_mismatch' });
  assert.deepEqual(await fs.readdir(wrongScratch.directory), []);
  await assert.rejects(createWorkspaceGitCheckout({ ...selection, scratch: sourceBinding }),
    { code: 'git_checkout_overlap' });
  const contested = { ...selection, scratch: await isolatedScratch('run-contested') };
  const race = await Promise.allSettled([createWorkspaceGitCheckout(contested), createWorkspaceGitCheckout(contested)]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.find((result) => result.status === 'rejected')?.reason.code, 'allocation_conflict');
  const config = path.join(cache.gitDirectory.directory, 'config');
  const configContents = await fs.readFile(config);
  await fs.appendFile(config, '[fsck]\n\tmissingTree = ignore\n');
  await assert.rejects(verifyWorkspaceGitCache(cache), { code: 'git_cache_invalid' });
  const replacementConfig = path.join(base, 'replacement-config');
  await fs.writeFile(replacementConfig, configContents);
  await fs.rename(replacementConfig, config);
  assert.notEqual((await verifyWorkspaceGitCache(cache)).storeFingerprint, verified.storeFingerprint);
  const cachePacks = path.join(cache.gitDirectory.directory, 'objects', 'pack');
  const packFile = path.join(cachePacks, (await fs.readdir(cachePacks)).find((file) => file.endsWith('.pack'))!);
  const idxFile = packFile.replace(/\.pack$/, '.idx');
  const idxData = await fs.readFile(idxFile);
  await fs.chmod(idxFile, 0o600);
  await fs.truncate(idxFile, 16);
  await assert.rejects(verifyWorkspaceGitCache(cache), { code: 'git_cache_invalid' });
  await fs.writeFile(idxFile, idxData);
  const secondLink = path.join(base, 'shared-pack');
  await fs.link(packFile, secondLink);
  await assert.rejects(verifyWorkspaceGitCache(cache), { code: 'git_cache_invalid' });
  await fs.unlink(secondLink);
  await fs.chmod(packFile, 0o600);
  await fs.truncate(packFile, 24);
  await assert.rejects(verifyWorkspaceGitCache(cache), { code: 'git_cache_invalid' });

  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'second fixture');
  const extra = git('-C', source, 'rev-parse', 'HEAD');
  const overbroad = await makeCache('cache-with-extra-objects', [extra]);
  assert.deepEqual(await inspectWorkspaceGitSnapshot(overbroad), snapshot);
  await assert.rejects(verifyWorkspaceGitCache(overbroad), { code: 'git_cache_invalid' });
  const incomplete = await makeCache('cache-with-missing-objects', [extra, `^${commit}`], extra);
  assert.equal((await inspectWorkspaceGitSnapshot(incomplete)).commit, extra);
  await assert.rejects(verifyWorkspaceGitCache(incomplete), { code: 'git_cache_invalid' });

  await fs.mkdir(path.join(source, 'nested'));
  await fs.writeFile(path.join(source, '.gitattributes'), 'nested/data.txt text eol=crlf ident\n');
  await fs.writeFile(path.join(source, 'nested', 'data.txt'), '$Id$\nline\n');
  await fs.symlink('nested/data.txt', path.join(source, 'local-link'));
  git('-C', source, 'add', '.gitattributes', 'nested/data.txt', 'local-link');
  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'attributes and local link');
  const attributesCommit = git('-C', source, 'rev-parse', 'HEAD');
  const attributesCache = await makeCache('attributes-cache', [attributesCommit], attributesCommit);
  const attributesCheckout = await createWorkspaceGitCheckout({ cache: attributesCache,
    expected: await verifyWorkspaceGitCache(attributesCache), source: sourceBinding, scratch: await isolatedScratch('run-with-attributes') });
  const attributesDir = attributesCheckout.checkout.directory;
  assert.equal(await fs.readlink(path.join(attributesDir, 'local-link')), 'nested/data.txt');
  assert.match(await fs.readFile(path.join(attributesDir, 'local-link'), 'utf8'), /^\$Id: [0-9a-f]{40} \$\r\nline\r\n$/);
  assert.equal(git('-C', attributesDir, 'status', '--porcelain'), '');

  const collisionScratch = await isolatedScratch('run-case-compatibility');
  const caseProbe = path.join(collisionScratch.directory, 'CaseProbe');
  await fs.writeFile(caseProbe, '', { flag: 'wx' });
  const foldsCase = await fs.lstat(path.join(collisionScratch.directory, 'caseprobe')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  await fs.unlink(caseProbe);
  const trackedBlob = git('-C', source, 'rev-parse', `${commit}:tracked.txt`);
  for (const name of ['History.txt', 'history.txt']) {
    git('-C', source, '-c', 'core.ignoreCase=false', 'update-index', '--add', '--cacheinfo', `100644,${trackedBlob},${name}`);
  }
  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'distinct filename casing');
  const caseCommit = git('-C', source, 'rev-parse', 'HEAD');
  const caseCache = await makeCache('case-cache', [caseCommit], caseCommit);
  const caseRequest = { cache: caseCache, expected: await verifyWorkspaceGitCache(caseCache), source: sourceBinding, scratch: collisionScratch };
  if (foldsCase) {
    await assert.rejects(createWorkspaceGitCheckout(caseRequest), { code: 'git_checkout_failed' });
    assert.equal((await fs.stat(path.join(collisionScratch.directory, 'git-checkout', 'History.txt'))).size, 0);
  } else {
    const caseCheckout = await createWorkspaceGitCheckout(caseRequest);
    for (const name of ['History.txt', 'history.txt']) {
      assert.equal(await fs.readFile(path.join(caseCheckout.checkout.directory, name), 'utf8'), 'committed');
    }
  }

  const sha256Repo = path.join(base, 'sha256-source');
  git('init', '-q', '--object-format=sha256', sha256Repo);
  await fs.writeFile(path.join(sha256Repo, 'deps.lock'), 'sha256 fixture\n');
  git('-C', sha256Repo, 'add', 'deps.lock');
  git('-C', sha256Repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const sha256Commit = git('-C', sha256Repo, 'rev-parse', 'HEAD');
  const sha256 = await inspectWorkspaceGitSnapshot({ ...request,
    gitDirectory: await pinWorkspacePath(base, path.join(sha256Repo, '.git')), commit: sha256Commit });
  assert.equal(sha256.objectFormat, 'sha256');
  assert.equal(sha256.commit.length, 64);
  assert.notEqual(sha256.key, snapshot.key);
  const sha256Cache = await makeCache('sha256-cache', [sha256Commit], sha256Commit, sha256Repo);
  const sha256Verified = await verifyWorkspaceGitCache(sha256Cache);
  assert.equal(sha256Verified.key, sha256.key);
  assert.deepEqual((await readWorkspaceGitDependencyInputs(sha256Cache, sha256Verified, ['deps.lock'])).get('deps.lock'), Buffer.from('sha256 fixture\n'));
  const sha256Checkout = await createWorkspaceGitCheckout({ cache: sha256Cache, expected: sha256Verified,
    source: await pinWorkspacePath(base, sha256Repo), scratch: await isolatedScratch('run-sha256') });
  assert.equal(git('-C', sha256Checkout.checkout.directory, 'rev-parse', 'HEAD'), sha256Commit);

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
