import { execFile } from 'node:child_process';
import {
  appendFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const INVALID_LOCK_STALE_MS = 30_000;
const TAKEOVER_STALE_MS = 30_000;
const LOCK_ACQUIRE_ATTEMPTS = 10;

export interface SingleInstanceLockOptions {
  pid?: number;
  startedAt?: number;
  processExists?: (pid: number) => boolean | Promise<boolean>;
  getProcessStartedAt?: (pid: number) => number | null | Promise<number | null>;
}

export interface SingleInstanceLockHandle {
  path: string;
  pid: number;
  startedAt: number;
  release: () => void;
}

interface LockRecord {
  pid: number;
  startedAt?: number;
  createdAt?: string;
}

interface LockState {
  record: LockRecord | null;
  ageMs: number;
}

interface TakeoverSnapshot {
  identity: string;
  owner: LockRecord | null;
  stale: boolean;
}

function currentProcessStartedAt(): number {
  return Math.floor(Date.now() - process.uptime() * 1000);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultProcessStartedAt(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartedAt();
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const raw = String(stdout).trim();
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseLock(raw: string): LockRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startedAt = Number(parsed?.startedAt);
    return {
      pid,
      ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
      ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
    };
  } catch {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
}

function serializeLock(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function sameStartTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1000;
}

function makeHandle(lockPath: string, pid: number, startedAt: number): SingleInstanceLockHandle {
  return {
    path: lockPath,
    pid,
    startedAt,
    release: () => {
      try {
        const existing = parseLock(readFileSync(lockPath, 'utf-8'));
        if (existing?.pid === pid && existing.startedAt === startedAt) unlinkSync(lockPath);
      } catch {}
    },
  };
}

async function readLockState(lockPath: string): Promise<LockState | null> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(lockPath);
  } catch {
    return null;
  }
  const raw = await readFile(lockPath, 'utf-8').catch((err) => {
    console.error(`[resource-governance] Failed to read lock ${lockPath}:`, err?.message ?? String(err));
    return '';
  });
  return { record: parseLock(raw), ageMs: Date.now() - s.mtimeMs };
}

async function isLockStateStale(
  state: LockState | null,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<boolean> {
  if (!state) return true;
  const existing = state.record;
  if (!existing) return state.ageMs > INVALID_LOCK_STALE_MS;

  const alive = await processExists(existing.pid);
  if (!alive) return true;
  if (existing.startedAt) {
    const actualStartedAt = await getProcessStartedAt(existing.pid);
    return actualStartedAt !== null && !sameStartTime(actualStartedAt, existing.startedAt);
  }
  return false;
}

function activeLockError(state: LockState | null): Error {
  const pid = state?.record?.pid;
  return new Error(
    pid
      ? `Another instance is running (PID ${pid}).`
      : 'Another instance is running or the lock file is still initializing.',
  );
}

async function writeLockFileAtomically(lockPath: string, content: string): Promise<boolean> {
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmpPath, content, { flag: 'wx' });
    await link(tmpPath, lockPath);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    await removeIfExists(tmpPath);
  }
}

async function removePathIfExists(filePath: string): Promise<void> {
  await rm(filePath, { recursive: true, force: true }).catch(() => undefined);
}

async function readTakeoverSnapshot(
  takeoverPath: string,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<TakeoverSnapshot | null> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(takeoverPath);
  } catch {
    return null;
  }
  const ownerRaw = await readFile(join(takeoverPath, 'owner.json'), 'utf-8').catch(() => '');
  const owner = parseLock(ownerRaw);
  const identity = `${s.dev}:${s.ino}:${ownerRaw}`;
  if (!owner) return { identity, owner, stale: Date.now() - s.mtimeMs > TAKEOVER_STALE_MS };

  const alive = await processExists(owner.pid);
  if (!alive) return { identity, owner, stale: true };
  if (owner.startedAt) {
    const actualStartedAt = await getProcessStartedAt(owner.pid);
    return {
      identity,
      owner,
      stale: actualStartedAt !== null && !sameStartTime(actualStartedAt, owner.startedAt),
    };
  }
  return { identity, owner, stale: false };
}

