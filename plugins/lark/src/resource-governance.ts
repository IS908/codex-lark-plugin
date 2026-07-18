import { execFile } from 'node:child_process';
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { gzip } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const INVALID_LOCK_STALE_MS = 30_000;
const TAKEOVER_STALE_MS = 30_000;
const LOCK_ACQUIRE_ATTEMPTS = 10;

export interface SingleInstanceLockOptions {
  pid?: number;
  startedAt?: number;
  expectedUid?: number;
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

export type StopSingleInstanceLockStatus =
  | 'no_lock'
  | 'invalid_lock'
  | 'stale_lock_removed'
  | 'unrelated_process'
  | 'process_terminated'
  | 'process_still_running'
  | 'permission_denied';

export interface StopSingleInstanceLockResult {
  status: StopSingleInstanceLockStatus;
  lockPath: string;
  pid?: number;
  startedAt?: number;
  command?: string | null;
  message: string;
}

export interface StopSingleInstanceLockOptions {
  waitMs?: number;
  sleepMs?: number;
  processExists?: (pid: number) => boolean | Promise<boolean>;
  getProcessStartedAt?: (pid: number) => number | null | Promise<number | null>;
  getProcessCommand?: (pid: number) => string | null | Promise<string | null>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
  isExpectedProcess?: (command: string) => boolean;
  expectedUid?: number;
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

interface OwnedFileSnapshot {
  raw: string;
  mtimeMs: number;
  dev: number | bigint;
  ino: number | bigint;
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

async function defaultProcessCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]);
    const raw = String(stdout).trim();
    return raw || null;
  } catch {
    return null;
  }
}

async function defaultKillProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  process.kill(pid, signal);
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

function sameLockOwner(a: LockRecord | null, b: LockRecord): boolean {
  if (!a) return false;
  if (a.pid !== b.pid) return false;
  if (b.startedAt !== undefined) return a.startedAt === b.startedAt;
  return true;
}

async function removeLockIfStillOwned(
  lockPath: string,
  record: LockRecord,
  expectedUid?: number,
): Promise<boolean> {
  const current = await readLockState(lockPath, expectedUid);
  if (!current || !sameLockOwner(current.record, record)) return false;
  await removePathIfExists(lockPath);
  return true;
}

export function isCodexLarkProcessCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes('codex-lark-plugin') ||
    normalized.includes('scripts/start.sh') ||
    (normalized.includes('src/index.ts') && normalized.includes('tsx'))
  );
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

async function readLockState(lockPath: string, expectedUid?: number): Promise<LockState | null> {
  const snapshot = await readOwnedRegularFile(lockPath, expectedUid, 'lock');
  if (!snapshot) return null;
  return { record: parseLock(snapshot.raw), ageMs: Date.now() - snapshot.mtimeMs };
}

