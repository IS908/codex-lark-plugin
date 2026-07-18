import os from 'node:os';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import {
  acquireSingleInstanceLock,
  stopSingleInstanceLock,
  type SingleInstanceLockHandle,
  type StopSingleInstanceLockResult,
} from './resource-governance.js';

// Continuation state is shared across configured Lark app identities, so the
// process lock must cover the whole plugin runtime rather than one app id.
export const LARK_INSTANCE_LOCK_PATH = path.join(
  os.homedir(),
  '.codex',
  'channels',
  'lark',
  'runtime',
  'continuations',
  '.instance.lock',
);

export async function acquireLarkInstanceLock(
  appId: string,
  stateRoot = path.dirname(LARK_INSTANCE_LOCK_PATH),
  legacyLockRoot = os.tmpdir(),
  legacyOwnerUid = process.getuid?.(),
): Promise<SingleInstanceLockHandle> {
  const globalPath = path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH));
  const paths = [
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, true, legacyOwnerUid),
    globalPath,
  ];
  const acquired: SingleInstanceLockHandle[] = [];
  const expectedUid = process.getuid?.();
  try {
    for (const lockPath of paths) {
      acquired.push(await acquireSingleInstanceLock(lockPath, { expectedUid }));
    }
  } catch (error) {
    const releaseErrors = releaseLocks(acquired);
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [error, ...releaseErrors],
        'Lark instance-lock acquisition and rollback both failed.',
      );
    }
    throw error;
  }
  return {
    path: globalPath,
    pid: process.pid,
    startedAt: acquired[0]?.startedAt ?? Math.floor(Date.now() - process.uptime() * 1000),
    release: () => {
      const errors = releaseLocks(acquired);
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to release Lark instance locks.');
    },
  };
}

export async function stopLarkInstances(
  appId: string,
  stateRoot = path.dirname(LARK_INSTANCE_LOCK_PATH),
  legacyLockRoot = os.tmpdir(),
  legacyOwnerUid = process.getuid?.(),
): Promise<StopSingleInstanceLockResult[]> {
  const results: StopSingleInstanceLockResult[] = [];
  const paths = [
    path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH)),
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, false, legacyOwnerUid),
  ];
  const expectedUid = process.getuid?.();
  for (const lockPath of paths) {
    results.push(await stopSingleInstanceLock(lockPath, { expectedUid }));
  }
  return results;
}

export function legacyLarkInstanceLockPath(appId: string, lockRoot = os.tmpdir()): string {
  return path.join(lockRoot, `codex-lark-${appId}.lock`);
}

async function compatibleLegacyLockPaths(
  appId: string,
  lockRoot: string,
  scanAll: boolean,
  currentUid: number | undefined,
): Promise<string[]> {
  const names = await readdir(lockRoot).catch(() => []);
  const candidates = names
    .filter((name) => /^codex-lark-.+\.lock$/.test(name))
    .filter((name) => scanAll || name === path.basename(legacyLarkInstanceLockPath(appId, lockRoot)));
  const ownedPaths: string[] = [];
  for (const name of candidates) {
    const candidate = path.join(lockRoot, name);
    const metadata = await lstat(candidate).catch(() => null);
    if (
      metadata?.isFile()
      && !metadata.isSymbolicLink()
      && (currentUid === undefined || metadata.uid === currentUid)
    ) {
      ownedPaths.push(candidate);
    }
  }
  const currentPath = legacyLarkInstanceLockPath(appId, lockRoot);
  const currentMetadata = await lstat(currentPath).catch(() => null);
  const foreignRegularFile = Boolean(
    currentMetadata?.isFile()
    && !currentMetadata.isSymbolicLink()
    && currentUid !== undefined
    && currentMetadata.uid !== currentUid,
  );
  // Always reserve this app's legacy filename so an old same-app runtime
  // started after us cannot bypass the private global lock. Unrelated legacy
  // locks remain UID-scoped; a foreign regular file already occupies its own
  // shared-temp namespace and also prevents an old runtime from claiming it.
  if (!foreignRegularFile) ownedPaths.push(currentPath);
  return [...new Set(ownedPaths.sort())];
}

function releaseLocks(locks: readonly SingleInstanceLockHandle[]): unknown[] {
  const errors: unknown[] = [];
  for (const lock of [...locks].reverse()) {
    try {
      lock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