async function isTakeoverStale(
  takeoverPath: string,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<boolean> {
  const snapshot = await readTakeoverSnapshot(takeoverPath, processExists, getProcessStartedAt);
  return snapshot?.stale ?? true;
}

async function waitForTakeoverToClear(
  takeoverPath: string,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    if (!existsSync(takeoverPath)) return;
    if (await isTakeoverStale(takeoverPath, processExists, getProcessStartedAt)) {
      if (await removeStaleTakeoverIfStillStale(takeoverPath, processExists, getProcessStartedAt)) return;
    }
    await sleep(10);
  }
  throw new Error('Could not acquire single-instance lock: stale-lock takeover is still in progress.');
}

async function claimTakeover(
  takeoverPath: string,
  record: LockRecord,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      await mkdir(takeoverPath);
      try {
        await writeFile(join(takeoverPath, 'owner.json'), serializeLock(record), { flag: 'wx' });
      } catch (err) {
        await removePathIfExists(takeoverPath);
        throw err;
      }
      return true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (await isTakeoverStale(takeoverPath, processExists, getProcessStartedAt)) {
        await removeStaleTakeoverIfStillStale(takeoverPath, processExists, getProcessStartedAt);
      } else {
        await sleep(10);
      }
    }
  }
  return false;
}

async function removeStaleTakeoverIfStillStale(
  takeoverPath: string,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
): Promise<boolean> {
  const before = await readTakeoverSnapshot(takeoverPath, processExists, getProcessStartedAt);
  if (!before) return true;
  if (!before.stale) return false;

  const cleanupPath = join(takeoverPath, '.cleanup');
  try {
    await mkdir(cleanupPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    if (err?.code === 'EEXIST') return false;
    throw err;
  }

  try {
    const after = await readTakeoverSnapshot(takeoverPath, processExists, getProcessStartedAt);
    if (!after) return true;
    if (after.identity !== before.identity) return false;
    if (after.owner && !after.stale) return false;
    await removePathIfExists(takeoverPath);
    return true;
  } finally {
    await removePathIfExists(cleanupPath);
  }
}

export async function acquireSingleInstanceLock(
  lockPath: string,
  options: SingleInstanceLockOptions = {},
): Promise<SingleInstanceLockHandle> {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? currentProcessStartedAt();
  const record: LockRecord = { pid, startedAt, createdAt: new Date().toISOString() };
  const processExists = options.processExists ?? defaultProcessExists;
  const getProcessStartedAt = options.getProcessStartedAt ?? defaultProcessStartedAt;
  const takeoverPath = `${lockPath}.takeover`;

  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    await waitForTakeoverToClear(takeoverPath, processExists, getProcessStartedAt);
    if (await writeLockFileAtomically(lockPath, serializeLock(record))) {
      return makeHandle(lockPath, pid, startedAt);
    }

    const existing = await readLockState(lockPath);
    if (!(await isLockStateStale(existing, processExists, getProcessStartedAt))) throw activeLockError(existing);

    const claimed = await claimTakeover(takeoverPath, record, processExists, getProcessStartedAt);
    if (!claimed) {
      await sleep(10);
      continue;
    }

    try {
      const current = await readLockState(lockPath);
      if (!(await isLockStateStale(current, processExists, getProcessStartedAt))) throw activeLockError(current);
      await removePathIfExists(lockPath);
      if (await writeLockFileAtomically(lockPath, serializeLock(record))) {
        return makeHandle(lockPath, pid, startedAt);
      }
    } finally {
      await removePathIfExists(takeoverPath);
    }
  }

  throw new Error('Could not acquire single-instance lock after removing a stale lock.');
}