async function readOwnedRegularFile(
  filePath: string,
  expectedUid: number | undefined,
  label: string,
): Promise<OwnedFileSnapshot | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Refusing unsafe ${label} path ${filePath}.`, { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (expectedUid !== undefined && metadata.uid !== expectedUid)) {
      throw new Error(`Refusing ${label} path with unexpected type or owner: ${filePath}.`);
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    return {
      raw,
      mtimeMs: metadata.mtimeMs,
      dev: metadata.dev,
      ino: metadata.ino,
    };
  } finally {
    await handle.close();
  }
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
    await writeFile(tmpPath, content, { flag: 'wx', mode: 0o600 });
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
  expectedUid?: number,
): Promise<TakeoverSnapshot | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(takeoverPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (expectedUid !== undefined && metadata.uid !== expectedUid)
  ) {
    throw new Error(`Refusing takeover path with unexpected type or owner: ${takeoverPath}.`);
  }
  const ownerSnapshot = await readOwnedRegularFile(
    join(takeoverPath, 'owner.json'),
    expectedUid,
    'takeover owner',
  );
  const ownerRaw = ownerSnapshot?.raw ?? '';
  const owner = parseLock(ownerRaw);
  const identity = `${metadata.dev}:${metadata.ino}:${ownerSnapshot?.dev ?? '-'}:${ownerSnapshot?.ino ?? '-'}:${ownerRaw}`;
  if (!owner) {
    return { identity, owner, stale: Date.now() - metadata.mtimeMs > TAKEOVER_STALE_MS };
  }

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
  expectedUid?: number,
): Promise<boolean> {
  const snapshot = await readTakeoverSnapshot(
    takeoverPath,
    processExists,
    getProcessStartedAt,
    expectedUid,
  );
  return snapshot?.stale ?? true;
}

async function waitForTakeoverToClear(
  takeoverPath: string,
  processExists: (pid: number) => boolean | Promise<boolean>,
  getProcessStartedAt: (pid: number) => number | null | Promise<number | null>,
  expectedUid?: number,
): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const snapshot = await readTakeoverSnapshot(
      takeoverPath,
      processExists,
      getProcessStartedAt,
      expectedUid,
    );
    if (!snapshot) return;
    if (snapshot.stale) {
      if (await removeStaleTakeoverIfStillStale(
        takeoverPath,
        processExists,
        getProcessStartedAt,
        expectedUid,
      )) return;
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
  expectedUid?: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      await mkdir(takeoverPath, { mode: 0o700 });
      try {
        await writeFile(join(takeoverPath, 'owner.json'), serializeLock(record), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (err) {
        await removePathIfExists(takeoverPath);
        throw err;
      }
      return true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (await isTakeoverStale(takeoverPath, processExists, getProcessStartedAt, expectedUid)) {
        await removeStaleTakeoverIfStillStale(
          takeoverPath,
          processExists,
          getProcessStartedAt,
          expectedUid,
        );
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
  expectedUid?: number,
): Promise<boolean> {
  const before = await readTakeoverSnapshot(
    takeoverPath,
    processExists,
    getProcessStartedAt,
    expectedUid,
  );
  if (!before) return true;
  if (!before.stale) return false;

  const cleanupPath = join(takeoverPath, '.cleanup');
  try {
    await mkdir(cleanupPath, { mode: 0o700 });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    if (err?.code === 'EEXIST') return false;
    throw err;
  }

  try {
    const after = await readTakeoverSnapshot(
      takeoverPath,
      processExists,
      getProcessStartedAt,
      expectedUid,
    );
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
  const expectedUid = options.expectedUid;
  const takeoverPath = `${lockPath}.takeover`;

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    await waitForTakeoverToClear(takeoverPath, processExists, getProcessStartedAt, expectedUid);
    if (await writeLockFileAtomically(lockPath, serializeLock(record))) {
      return makeHandle(lockPath, pid, startedAt);
    }

    const existing = await readLockState(lockPath, expectedUid);
    if (!(await isLockStateStale(existing, processExists, getProcessStartedAt))) throw activeLockError(existing);

    const claimed = await claimTakeover(
      takeoverPath,
      record,
      processExists,
      getProcessStartedAt,
      expectedUid,
    );
    if (!claimed) {
      await sleep(10);
      continue;
    }

    try {
      const current = await readLockState(lockPath, expectedUid);
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

export async function stopSingleInstanceLock(
  lockPath: string,
  options: StopSingleInstanceLockOptions = {},
): Promise<StopSingleInstanceLockResult> {
  const processExists = options.processExists ?? defaultProcessExists;
  const getProcessStartedAt = options.getProcessStartedAt ?? defaultProcessStartedAt;
  const getProcessCommand = options.getProcessCommand ?? defaultProcessCommand;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const isExpectedProcess = options.isExpectedProcess ?? isCodexLarkProcessCommand;
  const expectedUid = options.expectedUid;
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 5_000));
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 100));

  const state = await readLockState(lockPath, expectedUid);
  if (!state) {
    return {
      status: 'no_lock',
      lockPath,
      message: `No codex-lark-plugin lock found at ${lockPath}.`,
    };
  }

  const record = state.record;
  if (!record) {
    return {
      status: 'invalid_lock',
      lockPath,
      message: `Refusing to stop: lock file ${lockPath} does not contain a valid PID.`,
    };
  }

  const base = {
    lockPath,
    pid: record.pid,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
  };

  const alive = await processExists(record.pid);
  if (!alive) {
    const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
    return {
      ...base,
      status: 'stale_lock_removed',
      message: removed
        ? `Removed stale codex-lark-plugin lock for non-running PID ${record.pid}.`
        : `Stale lock for PID ${record.pid} changed before cleanup; left it untouched.`,
    };
  }

  if (record.startedAt) {
    const actualStartedAt = await getProcessStartedAt(record.pid);
    if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        status: 'stale_lock_removed',
        message: removed
          ? `Removed stale codex-lark-plugin lock for reused PID ${record.pid}.`
          : `Stale lock for reused PID ${record.pid} changed before cleanup; left it untouched.`,
      };
    }
  }

  const command = await getProcessCommand(record.pid);
  if (!command || !isExpectedProcess(command)) {
    return {
      ...base,
      command,
      status: 'unrelated_process',
      message:
        `Refusing to stop PID ${record.pid}: it does not look like codex-lark-plugin. ` +
        `Command: ${command ?? '<unknown>'}. Lock left intact.`,
    };
  }

  try {
    await killProcess(record.pid, 'SIGTERM');
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        command,
        status: 'stale_lock_removed',
        message: removed
          ? `Removed stale codex-lark-plugin lock after PID ${record.pid} disappeared.`
          : `PID ${record.pid} disappeared, but the lock changed before cleanup; left it untouched.`,
      };
    }
    if (err?.code === 'EPERM') {
      return {
        ...base,
        command,
        status: 'permission_denied',
        message: `Permission denied while sending SIGTERM to PID ${record.pid}. Lock left intact.`,
      };
    }
    throw err;
  }

  const deadline = Date.now() + waitMs;
  do {
    if (!(await processExists(record.pid))) {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        command,
        status: 'process_terminated',
        message: removed
          ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock.`
          : `Stopped PID ${record.pid}, but the lock changed before cleanup; left it untouched.`,
      };
    }

    if (record.startedAt) {
      const actualStartedAt = await getProcessStartedAt(record.pid);
      if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
        const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
        return {
          ...base,
          command,
          status: 'process_terminated',
          message: removed
            ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock after PID reuse check.`
            : `PID ${record.pid} changed, but the lock changed before cleanup; left it untouched.`,
        };
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(sleepMs);
  } while (true);

  return {
    ...base,
    command,
    status: 'process_still_running',
    message: `PID ${record.pid} still appears to be running after SIGTERM. Lock left intact.`,
  };
}

export function registerLockCleanup(
  lock: SingleInstanceLockHandle,
  signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'],
  beforeExit?: () => Promise<void>,
): void {
  const cleanup = () => lock.release();
  process.once('exit', cleanup);
  for (const signal of signals) {
    process.once(signal, () => {
      if (!beforeExit) {
        cleanup();
        process.exit(0);
      }
      void Promise.resolve()
        .then(beforeExit)
        .catch(() => undefined)
        .finally(() => {
          cleanup();
          process.exit(0);
        });
    });
  }
}

export interface RotatingLogOptions {
  maxBytes: number;
  maxFiles: number;
  archiveRetentionMonths?: number;
  now?: Date;
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
  await archivePreviousMonthLogFiles(filePath, options);
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

async function archivePreviousMonthLogFiles(filePath: string, options: RotatingLogOptions): Promise<void> {
  const retentionMonths = normalizeNonNegative(options.archiveRetentionMonths ?? 0);
  if (retentionMonths <= 0) return;

  const logDir = dirname(filePath);
  const baseName = basename(filePath);
  const now = options.now ?? new Date();
  const currentMonth = monthIndex(now);
  const entries = await readdir(logDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile() || !isLogFileForBase(entry.name, baseName)) continue;
    const candidate = join(logDir, entry.name);
    try {
      const s = await stat(candidate);
      const fileMonth = monthIndex(s.mtime);
      if (fileMonth >= currentMonth) continue;
      await gzipArchiveAndRemove(candidate, join(logDir, 'archive', monthKey(s.mtime)), entry.name);
    } catch (err: any) {
      console.error(`[resource-governance] Failed to archive old log ${candidate}:`, err?.message ?? String(err));
    }
  }

  await pruneLogArchiveMonths(join(logDir, 'archive'), retentionMonths, now);
}

function isLogFileForBase(name: string, baseName: string): boolean {
  if (name === baseName) return true;
  if (!name.startsWith(`${baseName}.`)) return false;
  const suffix = name.slice(baseName.length + 1);
  return /^\d+$/.test(suffix);
}

async function gzipArchiveAndRemove(filePath: string, archiveDir: string, sourceName: string): Promise<void> {
  const contents = await readFile(filePath);
  if (contents.length === 0) {
    await unlink(filePath).catch(() => undefined);
    return;
  }
  await mkdir(archiveDir, { recursive: true });
  const archivePath = uniqueArchivePath(archiveDir, `${sourceName}.gz`);
  await writeFile(archivePath, await gzipAsync(contents));
  await unlink(filePath);
}

function uniqueArchivePath(archiveDir: string, fileName: string): string {
  let candidate = join(archiveDir, fileName);
  let attempt = 1;
  while (existsSync(candidate)) {
    candidate = join(archiveDir, `${fileName}.${attempt}`);
    attempt++;
  }
  return candidate;
}

async function pruneLogArchiveMonths(archiveRoot: string, retentionMonths: number, now: Date): Promise<void> {
  if (!existsSync(archiveRoot)) return;
  const cutoff = monthIndex(now) - retentionMonths;
  const entries = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const index = parseMonthKey(entry.name);
    if (index === null || index >= cutoff) continue;
    await rm(join(archiveRoot, entry.name), { recursive: true, force: true }).catch((err: any) => {
      console.error(`[resource-governance] Failed to prune log archive ${entry.name}:`, err?.message ?? String(err));
    });
  }
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function parseMonthKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
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
