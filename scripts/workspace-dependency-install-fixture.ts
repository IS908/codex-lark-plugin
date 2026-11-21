import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceDependencyToolchainBindingDigest } from '../src/domain/workspace-dependency.js';
import type { WorkspaceProjectBinding } from '../src/domain/workspace.js';
import { verifyWorkspaceDependencyCache } from '../src/workspace-dependency-cache.js';
import { installWorkspaceDependencyInStaging } from '../src/workspace-dependency-install.js';
import type { WorkspaceDependencyInput } from '../src/workspace-dependency-input.js';
import type { probeWorkspaceDependencyToolchain } from '../src/workspace-dependency-toolchain.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

type Probed = Awaited<ReturnType<typeof probeWorkspaceDependencyToolchain>>;
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const hash = (value: Uint8Array, algorithm = 'sha256', encoding: 'hex' | 'base64' | 'base64url' = 'hex') =>
  createHash(algorithm).update(value).digest(encoding);

export async function exerciseWorkspaceDependencyInstall(fixture: string, common: {
  codexCommand: string; temporaryRoot: WorkspaceProjectBinding;
}, npm: Probed, pip: Probed) {
  const npmCache = path.join(fixture, 'install-npm-cache');
  const pipCache = path.join(fixture, 'install-pip-cache');
  const [nodeInput, nodeArtifacts, blob] = await npmFixture(fixture, npmCache, npm.toolchain);
  const [pythonInput, pythonArtifacts, wheel] = await pipFixture(fixture, pipCache, pip.toolchain);
  const scope = [fixture] as const;
  for (const [input, artifactManifest, cachePath, artifact, tool, relative] of [
    [nodeInput, nodeArtifacts, npmCache, blob, npm, 'lark-fixture/index.js'],
    [pythonInput, pythonArtifacts, pipCache, wheel, pip, 'lark_fixture/__init__.py'],
  ] as const) {
    const cache = await pinWorkspacePath(fixture, cachePath);
    const original = hash(await fs.readFile(artifact));
    const measured = await verifyWorkspaceDependencyCache({ input, artifactManifest, cache, authorizedRoots: scope });
    const selection = { identity: measured.identity, cache, artifactManifestSha256: measured.artifactManifestSha256,
      cacheFingerprint: measured.cacheFingerprint, toolchainFingerprint: tool.fingerprint,
      toolchainBindingDigest: workspaceDependencyToolchainBindingDigest(tool.configured) };
    const request = { ...common, input, artifactManifest, selection, configured: tool.configured, authorizedRoots: scope };
    const before = (await fs.readdir(fixture)).sort();
    const stale = { ...input, toolchain: { ...input.toolchain, platformAbi: input.toolchain.platformAbi + '.0' } };
    const previous = await verifyWorkspaceDependencyCache({ input: stale, artifactManifest, cache, authorizedRoots: scope });
    await assert.rejects(installWorkspaceDependencyInStaging({ ...request, input: stale, selection: {
      ...selection, cacheFingerprint: previous.cacheFingerprint, identity: previous.identity,
    } }), { code: 'dependency_install_selection_mismatch' });
    assert.deepEqual((await fs.readdir(fixture)).sort(), before);
    const results = await Promise.allSettled([installWorkspaceDependencyInStaging(request), installWorkspaceDependencyInStaging(request)]);
    const complete = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    try {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const [a, b] = complete;
      assert.ok(a && b);
      assert.notEqual(a.staging.directory, b.staging.directory);
      assert.notEqual(a.output.inode, b.output.inode);
      assert.match(a.measurement.digest, /^[a-f0-9]{64}$/);
      assert.ok(a.measurement.entries >= 3 && a.measurement.bytes > 0);
      const one = path.join(a.output.directory, relative);
      const two = path.join(b.output.directory, relative);
      assert.notEqual((await fs.stat(one)).ino, (await fs.stat(two)).ino);
      assert.match(await fs.readFile(one, 'utf8'), /lark fixture/);
      await fs.writeFile(one, 'first run modified its private copy');
      assert.match(await fs.readFile(two, 'utf8'), /lark fixture/);
      if (input.ecosystem === 'npm') {
        assert.equal(await fs.realpath(path.join(b.output.directory, '.bin', 'lark-fixture')), two);
        await assert.rejects(fs.stat(path.join(path.dirname(one), 'lifecycle-ran')), { code: 'ENOENT' });
      }
      assert.equal(hash(await fs.readFile(artifact)), original);
    } finally {
      for (const { staging } of complete) await fs.rm(staging.directory, { recursive: true, force: true });
    }
    await fs.unlink(artifact);
    await assert.rejects(installWorkspaceDependencyInStaging(request), { code: 'dependency_artifact_missing' });
    assert.deepEqual((await fs.readdir(fixture)).sort(), before);
  }
  console.log('workspace dependency staging installs: real offline npm and pip, two private outputs per ecosystem, immutable cache and fail-closed absence');
}

