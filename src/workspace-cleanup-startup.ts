import { constants, lstatSync, readFileSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { DURABLE_RUN_SCHEMA_VERSION } from './durable-run/sqlite-migrations.js';
import { SqliteWorkspaceCleanupClaims } from './durable-run/workspace-cleanup-claims.js';
import { readProtectedPathReferences } from './durable-run/workspace-cleanup-references.js';
import { isLarkInstanceLockHeld } from './instance-lock.js';
import { resolveManagedGitSelection } from './managed-git-registry.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from './managed-workspace-ancestry.js';
import { readManagedWorkspaceRoots } from './managed-workspace-storage.js';
import type { SingleInstanceLockHandle } from './resource-governance.js';
import { hasExclusiveWorkspaceCleanupStorage, readWorkspaceCleanupEpoch } from './workspace-cleanup-evidence.js';
import { createWorkspaceCleanupFiles } from './workspace-cleanup-files.js';
import { pathsOverlap } from './workspace-cleanup-preview.js';
import { recoverWorkspaceCleanupClaim, reserveWorkspaceCleanupCandidate, type WorkspaceCleanupContext } from './workspace-cleanup-recovery.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { loadWorkspaceDependencyWriteGuard } from './workspace-dependency-registry.js';
import { pinWorkspacePath } from './workspace-projects.js';
import { inventoryWorkspaceStorage } from './workspace-storage.js';

const day = 86_400_000;
const candidateLimit = 128;
const cleanupPolicy = z.discriminatedUnion('enabled', [
  z.strictObject({ version: z.literal(1), enabled: z.literal(false) }),
  z.strictObject({ version: z.literal(1), enabled: z.literal(true),
    maxScratchBytes: z.int().positive(), maxRunsPerStartup: z.int().min(1).max(32).default(4) }),
]);

interface StartupCleanupRequest {
  databasePath: string;
  configPath: string;
  policyPath: string;
  sourceRegistryPath?: string;
  lock: SingleInstanceLockHandle | null;
  authorizedRoots: readonly [string, ...string[]];
  continuationRoot: string;
  protectedDirectories: readonly string[];
  minimumAgeDays: number;
  dryRun: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export async function runStartupWorkspaceCleanup(request: StartupCleanupRequest) {
  const report = { status: 'skipped' as 'disabled' | 'skipped' | 'blocked' | 'complete' | 'partial',
    reason: 'policy_unverified', examined: 0, removed: 0, held: 0, deferred: 0, allocatedBytes: null as number | null };
  const outcome = (status: typeof report.status, reason: string) => ({ ...report, status, reason });
  if (request.dryRun || request.signal?.aborted) return outcome('disabled', 'dry_run_or_stopping');
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(request.signal ? [request.signal] : [])]);
  const now = request.now ?? (() => new Date());
  let database: DatabaseSync | undefined;
  try {
    const configured = await readPolicy(request.policyPath);
    if (!configured?.policy.enabled) return outcome('disabled', 'not_enabled');
    const { policy, stamp } = configured;
    const { configPath, databasePath, lock, minimumAgeDays } = request;
    const stateRoot = path.dirname(databasePath);
    if (!isLarkInstanceLockHeld(lock, stateRoot) || !lockMatches(lock)) return outcome('skipped', 'lock_unverified');
    if (!Number.isSafeInteger(minimumAgeDays) || minimumAgeDays < 1 || minimumAgeDays > 3650) {
      return outcome('skipped', 'retention_unverified');
    }
    const ledger = await pinLedger(databasePath);
    if (!ledger) return outcome('skipped', 'ledger_unavailable');
    const configureRoot = path.dirname(configPath);
    if (path.dirname(request.policyPath) !== configureRoot) return outcome('skipped', 'policy_unverified');
    const policyFiles = [configPath, ...(request.sourceRegistryPath ? [request.sourceRegistryPath] : []),
      path.join(configureRoot, 'workspace-git-sources.json'), path.join(configureRoot, 'workspace-dependencies.json')];
    const stamps = policyFiles.map((file) => fileStamp(file, true));
    const guardPaths = [stateRoot, configureRoot, path.dirname(request.policyPath), ...request.protectedDirectories];
    const confirmPolicy = () => {
      try {
        return !signal.aborted && isLarkInstanceLockHeld(lock, stateRoot) && lockMatches(lock)
          && fileStamp(request.policyPath, true) === stamp && policyFiles.every((file, index) => fileStamp(file, true) === stamps[index])
          && sameFile(databasePath, ledger);
      } catch { return false; }
    };
    const readLayout = async () => {
      if (!confirmPolicy()) return;
      const roots = await readManagedWorkspaceRoots(request);
      if (!roots) return;
      await resolveManagedGitSelection({ ...request, roots });
      const dependencies = await loadWorkspaceDependencyWriteGuard(configPath, { allowMissingCachesForStorage: true });
      await dependencies?.assertWrites([roots.scratch.directory]);
      const mounts = await readWorkspaceDependencyMountPolicy();
      if (!mounts.supports(roots.scratch.directory) || !mounts.supports(roots.artifacts.directory)
        || guardPaths.some((entry) => pathsOverlap(roots.scratch.directory, entry, mounts))) return;
      return confirmPolicy() ? roots : undefined;
    };
    const roots = await readLayout();
    if (!roots) return outcome('skipped', 'layout_unverified');
    const exclusive = await hasExclusiveWorkspaceCleanupStorage([roots.scratch.directory, databasePath]);
    const epoch = exclusive ? await readWorkspaceCleanupEpoch() : undefined;
    const revalidatePolicy = async () => {
      const current = await readLayout();
      return !!current && sameWorkspaceProject(current.scratch, roots.scratch) && sameWorkspaceProject(current.artifacts, roots.artifacts)
        && (!epoch || await hasExclusiveWorkspaceCleanupStorage([roots.scratch.directory, databasePath]));
    };
    const refreshUsage = async () => {
      const [inventory] = await inventoryWorkspaceStorage([{ role: 'continuation', directory: roots.scratch.directory }],
        { maxEntries: 30_000, maxDepth: 32, signal });
      const usage = inventory?.total?.allocatedBytes;
      if (inventory?.status !== 'complete' || typeof usage !== 'number' || !Number.isSafeInteger(usage) || !await revalidatePolicy()) return false;
      report.allocatedBytes = usage;
      return true;
    };
    const probe = await createWorkspaceCleanupFiles(roots.scratch, ledger);
    if (!probe) return outcome('skipped', 'native_adapter_unavailable');
    const ready = probe.readiness();
    if (ready === 'busy') return outcome('blocked', 'native_operation_in_progress');
    if (ready !== 'ready') return outcome('skipped', 'native_adapter_unavailable');
    if (!await refreshUsage()) return outcome('skipped', 'inventory_unverified');
    if (!confirmPolicy()) return outcome('skipped', 'policy_changed');
    database = new DatabaseSync(databasePath, { timeout: 0 });
    if (!sameFile(databasePath, ledger) || database.prepare('PRAGMA user_version').get()?.user_version !== DURABLE_RUN_SCHEMA_VERSION) {
      return outcome('skipped', 'ledger_unavailable');
    }
    database.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');
    const references = readProtectedPathReferences(database);
    if (references.incomplete) return outcome('skipped', references.limitReached ? 'reference_scan_limit' : 'references_unverified');
    const claims = new SqliteWorkspaceCleanupClaims(database);
    const files = await createWorkspaceCleanupFiles(roots.scratch, ledger);
    if (!files || files.readiness() !== 'ready' || !confirmPolicy()) return outcome('skipped', 'native_adapter_unavailable');
    const context: WorkspaceCleanupContext = { claims, files, roots, authorizedRoots: request.authorizedRoots,
      continuationRoot: request.continuationRoot, minimumAgeDays, now, signal, epoch, revalidatePolicy, confirmPolicy };

    async function processClaim(claim: NonNullable<ReturnType<typeof claims.get>>) {
      const result = await recoverWorkspaceCleanupClaim(context, claim);
      report[result]++;
      if (result === 'deferred' && confirmPolicy()) {
        const latest = claims.get(claim.owner);
        if (latest) claims.postpone(latest, now().toISOString());
      }
    }

    const pending = claims.pending(roots.scratch, policy.maxRunsPerStartup);
    let attempted = 0;
    for (const claim of pending) {
      if (!confirmPolicy()) return outcome('partial', 'policy_changed_or_budget');
      attempted++;
      report.examined++;
      await processClaim(claim);
      if (!await refreshUsage()) return outcome('partial', 'inventory_unverified');
    }
    if (report.allocatedBytes! <= policy.maxScratchBytes) {
      return report.deferred || claims.pending(roots.scratch, 1).length
        ? outcome('partial', 'recovery_pending') : outcome('complete', 'within_capacity');
    }
    const cutoff = new Date(now().getTime() - minimumAgeDays * day).toISOString();
    const candidates = claims.candidates(roots.scratch, cutoff, candidateLimit);
    for (const candidate of candidates) {
      if (!confirmPolicy()) return outcome('partial', 'policy_changed_or_budget');
      if (attempted >= policy.maxRunsPerStartup) break;
      report.examined++;
      const claim = await reserveWorkspaceCleanupCandidate(context, candidate.owner);
      if (confirmPolicy()) claims.recordCandidateScan(roots.scratch, candidate);
      if (!claim) continue;
      attempted++;
      await processClaim(claim);
      if (!await refreshUsage()) return outcome('partial', 'inventory_unverified');
      if (report.allocatedBytes! <= policy.maxScratchBytes) {
        return report.deferred ? outcome('partial', 'recovery_pending') : outcome('complete', 'capacity_reached');
      }
    }
    return outcome('partial', attempted >= policy.maxRunsPerStartup ? 'run_limit'
      : candidates.length === candidateLimit ? 'candidate_scan_limit' : 'protected_or_ineligible');
  } catch {
    return outcome(report.examined ? 'partial' : 'skipped', 'policy_or_ledger_unavailable');
  } finally { database?.close(); }
}

