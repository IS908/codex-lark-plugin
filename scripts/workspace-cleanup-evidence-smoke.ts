import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { hasExclusiveWorkspaceCleanupStorage, measureWorkspaceCleanupBaseline, readWorkspaceCleanupEpoch,
  type WorkspaceCleanupEpoch, wasUsedOnPriorHostBoot } from '../src/workspace-cleanup-evidence.js';

const old: WorkspaceCleanupEpoch = { host: 'a'.repeat(64), boot: 'b'.repeat(64) };
const now: WorkspaceCleanupEpoch = { ...old, boot: 'c'.repeat(64) };
assert.equal(wasUsedOnPriorHostBoot(old, now), true);
assert.equal(wasUsedOnPriorHostBoot(old, old), false);
assert.equal(wasUsedOnPriorHostBoot({ ...old, host: 'd'.repeat(64) }, now), false);
assert.equal(wasUsedOnPriorHostBoot(undefined, now), false);
assert.equal(wasUsedOnPriorHostBoot(old, undefined), false);
if (process.env.LARK_TEST_REQUIRE_CLEANUP_EPOCH === '1') {
  assert.ok(await readWorkspaceCleanupEpoch(), 'the native host and boot identities are available on this fixture host');
  console.log('native workspace cleanup epoch: PASS');
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-evidence-fixture-')));
try {
  if (process.env.LARK_TEST_REQUIRE_CLEANUP_EPOCH === '1') {
    assert.ok(await hasExclusiveWorkspaceCleanupStorage([fixture]), 'fixture resides on verified internal native Data storage');
    console.log('native workspace cleanup exclusive storage: PASS');
  }
  const checkout = path.join(fixture, 'git-checkout');
  const git = path.join(checkout, '.git');
  await fs.mkdir(path.join(git, 'objects'), { recursive: true, mode: 0o700 });
  const file = path.join(checkout, 'tracked.txt');
  await fs.writeFile(file, 'original');
  await fs.writeFile(path.join(git, 'HEAD'), 'fixture');
  await fs.writeFile(path.join(checkout, '.gitignore'), 'ignored.txt\n');
  const binding = await pinWorkspacePath(fixture, '.');
  const baseline = await measureWorkspaceCleanupBaseline(binding);
  assert.ok(baseline);
  assert.equal(await measureWorkspaceCleanupBaseline(binding), baseline);
  await fs.writeFile(file, 'modified');
  assert.notEqual(await measureWorkspaceCleanupBaseline(binding), baseline);
  await fs.writeFile(file, 'original');
  assert.equal(await measureWorkspaceCleanupBaseline(binding), baseline);
  const bom = path.join(checkout, '\uFEFFtracked.txt');
  await fs.writeFile(bom, 'original');
  const withBom = await measureWorkspaceCleanupBaseline(binding);
  assert.ok(withBom && withBom !== baseline);
  await fs.writeFile(bom, 'changed');
  assert.notEqual(await measureWorkspaceCleanupBaseline(binding), withBom);
  await fs.unlink(bom);
  for (const newFile of [path.join(checkout, 'ignored.txt'), path.join(git, 'objects', 'private-object')]) {
    await fs.writeFile(newFile, 'unique content');
    assert.notEqual(await measureWorkspaceCleanupBaseline(binding), baseline);
    await fs.unlink(newFile);
  }
  const shortcut = path.join(checkout, 'unverified-link');
  await fs.symlink('tracked.txt', shortcut);
  assert.equal(await measureWorkspaceCleanupBaseline(binding), undefined);
  await fs.unlink(shortcut);
  await fs.unlink(path.join(git, 'HEAD'));
  assert.notEqual(await measureWorkspaceCleanupBaseline(binding), baseline);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
console.log('workspace cleanup evidence: PASS');
