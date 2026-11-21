import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeWorkspaceDependencies, prepareWorkspaceNpmLock, prepareWorkspacePipLock, workspaceDependencyIdentitySchema, WorkspaceDependencyInputError } from '../src/workspace-dependency-input.js';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const manifest = { name: 'fixture', version: '1.0.0', dependencies: { '@fixture/a': '^1.0.0' } };
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const defaultArtifact = { version: '1.0.0', resolved: 'https://registry.example.test/@fixture/a/-/a-1.0.0.tgz', integrity };
const node = { runtime: '26.12.0', installer: '12.2.1', abi: '147', platform: 'linux', arch: 'arm64', platformAbi: 'glibc-2.35' } as const;
const npm = {
  ecosystem: 'npm', toolchain: node, registry: 'https://registry.example.test/', scope: 'team-a', manifest: bytes(manifest),
  lock: bytes({ lockfileVersion: 3, packages: { '': manifest, 'node_modules/@fixture/a': defaultArtifact } }),
} as const;
const pip = {
  ecosystem: 'pip', toolchain: { ...node, runtime: '3.13.9', installer: '26.3', abi: 'cpython-313-aarch64-linux-gnu' }, scope: 'team-a',
  lock: Buffer.from(`# compiled requirements\nSome_Project==1.0.0 \\\n    --hash=sha256:${'9'.repeat(64)}\n`),
} as const;

const describe = () => describeWorkspaceDependencies(npm);
const npmPlan = describe();
assert.equal(npmPlan.ecosystem, 'npm');
assert.deepEqual(npmPlan.artifacts, [{ path: 'node_modules/@fixture/a', resolved: defaultArtifact.resolved, integrity }]);
assert.match(npmPlan.key, /^[a-f0-9]{64}$/);
assert.equal(describe().key, npmPlan.key);
const { artifacts: _artifacts, ...identity } = npmPlan;
assert.deepEqual(workspaceDependencyIdentitySchema.parse(identity), identity);
assert.ok(!workspaceDependencyIdentitySchema.safeParse({ ...identity, manifestSha256: '1'.repeat(64) }).success);
assert.ok(!workspaceDependencyIdentitySchema.safeParse({ ...identity, registry: 'file:///tmp/' }).success);
for (const modified of [
  { ...npm, lock: Buffer.concat([npm.lock, Buffer.from('\n')]) },
  { ...npm, manifest: Buffer.concat([npm.manifest, Buffer.from('\n')]) },
  { ...npm, scope: 'team-b' },
  ...Object.entries({ abi: '148', runtime: '26.13.0', installer: '11.12.1', platform: 'darwin', arch: 'x64', platformAbi: 'musl-1.2' })
    .map(([key, value]) => ({ ...npm, toolchain: { ...npm.toolchain, [key]: value } })),
]) assert.notEqual(describeWorkspaceDependencies(modified).key, npmPlan.key);

const throwsInput = (callback: () => unknown) => assert.throws(callback, WorkspaceDependencyInputError);
const withArtifact = (record: Record<string, unknown>, location = 'node_modules/@fixture/a') => ({ ...npm,
  lock: bytes({ lockfileVersion: 3, packages: { '': manifest, [location]: { ...defaultArtifact, ...record } } }),
});
for (const resolved of ['git+https://registry.example.test/a.git', 'file:../a.tgz', 'http://registry.example.test/a.tgz',
  'https://other.example.test/a.tgz', 'https://user:pass@registry.example.test/a.tgz', 'https://registry.example.test/a.tgz?token=secret']) {
  throwsInput(() => describeWorkspaceDependencies(withArtifact({ resolved })));
}
for (const record of [{ link: true }, { link: 'false' }, { inBundle: true }, { patched: { path: 'other.patch' } },
  { integrity: 'sha1-abc' }, { integrity: 'sha512-invalid' },
  { dependencies: { source: 'github:org/repo' } }]) throwsInput(() => describeWorkspaceDependencies(withArtifact(record)));
throwsInput(() => describeWorkspaceDependencies({ ...npm, manifest: bytes({ ...manifest, patchedDependencies: { '@fixture/a': 'other.patch' } }) }));
throwsInput(() => describeWorkspaceDependencies({ ...npm, lock: bytes({ lockfileVersion: 3, packages: { '': manifest } }) }));
throwsInput(() => describeWorkspaceDependencies(withArtifact({ dependencies: { omitted: '^1.0.0' } })));
const deepManifest = `{"name":"fixture","version":"1.0.0","dependencies":{"@fixture/a":"^1.0.0"},"data":${'['.repeat(200)}0${']'.repeat(200)}}`;
throwsInput(() => describeWorkspaceDependencies({ ...npm, manifest: Buffer.from(deepManifest) }));
const sparse = withArtifact({ integrity: undefined, resolved: undefined });
assert.deepEqual(describeWorkspaceDependencies(sparse).artifacts,
  [{ path: 'node_modules/@fixture/a', resolved: defaultArtifact.resolved, integrity: null }]);
