import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_START_TOLERANCE_MS = 1_000;
const ESTIMATED_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);
const PS_OPTIONS = { encoding: 'utf8' as const, env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2_000, maxBuffer: 4_096 };
let ownProcessStartedAt: number | undefined;

export function currentProcessStartedAt(): number {
  if (ownProcessStartedAt === undefined) {
    try {
      ownProcessStartedAt = parseProcessStart(execFileSync('/bin/ps', psArgs(process.pid), PS_OPTIONS)) ?? ESTIMATED_PROCESS_STARTED_AT;
    } catch {
      ownProcessStartedAt = ESTIMATED_PROCESS_STARTED_AT;
    }
  }
  return ownProcessStartedAt;
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
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (pid === process.pid) return currentProcessStartedAt();
  try {
    const { stdout } = await execFileAsync('/bin/ps', psArgs(pid), PS_OPTIONS);
    return parseProcessStart(stdout);
  } catch {
    return null;
  }
}

function psArgs(pid: number): string[] { return ['-o', 'lstart=', '-p', String(pid)]; }

function parseProcessStart(output: string): number | null {
  const raw = output.trim();
  if (!raw) return null;
  const startedAt = Date.parse(`${raw} UTC`);
  return Number.isFinite(startedAt) ? startedAt : null;
}

export function isSameProcessStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= PROCESS_START_TOLERANCE_MS;
}

export function isRecordedProcessInstanceActive(
  processAlive: boolean,
  recordedStartedAt: number,
  actualStartedAt: number | null,
  stateAgeMs: number,
  unknownIdentityGraceMs: number,
): boolean {
  if (!processAlive) return false;
  if (actualStartedAt === null) return stateAgeMs < unknownIdentityGraceMs;
  return isSameProcessStart(actualStartedAt, recordedStartedAt);
}

// Only an observed later birth proves that a live PID is not the file owner.
// Older estimates can be later than the OS timestamp of the very same process.
export function isCleanupProcessOwnerActive(processAlive: boolean, recordedStartedAt: number | null,
  actualStartedAt: number | null): boolean {
  return processAlive && (recordedStartedAt === null || actualStartedAt === null || actualStartedAt <= recordedStartedAt);
}

export async function isProcessInstanceAlive(pid: number, startedAt: number | null): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  return isCleanupProcessOwnerActive(true, startedAt, startedAt === null ? null : await getProcessStartedAt(pid));
}
