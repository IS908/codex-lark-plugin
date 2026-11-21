import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDarwinDependencyMountPolicy, readWorkspaceDependencyMountPolicy } from '../src/workspace-dependency-mounts.js';

const data = '/System/Volumes/Data';
const system = `/dev/disk0s1 on / (apfs, sealed, local, read-only)\n/dev/disk0s2 on ${data} (apfs, local, root data)\n`;
const firmlinks = [ ['/Users', `${data}/Users`], ['/private', `${data}/private`],
  ['/System/Library/Caches', `${data}/System/Library/Caches`] ] as const;
const policy = createDarwinDependencyMountPolicy(`${system}remote on ${data}/Users/fixture/nested (smbfs, nodev)\n`, firmlinks);
assert.deepEqual(policy.aliases('/Users/fixture/cache'), ['/Users/fixture/cache', `${data}/Users/fixture/cache`]);
assert.deepEqual(policy.aliases(`${data}/private/tmp/cache`), [`${data}/private/tmp/cache`, '/private/tmp/cache']);
assert.equal(policy.supports('/Users/fixture/cache'), true);
assert.equal(policy.supports('/USERS/Fixture'), false, 'a mount under a Data alias invalidates a broad write root');
assert.equal(policy.supports('/Users/fixture/nested/writable'), false);
assert.equal(policy.supports(`${data}/Users/fixture/nested`), false);
assert.equal(policy.supports('/Volumes/external/work'), false);
assert.equal(policy.supports('/'), false);
assert.equal(policy.supportsSystemRead?.('/System/Library'), false, 'recursive reads may not span a Data-backed child');
assert.equal(policy.supportsSystemRead?.('/System/Library/Frameworks'), true);
assert.equal(policy.supportsSystemRead?.('/System/Library/Caches'), false);
assert.equal(policy.supportsSystemRead?.('/Users/fixture'), false);
assert.equal(createDarwinDependencyMountPolicy(`${system}nested on /usr/lib/opaque (tmpfs, nodev)\n`, firmlinks)
  .supportsSystemRead?.('/usr/lib'), false);
assert.throws(() => createDarwinDependencyMountPolicy(system.replace('root data', 'journaled'), firmlinks));
assert.throws(() => createDarwinDependencyMountPolicy(`${system}opaque on /unrecognized (smbfs, nodev)\nnon-mount line\n`, firmlinks));

if (process.platform === 'darwin') {
  const current = await readWorkspaceDependencyMountPolicy();
  const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-mount-policy-')));
  try {
    assert.equal(current.supports(fixture), true);
    const first = await fs.stat(fixture, { bigint: true });
    const aliases = current.aliases(fixture);
    assert.ok(aliases.length >= 2, 'the native temporary directory participates in the APFS Data mapping');
    for (const alias of aliases) {
      const second = await fs.stat(alias, { bigint: true });
      assert.equal(second.dev, first.dev);
      assert.equal(second.ino, first.ino);
    }
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
}

console.log('workspace dependency mount policy smoke: PASS');