async function readPolicy(filename: string) {
  const parent = path.dirname(filename);
  let file;
  try { file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const binding = await pinWorkspacePath(parent, '.');
    if (binding.directory !== parent) throw new Error('Cleanup policy path is not pinned.');
    await assertProtectedWorkspacePath(binding, true);
    const info = await file.stat({ bigint: true });
    if (!isTrustedFile(info) || info.size > 8192n) throw new Error('Unsafe cleanup configuration.');
    await assertDenyOnlyWorkspaceAcls([filename]);
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const stamp = describe(info);
    if (BigInt(bytesRead) !== info.size || describe(await file.stat({ bigint: true })) !== stamp || fileStamp(filename) !== stamp) {
      throw new Error('Cleanup configuration changed.');
    }
    return { policy: cleanupPolicy.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))), stamp };
  } finally { await file.close(); }
}

async function pinLedger(filename: string): Promise<WorkspaceProjectBinding | undefined> {
  try {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) return;
    const parentPath = path.dirname(filename);
    const parent = await pinWorkspacePath(parentPath, '.');
    if (parent.directory !== parentPath) return;
    await assertProtectedWorkspacePath(parent, true);
    const files = [filename, `${filename}-wal`, `${filename}-shm`];
    const existing: string[] = [];
    let ledger: WorkspaceProjectBinding | undefined;
    for (const [index, file] of files.entries()) {
      const info = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!info && index > 0) continue;
      if (!info || !isTrustedFile(info) || String(info.dev) !== parent.device) return;
      existing.push(file);
      if (index === 0) ledger = { directory: filename, device: String(info.dev), inode: String(info.ino) };
    }
    if (fileStamp(`${filename}-journal`) !== 'absent') return;
    await assertDenyOnlyWorkspaceAcls(existing);
    return ledger;
  } catch { return undefined; }
}

function isTrustedFile(info: BigIntStats) {
  return info.isFile() && !!process.geteuid && info.uid === BigInt(process.geteuid())
    && info.nlink === 1n && (info.mode & 0o022n) === 0n;
}

function describe(info: BigIntStats) {
  return [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function fileStamp(filename: string, trusted = false) {
  try {
    const info = lstatSync(filename, { bigint: true });
    if (trusted && !isTrustedFile(info)) throw new Error('Untrusted configuration file.');
    return describe(info);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

function sameFile(filename: string, binding: WorkspaceProjectBinding) {
  const info = lstatSync(filename, { bigint: true });
  return isTrustedFile(info) && String(info.dev) === binding.device && String(info.ino) === binding.inode;
}

function lockMatches(lock: SingleInstanceLockHandle) {
  const info = lstatSync(lock.path, { bigint: true });
  if (!isTrustedFile(info) || info.size > 1024n) return false;
  const record = JSON.parse(readFileSync(lock.path, 'utf8'));
  return record?.pid === process.pid && record?.startedAt === lock.startedAt;
}
