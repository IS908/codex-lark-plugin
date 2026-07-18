import os from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
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
): Promise<SingleInstanceLockHandle> {
  const globalPath = path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH));
  const paths = [
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, true),
    globalPath,
  ];
  const acquired: SingleInstanceLockHandle[] = [];
  try {
    for (const lockPath of paths) acquired.push(await acquireSingleInstanceLock(lockPath));
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
): Promise<StopSingleInstanceLockResult[]> {
  const results: StopSingleInstanceLockResult[] = [];
  const paths = [
    path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH)),
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, false),
  ];
  for (const lockPath of paths) results.push(await stopSingleInstanceLock(lockPath));
  return results;
}

export function legacyLarkInstanceLockPath(appId: string, lockRoot = os.tmpdir()): string {
  return path.join(lockRoot, `codex-lark-${appId}.lock`);
}

async function compatibleLegacyLockPaths(
  appId: string,
  lockRoot: string,
  scanAll: boolean,
): Promise<string[]> {
  const currentUid = process.getuid?.();
  const names = await readdir(lockRoot).catch(() => []);
  const candidates = names
    .filter((name) => /^codex-lark-.+\.lock$/.test(name))
    .filter((name) => scanAll || name === path.basename(legacyLarkInstanceLockPath(appId, lockRoot)));
  const ownedPaths: string[] = [];
  for (const name of candidates) {
    const candidate = path.join(lockRoot, name);
    const metadata = await stat(candidate).catch(() => null);
    if (metadata && (currentUid === undefined || metadata.uid === currentUid)) {
      ownedPaths.push(candidate);
    }
  }
  const currentPath = legacyLarkInstanceLockPath(appId, lockRoot);
  // Always reserve this app's legacy filename so an old same-app runtime
  // started after us cannot bypass the private global lock. Unrelated legacy
  // locks discovered in a shared root remain restricted to the current UID.
  ownedPaths.push(currentPath);
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
