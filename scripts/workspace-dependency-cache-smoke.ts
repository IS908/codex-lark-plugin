import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { verifyWorkspaceDependencyCache } from '../src/workspace-dependency-cache.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-cache-')));
try {
  const authorizedRoots = [fixture] as const;
  const archive = Buffer.from('npm archive fixture');
  const sha512 = createHash('sha512').update(archive).digest();
  const integrity = `sha512-${sha512.toString('base64')}`;
  const hex = sha512.toString('hex');
  const relative = `_cacache/content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
  const npmCache = path.join(fixture, 'npm');
  const blob = path.join(npmCache, relative);
  await fs.mkdir(path.dirname(blob), { recursive: true, mode: 0o700 });
  await fs.writeFile(blob, archive, { mode: 0o600 });
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: { child: '1.0.0' } };
  const resolved = 'https://registry.example.test/child/-/child-1.0.0.tgz';
  const npmInput = {
    ecosystem: 'npm', registry: 'https://registry.example.test/', scope: 'team-a',
    toolchain: { runtime: '24.15.0', installer: '11.12.1', abi: '137', platform: 'linux', arch: 'x64', platformAbi: 'glibc-2.35' },
    manifest: Buffer.from(JSON.stringify(pkg)),
    lock: Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': pkg, 'node_modules/child': { version: '1.0.0', resolved, integrity } } })),
  } as const;
  const npmSelection = { cache: await pinWorkspacePath(fixture, npmCache), authorizedRoots, input: npmInput,
    artifactManifest: [{ resolved, integrity }] };
  const first = await verifyWorkspaceDependencyCache(npmSelection);
  assert.equal(first.identity.ecosystem, 'npm');
  assert.equal(first.bytes, archive.length);
  assert.match(first.cacheFingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await verifyWorkspaceDependencyCache({ ...npmSelection, expectedFingerprint: first.cacheFingerprint })).cacheFingerprint, first.cacheFingerprint);
  const extra = path.join(npmCache, '_cacache', 'index-v5');
  await fs.mkdir(extra);
  await assert.rejects(verifyWorkspaceDependencyCache(npmSelection), { code: 'dependency_cache_invalid' });
  await fs.rmdir(extra);
  await fs.writeFile(blob, Buffer.alloc(archive.length));
  await assert.rejects(verifyWorkspaceDependencyCache(npmSelection), { code: 'dependency_artifact_conflict' });
  await fs.unlink(blob);
  await assert.rejects(verifyWorkspaceDependencyCache(npmSelection), { code: 'dependency_artifact_missing' });
  await fs.writeFile(blob, archive, { mode: 0o600 });
  await assert.rejects(verifyWorkspaceDependencyCache({ ...npmSelection, expectedFingerprint: first.cacheFingerprint }),
    { code: 'dependency_cache_changed' });

  const wheelhouse = path.join(fixture, 'wheelhouse');
  await fs.mkdir(wheelhouse, { mode: 0o700 });
  const wheel = Buffer.from('wheel bytes fixture');
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  const filename = 'fixture-1.0.0-py3-none-any.whl';
  const wheelPath = path.join(wheelhouse, filename);
  await fs.writeFile(wheelPath, wheel, { mode: 0o600 });
  const pythonSelection = { cache: await pinWorkspacePath(fixture, wheelhouse), authorizedRoots, input: { ecosystem: 'pip', scope: 'team-a',
    toolchain: { ...npmInput.toolchain, runtime: '3.13.9', installer: '26.3', abi: 'cpython-313-x86_64-linux-gnu' },
    lock: Buffer.from(`fixture==1.0.0 --hash=sha256:${sha256}\n`) }, artifactManifest: [{ filename, sha256 }] } as const;
  assert.equal((await verifyWorkspaceDependencyCache(pythonSelection)).bytes, wheel.length);
  await assert.rejects(verifyWorkspaceDependencyCache({ ...pythonSelection, authorizedRoots: [npmCache] }), { code: 'dependency_cache_invalid' });
  const outside = path.join(fixture, 'different-wheel');
  await fs.rename(wheelPath, outside);
  await fs.symlink(outside, wheelPath);
  await assert.rejects(verifyWorkspaceDependencyCache(pythonSelection), { code: 'dependency_cache_invalid' });
  await fs.unlink(wheelPath);
  await fs.link(outside, wheelPath);
  await assert.rejects(verifyWorkspaceDependencyCache(pythonSelection), { code: 'dependency_cache_invalid' });
  await fs.unlink(wheelPath);
  await fs.rename(outside, wheelPath);
  if (process.platform === 'darwin') {
    execFileSync('/bin/chmod', ['+a', 'everyone allow write', wheelPath]);
    const open = mock.method(fs, 'open');
    try {
      await assert.rejects(verifyWorkspaceDependencyCache(pythonSelection), { code: 'dependency_cache_invalid' });
      assert.equal(open.mock.callCount(), 0, 'unexpected ACL must be rejected before opening the wheel');
    } finally {
      open.mock.restore();
      execFileSync('/bin/chmod', ['-N', wheelPath]);
    }
  }
  await fs.chmod(wheelPath, 0o622);
  await assert.rejects(verifyWorkspaceDependencyCache(pythonSelection), { code: 'dependency_cache_invalid' });
  console.log('workspace dependency cache smoke: PASS');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
