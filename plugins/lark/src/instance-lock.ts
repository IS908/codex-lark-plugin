import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  acquireSingleInstanceLock,
  stopSingleInstanceLock,
  type SingleInstanceLockHandle,
  type StopSingleInstanceLockResult,
} from './resource-governance.js';

// Continuation state is shared across configured Lark app identities, so the
// process lock must cover the whole plugin runtime rather than one app id.
export const LARK_INSTANCE_LOCK_PATH = path.join(os.tmpdir(), 'codex-lark-plugin.lock');

export async function acquireLarkInstanceLock(
  appId: string,
  lockRoot = os.tmpdir(),
): Promise<SingleInstanceLockHandle> {
  const paths = await compatibleLockPaths(appId, lockRoot);
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
  const globalPath = path.join(lockRoot, path.basename(LARK_INSTANCE_LOCK_PATH));
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
  lockRoot = os.tmpdir(),
): Promise<StopSingleInstanceLockResult[]> {
  const results: StopSingleInstanceLockResult[] = [];
  const paths = [
    path.join(lockRoot, path.basename(LARK_INSTANCE_LOCK_PATH)),
    legacyLarkInstanceLockPath(appId, lockRoot),
  ];
  for (const lockPath of paths) results.push(await stopSingleInstanceLock(lockPath));
  return results;
}

export function legacyLarkInstanceLockPath(appId: string, lockRoot = os.tmpdir()): string {
  return path.join(lockRoot, `codex-lark-${appId}.lock`);
}

async function compatibleLockPaths(appId: string, lockRoot: string): Promise<string[]> {
  const globalPath = path.join(lockRoot, path.basename(LARK_INSTANCE_LOCK_PATH));
  const legacyNames = await readdir(lockRoot).catch(() => []);
  const legacyPaths = legacyNames
    .filter((name) => /^codex-lark-.+\.lock$/.test(name) && name !== path.basename(globalPath))
    .map((name) => path.join(lockRoot, name));
  legacyPaths.push(legacyLarkInstanceLockPath(appId, lockRoot));
  return [...new Set([...legacyPaths.sort(), globalPath])];
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