throwsInput(() => prepareWorkspaceNpmLock(sparse, []));
throwsInput(() => prepareWorkspaceNpmLock(npm, [{ resolved: defaultArtifact.resolved, integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}` }]));
throwsInput(() => prepareWorkspaceNpmLock(sparse, [{ resolved: defaultArtifact.resolved, integrity: 'sha256-invalid' }]));
const catalog = [{ resolved: defaultArtifact.resolved, integrity }];
const prepared = prepareWorkspaceNpmLock(sparse, catalog);
assert.equal(prepared.identity.key, describeWorkspaceDependencies(sparse).key);
assert.deepEqual(JSON.parse(prepared.lock).packages['node_modules/@fixture/a'], defaultArtifact);
assert.equal(JSON.parse(sparse.lock.toString()).packages['node_modules/@fixture/a'].integrity, undefined);
assert.equal(prepared.artifactManifestSha256, prepareWorkspaceNpmLock(npm, catalog).artifactManifestSha256);
throwsInput(() => describeWorkspaceDependencies(withArtifact({}, 'node_modules/../outside')));
throwsInput(() => describeWorkspaceDependencies({ ...npm, manifest: bytes({ ...manifest, workspaces: ['packages/*'] }) }));
assert.notEqual(describeWorkspaceDependencies({ ...npm, manifest: bytes({ ...manifest, overrides: { '@fixture/a@^1': { '.': '$@fixture/a' } } }) }).key,
  npmPlan.key);
throwsInput(() => describeWorkspaceDependencies({ ...npm, manifest: bytes({ ...manifest,
  overrides: { '@fixture/a': { '.': 'git+https://example.test/remote' } } }) }));
throwsInput(() => describeWorkspaceDependencies({ ...npm, manifest: bytes({ ...manifest, dependencies: { '@fixture/a': '^2.0.0' } }) }));
throwsInput(() => describeWorkspaceDependencies({ ...npm, lock: Buffer.concat([npm.lock, Buffer.from([0xff])]) }));
throwsInput(() => describeWorkspaceDependencies({ ...npm, scope: '../shared' }));
throwsInput(() => describeWorkspaceDependencies({ ...npm, registry: 'https://registry.example.test/subregistry/' }));

const pipPlan = describeWorkspaceDependencies(pip);
assert.equal(pipPlan.ecosystem, 'pip');
assert.deepEqual(pipPlan.requirements, [{ name: 'some-project', version: '1.0.0', hashes: ['9'.repeat(64)] }]);
const { requirements: _requirements, ...pipIdentity } = pipPlan;
assert.deepEqual(workspaceDependencyIdentitySchema.parse(pipIdentity), pipIdentity);
assert.ok(!workspaceDependencyIdentitySchema.safeParse({ ...pipIdentity, key: '1'.repeat(64) }).success);
assert.notEqual(pipPlan.key, describeWorkspaceDependencies({ ...pip, lock: Buffer.concat([pip.lock, Buffer.from('\n')]) }).key);
const hashArg = `--hash=sha256:${'9'.repeat(64)}`;
const wheel = { filename: 'some_project-1.0.0-py3-none-any.whl', sha256: '9'.repeat(64) };
const wheels = prepareWorkspacePipLock(pip, [wheel]);
assert.equal(wheels.lock, `some-project==1.0.0 ${hashArg}\n`);
assert.equal(wheels.identity.key, pipPlan.key);
assert.match(wheels.artifactManifestSha256, /^[0-9a-f]{64}$/);
assert.throws(() => prepareWorkspacePipLock(pip, []), { code: 'dependency_artifact_missing' });
assert.throws(() => prepareWorkspacePipLock(pip, [{ ...wheel, sha256: '8'.repeat(64) }]), { code: 'dependency_artifact_conflict' });
for (const invalid of [{ ...wheel, filename: `../${wheel.filename}` }, { ...wheel, filename: 'some_project-1.0.0.tar.gz' },
  { ...wheel, filename: 'other_project-1.0.0-py3-none-any.whl' }]) throwsInput(() => prepareWorkspacePipLock(pip, [invalid]));
throwsInput(() => prepareWorkspacePipLock(pip, [wheel, wheel]));
for (const line of ['-r another.txt', '--extra-index-url https://example.test', `a>=1.0 ${hashArg}`, 'a==1.0',
  `a @ https://example.test/a.whl ${hashArg}`, `a==1.0.* ${hashArg}`, `a==1.0; sys_platform=="linux" ${hashArg}`,
  `a==1.0 ${hashArg} --find-links other`, `a_b==1.0 ${hashArg}\nA-B==1.0 ${hashArg}`, `a==1.0 ${hashArg} \\`,
  `a==1.0 # ambiguous \\\n--hash=sha256:${'9'.repeat(64)}`, `a==1.0.0.lark ${hashArg}`]) {
  throwsInput(() => describeWorkspaceDependencies({ ...pip, lock: Buffer.from(`${line}\n`) }));
}
const repo = describeWorkspaceDependencies({ ...npm, registry: 'https://registry.npmjs.org/',
  manifest: readFileSync(new URL('../package.json', import.meta.url)), lock: readFileSync(new URL('../package-lock.json', import.meta.url)) });
assert.equal(repo.ecosystem, 'npm');
assert.ok(repo.artifacts.some(({ path }) => path === 'node_modules/zod'));
console.log('workspace dependency input smoke: PASS');
