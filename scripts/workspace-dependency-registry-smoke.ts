import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { sameWorkspaceDependencySelections, workspaceDependencySelectionsSchema } from '../src/domain/workspace-dependency.js';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { describeWorkspaceDependencies, prepareWorkspaceNpmLock, prepareWorkspacePipLock } from '../src/workspace-dependency-input.js';
import * as dependencyInstall from '../src/workspace-dependency-install.js';
import { assertWorkspaceDependencySelectionAuthorized, assertWorkspaceDependencyWriteIsolation,
  resolveWorkspaceDependencySelections } from '../src/workspace-dependency-registry.js';
import { readWorkspaceGitCacheIdentity } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-registry-')));
try {
  const config = path.join(fixture, 'config');
  const work = path.join(fixture, 'work');
  const runRoot = path.join(work, 'runs');
  const [source, bare, scratch, artifacts] = ['project', 'git-cache', 'scratch', 'artifacts'].map((dir) => path.join(runRoot, dir));
  const cache = path.join(work, 'wheelhouse');
  await Promise.all([config, source, cache, bare, scratch, artifacts].map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const selected = await pinWorkspacePath(fixture, source);
  const wheelhouse = await pinWorkspacePath(fixture, cache);
  const wheel = Buffer.from('registry fixture wheel');
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  const wheelName = 'fixture-1.0.0-py3-none-any.whl';
  const lock = Buffer.from(`fixture==1.0.0 --hash=sha256:${sha256}\n`);
  await fs.writeFile(path.join(cache, wheelName), wheel);
  await fs.writeFile(path.join(source, 'requirements.lock'), lock);
  const npmCache = path.join(work, 'npm-cache');
  const blob = Buffer.from('registry fixture npm tarball');
  const npmDigest = createHash('sha512').update(blob).digest();
  const npmHex = npmDigest.toString('hex');
  const npmArtifact = path.join(npmCache, '_cacache', 'content-v2', 'sha512', npmHex.slice(0, 2), npmHex.slice(2, 4), npmHex.slice(4));
  await fs.mkdir(path.dirname(npmArtifact), { recursive: true, mode: 0o700 });
  await fs.writeFile(npmArtifact, blob);
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: { child: '1.0.0' } };
  const npmRegistry = 'https://registry.example.test/';
  const resolved = `${npmRegistry}child/-/child-1.0.0.tgz`;
  const integrity = `sha512-${npmDigest.toString('base64')}`;
  const npmManifest = Buffer.from(JSON.stringify(pkg));
  const npmLock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': pkg,
    'node_modules/child': { version: '1.0.0', resolved, integrity } } }));
  await fs.writeFile(path.join(source, 'package.json'), npmManifest);
  await fs.writeFile(path.join(source, 'package-lock.json'), npmLock);
  const git = (args: string[], input?: string) => execFileSync('git', args, { input, encoding: 'utf8',
    env: { HOME: fixture, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '--object-format=sha1', source]);
  git(['-C', source, 'add', 'requirements.lock', 'package.json', 'package-lock.json']);
  git(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = git(['-C', source, 'rev-parse', 'HEAD']);
  const pack = path.join(bare, 'objects', 'pack');
  await fs.mkdir(pack, { recursive: true });
  await fs.mkdir(path.join(bare, 'refs'));
  await fs.writeFile(path.join(bare, 'HEAD'), `${commit}\n`);
  await fs.writeFile(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  git(['-C', source, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(pack, 'pack')], `${commit}\n`);
  const repositoryId = 'a'.repeat(64);
  const authorizedRoots = [work] as const;
  const gitCache = await pinWorkspacePath(fixture, bare);
  const scope = 'team-a';
  const pinned = { cache: gitCache, ...await readWorkspaceGitCacheIdentity({ gitDirectory: gitCache, authorizedRoots, repositoryId, scope, commit }) };
  const toolchain = { runtime: '3.13.9', installer: '26.3', abi: 'cpython-313-x86_64-linux-gnu', platform: 'linux', arch: 'x64', platformAbi: 'glibc-2.35' } as const;
  const input = { lock, scope, toolchain, ecosystem: 'pip' } as const;
  const { key } = describeWorkspaceDependencies(input);
  const manifest = [{ filename: wheelName, sha256 }];
  const { artifactManifestSha256 } = prepareWorkspacePipLock(input, manifest);
  const configPath = path.join(config, 'managed-workspace.json');
  const gitRegistry = path.join(config, 'workspace-git-sources.json');
  await fs.writeFile(gitRegistry, JSON.stringify({ version: 1, projects: [{ source, cache: bare, repositoryId, scope, commit }] }), { mode: 0o600 });
  const roots = { scratch: await pinWorkspacePath(work, scratch), artifacts: await pinWorkspacePath(work, artifacts) };
  const registry = path.join(config, 'workspace-dependencies.json');
  const manifests = path.join(config, 'workspace-dependency-manifests');
  const sidecar = path.join(manifests, `${key}.json`);
  const entry = { scope, key, ecosystem: 'pip', cache: wheelhouse, artifactManifestSha256 };
  const projects = [{ source: selected, repositoryId, policies: [{ ecosystem: 'pip' }] }];
  const policy = { version: 1, projects, caches: [entry] };
  const writeRegistry = async (value: unknown) => fs.writeFile(registry, JSON.stringify(value), { mode: 0o600 });
  const request = { configPath, authorizedRoots, roots, project: selected, git: pinned, toolchains: { pip: toolchain } };
  assert.deepEqual(await resolveWorkspaceDependencySelections(request), []);
  await assertWorkspaceDependencyWriteIsolation(configPath, [fixture]);
  await writeRegistry(policy);
  await fs.mkdir(manifests, { mode: 0o700 });
  await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_manifest_missing' });
  await fs.writeFile(sidecar, 'null', { mode: 0o600 });
  await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_manifest_invalid' });
  await fs.writeFile(sidecar, JSON.stringify(manifest), { mode: 0o600 });
  const prepared = await resolveWorkspaceDependencySelections(request);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].selection.identity.key, key);
  assert.deepEqual(prepared[0].selection.cache, wheelhouse);
  const expected = prepared.map(({ selection }) => selection);
  const otherScope = await readWorkspaceGitCacheIdentity({ gitDirectory: gitCache, authorizedRoots, repositoryId, scope: 'team-b', commit });
  const ledgerPath = path.join(work, 'allocation.sqlite');
  const firstRun = { authorizedRoots, roots, project: selected, git: pinned, createdAt: '2026-11-21T20:00:00.000Z',
    owner: { kind: 'foreground', runId: 'dependency-selected' } as const, dependencySelections: expected, dependencyRegistryConfigPath: configPath };
  const optOut = { ...firstRun, owner: { kind: 'cron_prompt', runId: 'dependency-opt-out' } as const, dependencySelections: [] };
  const legacy = { ...firstRun, owner: { kind: 'async_task', runId: 'dependency-legacy' } as const, dependencySelections: undefined };
  const interrupted = { ...firstRun, owner: { kind: 'cron_prompt', runId: 'dependency-interrupted' } as const };
  const preparedRun = { ...firstRun, owner: { kind: 'async_task', runId: 'dependency-prepared' } as const };
  const installNonce = 'b'.repeat(24);
  let installed: { output: Awaited<ReturnType<typeof pinWorkspacePath>>; measurement: { digest: string; bytes: number; entries: number } };
  const originalLedger = new DatabaseSync(ledgerPath);
  try {
    const store = new SqliteManagedWorkspaceStore(originalLedger);
    const overlapping = { ...optOut, roots: { ...roots, scratch: wheelhouse }, owner: { ...optOut.owner, runId: 'dependency-overlap' } };
    await assert.rejects(store.ensure(overlapping), { code: 'dependency_write_overlap' });
    assert.equal(store.get(overlapping.owner), null);
    assert.deepEqual(await fs.readdir(cache), [wheelName]);
    const selectedRun = await store.ensure(firstRun);
    const optedOutRun = await store.ensure(optOut);
    assert.deepEqual(selectedRun.dependencySelections, expected);
    assert.notEqual(selectedRun.scratch.directory, optedOutRun.scratch.directory);
    assert.deepEqual(optedOutRun.dependencySelections, []);
    assert.equal((await store.ensure(legacy)).dependencySelections, undefined);
    assert.equal(store.getDependencyInstall(firstRun.owner, 'pip'), null);
    assert.throws(() => store.reserveDependencyInstall(optOut.owner, 'pip', installNonce), { code: 'invalid_binding' });
    assert.throws(() => store.reserveDependencyInstall(firstRun.owner, 'npm', installNonce), { code: 'invalid_binding' });
    store.reserveDependencyInstall(firstRun.owner, 'pip', installNonce);
    const peer = new DatabaseSync(ledgerPath);
    try {
      assert.throws(() => new SqliteManagedWorkspaceStore(peer).reserveDependencyInstall(firstRun.owner, 'pip', 'c'.repeat(24)),
        { code: 'dependency_install_incomplete' });
    } finally { peer.close(); }
    const interruptedRun = await store.ensure(interrupted);
    store.reserveDependencyInstall(interrupted.owner, 'pip', installNonce);
    const uncommittedOutput = path.join(interruptedRun.scratch.directory, `lark-dependency-install-${installNonce}`, 'python-deps');
    await fs.mkdir(uncommittedOutput, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(uncommittedOutput, 'ready.py'), '# present but not committed');
    const lifecycle = await store.ensure(preparedRun);
    await assert.rejects(dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, preparedRun.owner, 'pip'),
      { code: 'dependency_install_selection_mismatch' });
    assert.equal(store.getDependencyInstall(preparedRun.owner, 'pip'), null);
    store.reserveDependencyInstall(preparedRun.owner, 'pip', installNonce);
    const issuedPath = path.join(lifecycle.scratch.directory, `lark-dependency-install-${installNonce}`, 'python-deps');
    await fs.mkdir(issuedPath, { recursive: true, mode: 0o700 });
    const issued = await pinWorkspacePath(lifecycle.scratch.directory, issuedPath);
    const readyOutput = { output: issued, measurement: await dependencyInstall.measureWorkspaceDependencyOutput(issued, 'pip') };
    await dependencyInstall.publishWorkspaceDependencyOutput({ scratch: lifecycle.scratch, ...lifecycle.gitCheckout!, ecosystem: 'pip',
      nonce: installNonce, receipt: readyOutput });
    store.completeDependencyInstall(preparedRun.owner, 'pip', installNonce, readyOutput);
    assert.deepEqual(store.getDependencyInstall(preparedRun.owner, 'pip')?.receipt, readyOutput);
    const output = path.join(selectedRun.scratch.directory, `lark-dependency-install-${installNonce}`, 'python-deps');
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    installed = { output: await pinWorkspacePath(selectedRun.scratch.directory, output), measurement: { digest: 'e'.repeat(64), bytes: 0, entries: 1 } };
    assert.throws(() => store.completeDependencyInstall(firstRun.owner, 'pip', 'c'.repeat(24), installed), { code: 'invalid_binding' });
    assert.throws(() => store.completeDependencyInstall(firstRun.owner, 'pip', installNonce, { ...installed, output: optedOutRun.scratch }),
      { code: 'invalid_binding' });
    store.completeDependencyInstall(firstRun.owner, 'pip', installNonce, installed);
    assert.throws(() => store.completeDependencyInstall(firstRun.owner, 'pip', installNonce, installed), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...firstRun, owner: { ...firstRun.owner, runId: 'wrong-dependency-scope' },
      git: { cache: gitCache, ...otherScope } }), { code: 'invalid_binding' });
  } finally { originalLedger.close(); }
  const reopenedLedger = new DatabaseSync(ledgerPath);
  try {
    const store = new SqliteManagedWorkspaceStore(reopenedLedger);
    assert.deepEqual(store.get(firstRun.owner)?.allocation.dependencySelections, expected);
    assert.deepEqual(store.getDependencyInstall(firstRun.owner, 'pip'), { nonce: installNonce, receipt: installed });
    assert.deepEqual(store.getDependencyInstall(interrupted.owner, 'pip'), { nonce: installNonce });
    assert.throws(() => store.reserveDependencyInstall(interrupted.owner, 'pip', 'c'.repeat(24)), { code: 'dependency_install_incomplete' });
    await assert.rejects(dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, interrupted.owner, 'pip'),
      { code: 'dependency_install_incomplete' });
    const uncommittedOutput = path.join(store.get(interrupted.owner)!.allocation.scratch.directory,
      `lark-dependency-install-${installNonce}`, 'python-deps', 'ready.py');
    assert.equal(await fs.readFile(uncommittedOutput, 'utf8'), '# present but not committed');
    const resumedOutput = await dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, preparedRun.owner, 'pip');
    assert.deepEqual(resumedOutput, store.getDependencyInstall(preparedRun.owner, 'pip')?.receipt);
    await fs.writeFile(path.join(resumedOutput.output.directory, 'new.py'), '# changed');
    await assert.rejects(dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, preparedRun.owner, 'pip'),
      { code: 'dependency_installed_output_invalid' });
    assert.deepEqual(store.get(optOut.owner)?.allocation.dependencySelections, []);
    assert.equal(store.get(legacy.owner)?.allocation.dependencySelections, undefined);
    await assert.rejects(store.ensure({ ...firstRun, dependencySelections: [] }), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...legacy, dependencySelections: [] }), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...firstRun, dependencySelections: [{ ...expected[0], cacheFingerprint: 'f'.repeat(64) }] }), { code: 'invalid_binding' });
    await assert.rejects(store.ensure({ ...firstRun, authorizedRoots: [runRoot] }), { code: 'outside_authorized_root' });
    assert.deepEqual((await store.ensure(firstRun)).dependencySelections, expected);
    const sql = "UPDATE workspace_run_allocations SET allocation_json = json_remove(allocation_json, '$.dependencySelections') WHERE workload_kind = ? AND run_id = ?";
    assert.equal(reopenedLedger.prepare(sql).run(optOut.owner.kind, optOut.owner.runId).changes, 1);
    assert.throws(() => store.get(optOut.owner), { code: 'invalid_binding' });
  } finally { reopenedLedger.close(); }
  assert.deepEqual(await resolveWorkspaceDependencySelections({ ...request, expected }), prepared);
  assert.deepEqual(await resolveWorkspaceDependencySelections({ ...request, expected: [] }), []);
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, git: undefined }), { code: 'dependency_project_unavailable' });
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, git: { cache: gitCache, ...otherScope } }),
    { code: 'dependency_project_unavailable' });
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request,
    toolchains: { pip: { ...toolchain, installer: '26.4' } } }), { code: 'dependency_cache_unavailable' });
  await assertWorkspaceDependencyWriteIsolation(configPath, [scratch]);
  for (const writable of [fixture, config, cache, manifests]) {
    await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [writable]), { code: 'dependency_write_overlap' });
  }
  const originalOpen = fs.open;
  const changePolicy = mock.method(fs, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === sidecar) await writeRegistry({ ...policy, projects: [] });
    return originalOpen(...args);
  });
  try { await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_selection_revoked' }); }
  finally { changePolicy.mock.restore(); }
  await writeRegistry({ ...policy, projects: [] });
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected }), { code: 'dependency_selection_revoked' });
  const revokedLedger = new DatabaseSync(ledgerPath);
  try {
    const store = new SqliteManagedWorkspaceStore(revokedLedger);
    const next = { ...firstRun, owner: { ...firstRun.owner, runId: 'dependency-revoked-before-reservation' } };
    await assert.rejects(store.ensure(next), { code: 'dependency_selection_revoked' });
    assert.equal(store.get(next.owner), null);
    await assert.rejects(store.ensure(firstRun), { code: 'dependency_selection_revoked' });
    assert.deepEqual(store.get(firstRun.owner)?.allocation.dependencySelections, expected);
  } finally { revokedLedger.close(); }
  const laterDb = path.join(fixture, 'not-created', 'jobs.sqlite');
  await assert.rejects(SqliteContinuationRepository.open({ databasePath: laterDb, artifactsDir: path.join(cache, 'nested', 'artifacts'),
    managedWorkspacePolicy: { managedWorkspaceConfigPath: configPath, currentWorkingRoot: work } }), { code: 'dependency_write_overlap' });
  await assert.rejects(fs.access(path.dirname(laterDb)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(cache), [wheelName]);
  const alternate = path.join(fixture, 'storage-via-symlink');
  const realStorage = path.join(fixture, 'real-storage');
  await fs.mkdir(realStorage, { mode: 0o700 });
  await fs.symlink(realStorage, alternate);
  await assert.rejects(SqliteContinuationRepository.open({ databasePath: path.join(alternate, 'database', 'jobs.sqlite'),
    artifactsDir: path.join(realStorage, 'artifacts'), managedWorkspacePolicy: { managedWorkspaceConfigPath: configPath, currentWorkingRoot: work } }),
  { code: 'dependency_storage_unverifiable' });
  assert.deepEqual(await fs.readdir(realStorage), []);
  assert.deepEqual(await resolveWorkspaceDependencySelections(request), []);
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [cache]), { code: 'dependency_write_overlap' });
  await writeRegistry({ ...policy, caches: [entry, { ...entry, scope: 'team-b', key: 'b'.repeat(64) }] });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [scratch]), { code: 'dependency_registry_invalid' });
  await writeRegistry({ ...policy, caches: [{ ...entry, artifactManifestSha256: 'c'.repeat(64) }] });
  await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_manifest_mismatch' });
  const npmToolchain = { ...toolchain, runtime: '24.15.0', installer: '11.12.1', abi: '137' };
  const npmPrepared = prepareWorkspaceNpmLock({ ecosystem: 'npm', toolchain: npmToolchain,
    lock: npmLock, manifest: npmManifest, scope, registry: npmRegistry }, [{ resolved, integrity }]);
  const npmEntry = { scope, key: npmPrepared.identity.key, ecosystem: 'npm', cache: await pinWorkspacePath(fixture, npmCache),
    artifactManifestSha256: npmPrepared.artifactManifestSha256 };
  await fs.writeFile(path.join(manifests, `${npmEntry.key}.json`), JSON.stringify([{ resolved, integrity }]), { mode: 0o600 });
  const dual = { ...policy, projects: [{ ...projects[0], policies: [...projects[0].policies, { ecosystem: 'npm', registry: npmRegistry }] }],
    caches: [entry, npmEntry] };
  await writeRegistry(dual);
  const both = await resolveWorkspaceDependencySelections({ ...request, toolchains: { pip: toolchain, npm: npmToolchain } });
  assert.deepEqual(both.map(({ selection }) => selection.identity.key), [npmEntry.key, key]);
  assert.deepEqual(both[0].npmManifest, npmManifest);
  assert.equal(both[0].stagedLock, npmPrepared.lock);
  assert.equal(both[1].npmManifest, undefined);
  const shared = both.map(({ selection }) => selection);
  const npmOwner = { kind: 'cron_prompt', runId: 'dependency-npm-linked-before-commit' } as const;
  const npmLedger = new DatabaseSync(ledgerPath);
  let npmPublication;
  try {
    const store = new SqliteManagedWorkspaceStore(npmLedger);
    const run = await store.ensure({ ...firstRun, owner: npmOwner, dependencySelections: shared });
    store.reserveDependencyInstall(npmOwner, 'npm', installNonce);
    const outputPath = path.join(run.scratch.directory, `lark-dependency-install-${installNonce}`, 'node_modules');
    await fs.mkdir(outputPath, { recursive: true, mode: 0o700 });
    const output = await pinWorkspacePath(run.scratch.directory, outputPath);
    npmPublication = { scratch: run.scratch, ...run.gitCheckout!, ecosystem: 'npm' as const, nonce: installNonce,
      receipt: { output, measurement: await dependencyInstall.measureWorkspaceDependencyOutput(output, 'npm') } };
    await dependencyInstall.publishWorkspaceDependencyOutput(npmPublication);
  } finally { npmLedger.close(); }
  const afterNpmCrash = new DatabaseSync(ledgerPath);
  try {
    const store = new SqliteManagedWorkspaceStore(afterNpmCrash);
    assert.deepEqual(store.getDependencyInstall(npmOwner, 'npm'), { nonce: installNonce });
    await assert.rejects(dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, npmOwner, 'npm'),
      { code: 'dependency_install_incomplete' });
    await dependencyInstall.validatePublishedWorkspaceDependencyOutput(npmPublication);
  } finally { afterNpmCrash.close(); }
  assert.ok(sameWorkspaceDependencySelections(shared, [...shared].reverse()));
  assert.ok(!workspaceDependencySelectionsSchema.safeParse([shared[0], { ...shared[1], cache: shared[0].cache }]).success);
  assert.ok(!workspaceDependencySelectionsSchema.safeParse([{ ...shared[0], cache: { ...shared[0].cache,
    directory: `${shared[0].cache.directory}/.` } }]).success);
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected }), { code: 'dependency_selection_revoked' });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [npmCache]), { code: 'dependency_write_overlap' });
  await writeRegistry({ ...dual, projects: [{ ...dual.projects[0], policies: [{ ecosystem: 'npm', registry: 'http://registry.example.test/' }] }] });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [scratch]), { code: 'dependency_registry_invalid' });
  const runtimePath = path.join(fixture, 'trusted-runtime');
  const installerPath = path.join(fixture, 'trusted-installer');
  await Promise.all([runtimePath, installerPath].map((directory) => fs.mkdir(directory, { mode: 0o700 })));
  const declared = { ecosystem: 'pip', executable: path.join(runtimePath, 'python'), runtime: await pinWorkspacePath(fixture, runtimePath),
    installer: await pinWorkspacePath(fixture, installerPath) } as const;
  const fingerprint = 'a'.repeat(64);
  await writeRegistry({ ...policy, toolchains: [declared] });
  await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_toolchain_unavailable' });
  const measured = await resolveWorkspaceDependencySelections({ ...request, probeToolchain: async (configured, saved) => {
    assert.deepEqual(configured, declared);
    assert.equal(saved, undefined);
    return { toolchain, fingerprint };
  } });
  assert.equal(measured[0].selection.identity.key, key, 'the same ABI can reuse the cache across protected installations');
  assert.equal(measured[0].selection.toolchainFingerprint, fingerprint);
  const toolchainSelections = measured.map(({ selection }) => selection);
  const driftLedger = new DatabaseSync(ledgerPath);
  try {
    const owner = { kind: 'async_task', runId: 'dependency-wrong-lock' } as const;
    const store = new SqliteManagedWorkspaceStore(driftLedger);
    const run = await store.ensure({ ...firstRun, owner, dependencySelections: toolchainSelections });
    const before = await fs.readdir(run.scratch.directory);
    await assert.rejects(dependencyInstall.ensureManagedWorkspaceDependencyOutput(store, owner, 'pip', {
      input: { ...input, lock: Buffer.concat([input.lock, Buffer.from('\n')]) }, configured: declared, artifactManifest: manifest,
      authorizedRoots, configPath, codexCommand: '/must-not-launch',
    }), { code: 'dependency_install_selection_mismatch' });
    assert.equal(store.getDependencyInstall(owner, 'pip'), null, 'wrong raw lock never reserves a run install');
    assert.deepEqual(await fs.readdir(run.scratch.directory), before);
  } finally { driftLedger.close(); }
  await assertWorkspaceDependencySelectionAuthorized(configPath, request.project, request.git, toolchainSelections);
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [runtimePath]), { code: 'dependency_write_overlap' });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [installerPath]), { code: 'dependency_write_overlap' });
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected: measured.map(({ selection }) => selection),
    probeToolchain: async (_configured, saved) => {
      assert.equal(saved, fingerprint);
      return { toolchain, fingerprint: 'b'.repeat(64) };
    } }), { code: 'dependency_selection_revoked' });
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected, probeToolchain: async () => ({ toolchain, fingerprint }) }),
    { code: 'dependency_selection_revoked' });
  await writeRegistry({ ...policy, toolchains: [{ ...declared, executable: path.join(runtimePath, 'different-python') }] });
  await assert.rejects(assertWorkspaceDependencySelectionAuthorized(configPath, request.project, request.git, toolchainSelections),
    { code: 'dependency_selection_revoked' });
  await writeRegistry(policy);
  const wheelPath = path.join(cache, wheelName);
  await fs.unlink(wheelPath);
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected }), { code: 'dependency_artifact_missing' });
  const deliveryLedger = new DatabaseSync(ledgerPath);
  try {
    const record = new SqliteManagedWorkspaceStore(deliveryLedger).get(firstRun.owner);
    assert.deepEqual(record?.allocation.dependencySelections, expected, 'delivery can still read a committed allocation when its dependencies are missing');
  } finally { deliveryLedger.close(); }
  const movedCache = path.join(work, 'unavailable-cache');
  await fs.rename(cache, movedCache);
  try {
    const reopened = await SqliteContinuationRepository.open({ databasePath: path.join(fixture, 'delivery-runtime', 'jobs.sqlite'),
      artifactsDir: path.join(fixture, 'delivery-runtime', 'artifacts'),
      managedWorkspacePolicy: { managedWorkspaceConfigPath: configPath, currentWorkingRoot: work } });
    reopened.close();
  } finally { await fs.rename(movedCache, cache); }
  await fs.writeFile(wheelPath, wheel);
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected }), { code: 'dependency_cache_changed' });
  await fs.chmod(sidecar, 0o622);
  await assert.rejects(resolveWorkspaceDependencySelections(request), { code: 'dependency_manifest_invalid' });
  await fs.chmod(sidecar, 0o600);
  await fs.chmod(registry, 0o622);
  assert.deepEqual(await resolveWorkspaceDependencySelections({ ...request, expected: [] }), []);
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [scratch]), { code: 'dependency_registry_invalid' });
  console.log('workspace dependency registry smoke: PASS');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
