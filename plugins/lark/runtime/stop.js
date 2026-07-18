import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);

// src/resource-governance.ts
import { execFile } from "node:child_process";
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
  writeFile
} from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var gzipAsync = promisify(gzip);
function currentProcessStartedAt() {
  return Math.floor(Date.now() - process.uptime() * 1e3);
}
function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function defaultProcessStartedAt(pid) {
  if (pid === process.pid) return currentProcessStartedAt();
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
async function defaultProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
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
function sameStartTime(a, b) {
  return Math.abs(a - b) <= 1e3;
}
function sameLockOwner(a, b) {
  if (!a) return false;
  if (a.pid !== b.pid) return false;
  if (b.startedAt !== void 0) return a.startedAt === b.startedAt;
  return true;
}
async function removeLockIfStillOwned(lockPath, record) {
  const current = await readLockState(lockPath);
  if (!current || !sameLockOwner(current.record, record)) return false;
  await removePathIfExists(lockPath);
  return true;
}
function isCodexLarkProcessCommand(command) {
  const normalized = command.toLowerCase();
  return normalized.includes("codex-lark-plugin") || normalized.includes("scripts/start.sh") || normalized.includes("src/index.ts") && normalized.includes("tsx");
}
async function readLockState(lockPath) {
  let s;
  try {
    s = await stat(lockPath);
  } catch {
    return null;
  }
  const raw = await readFile(lockPath, "utf-8").catch((err) => {
    console.error(`[resource-governance] Failed to read lock ${lockPath}:`, err?.message ?? String(err));
    return "";
  });
  return { record: parseLock(raw), ageMs: Date.now() - s.mtimeMs };
}
async function removePathIfExists(filePath) {
  await rm(filePath, { recursive: true, force: true }).catch(() => void 0);
}
async function stopSingleInstanceLock(lockPath, options = {}) {
  const processExists = options.processExists ?? defaultProcessExists;
  const getProcessStartedAt = options.getProcessStartedAt ?? defaultProcessStartedAt;
  const getProcessCommand = options.getProcessCommand ?? defaultProcessCommand;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const isExpectedProcess = options.isExpectedProcess ?? isCodexLarkProcessCommand;
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 5e3));
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 100));
  const state = await readLockState(lockPath);
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
    const removed = await removeLockIfStillOwned(lockPath, record);
    return {
      ...base,
      status: "stale_lock_removed",
      message: removed ? `Removed stale codex-lark-plugin lock for non-running PID ${record.pid}.` : `Stale lock for PID ${record.pid} changed before cleanup; left it untouched.`
    };
  }
  if (record.startedAt) {
    const actualStartedAt = await getProcessStartedAt(record.pid);
    if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
      const removed = await removeLockIfStillOwned(lockPath, record);
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
      const removed = await removeLockIfStillOwned(lockPath, record);
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
      const removed = await removeLockIfStillOwned(lockPath, record);
      return {
        ...base,
        command,
        status: "process_terminated",
        message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock.` : `Stopped PID ${record.pid}, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (record.startedAt) {
      const actualStartedAt = await getProcessStartedAt(record.pid);
      if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
        const removed = await removeLockIfStillOwned(lockPath, record);
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

// src/instance-lock.ts
import os from "node:os";
import path from "node:path";
var LARK_INSTANCE_LOCK_PATH = path.join(os.tmpdir(), "codex-lark-plugin.lock");

// src/stop.ts
var okStatuses = /* @__PURE__ */ new Set(["no_lock", "stale_lock_removed", "process_terminated"]);
try {
  const result = await stopSingleInstanceLock(LARK_INSTANCE_LOCK_PATH);
  console.error(result.message);
  process.exit(okStatuses.has(result.status) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
