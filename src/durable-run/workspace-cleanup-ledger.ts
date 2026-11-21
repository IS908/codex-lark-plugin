import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from '../managed-workspace-ancestry.js';
import { pinWorkspacePath } from '../workspace-projects.js';
import { mkdirTemporaryInsidePinnedRoot } from '../managed-workspace-mkdir.js';

const maxSnapshotBytes = 128n * 1024n * 1024n;

export class WorkspaceCleanupLedgerError extends Error {
  constructor(readonly code: 'ledger_unavailable' | 'ledger_changed' | 'ledger_snapshot_limit') {
    super(code);
  }
}

function fail(code: WorkspaceCleanupLedgerError['code']): never {
  throw new WorkspaceCleanupLedgerError(code);
}

function fileStamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.uid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function optionalStat(filename: string) {
  return fs.lstat(filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

async function observe(databasePath: string) {
  if (!path.isAbsolute(databasePath) || path.normalize(databasePath) !== databasePath || !process.geteuid) fail('ledger_unavailable');
  const parentPath = path.dirname(databasePath);
  const parent = await pinWorkspacePath(parentPath, '.');
  if (parent.directory !== parentPath) fail('ledger_unavailable');
  await assertProtectedWorkspacePath(parent, true);
  const walPath = `${databasePath}-wal`;
  const journalPath = `${databasePath}-journal`;
  const infos = await Promise.all([databasePath, walPath, journalPath].map(optionalStat));
  const [database, wal, journal] = infos;
  // A hot rollback journal needs SQLite recovery on the original; this command never performs it.
  if (!database || journal) fail('ledger_unavailable');
  const uid = BigInt(process.geteuid());
  const files = [{ filename: databasePath, info: database }, ...(wal ? [{ filename: walPath, info: wal }] : [])];
  for (const { info } of files) {
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o022n) !== 0n || info.nlink !== 1n || `${info.dev}` !== parent.device) fail('ledger_unavailable');
  }
  if (files.reduce((total, { info }) => total + info.size, 0n) > maxSnapshotBytes) fail('ledger_snapshot_limit');
  await assertDenyOnlyWorkspaceAcls(files.map(({ filename }) => filename));
  const stamp = createHash('sha256').update(JSON.stringify([parent.device, parent.inode, ...files.map(({ info }) => fileStamp(info))])).digest('hex');
  return { files, stamp };
}

export async function verifyWorkspaceCleanupLedger(databasePath: string, expected: string): Promise<boolean> {
  try { return (await observe(databasePath)).stamp === expected; } catch { return false; }
}

async function copyObservedFile(filename: string, expected: BigIntStats, destination: string): Promise<void> {
  const input = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stamp = fileStamp(expected);
    if (fileStamp(await input.stat({ bigint: true })) !== stamp) fail('ledger_changed');
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(128 * 1024);
      for (let remaining = Number(expected.size); remaining > 0;) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(remaining, buffer.length), null);
        if (bytesRead === 0) fail('ledger_changed');
        for (let offset = 0; offset < bytesRead;) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (bytesWritten === 0) fail('ledger_unavailable');
          offset += bytesWritten;
        }
        remaining -= bytesRead;
      }
    } finally { await output.close(); }
    if (fileStamp(await input.stat({ bigint: true })) !== stamp) fail('ledger_changed');
  } finally { await input.close(); }
}

export async function readWorkspaceCleanupLedger<T>(databasePath: string, read: (database: DatabaseSync) => T,
  validateTemporaryDestination: (directory: string) => Promise<void>) {
  try {
    const { files, stamp } = await observe(databasePath);
    // SQLite reads only the private copy (including WAL), not a live connection that might create sidecars or hold a lock.
    const tempParent = await pinWorkspacePath(await fs.realpath('/tmp'), '.');
    const leaf = `lark-cleanup-preview-${randomBytes(12).toString('hex')}`;
    await validateTemporaryDestination(path.join(tempParent.directory, leaf));
    const temporary = await mkdirTemporaryInsidePinnedRoot(tempParent, leaf);
    try {
      const snapshot = path.join(temporary.directory, 'ledger.sqlite');
      for (const [index, { filename, info }] of files.entries()) {
        await copyObservedFile(filename, info, index === 0 ? snapshot : `${snapshot}-wal`);
      }
      if (!await verifyWorkspaceCleanupLedger(databasePath, stamp)) fail('ledger_changed');
      const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 0 });
      let value: T;
      try { value = read(database); } finally { database.close(); }
      if (!await verifyWorkspaceCleanupLedger(databasePath, stamp)) fail('ledger_changed');
      return { stamp, value };
    } finally {
      await assertProtectedWorkspacePath(temporary, true);
      await fs.rm(temporary.directory, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof WorkspaceCleanupLedgerError) throw error;
    return fail('ledger_unavailable');
  }
}
