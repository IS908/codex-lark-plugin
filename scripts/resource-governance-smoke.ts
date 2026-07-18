/**
 * Resource-governance smoke tests.
 *
 * Covers daemon lock disambiguation, rotating logs, inbox garbage collection,
 * bounded identity sessions, and episode pruning.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  acquireSingleInstanceLock,
  appendRotatingLine,
  BoundedCache,
  stopSingleInstanceLock,
  sweepInbox,
} from '../src/resource-governance.js';
import { IdentitySession } from '../src/identity-session.js';
import { LarkChannel } from '../src/channel.js';
import { BotMessageTracker, LatestMessageTracker } from '../src/message-trackers.js';
import { MemoryStore } from '../src/memory/file.js';
import { appConfig } from '../src/config.js';
import { sendFeishuReply } from '../src/reply-sender.js';
import {
  acquireLarkInstanceLock,
  legacyLarkInstanceLockPath,
} from '../src/instance-lock.js';

let passed = 0;

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function touchAge(filePath: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(filePath, when, when);
}

// 1. Reused PID with a different process start time is treated as stale.
{
  const dir = tmpRoot('resource-lock-reused-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');

  const lock = await acquireSingleInstanceLock(lockPath, {
    pid: 99999,
    startedAt: 3333,
    processExists: () => true,
    getProcessStartedAt: async () => 2222,
  });

  const saved = JSON.parse(readFileSync(lockPath, 'utf-8'));
  assert.equal(saved.pid, 99999);
  assert.equal(saved.startedAt, 3333);
  lock.release();
  assert.equal(existsSync(lockPath), false);
  cleanup(dir);
  passed++;
}

// 2. Live process with matching PID and start time rejects a second instance.
{
  const dir = tmpRoot('resource-lock-live-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');

  await assert.rejects(
    acquireSingleInstanceLock(lockPath, {
      pid: 99999,
      startedAt: 3333,
      processExists: () => true,
      getProcessStartedAt: async () => 1111,
    }),
    /Another instance is running/,
  );
  cleanup(dir);
  passed++;
}

// 3. Fresh unparsable locks are treated as in-flight/corrupt, not stale.
{
  const dir = tmpRoot('resource-lock-invalid-fresh-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, '', 'utf-8');

  await assert.rejects(
    acquireSingleInstanceLock(lockPath, {
      pid: 99999,
      startedAt: 3333,
      processExists: () => false,
      getProcessStartedAt: async () => null,
    }),
    /Another instance is running|Could not acquire|initializing|invalid lock/i,
  );
  assert.equal(existsSync(lockPath), true);
  cleanup(dir);
  passed++;
}

// 4. Stale takeover markers are recoverable after a crashed takeover owner.
{
  const dir = tmpRoot('resource-lock-stale-takeover-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
  mkdirSync(`${lockPath}.takeover`, { recursive: true });
  await touchAge(`${lockPath}.takeover`, 120_000);

  const lock = await acquireSingleInstanceLock(lockPath, {
    pid: 99999,
    startedAt: 3333,
    processExists: () => false,
    getProcessStartedAt: async () => null,
  });

  assert.equal(existsSync(`${lockPath}.takeover`), false);
  lock.release();
  cleanup(dir);
  passed++;
}

// 5. Concurrent stale-lock replacement is atomic: only one caller wins.
{
  for (let i = 0; i < 20; i++) {
    const dir = tmpRoot('resource-lock-race-');
    const lockPath = join(dir, 'bridge.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
    const attempts = await Promise.allSettled([
      acquireSingleInstanceLock(lockPath, {
        pid: 10001,
        startedAt: 3333,
        processExists: (pid) => pid !== 12345,
        getProcessStartedAt: async (pid) => (pid === 10001 ? 3333 : pid === 10002 ? 4444 : null),
      }),
      acquireSingleInstanceLock(lockPath, {
        pid: 10002,
        startedAt: 4444,
        processExists: (pid) => pid !== 12345,
        getProcessStartedAt: async (pid) => (pid === 10001 ? 3333 : pid === 10002 ? 4444 : null),
      }),
    ]);

    const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, `race iteration ${i}: expected one winner`);
    assert.equal(rejected.length, 1, `race iteration ${i}: expected one loser`);
    assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /Another instance is running/);
    fulfilled[0].value.release();
    assert.equal(existsSync(`${lockPath}.takeover`), false);
    cleanup(dir);
  }
  passed++;
}

// 6. Concurrent stale-takeover cleanup is atomic: only one caller wins.
{
  for (let i = 0; i < 20; i++) {
    const dir = tmpRoot('resource-lock-takeover-race-');
    const lockPath = join(dir, 'bridge.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
    mkdirSync(`${lockPath}.takeover`, { recursive: true });
    writeFileSync(`${lockPath}.takeover/owner.json`, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
    await touchAge(`${lockPath}.takeover`, 120_000);

    const attempts = await Promise.allSettled([
      acquireSingleInstanceLock(lockPath, {
        pid: 10001,
        startedAt: 3333,
        processExists: (pid) => pid !== 12345,
        getProcessStartedAt: async (pid) => (pid === 10001 ? 3333 : pid === 10002 ? 4444 : null),
      }),
      acquireSingleInstanceLock(lockPath, {
        pid: 10002,
        startedAt: 4444,
        processExists: (pid) => pid !== 12345,
        getProcessStartedAt: async (pid) => (pid === 10001 ? 3333 : pid === 10002 ? 4444 : null),
      }),
    ]);

    const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, `takeover race iteration ${i}: expected one winner`);
    assert.equal(rejected.length, 1, `takeover race iteration ${i}: expected one loser`);
    assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /Another instance is running/);
    fulfilled[0].value.release();
    assert.equal(existsSync(`${lockPath}.takeover`), false);
    cleanup(dir);
  }
  passed++;
}

// 6a. The global lock rejects a live legacy per-app runtime during an upgrade.
{
  const dir = tmpRoot('resource-lark-lock-upgrade-');
  const appId = 'cli_upgrade_compatibility';
  const legacyPath = legacyLarkInstanceLockPath(appId, dir);
  const legacyLock = await acquireSingleInstanceLock(legacyPath);
  await assert.rejects(
    acquireLarkInstanceLock('cli_new_runtime', dir, dir),
    /Another instance is running/i,
  );
  legacyLock.release();

  const compatibleLock = await acquireLarkInstanceLock(appId, dir, dir);
  assert.equal(existsSync(legacyPath), true);
  assert.equal(existsSync(join(dir, '.instance.lock')), true);
  compatibleLock.release();
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(join(dir, '.instance.lock')), false);
  cleanup(dir);
  passed++;
}

// 6b. Shared legacy roots reserve the current app's old filename in both start orders.
{
  const stateDir = tmpRoot('resource-lark-private-state-');
  const sharedLegacyDir = tmpRoot('resource-lark-shared-legacy-');
  await chmod(sharedLegacyDir, 0o777);
  const appId = 'cli_shared_legacy_root';
  const legacyPath = legacyLarkInstanceLockPath(appId, sharedLegacyDir);
  const oldLock = await acquireSingleInstanceLock(legacyPath);
  await assert.rejects(
    acquireLarkInstanceLock(appId, stateDir, sharedLegacyDir),
    /Another instance is running/i,
  );
  oldLock.release();

  const scopedLock = await acquireLarkInstanceLock(appId, stateDir, sharedLegacyDir);
  assert.equal(existsSync(join(stateDir, '.instance.lock')), true);
  assert.equal(existsSync(legacyPath), true);
  await assert.rejects(
    acquireSingleInstanceLock(legacyPath),
    /Another instance is running/i,
  );
  scopedLock.release();
  assert.equal(existsSync(join(stateDir, '.instance.lock')), false);
  assert.equal(existsSync(legacyPath), false);
  cleanup(stateDir);
  cleanup(sharedLegacyDir);
  passed++;
}

// 6c. Shared legacy roots never follow attacker-controlled lock symlinks.
{
  const stateDir = tmpRoot('resource-lark-symlink-state-');
  const sharedLegacyDir = tmpRoot('resource-lark-symlink-legacy-');
  await chmod(sharedLegacyDir, 0o777);
  const target = join(sharedLegacyDir, 'foreign-target');
  writeFileSync(target, JSON.stringify({ pid: process.pid }), 'utf8');
  const unsafePath = legacyLarkInstanceLockPath('cli_symlink_current', sharedLegacyDir);
  symlinkSync(target, unsafePath);
  await assert.rejects(
    acquireLarkInstanceLock('cli_symlink_current', stateDir, sharedLegacyDir),
    /unsafe lock path|unexpected type or owner/i,
  );
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify({ pid: process.pid }));
  assert.equal(existsSync(join(stateDir, '.instance.lock')), false);
  cleanup(stateDir);
  cleanup(sharedLegacyDir);
  passed++;
}

// 6d. Shared lock takeover markers also reject symlinked directories and owners.
{
  const dir = tmpRoot('resource-lock-takeover-symlink-');
  const lockPath = join(dir, 'bridge.lock');
  const takeoverPath = `${lockPath}.takeover`;
  const targetDir = join(dir, 'takeover-target');
  mkdirSync(targetDir);
  writeFileSync(join(targetDir, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
  symlinkSync(targetDir, takeoverPath);
  await assert.rejects(
    acquireSingleInstanceLock(lockPath, { expectedUid: process.getuid?.() }),
    /takeover path with unexpected type or owner/i,
  );
  rmSync(takeoverPath);
  mkdirSync(takeoverPath);
  const ownerTarget = join(dir, 'owner-target.json');
  writeFileSync(ownerTarget, JSON.stringify({ pid: process.pid }), 'utf8');
  symlinkSync(ownerTarget, join(takeoverPath, 'owner.json'));
  await assert.rejects(
    acquireSingleInstanceLock(lockPath, { expectedUid: process.getuid?.() }),
    /unsafe takeover owner path/i,
  );
  assert.equal(existsSync(lockPath), false);
  cleanup(dir);
  passed++;
}

// 6e. A foreign-owned regular legacy filename is outside the current UID namespace.
{
  const stateDir = tmpRoot('resource-lark-foreign-state-');
  const sharedLegacyDir = tmpRoot('resource-lark-foreign-legacy-');
  const appId = 'cli_foreign_legacy_owner';
  const legacyPath = legacyLarkInstanceLockPath(appId, sharedLegacyDir);
  const foreignContents = JSON.stringify({ pid: process.pid });
  writeFileSync(legacyPath, foreignContents, 'utf8');
  const simulatedCurrentUid = (process.getuid?.() ?? 0) + 1;
  const scopedLock = await acquireLarkInstanceLock(
    appId,
    stateDir,
    sharedLegacyDir,
    simulatedCurrentUid,
  );
  assert.equal(existsSync(join(stateDir, '.instance.lock')), true);
  assert.equal(readFileSync(legacyPath, 'utf8'), foreignContents);
  scopedLock.release();
  assert.equal(existsSync(join(stateDir, '.instance.lock')), false);
  assert.equal(readFileSync(legacyPath, 'utf8'), foreignContents);
  cleanup(stateDir);
  cleanup(sharedLegacyDir);
  passed++;
}

// 6f. Lock and takeover permissions remain private even with a permissive umask.
{
  const previousUmask = process.umask(0);
  const dir = tmpRoot('resource-lock-umask-');
  try {
    const freshLockPath = join(dir, 'fresh-parent', 'bridge.lock');
    const freshLock = await acquireSingleInstanceLock(freshLockPath);
    assert.equal(statSync(join(dir, 'fresh-parent')).mode & 0o777, 0o700);
    assert.equal(statSync(freshLockPath).mode & 0o777, 0o600);
    freshLock.release();

    const staleParent = join(dir, 'stale-parent');
    mkdirSync(staleParent, { mode: 0o700 });
    const staleLockPath = join(staleParent, 'bridge.lock');
    writeFileSync(
      staleLockPath,
      JSON.stringify({ pid: 12345, startedAt: 1111 }),
      { mode: 0o600 },
    );
    let takeoverModes: { directory: number; owner: number } | null = null;
    const takeoverLock = await acquireSingleInstanceLock(staleLockPath, {
      pid: 54321,
      startedAt: 2222,
      processExists: () => {
        const takeoverPath = `${staleLockPath}.takeover`;
        if (existsSync(join(takeoverPath, 'owner.json'))) {
          takeoverModes = {
            directory: statSync(takeoverPath).mode & 0o777,
            owner: statSync(join(takeoverPath, 'owner.json')).mode & 0o777,
          };
        }
        return false;
      },
      getProcessStartedAt: async () => null,
    });
    assert.deepEqual(takeoverModes, { directory: 0o700, owner: 0o600 });
    assert.equal(statSync(staleLockPath).mode & 0o777, 0o600);
    takeoverLock.release();
  } finally {
    process.umask(previousUmask);
    cleanup(dir);
  }
  passed++;
}

// 7. Rotating logs keep current + configured backups and preserve new writes.
{
  const dir = tmpRoot('resource-log-');
  const logPath = join(dir, 'debug.log');
  await appendRotatingLine(logPath, 'a'.repeat(40) + '\n', { maxBytes: 60, maxFiles: 2 });
  await appendRotatingLine(logPath, 'b'.repeat(40) + '\n', { maxBytes: 60, maxFiles: 2 });
  await appendRotatingLine(logPath, 'c'.repeat(40) + '\n', { maxBytes: 60, maxFiles: 2 });

  assert.equal(readFileSync(logPath, 'utf-8'), 'c'.repeat(40) + '\n');
  assert.equal(readFileSync(`${logPath}.1`, 'utf-8'), 'b'.repeat(40) + '\n');
  assert.equal(readFileSync(`${logPath}.2`, 'utf-8'), 'a'.repeat(40) + '\n');
  cleanup(dir);
  passed++;
}

// 7a. Safe stop sends SIGTERM only to a matching live lark plugin process and removes its lock after exit.
{
  const dir = tmpRoot('resource-stop-live-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
  let alive = true;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  const result = await stopSingleInstanceLock(lockPath, {
    waitMs: 10,
    sleepMs: 0,
    processExists: () => alive,
    getProcessStartedAt: async () => 1111,
    getProcessCommand: async () => 'node --import tsx src/index.ts',
    killProcess: async (pid, signal) => {
      signals.push({ pid, signal });
      alive = false;
    },
  });

  assert.equal(result.status, 'process_terminated');
  assert.deepEqual(signals, [{ pid: 12345, signal: 'SIGTERM' }]);
  assert.equal(existsSync(lockPath), false);
  cleanup(dir);
  passed++;
}

// 7b. Safe stop refuses a live unrelated process and leaves the lock intact.
{
  const dir = tmpRoot('resource-stop-unrelated-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
  let killed = false;

  const result = await stopSingleInstanceLock(lockPath, {
    waitMs: 10,
    sleepMs: 0,
    processExists: () => true,
    getProcessStartedAt: async () => 1111,
    getProcessCommand: async () => '/usr/bin/python unrelated.py',
    killProcess: async () => {
      killed = true;
    },
  });

  assert.equal(result.status, 'unrelated_process');
  assert.equal(killed, false);
  assert.equal(existsSync(lockPath), true);
  cleanup(dir);
  passed++;
}

// 7c. Safe stop removes stale locks only after proving the PID is gone or reused.
{
  const goneDir = tmpRoot('resource-stop-stale-gone-');
  const goneLock = join(goneDir, 'bridge.lock');
  writeFileSync(goneLock, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
  const gone = await stopSingleInstanceLock(goneLock, {
    processExists: () => false,
    getProcessStartedAt: async () => null,
    getProcessCommand: async () => null,
  });
  assert.equal(gone.status, 'stale_lock_removed');
  assert.equal(existsSync(goneLock), false);
  cleanup(goneDir);

  const reusedDir = tmpRoot('resource-stop-stale-reused-');
  const reusedLock = join(reusedDir, 'bridge.lock');
  writeFileSync(reusedLock, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');
  const reused = await stopSingleInstanceLock(reusedLock, {
    processExists: () => true,
    getProcessStartedAt: async () => 2222,
    getProcessCommand: async () => '/bin/sleep 100',
  });
  assert.equal(reused.status, 'stale_lock_removed');
  assert.equal(existsSync(reusedLock), false);
  cleanup(reusedDir);
  passed++;
}

// 7d. Safe stop keeps the lock when a matching process ignores SIGTERM.
{
  const dir = tmpRoot('resource-stop-stubborn-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, startedAt: 1111 }), 'utf-8');

  const result = await stopSingleInstanceLock(lockPath, {
    waitMs: 1,
    sleepMs: 0,
    processExists: () => true,
    getProcessStartedAt: async () => 1111,
    getProcessCommand: async () => 'node --import tsx src/index.ts',
    killProcess: async () => {},
  });

  assert.equal(result.status, 'process_still_running');
  assert.equal(existsSync(lockPath), true);
  cleanup(dir);
  passed++;
}

// 7e. Safe stop refuses unparsable locks because it cannot prove ownership.
{
  const dir = tmpRoot('resource-stop-invalid-');
  const lockPath = join(dir, 'bridge.lock');
  writeFileSync(lockPath, 'not-json-not-pid', 'utf-8');

  const result = await stopSingleInstanceLock(lockPath, {
    processExists: () => false,
    getProcessStartedAt: async () => null,
    getProcessCommand: async () => null,
  });

  assert.equal(result.status, 'invalid_lock');
  assert.equal(existsSync(lockPath), true);
  cleanup(dir);
  passed++;
}

// 8. Concurrent rotating writes keep every line that fits in the retention window.
{
  const dir = tmpRoot('resource-log-concurrent-');
  const logPath = join(dir, 'audit.log');
  const lines = Array.from({ length: 80 }, (_, i) => `line-${String(i).padStart(3, '0')}`);
  await Promise.all(lines.map((line) => appendRotatingLine(logPath, `${line}\n`, { maxBytes: 80, maxFiles: 20 })));

  const retained = [logPath, ...Array.from({ length: 20 }, (_, i) => `${logPath}.${i + 1}`)]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf-8'))
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(new Set(retained), new Set(lines));
  cleanup(dir);
  passed++;
}

// 8a. Previous-month logs archive to gzip files and expired archive months are pruned.
{
  const dir = tmpRoot('resource-log-archive-');
  const logPath = join(dir, 'debug.log');
  await writeFile(logPath, 'june-active\n');
  await writeFile(`${logPath}.1`, 'june-rotated\n');
  const june = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
  await utimes(logPath, june, june);
  await utimes(`${logPath}.1`, june, june);

  const expiredArchiveDir = join(dir, 'archive', '2025-12');
  mkdirSync(expiredArchiveDir, { recursive: true });
  writeFileSync(join(expiredArchiveDir, 'debug.log.gz'), 'expired', 'utf-8');

  await appendRotatingLine(logPath, 'july-active\n', {
    maxBytes: 1024,
    maxFiles: 2,
    archiveRetentionMonths: 6,
    now: new Date(Date.UTC(2026, 6, 1, 0, 0, 0)),
  });

  assert.equal(readFileSync(logPath, 'utf-8'), 'july-active\n');
  assert.equal(gunzipSync(readFileSync(join(dir, 'archive', '2026-06', 'debug.log.gz'))).toString('utf-8'), 'june-active\n');
  assert.equal(
    gunzipSync(readFileSync(join(dir, 'archive', '2026-06', 'debug.log.1.gz'))).toString('utf-8'),
    'june-rotated\n',
  );
  assert.equal(existsSync(expiredArchiveDir), false);
  cleanup(dir);
  passed++;
}

// 9. Inbox GC removes old files first, then LRU files until under byte cap.
{
  const dir = tmpRoot('resource-inbox-');
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, 'old.bin'), Buffer.alloc(5));
  await writeFile(join(dir, 'new-a.bin'), Buffer.alloc(9));
  await writeFile(join(dir, 'new-b.bin'), Buffer.alloc(9));
  await touchAge(join(dir, 'old.bin'), 10_000);
  await touchAge(join(dir, 'new-a.bin'), 2_000);
  await touchAge(join(dir, 'new-b.bin'), 1_000);

  const result = await sweepInbox(dir, { maxAgeMs: 5_000, maxBytes: 10 });
  assert.equal(result.removedOld, 1);
  assert.equal(result.removedForSize, 1);
  assert.deepEqual(await names(dir), ['new-b.bin']);
  cleanup(dir);
  passed++;
}

// 10. Inbox GC treats invalid byte caps as disabled rather than deleting fresh files.
{
  const dir = tmpRoot('resource-inbox-nan-');
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, 'fresh-a.bin'), Buffer.alloc(5));
  await writeFile(join(dir, 'fresh-b.bin'), Buffer.alloc(5));

  const result = await sweepInbox(dir, { maxAgeMs: 60_000, maxBytes: Number.NaN });
  assert.equal(result.removedOld, 0);
  assert.equal(result.removedForSize, 0);
  assert.deepEqual(await names(dir), ['fresh-a.bin', 'fresh-b.bin']);
  cleanup(dir);
  passed++;
}

// 11. Inbox GC reports failed old-file deletions instead of counting them as removed.
{
  const dir = tmpRoot('resource-inbox-unlink-fail-');
  mkdirSync(dir, { recursive: true });
  const oldPath = join(dir, 'old.bin');
  await writeFile(oldPath, Buffer.alloc(5));
  await touchAge(oldPath, 10_000);
  await chmod(dir, 0o555);
  try {
    const result = await sweepInbox(dir, { maxAgeMs: 5_000, maxBytes: 10 });
    assert.equal(result.removedOld, 0);
    assert.equal(result.removedBytes, 0);
    assert.equal(result.keptBytes, 5);
    assert.equal(result.errors, 1);
    assert.equal(existsSync(oldPath), true);
  } finally {
    await chmod(dir, 0o755).catch(() => undefined);
    cleanup(dir);
  }
  passed++;
}

// 12. BotMessageTracker treats invalid/non-positive caps as disabled storage.
{
  const tracker = new BotMessageTracker(-1);
  tracker.add('om_bot');
  assert.equal(tracker.has('om_bot'), false);
  passed++;
}

// 13. IdentitySession enforces an LRU cap in addition to TTL cleanup.
{
  const s = new IdentitySession(() => null, 60_000, 2);
  s.setCaller('chat-a', undefined, 'ou_a');
  s.setCaller('chat-b', undefined, 'ou_b');
  s.setCaller('chat-c', undefined, 'ou_c');
  assert.equal(s._size(), 2);
  assert.equal(s.getCaller('chat-a'), null);
  assert.equal(s.getCaller('chat-b'), 'ou_b');
  assert.equal(s.getCaller('chat-c'), 'ou_c');
  passed++;
}

// 14. IdentitySession normalizes invalid caps instead of becoming unbounded.
{
  const s = new IdentitySession(() => null, Number.NaN, Number.NaN);
  for (let i = 0; i < 5001; i++) {
    s.setCaller(`chat-${i}`, undefined, `ou_${i}`);
  }
  assert.equal(s._size(), 5000);
  passed++;
}

// 15. Episode pruning keeps newest files under both count and total-byte caps.
{
  const dir = tmpRoot('resource-episodes-');
  const store = new MemoryStore(dir);
  await store.saveEpisode('chat', 'one'.repeat(40), { chatId: 'oc_resource' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.saveEpisode('chat', 'two'.repeat(40), { chatId: 'oc_resource' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.saveEpisode('chat', 'three'.repeat(20), { chatId: 'oc_resource' });

  await store.pruneEpisodes({ maxFilesPerScope: 2, maxBytesPerScope: 170 });
  const episodeDir = join(dir, 'episodes', 'oc_resource');
  const remaining = await names(episodeDir);
  assert.equal(remaining.length, 1);
  assert.equal(readFileSync(join(episodeDir, remaining[0]), 'utf-8').includes('three'), true);
  assert.ok(statSync(join(episodeDir, remaining[0])).size <= 170);
  cleanup(dir);
  passed++;
}

// 16. Episode pruning falls back to configured caps for invalid override values.
{
  const dir = tmpRoot('resource-episodes-nan-');
  const oldFiles = appConfig.maxEpisodeFilesPerScope;
  const oldBytes = appConfig.maxEpisodeScopeBytes;
  (appConfig as any).maxEpisodeFilesPerScope = 10;
  (appConfig as any).maxEpisodeScopeBytes = 10_000;
  try {
    const store = new MemoryStore(dir);
    await store.saveEpisode('chat', 'one', { chatId: 'oc_nan' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveEpisode('chat', 'two', { chatId: 'oc_nan' });
    (appConfig as any).maxEpisodeFilesPerScope = 1;
    const result = await store.pruneEpisodes({
      maxFilesPerScope: Number.NaN,
      maxBytesPerScope: Number.NaN,
    });
    assert.equal(result.removedFiles, 1);
    const episodeDir = join(dir, 'episodes', 'oc_nan');
    const remaining = await names(episodeDir);
    assert.equal(remaining.length, 1);
    assert.equal(readFileSync(join(episodeDir, remaining[0]), 'utf-8'), 'two');
  } finally {
    (appConfig as any).maxEpisodeFilesPerScope = oldFiles;
    (appConfig as any).maxEpisodeScopeBytes = oldBytes;
    cleanup(dir);
  }
  passed++;
}

// 17. LatestMessageTracker enforces TTL and true LRU cap without losing fresh route data.
{
  const tracker = new LatestMessageTracker(50, 2);
  tracker.record('chat-a', { messageId: 'm-a', timestamp: Date.now() });
  tracker.record('chat-b', { messageId: 'm-b', timestamp: Date.now() });
  assert.equal(tracker.getLatest('chat-a')?.messageId, 'm-a');
  tracker.record('chat-c', { messageId: 'm-c', timestamp: Date.now() });
  assert.equal(tracker.getLatest('chat-a')?.messageId, 'm-a');
  assert.equal(tracker.getLatest('chat-b')?.messageId, undefined);
  assert.equal(tracker.getLatest('chat-c')?.messageId, 'm-c');
  tracker.record('chat-expire', { messageId: 'm-old', timestamp: Date.now() - 1000 });
  assert.equal(tracker.getLatest('chat-expire')?.messageId, undefined);
  passed++;
}

// 18. LatestMessageTracker treats non-positive caps as disabled storage.
{
  const tracker = new LatestMessageTracker(60_000, -1);
  tracker.record('chat-disabled', { messageId: 'm-disabled', timestamp: Date.now() });
  assert.equal(tracker.getLatest('chat-disabled')?.messageId, undefined);
  passed++;
}

// 19. Reply sending auto-fills reply_to from the latest-message tracker.
{
  const calls: any[] = [];
  const client = {
    im: {
      v1: {
        message: {
          reply: async (args: any) => {
            calls.push({ method: 'reply', args });
            return { data: { message_id: 'om_bot_reply' } };
          },
          create: async (args: any) => {
            calls.push({ method: 'create', args });
            return { data: { message_id: 'om_bot_create' } };
          },
        },
      },
    },
  };
  const tracker = new LatestMessageTracker(60_000, 2);
  tracker.record('oc_auto_reply', { messageId: 'om_user_source', timestamp: Date.now() });
  tracker.record('oc_auto_reply', { messageId: 'om_thread_source', threadId: 'omt_thread_1', timestamp: Date.now() });

  const result = await sendFeishuReply(
    { client: client as any, latestMessageTracker: tracker },
    { chat_id: 'oc_auto_reply', text: 'hello' },
  );

  assert.equal(result.sentCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'reply');
  assert.equal(calls[0].args.path.message_id, 'om_user_source');

  const threadResult = await sendFeishuReply(
    { client: client as any, latestMessageTracker: tracker },
    { chat_id: 'oc_auto_reply', thread_id: 'omt_thread_1', text: 'thread hello' },
  );
  assert.equal(threadResult.sentCount, 1);
  assert.equal(calls[1].method, 'reply');
  assert.equal(calls[1].args.path.message_id, 'om_thread_source');
  passed++;
}

// 20. LarkChannel falls back to group visibility once chat-type cache entries are evicted.
{
  const oldSize = appConfig.chatTypeCacheSize;
  (appConfig as any).chatTypeCacheSize = 1;
  try {
    const channel = new LarkChannel();
    (channel as any).chatTypeCache.set('oc_private', 'p2p');
    assert.equal(channel.isPrivateChat('oc_private'), true);
    (channel as any).chatTypeCache.set('oc_group', 'group');
    assert.equal(channel.isPrivateChat('oc_private'), false);
    assert.equal(channel.isPrivateChat('oc_group'), false);
  } finally {
    (appConfig as any).chatTypeCacheSize = oldSize;
  }
  passed++;
}

// 21. BoundedCache keeps most-recently-used entries.
{
  const cache = new BoundedCache<string, string>(2);
  cache.set('a', '1');
  cache.set('b', '2');
  assert.equal(cache.get('a'), '1');
  cache.set('c', '3');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('c'), '3');
  passed++;
}

// 22. saveEpisode auto-prunes per scope and does not cross-delete chat/thread scopes.
{
  const dir = tmpRoot('resource-episodes-auto-');
  const oldFiles = appConfig.maxEpisodeFilesPerScope;
  const oldBytes = appConfig.maxEpisodeScopeBytes;
  (appConfig as any).maxEpisodeFilesPerScope = 1;
  (appConfig as any).maxEpisodeScopeBytes = 10_000;
  try {
    const store = new MemoryStore(dir);
    await store.saveEpisode('chat', 'chat-one', { chatId: 'oc_auto' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveEpisode('chat', 'chat-two', { chatId: 'oc_auto' });
    await store.saveEpisode('thread', 'thread-one', { chatId: 'oc_auto', threadId: 'omt_1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveEpisode('thread', 'thread-two', { chatId: 'oc_auto', threadId: 'omt_1' });

    const chatDir = join(dir, 'episodes', 'oc_auto');
    const threadDir = join(dir, 'episodes', 'oc_auto', 'threads', 'omt_1');
    const chatFiles = (await names(chatDir)).filter((name) => name.endsWith('.md'));
    const threadFiles = await names(threadDir);
    assert.equal(chatFiles.length, 1);
    assert.equal(threadFiles.length, 1);
    assert.equal(readFileSync(join(chatDir, chatFiles[0]), 'utf-8'), 'chat-two');
    assert.equal(readFileSync(join(threadDir, threadFiles[0]), 'utf-8'), 'thread-two');
  } finally {
    (appConfig as any).maxEpisodeFilesPerScope = oldFiles;
    (appConfig as any).maxEpisodeScopeBytes = oldBytes;
    cleanup(dir);
  }
  passed++;
}

console.log(`resource-governance smoke: ${passed}/34 PASS`);
