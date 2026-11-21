import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type WorkspaceProjectBinding } from '../src/domain/workspace.js';
import { managedRunDirectoryPath } from '../src/managed-workspace-storage.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { observeWorkspaceCleanupTree } from '../src/workspace-cleanup-evidence.js';
import { createWorkspaceCleanupFiles, workspaceCleanupQuarantinePath } from '../src/workspace-cleanup-files.js';

const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-cleanup-files-')));
const ledgerPath = path.join(work, 'test.sqlite');
const ledger = new DatabaseSync(ledgerPath, { timeout: 0 });
try {
  ledger.exec('PRAGMA journal_mode = WAL; CREATE TABLE fixture (value INTEGER);');
  const inode = await fs.lstat(ledgerPath, { bigint: true });
  const database = { directory: ledgerPath, inode: String(inode.ino), device: String(inode.dev) };
  const root = await pinWorkspacePath(work, '.');
  const owner = { kind: 'cron_prompt', runId: 'physical-fixture' } as const;
  const source = managedRunDirectoryPath(root, owner);
  await fs.mkdir(path.join(source, 'checkout', '.git'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(source, 'checkout', 'tracked.txt'), 'fixture');
  await fs.writeFile(path.join(source, 'checkout', '.git', 'HEAD'), 'fixture object');
  const artifact = path.join(work, 'unmanaged-report.txt');
  await fs.writeFile(artifact, 'preserved');
  const scratch = await pinWorkspacePath(work, source);
  const claim = { owner, scratch, nonce: 'b'.repeat(32) };
  const destination = workspaceCleanupQuarantinePath(root, claim);
  const files = await createWorkspaceCleanupFiles(root, database);
  assert.ok(files, 'a trusted native helper is required in this fixture');
  const original = await observeWorkspaceCleanupTree(scratch);
  assert.ok(original);
  assert.ok(files.canStage(owner, original));
  assert.equal(files.canStage(owner, { ...original, entries: [['x'.repeat(4 * 1024 * 1024), false, '0']] }), false);
  if (process.platform === 'darwin') {
    const tracked = path.join(source, 'checkout', 'tracked.txt');
    execFileSync('/usr/bin/chflags', ['hidden', tracked]);
    const flagged = await observeWorkspaceCleanupTree(scratch);
    assert.ok(flagged);
    assert.equal(flagged.digest, original.digest, 'the released baseline did not cover flags');
    assert.equal(files.canStage(owner, flagged), false, 'do not stage unprovable metadata');
    execFileSync('/usr/bin/chflags', ['nohidden', tracked]);
    execFileSync('/bin/chmod', ['+a', 'everyone deny delete', tracked]);
    try {
      const withAcl = await observeWorkspaceCleanupTree(scratch);
      assert.ok(withAcl);
      assert.equal(withAcl.digest, original.digest);
      assert.equal(files.canStage(owner, withAcl), false, 'an unrecorded ACL can prevent cleanup partway through');
    } finally { execFileSync('/bin/chmod', ['-N', tracked]); }
  }
  const quarantine: WorkspaceProjectBinding = { ...scratch, directory: destination };

  assert.equal(await files.location(claim), 'source');
  await checkOrphanedWriteLock();
  const staged = await observeWorkspaceCleanupTree(scratch);
  assert.ok(staged);
  const lockHolder = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', [
    'import fcntl, os, sys',
    'fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)',
    'fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    'print("locked", flush=True)',
    'sys.stdin.read()',
  ].join('\n'), root.directory], { stdio: ['pipe', 'pipe', 'inherit'] });
  const completed = once(lockHolder, 'close');
  try {
    assert.equal(String((await once(lockHolder.stdout, 'data'))[0]), 'locked\n');
    assert.equal(files.readiness(), 'busy');
    assert.equal(await files.move(claim, staged, () => true), false, 'an existing kernel-held filesystem lock blocks a mutation');
    assert.ok(await staged.unchanged());
  } finally {
    lockHolder.stdin.end();
    await completed;
  }
  assert.equal(files.readiness(), 'ready');
  await fs.mkdir(destination, { mode: 0o700 });
  assert.equal(await files.location(claim), 'ambiguous');
  assert.equal(await files.move(claim, staged, () => true), false);
  assert.ok(await staged.unchanged());
  await fs.rmdir(destination);

  const displaced = path.join(work, 'displaced');
  await fs.rename(source, displaced);
  await fs.symlink(displaced, source);
  assert.equal(await files.location(claim), 'ambiguous');
  assert.equal(await files.move(claim, staged, () => true), false);
  assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
  await fs.unlink(source);
  await fs.rename(displaced, source);
  const restored = await observeWorkspaceCleanupTree(scratch);
  assert.ok(restored);
  assert.equal(restored.digest, original.digest);

  assert.equal(await files.move(claim, restored, () => false), false, 'authorization denied after the helper obtained locks');
  assert.equal(await files.move(claim, restored, () => {
    assert.throws(() => ledger.exec('BEGIN IMMEDIATE'), /locked/);
    return true;
  }), true);
  assert.equal(await files.location(claim), 'quarantine');
  const verified = await observeWorkspaceCleanupTree(quarantine, undefined, false, source);
  assert.ok(verified);
  assert.equal(verified.digest, original.digest, 'the v2 baseline is stable through relocation');
  const extra = path.join(destination, 'checkout', 'extra.txt');
  await fs.writeFile(extra, 'late file');
  assert.equal(await files.purge(claim, verified, () => true), false, 'a changed manifest must reject the whole purge');
  assert.equal(await fs.readFile(path.join(destination, 'checkout', '.git', 'HEAD'), 'utf8'), 'fixture object');
  assert.equal(await fs.readFile(extra, 'utf8'), 'late file');
  await fs.unlink(extra);

  const ready = await observeWorkspaceCleanupTree(quarantine, undefined, false, source);
  assert.ok(ready);
  assert.equal(ready.digest, original.digest);
  assert.equal(await files.purge(claim, ready, () => true), true);
  assert.equal(await files.location(claim), 'missing');
  assert.equal(await files.flush(claim, 'missing', () => true), true);
  assert.equal(await fs.readFile(artifact, 'utf8'), 'preserved');

  async function checkOrphanedWriteLock() {
    const module = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
    const program = `
      import { createWorkspaceCleanupFiles } from ${module('../src/workspace-cleanup-files.ts')};
      import { observeWorkspaceCleanupTree } from ${module('../src/workspace-cleanup-evidence.ts')};
      import { writeSync } from 'node:fs';
      const { root, database, claim } = JSON.parse(process.argv[1]);
      const files = await createWorkspaceCleanupFiles(root, database);
      const tree = await observeWorkspaceCleanupTree(claim.scratch);
      await files.move(claim, tree, (pid) => {
        writeSync(1, String(pid) + '\\n');
        // Stop at the authorization handshake until the test terminates this process.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
        return false;
      });`;
    const launcher = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program,
      JSON.stringify({ root, database, claim })], { stdio: ['ignore', 'pipe', 'inherit'] });
    const closed = once(launcher, 'close');
    let orphan: number | undefined;
    try {
      const started = await Promise.race([once(launcher.stdout, 'data').then(([data]) => String(data)), closed.then(() => 'closed')]);
      assert.match(started, /^[1-9]\d+\n$/);
      orphan = Number(started);
      process.kill(orphan, 'SIGSTOP');
      launcher.kill('SIGKILL');
      await closed;
      assert.throws(() => ledger.exec('BEGIN IMMEDIATE'), /locked/, 'the orphan still holds the SQLite writer reservation');
      assert.equal(await files.location(claim), 'source');
      process.kill(orphan, 'SIGCONT');
      orphan = undefined;
      for (let attempt = 0; ; attempt++) {
        try { ledger.exec('BEGIN IMMEDIATE; ROLLBACK;'); break; }
        catch (error) {
          if (attempt === 99) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(await files.location(claim), 'source', 'without GO the helper did not move the tree');
    } finally {
      launcher.kill('SIGKILL');
      if (orphan) {
        try { process.kill(orphan, 'SIGCONT'); } catch {}
      }
      await closed;
    }
  }
} finally {
  ledger.close();
  await fs.rm(work, { recursive: true, force: true });
}
console.log('workspace cleanup filesystem: PASS');
