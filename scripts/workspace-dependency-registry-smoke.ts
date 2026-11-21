import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { describeWorkspaceDependencies, prepareWorkspaceNpmLock, prepareWorkspacePipLock } from '../src/workspace-dependency-input.js';
import { assertWorkspaceDependencyWriteIsolation, resolveWorkspaceDependencySelections } from '../src/workspace-dependency-registry.js';
import { readWorkspaceGitCacheIdentity } from '../src/workspace-git-snapshot.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-registry-')));
try {
  const config = path.join(fixture, 'config');
  const work = path.join(fixture, 'work');
  const [source, cache, bare, scratch, artifacts] = ['project', 'wheelhouse', 'git-cache', 'scratch', 'artifacts'].map((dir) => path.join(work, dir));
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
  assert.deepEqual(await resolveWorkspaceDependencySelections({ ...request, expected }), prepared);
  assert.deepEqual(await resolveWorkspaceDependencySelections({ ...request, expected: [] }), []);
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, git: undefined }), { code: 'dependency_project_unavailable' });
  const otherScope = await readWorkspaceGitCacheIdentity({ gitDirectory: gitCache, authorizedRoots, repositoryId, scope: 'team-b', commit });
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
  await assert.rejects(resolveWorkspaceDependencySelections({ ...request, expected }), { code: 'dependency_selection_revoked' });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [npmCache]), { code: 'dependency_write_overlap' });
  await writeRegistry({ ...dual, projects: [{ ...dual.projects[0], policies: [{ ecosystem: 'npm', registry: 'http://registry.example.test/' }] }] });
  await assert.rejects(assertWorkspaceDependencyWriteIsolation(configPath, [scratch]), { code: 'dependency_registry_invalid' });
  await writeRegistry(policy);
  const wheelPath = path.join(cache, wheelName);
  await fs.unlink(wheelPath);
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