async function npmFixture(fixture: string, cache: string, toolchain: Probed['toolchain']) {
  const source = path.join(fixture, 'npm-source');
  const packageDir = path.join(source, 'package');
  await fs.mkdir(packageDir, { recursive: true });
  const leaf = { name: 'lark-fixture', version: '1.0.0', bin: { 'lark-fixture': 'index.js' },
    scripts: { install: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\'); process.exit(13)"' } };
  await fs.writeFile(path.join(packageDir, 'package.json'), json(leaf));
  await fs.writeFile(path.join(packageDir, 'index.js'), "#!/usr/bin/env node\nmodule.exports = 'lark fixture';\n");
  const tar = path.join(source, 'packed.tgz');
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', tar, '-C', source, 'package'], { env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(tar);
  const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
  const hex = hash(bytes, 'sha512');
  const blob = path.join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  await fs.mkdir(path.dirname(blob), { recursive: true });
  await fs.writeFile(blob, bytes);
  const registry = 'https://registry.npmjs.org/';
  const resolved = `${registry}lark-fixture/-/lark-fixture-1.0.0.tgz`;
  const project = { name: 'test-run', version: '1.0.0', dependencies: { 'lark-fixture': '1.0.0' } };
  const lock = { name: project.name, version: project.version, lockfileVersion: 3, requires: true,
    packages: { '': project, 'node_modules/lark-fixture': { version: leaf.version, resolved, integrity, bin: leaf.bin, hasInstallScript: true } } };
  const input = { ecosystem: 'npm', scope: 'fixture', registry, manifest: json(project), lock: json(lock), toolchain } satisfies WorkspaceDependencyInput;
  return [input, [{ resolved, integrity }], blob] as const;
}

async function pipFixture(fixture: string, cache: string, toolchain: Probed['toolchain']) {
  const source = path.join(fixture, 'pip-source');
  await fs.mkdir(cache);
  const info = 'lark_fixture-1.0.0.dist-info';
  const files: Record<string, string> = {
    'lark_fixture/__init__.py': "VALUE = 'lark fixture'\n",
    [`${info}/METADATA`]: 'Metadata-Version: 2.1\nName: lark-fixture\nVersion: 1.0.0\n',
    [`${info}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: offline-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
  };
  files[`${info}/RECORD`] = Object.entries(files).map(([file, value]) =>
    `${file},sha256=${hash(Buffer.from(value), 'sha256', 'base64url')},${Buffer.byteLength(value)}\n`).join('') + `${info}/RECORD,,\n`;
  for (const [file, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), value);
  }
  const filename = 'lark_fixture-1.0.0-py3-none-any.whl';
  const wheel = path.join(cache, filename);
  execFileSync('/usr/bin/zip', ['-q', wheel, ...Object.keys(files)], { cwd: source, env: { PATH: '/usr/bin:/bin' } });
  const sha256 = hash(await fs.readFile(wheel));
  const input = { ecosystem: 'pip', scope: 'fixture', toolchain,
    lock: Buffer.from(`lark-fixture==1.0.0 --hash=sha256:${sha256}\n`) } satisfies WorkspaceDependencyInput;
  return [input, [{ filename, sha256 }], wheel] as const;
}
