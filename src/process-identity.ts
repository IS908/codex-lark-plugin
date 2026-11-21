import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_START_TOLERANCE_MS = 1_000;
const ESTIMATED_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1_000);
const PS_OPTIONS = { encoding: 'utf8' as const, env: { LC_ALL: 'C', TZ: 'UTC' }, timeout: 2_000, maxBuffer: 4_096 };
let ownProcessStartedAt: number | undefined;
let linuxBootId: string | null | undefined;
let ownLinuxBirthToken: string | null | undefined;

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

export const LINUX_BIRTH_TOKEN_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d{1,20}$/;

export function getLinuxProcessBirthToken(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null;
  if (pid === process.pid && ownLinuxBirthToken !== undefined) return ownLinuxBirthToken;
  let token: string | null = null;
  try {
    if (linuxBootId === undefined) linuxBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(') ');
    // Field 22 is time since boot; comm can contain spaces and parentheses.
    const ticks = endOfCommand > 0 && stat.startsWith(`${pid} (`) ? stat.slice(endOfCommand + 2).trim().split(/\s+/)[19] : '';
    const measured = `${linuxBootId}:${ticks}`;
    if (LINUX_BIRTH_TOKEN_PATTERN.test(measured)) token = measured;
  } catch { /* Unobservable identity is not proof of a stale lock. */ }
  if (pid === process.pid) ownLinuxBirthToken = token;
  return token;
}

export function isCleanupProcessOwnerActive(processAlive: boolean, recordedStartedAt: number | null,
  actualStartedAt: number | null, linuxBirth?: { recorded: string | null; actual: string | null }): boolean {
  if (!processAlive) return false;
  if (linuxBirth) return linuxBirth.recorded === null || linuxBirth.actual === null || linuxBirth.recorded === linuxBirth.actual;
  // Older estimates can be later than the OS timestamp of the same Darwin process.
  return recordedStartedAt === null || actualStartedAt === null || actualStartedAt <= recordedStartedAt;
}

export async function isCleanupProcessInstanceAlive(pid: number, recordedStartedAt: number | null, linuxBirthToken: string | null): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (process.platform === 'linux') return isCleanupProcessOwnerActive(true, recordedStartedAt, null,
    { recorded: linuxBirthToken, actual: linuxBirthToken === null ? null : getLinuxProcessBirthToken(pid) });
  return isCleanupProcessOwnerActive(true, recordedStartedAt, await getProcessStartedAt(pid));
}

export async function isProcessInstanceAlive(pid: number, startedAt: number, stateAgeMs: number, unknownIdentityGraceMs: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  return isRecordedProcessInstanceActive(true, startedAt, await getProcessStartedAt(pid), stateAgeMs, unknownIdentityGraceMs);
}