export function registerLockCleanup(
  lock: SingleInstanceLockHandle,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'],
): void {
  const cleanup = () => lock.release();
  process.once('exit', cleanup);
  for (const signal of signals) {
    process.once(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
}

export interface RotatingLogOptions {
  maxBytes: number;
  maxFiles: number;
}

const rotatingLogQueues = new Map<string, Promise<void>>();

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {}
}

export async function appendRotatingLine(
  filePath: string,
  line: string,
  options: RotatingLogOptions,
): Promise<void> {
  const previous = rotatingLogQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => appendRotatingLineUnlocked(filePath, line, options));
  let stored: Promise<void>;
  stored = current.catch(() => undefined).finally(() => {
    if (rotatingLogQueues.get(filePath) === stored) rotatingLogQueues.delete(filePath);
  });
  rotatingLogQueues.set(filePath, stored);
  return current;
}

async function appendRotatingLineUnlocked(
  filePath: string,
  line: string,
  options: RotatingLogOptions,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const maxBytes = normalizeNonNegative(options.maxBytes);
  const maxFiles = normalizeNonNegative(options.maxFiles);
  const lineBytes = Buffer.byteLength(line, 'utf8');
  const currentSize = existsSync(filePath) ? (await stat(filePath)).size : 0;

  if (maxBytes > 0 && currentSize > 0 && currentSize + lineBytes > maxBytes) {
    if (maxFiles <= 0) {
      await removeIfExists(filePath);
    } else {
      await removeIfExists(`${filePath}.${maxFiles}`);
      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = `${filePath}.${i}`;
        if (existsSync(src)) await rename(src, `${filePath}.${i + 1}`).catch(() => undefined);
      }
      if (existsSync(filePath)) await rename(filePath, `${filePath}.1`).catch(() => undefined);
    }
  }

  await appendFile(filePath, line, 'utf8');
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export interface InboxSweepOptions {
  maxAgeMs: number;
  maxBytes: number;
}

export interface InboxSweepResult {
  removedOld: number;
  removedForSize: number;
  removedBytes: number;
  keptBytes: number;
  errors: number;
}

export async function sweepInbox(dir: string, options: InboxSweepOptions): Promise<InboxSweepResult> {
  const result: InboxSweepResult = { removedOld: 0, removedForSize: 0, removedBytes: 0, keptBytes: 0, errors: 0 };
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const maxAgeMs = normalizeNonNegative(options.maxAgeMs);
  const maxBytes = normalizeNonNegative(options.maxBytes);
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    result.errors++;
    console.error(`[resource-governance] Failed to read inbox ${dir}:`, err?.message ?? String(err));
    return [];
  });
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(dir, entry.name);
    try {
      const s = await stat(filePath);
      if (maxAgeMs > 0 && now - s.mtimeMs > maxAgeMs) {
        try {
          await unlink(filePath);
          result.removedOld++;
          result.removedBytes += s.size;
        } catch (err: any) {
          result.errors++;
          console.error(`[resource-governance] Failed to remove old inbox file ${filePath}:`, err?.message ?? String(err));
          files.push({ path: filePath, mtimeMs: s.mtimeMs, size: s.size });
        }
      } else {
        files.push({ path: filePath, mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch (err: any) {
      result.errors++;
      console.error(`[resource-governance] Failed to inspect inbox file ${filePath}:`, err?.message ?? String(err));
    }
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (maxBytes <= 0 || total <= maxBytes) break;
    try {
      await unlink(file.path);
      result.removedForSize++;
      result.removedBytes += file.size;
      total -= file.size;
    } catch (err: any) {
      result.errors++;
      console.error(`[resource-governance] Failed to remove inbox file ${file.path}:`, err?.message ?? String(err));
    }
  }
  result.keptBytes = Math.max(0, total);
  return result;
}

export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.maxSize <= 0) return this;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    return this;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }
}
