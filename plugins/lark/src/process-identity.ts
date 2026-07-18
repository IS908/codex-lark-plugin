import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_START_TOLERANCE_MS = 1_000;
const CURRENT_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);

export function currentProcessStartedAt(): number {
  return CURRENT_PROCESS_STARTED_AT;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function getProcessStartedAt(pid: number): Promise<number | null> {
  if (pid === process.pid) return CURRENT_PROCESS_STARTED_AT;
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

export function isSameProcessStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= PROCESS_START_TOLERANCE_MS;
}

export async function isProcessInstanceAlive(pid: number, startedAt: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  const actualStartedAt = await getProcessStartedAt(pid);
  return actualStartedAt === null || isSameProcessStart(actualStartedAt, startedAt);
}
