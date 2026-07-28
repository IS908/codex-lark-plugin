import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);

// src/resource-governance.ts
import { execFile as execFile2 } from "node:child_process";
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
  writeFile
} from "node:fs/promises";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  futimesSync,
  openSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { gzip } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { promisify as promisify2 } from "node:util";

// src/process-identity.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var PROCESS_START_TOLERANCE_MS = 1e3;
var CURRENT_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1e3);
function currentProcessStartedAt() {
  return CURRENT_PROCESS_STARTED_AT;
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function getProcessStartedAt(pid) {
  if (pid === process.pid) return CURRENT_PROCESS_STARTED_AT;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const raw = String(stdout).trim();
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function isSameProcessStart(a, b) {
  return Math.abs(a - b) <= PROCESS_START_TOLERANCE_MS;
}
function isRecordedProcessInstanceActive(processAlive, recordedStartedAt, actualStartedAt, stateAgeMs, unknownIdentityGraceMs) {
  if (!processAlive) return false;
  if (actualStartedAt === null) return stateAgeMs < unknownIdentityGraceMs;
  return isSameProcessStart(actualStartedAt, recordedStartedAt);
}
async function isProcessInstanceAlive(pid, startedAt, stateAgeMs, unknownIdentityGraceMs) {
  const processAlive = isProcessAlive(pid);
  if (!processAlive) return false;
  const actualStartedAt = await getProcessStartedAt(pid);
  return isRecordedProcessInstanceActive(
    processAlive,
    startedAt,
    actualStartedAt,
    stateAgeMs,
    unknownIdentityGraceMs
  );
}

// src/resource-governance.ts
var execFileAsync2 = promisify2(execFile2);
var gzipAsync = promisify2(gzip);
var INVALID_LOCK_STALE_MS = 3e4;
var TAKEOVER_STALE_MS = 3e4;
var LOCK_ACQUIRE_ATTEMPTS = 10;
var LOCK_HEARTBEAT_INTERVAL_MS = 1e4;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function defaultProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync2("ps", ["-o", "command=", "-p", String(pid)]);
    const raw = String(stdout).trim();
    return raw || null;
  } catch {
    return null;
  }
}
async function defaultKillProcess(pid, signal) {
  process.kill(pid, signal);
}
function parseLock(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startedAt = Number(parsed?.startedAt);
    return {
      pid,
      ...Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {},
      ...typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}
    };
  } catch {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
}
function serializeLock(record) {
  return `${JSON.stringify(record)}
`;
}
function sameLockOwner(a, b) {
  if (!a) return false;
  if (a.pid !== b.pid) return false;
  if (b.startedAt !== void 0) return a.startedAt === b.startedAt;
  return true;
}
async function removeLockIfStillOwned(lockPath, record, expectedUid) {
  const current = await readLockState(lockPath, expectedUid);
  if (!current || !sameLockOwner(current.record, record)) return false;
  await removePathIfExists(lockPath);
  return true;
}
function isCodexLarkProcessCommand(command) {
  const normalized = command.toLowerCase();
  const tokens = Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
    (match) => match[1] ?? match[2] ?? match[3]
  );
  const executable = tokens[0] ? basename(tokens[0].replaceAll("\\", "/")).toLowerCase() : "";
  const entrypoint = tokens[1]?.replaceAll("\\", "/").toLowerCase();
  const isPackagedRuntime = (executable === "node" || executable === "node.exe") && entrypoint === "runtime/index.js";
  return isPackagedRuntime || normalized.includes("codex-lark-plugin") || normalized.includes("scripts/start.sh") || normalized.includes("src/index.ts") && normalized.includes("tsx");
}
function refreshLockHeartbeat(lockPath, record, expectedUid) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || expectedUid !== void 0 && metadata.uid !== expectedUid) return;
    if (!sameLockOwner(parseLock(readFileSync(fd, "utf8")), record)) return;
    const now = /* @__PURE__ */ new Date();
    futimesSync(fd, now, now);
  } catch {
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function makeHandle(lockPath, pid, startedAt, heartbeatIntervalMs, expectedUid) {
  const record = { pid, startedAt };
  const heartbeat = setInterval(
    () => refreshLockHeartbeat(lockPath, record, expectedUid),
    heartbeatIntervalMs
  );
  heartbeat.unref();
  let released = false;
  return {
    path: lockPath,
    pid,
    startedAt,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        const existing = parseLock(readFileSync(lockPath, "utf-8"));
        if (existing?.pid === pid && existing.startedAt === startedAt) unlinkSync(lockPath);
      } catch {
      }
    }
  };
}
async function readLockState(lockPath, expectedUid) {
  const snapshot = await readOwnedRegularFile(lockPath, expectedUid, "lock");
  if (!snapshot) return null;
  return { record: parseLock(snapshot.raw), ageMs: Date.now() - snapshot.mtimeMs };
}
async function readOwnedRegularFile(filePath, expectedUid, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Refusing unsafe ${label} path ${filePath}.`, { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || expectedUid !== void 0 && metadata.uid !== expectedUid) {
      throw new Error(`Refusing ${label} path with unexpected type or owner: ${filePath}.`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return {
      raw,
      mtimeMs: metadata.mtimeMs,
      dev: metadata.dev,
      ino: metadata.ino
    };
  } finally {
    await handle.close();
  }
}
async function isLockStateStale(state, processExists, getProcessStartedAt2) {
  if (!state) return true;
  const existing = state.record;
  if (!existing) return state.ageMs > INVALID_LOCK_STALE_MS;
  const alive = await processExists(existing.pid);
  if (!alive) return true;
  if (existing.startedAt) {
    const actualStartedAt = await getProcessStartedAt2(existing.pid);
    return !isRecordedProcessInstanceActive(
      alive,
      existing.startedAt,
      actualStartedAt,
      state.ageMs,
      INVALID_LOCK_STALE_MS
    );
  }
  return false;
}
function activeLockError(state) {
  const pid = state?.record?.pid;
  return new Error(
    pid ? `Another instance is running (PID ${pid}).` : "Another instance is running or the lock file is still initializing."
  );
}
async function writeLockFileAtomically(lockPath, content) {
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmpPath, content, { flag: "wx", mode: 384 });
    await link(tmpPath, lockPath);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    await removeIfExists(tmpPath);
  }
}
async function removePathIfExists(filePath) {
  await rm(filePath, { recursive: true, force: true }).catch(() => void 0);
}
async function readTakeoverSnapshot(takeoverPath, processExists, getProcessStartedAt2, expectedUid) {
  let metadata;
  try {
    metadata = await lstat(takeoverPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || expectedUid !== void 0 && metadata.uid !== expectedUid) {
    throw new Error(`Refusing takeover path with unexpected type or owner: ${takeoverPath}.`);
  }
  const ownerSnapshot = await readOwnedRegularFile(
    join(takeoverPath, "owner.json"),
    expectedUid,
    "takeover owner"
  );
  const ownerRaw = ownerSnapshot?.raw ?? "";
  const owner = parseLock(ownerRaw);
  const identity = `${metadata.dev}:${metadata.ino}:${ownerSnapshot?.dev ?? "-"}:${ownerSnapshot?.ino ?? "-"}:${ownerRaw}`;
  if (!owner) {
    return { identity, owner, stale: Date.now() - metadata.mtimeMs > TAKEOVER_STALE_MS };
  }
  const alive = await processExists(owner.pid);
  if (!alive) return { identity, owner, stale: true };
  if (owner.startedAt) {
    const actualStartedAt = await getProcessStartedAt2(owner.pid);
    return {
      identity,
      owner,
      stale: !isRecordedProcessInstanceActive(
        alive,
        owner.startedAt,
        actualStartedAt,
        Date.now() - (ownerSnapshot?.mtimeMs ?? metadata.mtimeMs),
        TAKEOVER_STALE_MS
      )
    };
  }
  return { identity, owner, stale: false };
}
async function isTakeoverStale(takeoverPath, processExists, getProcessStartedAt2, expectedUid) {
  const snapshot = await readTakeoverSnapshot(
    takeoverPath,
    processExists,
    getProcessStartedAt2,
    expectedUid
  );
  return snapshot?.stale ?? true;
}
async function waitForTakeoverToClear(takeoverPath, processExists, getProcessStartedAt2, expectedUid) {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const snapshot = await readTakeoverSnapshot(
      takeoverPath,
      processExists,
      getProcessStartedAt2,
      expectedUid
    );
    if (!snapshot) return;
    if (snapshot.stale) {
      if (await removeStaleTakeoverIfStillStale(
        takeoverPath,
        processExists,
        getProcessStartedAt2,
        expectedUid
      )) return;
    }
    await sleep(10);
  }
  throw new Error("Could not acquire single-instance lock: stale-lock takeover is still in progress.");
}
async function claimTakeover(takeoverPath, record, processExists, getProcessStartedAt2, expectedUid) {
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      await mkdir(takeoverPath, { mode: 448 });
      try {
        await writeFile(join(takeoverPath, "owner.json"), serializeLock(record), {
          flag: "wx",
          mode: 384
        });
      } catch (err) {
        await removePathIfExists(takeoverPath);
        throw err;
      }
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (await isTakeoverStale(takeoverPath, processExists, getProcessStartedAt2, expectedUid)) {
        await removeStaleTakeoverIfStillStale(
          takeoverPath,
          processExists,
          getProcessStartedAt2,
          expectedUid
        );
      } else {
        await sleep(10);
      }
    }
  }
  return false;
}
async function removeStaleTakeoverIfStillStale(takeoverPath, processExists, getProcessStartedAt2, expectedUid) {
  const before = await readTakeoverSnapshot(
    takeoverPath,
    processExists,
    getProcessStartedAt2,
    expectedUid
  );
  if (!before) return true;
  if (!before.stale) return false;
  const cleanupPath = join(takeoverPath, ".cleanup");
  try {
    await mkdir(cleanupPath, { mode: 448 });
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    if (err?.code === "EEXIST") return false;
    throw err;
  }
  try {
    const after = await readTakeoverSnapshot(
      takeoverPath,
      processExists,
      getProcessStartedAt2,
      expectedUid
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
async function acquireSingleInstanceLock(lockPath, options = {}) {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? currentProcessStartedAt();
  const record = { pid, startedAt, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  const processExists = options.processExists ?? isProcessAlive;
  const resolveProcessStartedAt = options.getProcessStartedAt ?? getProcessStartedAt;
  const expectedUid = options.expectedUid;
  const heartbeatIntervalMs = Math.min(
    LOCK_HEARTBEAT_INTERVAL_MS,
    Math.max(1, Math.floor(options.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS))
  );
  const takeoverPath = `${lockPath}.takeover`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    await waitForTakeoverToClear(takeoverPath, processExists, resolveProcessStartedAt, expectedUid);
    if (await writeLockFileAtomically(lockPath, serializeLock(record))) {
      return makeHandle(lockPath, pid, startedAt, heartbeatIntervalMs, expectedUid);
    }
    const existing = await readLockState(lockPath, expectedUid);
    if (!await isLockStateStale(existing, processExists, resolveProcessStartedAt)) throw activeLockError(existing);
    const claimed = await claimTakeover(
      takeoverPath,
      record,
      processExists,
      resolveProcessStartedAt,
      expectedUid
    );
    if (!claimed) {
      await sleep(10);
      continue;
    }
    try {
      const current = await readLockState(lockPath, expectedUid);
      if (!await isLockStateStale(current, processExists, resolveProcessStartedAt)) throw activeLockError(current);
      await removePathIfExists(lockPath);
      if (await writeLockFileAtomically(lockPath, serializeLock(record))) {
        return makeHandle(lockPath, pid, startedAt, heartbeatIntervalMs, expectedUid);
      }
    } finally {
      await removePathIfExists(takeoverPath);
    }
  }
  throw new Error("Could not acquire single-instance lock after removing a stale lock.");
}
async function stopSingleInstanceLock(lockPath, options = {}) {
  const processExists = options.processExists ?? isProcessAlive;
  const resolveProcessStartedAt = options.getProcessStartedAt ?? getProcessStartedAt;
  const getProcessCommand = options.getProcessCommand ?? defaultProcessCommand;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const isExpectedProcess = options.isExpectedProcess ?? isCodexLarkProcessCommand;
  const expectedUid = options.expectedUid;
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 5e3));
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 100));
  const state = await readLockState(lockPath, expectedUid);
  if (!state) {
    return {
      status: "no_lock",
      lockPath,
      message: `No codex-lark-plugin lock found at ${lockPath}.`
    };
  }
  const record = state.record;
  if (!record) {
    return {
      status: "invalid_lock",
      lockPath,
      message: `Refusing to stop: lock file ${lockPath} does not contain a valid PID.`
    };
  }
  const base = {
    lockPath,
    pid: record.pid,
    ...record.startedAt ? { startedAt: record.startedAt } : {}
  };
  const alive = await processExists(record.pid);
  if (!alive) {
    const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
    return {
      ...base,
      status: "stale_lock_removed",
      message: removed ? `Removed stale codex-lark-plugin lock for non-running PID ${record.pid}.` : `Stale lock for PID ${record.pid} changed before cleanup; left it untouched.`
    };
  }
  if (record.startedAt) {
    const actualStartedAt = await resolveProcessStartedAt(record.pid);
    if (actualStartedAt !== null && !isSameProcessStart(actualStartedAt, record.startedAt)) {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        status: "stale_lock_removed",
        message: removed ? `Removed stale codex-lark-plugin lock for reused PID ${record.pid}.` : `Stale lock for reused PID ${record.pid} changed before cleanup; left it untouched.`
      };
    }
  }
  const command = await getProcessCommand(record.pid);
  if (!command || !isExpectedProcess(command)) {
    return {
      ...base,
      command,
      status: "unrelated_process",
      message: `Refusing to stop PID ${record.pid}: it does not look like codex-lark-plugin. Command: ${command ?? "<unknown>"}. Lock left intact.`
    };
  }
  try {
    await killProcess(record.pid, "SIGTERM");
  } catch (err) {
    if (err?.code === "ESRCH") {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        command,
        status: "stale_lock_removed",
        message: removed ? `Removed stale codex-lark-plugin lock after PID ${record.pid} disappeared.` : `PID ${record.pid} disappeared, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (err?.code === "EPERM") {
      return {
        ...base,
        command,
        status: "permission_denied",
        message: `Permission denied while sending SIGTERM to PID ${record.pid}. Lock left intact.`
      };
    }
    throw err;
  }
  const deadline = Date.now() + waitMs;
  do {
    if (!await processExists(record.pid)) {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        command,
        status: "process_terminated",
        message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock.` : `Stopped PID ${record.pid}, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (record.startedAt) {
      const actualStartedAt = await resolveProcessStartedAt(record.pid);
      if (actualStartedAt !== null && !isSameProcessStart(actualStartedAt, record.startedAt)) {
        const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
        return {
          ...base,
          command,
          status: "process_terminated",
          message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock after PID reuse check.` : `PID ${record.pid} changed, but the lock changed before cleanup; left it untouched.`
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(sleepMs);
  } while (true);
  return {
    ...base,
    command,
    status: "process_still_running",
    message: `PID ${record.pid} still appears to be running after SIGTERM. Lock left intact.`
  };
}
function registerLockCleanup(lock, signals = ["SIGINT", "SIGTERM", "SIGHUP"], beforeExit) {
  const cleanup = () => lock.release();
  process.once("exit", cleanup);
  for (const signal of signals) {
    process.once(signal, () => {
      if (!beforeExit) {
        cleanup();
        process.exit(0);
      }
      void Promise.resolve().then(beforeExit).catch(() => void 0).finally(() => {
        cleanup();
        process.exit(0);
      });
    });
  }
}
var rotatingLogQueues = /* @__PURE__ */ new Map();
async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch {
  }
}
async function appendRotatingLine(filePath, line, options) {
  const previous = rotatingLogQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => void 0).then(() => appendRotatingLineUnlocked(filePath, line, options));
  let stored;
  stored = current.catch(() => void 0).finally(() => {
    if (rotatingLogQueues.get(filePath) === stored) rotatingLogQueues.delete(filePath);
  });
  rotatingLogQueues.set(filePath, stored);
  return current;
}
async function appendRotatingLineUnlocked(filePath, line, options) {
  await mkdir(dirname(filePath), { recursive: true });
  await archivePreviousMonthLogFiles(filePath, options);
  const maxBytes = normalizeNonNegative(options.maxBytes);
  const maxFiles = normalizeNonNegative(options.maxFiles);
  const lineBytes = Buffer.byteLength(line, "utf8");
  const currentSize = existsSync(filePath) ? (await stat(filePath)).size : 0;
  if (maxBytes > 0 && currentSize > 0 && currentSize + lineBytes > maxBytes) {
    if (maxFiles <= 0) {
      await removeIfExists(filePath);
    } else {
      await removeIfExists(`${filePath}.${maxFiles}`);
      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = `${filePath}.${i}`;
        if (existsSync(src)) await rename(src, `${filePath}.${i + 1}`).catch(() => void 0);
      }
      if (existsSync(filePath)) await rename(filePath, `${filePath}.1`).catch(() => void 0);
    }
  }
  await appendFile(filePath, line, "utf8");
}
async function archivePreviousMonthLogFiles(filePath, options) {
  const retentionMonths = normalizeNonNegative(options.archiveRetentionMonths ?? 0);
  if (retentionMonths <= 0) return;
  const logDir = dirname(filePath);
  const baseName = basename(filePath);
  const now = options.now ?? /* @__PURE__ */ new Date();
  const currentMonth = monthIndex(now);
  const entries = await readdir(logDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !isLogFileForBase(entry.name, baseName)) continue;
    const candidate = join(logDir, entry.name);
    try {
      const s = await stat(candidate);
      const fileMonth = monthIndex(s.mtime);
      if (fileMonth >= currentMonth) continue;
      await gzipArchiveAndRemove(candidate, join(logDir, "archive", monthKey(s.mtime)), entry.name);
    } catch (err) {
      console.error(`[resource-governance] Failed to archive old log ${candidate}:`, err?.message ?? String(err));
    }
  }
  await pruneLogArchiveMonths(join(logDir, "archive"), retentionMonths, now);
}
function isLogFileForBase(name, baseName) {
  if (name === baseName) return true;
  if (!name.startsWith(`${baseName}.`)) return false;
  const suffix = name.slice(baseName.length + 1);
  return /^\d+$/.test(suffix);
}
async function gzipArchiveAndRemove(filePath, archiveDir, sourceName) {
  const contents = await readFile(filePath);
  if (contents.length === 0) {
    await unlink(filePath).catch(() => void 0);
    return;
  }
  await mkdir(archiveDir, { recursive: true });
  const archivePath = uniqueArchivePath(archiveDir, `${sourceName}.gz`);
  await writeFile(archivePath, await gzipAsync(contents));
  await unlink(filePath);
}
function uniqueArchivePath(archiveDir, fileName) {
  let candidate = join(archiveDir, fileName);
  let attempt = 1;
  while (existsSync(candidate)) {
    candidate = join(archiveDir, `${fileName}.${attempt}`);
    attempt++;
  }
  return candidate;
}
async function pruneLogArchiveMonths(archiveRoot, retentionMonths, now) {
  if (!existsSync(archiveRoot)) return;
  const cutoff = monthIndex(now) - retentionMonths;
  const entries = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const index = parseMonthKey(entry.name);
    if (index === null || index >= cutoff) continue;
    await rm(join(archiveRoot, entry.name), { recursive: true, force: true }).catch((err) => {
      console.error(`[resource-governance] Failed to prune log archive ${entry.name}:`, err?.message ?? String(err));
    });
  }
}
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthIndex(date) {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}
function parseMonthKey(key) {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}
function normalizeNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
async function sweepInbox(dir, options) {
  const result = { removedOld: 0, removedForSize: 0, removedBytes: 0, keptBytes: 0, errors: 0 };
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const maxAgeMs = normalizeNonNegative(options.maxAgeMs);
  const maxBytes = normalizeNonNegative(options.maxBytes);
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    result.errors++;
    console.error(`[resource-governance] Failed to read inbox ${dir}:`, err?.message ?? String(err));
    return [];
  });
  const files = [];
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
        } catch (err) {
          result.errors++;
          console.error(`[resource-governance] Failed to remove old inbox file ${filePath}:`, err?.message ?? String(err));
          files.push({ path: filePath, mtimeMs: s.mtimeMs, size: s.size });
        }
      } else {
        files.push({ path: filePath, mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch (err) {
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
    } catch (err) {
      result.errors++;
      console.error(`[resource-governance] Failed to remove inbox file ${file.path}:`, err?.message ?? String(err));
    }
  }
  result.keptBytes = Math.max(0, total);
  return result;
}
var BoundedCache = class {
  map = /* @__PURE__ */ new Map();
  maxSize;
  constructor(maxSize) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }
  get size() {
    return this.map.size;
  }
  get(key) {
    if (!this.map.has(key)) return void 0;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.maxSize <= 0) return this;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }
  has(key) {
    return this.map.has(key);
  }
  delete(key) {
    return this.map.delete(key);
  }
};

// src/instance-lock.ts
import os from "node:os";
import path from "node:path";
import { lstat as lstat2, readdir as readdir2 } from "node:fs/promises";
var LARK_INSTANCE_LOCK_PATH = path.join(
  os.homedir(),
  ".codex",
  "channels",
  "lark",
  "runtime",
  "continuations",
  ".instance.lock"
);
async function acquireLarkInstanceLock(appId, stateRoot = path.dirname(LARK_INSTANCE_LOCK_PATH), legacyLockRoot = os.tmpdir(), legacyOwnerUid = process.getuid?.()) {
  const globalPath = path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH));
  const paths = [
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, true, legacyOwnerUid),
    globalPath
  ];
  const acquired = [];
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
        "Lark instance-lock acquisition and rollback both failed."
      );
    }
    throw error;
  }
  return {
    path: globalPath,
    pid: process.pid,
    startedAt: acquired[0]?.startedAt ?? Math.floor(Date.now() - process.uptime() * 1e3),
    release: () => {
      const errors = releaseLocks(acquired);
      if (errors.length > 0) throw new AggregateError(errors, "Failed to release Lark instance locks.");
    }
  };
}
async function stopLarkInstances(appId, stateRoot = path.dirname(LARK_INSTANCE_LOCK_PATH), legacyLockRoot = os.tmpdir(), legacyOwnerUid = process.getuid?.()) {
  const results = [];
  const paths = [
    path.join(stateRoot, path.basename(LARK_INSTANCE_LOCK_PATH)),
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, false, legacyOwnerUid)
  ];
  const expectedUid = process.getuid?.();
  for (const lockPath of paths) {
    results.push(await stopSingleInstanceLock(lockPath, { expectedUid }));
  }
  return results;
}
function legacyLarkInstanceLockPath(appId, lockRoot = os.tmpdir()) {
  return path.join(lockRoot, `codex-lark-${appId}.lock`);
}
async function compatibleLegacyLockPaths(appId, lockRoot, scanAll, currentUid) {
  const names = await readdir2(lockRoot).catch(() => []);
  const candidates = names.filter((name) => /^codex-lark-.+\.lock$/.test(name)).filter((name) => scanAll || name === path.basename(legacyLarkInstanceLockPath(appId, lockRoot)));
  const ownedPaths = [];
  for (const name of candidates) {
    const candidate = path.join(lockRoot, name);
    const metadata = await lstat2(candidate).catch(() => null);
    if (metadata?.isFile() && !metadata.isSymbolicLink() && (currentUid === void 0 || metadata.uid === currentUid)) {
      ownedPaths.push(candidate);
    }
  }
  const currentPath = legacyLarkInstanceLockPath(appId, lockRoot);
  const currentMetadata = await lstat2(currentPath).catch(() => null);
  const foreignOccupiedPath = Boolean(
    currentMetadata && currentUid !== void 0 && currentMetadata.uid !== currentUid
  );
  if (!foreignOccupiedPath) ownedPaths.push(currentPath);
  return [...new Set(ownedPaths.sort())];
}
function releaseLocks(locks) {
  const errors = [];
  for (const lock of [...locks].reverse()) {
    try {
      lock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export {
  currentProcessStartedAt,
  isProcessAlive,
  isProcessInstanceAlive,
  registerLockCleanup,
  appendRotatingLine,
  sweepInbox,
  BoundedCache,
  acquireLarkInstanceLock,
  stopLarkInstances
};
