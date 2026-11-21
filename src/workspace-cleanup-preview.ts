import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { readWorkspaceCleanupLedger, verifyWorkspaceCleanupLedger, WorkspaceCleanupLedgerError } from './durable-run/workspace-cleanup-ledger.js';
import { readWorkspaceCleanupReferences, workspaceCleanupLedgerEligibility, workspaceCleanupRunStatuses,
  type WorkspaceCleanupReference } from './durable-run/workspace-cleanup-references.js';
import { readManagedWorkspaceRoots, validateManagedRunDirectory } from './managed-workspace-storage.js';
import { resolveManagedGitSelection } from './managed-git-registry.js';
import { loadWorkspaceDependencyWriteGuard } from './workspace-dependency-registry.js';
import { readWorkspaceDependencyMountPolicy, type WorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { inventoryWorkspaceStorage } from './workspace-storage.js';
import { assertDenyOnlyWorkspaceAcls } from './managed-workspace-ancestry.js';
import { hasExclusiveWorkspaceCleanupStorage, hasLocalWorkspaceCleanupStorage, observeWorkspaceCleanupTree, readWorkspaceCleanupEpoch,
  type WorkspaceCleanupEpoch } from './workspace-cleanup-evidence.js';
import type { ManagedGitSelection } from './domain/managed-workspace.js';
import { assertWorkspaceGitCacheIdentity, verifyWorkspaceGitCache } from './workspace-git-snapshot.js';

const maxRootNames = 256;
const exec = promisify(execFile);

interface PreviewEntry {
  leaf: string;
  workload: WorkspaceCleanupReference['owner']['kind'];
  disposition: 'candidate' | 'retain';
  reasons: string[];
  runStatus: string;
  lastUsedAt?: string;
  usage?: { apparentBytes: number; allocatedBytes: number | null; complete: boolean };
}

interface PreviewRequest {
  configPath: string;
  sourceRegistryPath?: string;
  databasePath: string;
  authorizedRoots: readonly [string, ...string[]];
  minimumAgeDays: number;
  now: Date;
  readEpoch?: () => Promise<WorkspaceCleanupEpoch | undefined>;
  checkExclusiveStorage?: (directories: readonly string[]) => Promise<boolean>;
}

export async function previewWorkspaceCleanup(request: PreviewRequest) {
  const report = { readOnly: true, advisory: true, observedAt: request.now.toISOString(), minimumAgeDays: request.minimumAgeDays,
    scratchRoot: null as string | null, status: 'complete' as 'complete' | 'partial' | 'unavailable',
    observations: [] as string[], entries: [] as PreviewEntry[], unregisteredObserved: 0 };
  if (!Number.isSafeInteger(request.minimumAgeDays) || request.minimumAgeDays < 1 || request.minimumAgeDays > 3650) {
    return { ...report, status: 'unavailable' as const, observations: ['invalid_retention_policy'] };
  }
  const observeRoots = async () => {
    const roots = await readManagedWorkspaceRoots(request);
    if (!roots) return undefined;
    await resolveManagedGitSelection({ ...request, roots });
    const guard = await loadWorkspaceDependencyWriteGuard(request.configPath, { allowMissingCachesForStorage: true });
    await guard?.assertWrites([roots.scratch.directory]);
    const mounts = await readWorkspaceDependencyMountPolicy();
    if (!mounts.supports(roots.scratch.directory) || !mounts.supports(roots.artifacts.directory)) throw new Error('Unsupported layout.');
    return { roots, mounts, guard };
  };
  try {
    const layout = await observeRoots();
    if (!layout) return { ...report, status: 'unavailable' as const, observations: ['managed_storage_disabled'] };
    const { roots, mounts } = layout;
    report.scratchRoot = roots.scratch.directory;
    const snapshot = await readWorkspaceCleanupLedger(request.databasePath, (db) => readWorkspaceCleanupReferences(db, roots.scratch), async (temp) => {
      const authorized = await Promise.all(request.authorizedRoots.map((directory) => fs.realpath(directory)));
      const protectedPaths = [roots.scratch.directory, roots.artifacts.directory, path.dirname(request.databasePath), path.dirname(request.configPath), ...authorized];
      const current = await observeRoots();
      if (!current || !sameWorkspaceProject(roots.scratch, current.roots.scratch) || !sameWorkspaceProject(roots.artifacts, current.roots.artifacts)
        || !current.mounts.supports(temp) || protectedPaths.some((protectedPath) => pathsOverlap(temp, protectedPath, current.mounts))) {
        throw new WorkspaceCleanupLedgerError('ledger_unavailable');
      }
      await current.guard?.assertNewDirectory(temp);
    });
    const { references, invalidRows, truncated, paths } = snapshot.value;
    const registered = new Set(references.map(({ leaf }) => leaf));
    let seen = 0;
    for await (const entry of await fs.opendir(roots.scratch.directory)) {
      if (++seen > maxRootNames) { report.observations.push('directory_limit'); break; }
      if (!truncated && !invalidRows && !registered.has(entry.name)) report.unregisteredObserved++;
    }
    if (truncated) report.observations.push('ledger_limit');
    if (invalidRows) report.observations.push('invalid_ledger_rows');
    if (report.unregisteredObserved) report.observations.push('unregistered_entries_retained');
    const storagePaths = [roots.scratch.directory, request.databasePath];
    const local = await hasLocalWorkspaceCleanupStorage(storagePaths);
    const exclusive = local && await (request.checkExclusiveStorage ?? hasExclusiveWorkspaceCleanupStorage)(storagePaths);
    const epoch = exclusive ? await (request.readEpoch ?? readWorkspaceCleanupEpoch)() : undefined;
    if (!local) report.observations.push('local_storage_unverified');
    const baselineBudget = AbortSignal.timeout(20_000);
    const candidates = new Map<PreviewEntry, { binding: WorkspaceProjectBinding; stamp: string; baseline: string; git?: ManagedGitSelection }>();
    for (const reference of references) {
      const result = await inspect(reference, request, roots, mounts, truncated || invalidRows > 0, epoch, baselineBudget);
      report.entries.push(result.entry);
      if (result.candidate) candidates.set(result.entry, result.candidate);
    }
    if (candidates.size > 0) {
      const current = await observeRoots().catch(() => undefined);
      if (!current || !sameWorkspaceProject(roots.scratch, current.roots.scratch)
        || !sameWorkspaceProject(roots.artifacts, current.roots.artifacts)
        || !await hasLocalWorkspaceCleanupStorage(storagePaths)
        || (epoch && !await (request.checkExclusiveStorage ?? hasExclusiveWorkspaceCleanupStorage)(storagePaths))) report.observations.push('policy_changed');
      const referenced = current && await resolveProtectedPaths(paths, request.authorizedRoots[0]);
      if (!referenced || !referenced.complete) report.observations.push('saved_references_unverified');
      const verifiedCaches = new Map<string, boolean>();
      const observedScratch = new Map<PreviewEntry, NonNullable<Awaited<ReturnType<typeof observeWorkspaceCleanupTree>>>>();
      for (const [entry, { binding, stamp, baseline, git }] of candidates) {
        if (!current || !supportsScratch(binding.directory, roots.scratch, current.mounts)
          || await directoryStamp(binding).catch(() => undefined) !== stamp) demote(entry, 'directory_changed');
        if (current && referenced?.directories.some((directory) => pathsOverlap(binding.directory, directory, current.mounts))) {
          demote(entry, 'saved_workspace_reference');
        }
        if (entry.disposition === 'candidate' && git
          && !await verifyGitBacking(git, request.authorizedRoots, verifiedCaches, baselineBudget)) demote(entry, 'git_backing_unverified');
        if (entry.disposition === 'candidate') {
          const tree = await observeWorkspaceCleanupTree(binding, baselineBudget, !git);
          if (tree?.digest === baseline) observedScratch.set(entry, tree);
          else demote(entry, git ? 'git_baseline_unverified_or_changed' : 'scratch_baseline_unverified_or_changed');
        }
      }
      // Full object verification can precede other candidates' scans. Recheck each surviving pin at the reporting boundary.
      for (const [entry, { git }] of candidates) {
        if (entry.disposition !== 'candidate' || !git) continue;
        try { await assertWorkspaceGitCacheIdentity(git, request.authorizedRoots); }
        catch { demote(entry, 'git_backing_unverified'); }
      }
      const finalMounts = await readWorkspaceDependencyMountPolicy().catch(() => undefined);
      for (const [entry, tree] of observedScratch) {
        if (entry.disposition !== 'candidate') continue;
        const { binding } = candidates.get(entry)!;
        if (!finalMounts || !supportsScratch(binding.directory, roots.scratch, finalMounts) || !await tree.unchanged()) {
          demote(entry, 'directory_changed');
        }
      }
    }
    if (!await verifyWorkspaceCleanupLedger(request.databasePath, snapshot.stamp)) report.observations.push('ledger_changed');
    if (report.observations.some((reason) => reason !== 'unregistered_entries_retained')) {
      report.status = 'partial';
      for (const [entry] of candidates) demote(entry, 'incomplete_observation');
    }
    return report;
  } catch (error) {
    return { ...report, status: 'unavailable' as const, entries: [], observations: [
      error instanceof WorkspaceCleanupLedgerError ? error.code : 'workspace_policy_unavailable',
    ] };
  }
}

async function inspect(reference: WorkspaceCleanupReference, request: PreviewRequest,
  roots: { scratch: WorkspaceProjectBinding; artifacts: WorkspaceProjectBinding }, mounts: WorkspaceDependencyMountPolicy, incomplete: boolean,
  epoch: WorkspaceCleanupEpoch | undefined, baselineBudget: AbortSignal) {
  const entry: PreviewEntry = { leaf: reference.leaf, workload: reference.owner.kind, disposition: 'retain', reasons: [],
    runStatus: reference.runStatus && workspaceCleanupRunStatuses.has(reference.runStatus) ? reference.runStatus : 'untracked' };
  const record = reference.record;
  if (!record) { entry.reasons.push(reference.allocationError ?? 'allocation_invalid'); return { entry }; }
  const { allocation, lastUsedAt } = record;
  entry.lastUsedAt = lastUsedAt;
  if (!sameWorkspaceProject(allocation.roots.scratch, roots.scratch) || !sameWorkspaceProject(allocation.roots.artifacts, roots.artifacts)) {
    entry.reasons.push('historical_root');
    return { entry };
  }
  try {
    const { directory, device } = allocation.scratch;
    if (device !== roots.scratch.device || !supportsScratch(directory, roots.scratch, mounts)) {
      entry.reasons.push('unverified_mount');
      return { entry };
    }
    if (await validateManagedRunDirectory(allocation, 'scratch', request.authorizedRoots) !== directory) throw new Error('Displaced scratch.');
    const stamp = await directoryStamp(allocation.scratch);
    const [inventory] = await inventoryWorkspaceStorage([{ role: 'continuation', directory }], { maxEntries: 128, maxDepth: 4 });
    if (inventory.total) entry.usage = { apparentBytes: inventory.total.apparentBytes, allocatedBytes: inventory.total.allocatedBytes,
      complete: inventory.status === 'complete' };
    if (inventory.status !== 'complete' && !allocation.gitCheckout) entry.reasons.push('usage_incomplete');
    const { reasons, priorBoot } = workspaceCleanupLedgerEligibility(reference, request.now, request.minimumAgeDays, epoch);
    entry.reasons.push(...reasons);
    const baseline = reference.scratchBaseline;
    if (!entry.reasons.length) {
      if (!allocation.gitCheckout && !await isPinnedScratchEmpty(allocation.scratch)) entry.reasons.push('scratch_contains_files');
      else if (!baseline || (await observeWorkspaceCleanupTree(allocation.scratch, baselineBudget, !allocation.gitCheckout))?.digest !== baseline) {
        entry.reasons.push(allocation.gitCheckout ? 'git_baseline_unverified_or_changed' : 'scratch_baseline_unverified_or_changed');
      }
    }
    if (await directoryStamp(allocation.scratch) !== stamp) entry.reasons.push('directory_changed');
    if (incomplete) entry.reasons.push('incomplete_observation');
    if (baseline && !entry.reasons.length) {
      entry.disposition = 'candidate';
      entry.reasons.push(allocation.gitCheckout ? 'expired_original_checkout' : 'expired_empty_scratch');
      if (priorBoot) entry.reasons.push('last_use_on_prior_host_boot');
      return { entry, candidate: { binding: allocation.scratch, stamp, baseline, git: allocation.git } };
    }
  } catch { entry.reasons.push('directory_unverified'); }
  return { entry };
}

export async function verifyGitBacking(git: ManagedGitSelection, authorizedRoots: PreviewRequest['authorizedRoots'],
  checked: Map<string, boolean>, signal: AbortSignal): Promise<boolean> {
  const key = JSON.stringify([git.key, git.storeFingerprint, git.cache.directory, git.cache.device, git.cache.inode]);
  if (signal.aborted) return false;
  try {
    if (!checked.has(key)) {
      if (checked.size >= 8) return false;
      const actual = await verifyWorkspaceGitCache({ gitDirectory: git.cache, authorizedRoots,
        repositoryId: git.repositoryId, scope: git.scope, commit: git.commit });
      checked.set(key, actual.key === git.key && actual.storeFingerprint === git.storeFingerprint);
    }
    if (!checked.get(key) || signal.aborted) return false;
    await assertWorkspaceGitCacheIdentity(git, authorizedRoots);
    return true;
  } catch { checked.set(key, false); return false; }
}

export function supportsScratch(directory: string, root: WorkspaceProjectBinding, mounts: WorkspaceDependencyMountPolicy,
  platform: NodeJS.Platform = process.platform): boolean {
  if (!mounts.supports(directory) || path.dirname(directory) !== root.directory) return false;
  if (platform === 'linux') {
    return [root.directory, directory].every((candidate) => mounts.aliases(candidate).every((alias) => alias === candidate));
  }
  if (platform !== 'darwin') return false;
  // Only the verified macOS Data firmlinks can map the whole scratch tree to another path.
  const allowed = new Set(mounts.aliases(root.directory).map((alias) => path.join(alias, path.basename(directory))));
  return mounts.aliases(directory).every((alias) => allowed.has(alias));
}

async function directoryStamp(binding: WorkspaceProjectBinding) {
  const observe = async () => {
    const stat = await fs.lstat(binding.directory, { bigint: true });
    if (!stat.isDirectory() || `${stat.dev}` !== binding.device || `${stat.ino}` !== binding.inode
      || !process.geteuid || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n) throw new Error('Displaced or unprotected directory.');
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  const stamp = await observe();
  await assertDenyOnlyWorkspaceAcls([binding.directory]);
  if (await observe() !== stamp) throw new Error('Directory permissions changed while reading.');
  return stamp;
}

async function isPinnedScratchEmpty(binding: WorkspaceProjectBinding): Promise<boolean> {
  // The helper holds cwd as a kernel directory reference while checking identity and emptiness.
  const program = `const fs = require('node:fs');
    const stat = fs.statSync('.', { bigint: true });
    if (String(stat.dev) !== process.argv[1] || String(stat.ino) !== process.argv[2] || !process.geteuid
      || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n) process.exit(2);
    const directory = fs.opendirSync('.');
    try { process.stdout.write(directory.readSync() === null ? 'empty' : 'occupied'); } finally { directory.closeSync(); }`;
  const { stdout } = await exec(process.execPath, ['--input-type=commonjs', '-e', program, '--', binding.device, binding.inode],
    { cwd: binding.directory, env: {}, maxBuffer: 64, timeout: 5000 });
  if (stdout !== 'empty' && stdout !== 'occupied') throw new Error('Directory observation failed.');
  return stdout === 'empty';
}

export async function resolveProtectedPaths(input: { paths: string[]; incomplete: boolean; unresolvedActiveCron: boolean }, execRoot: string) {
  let complete = !input.incomplete;
  const directories = new Set(input.paths);
  if (input.unresolvedActiveCron) directories.add(execRoot);
  for (const directory of [...directories]) {
    try { directories.add(await fs.realpath(directory)); }
    catch { complete = false; }
  }
  return { directories: [...directories], complete };
}

export function pathsOverlap(left: string, right: string, mounts: WorkspaceDependencyMountPolicy) {
  return mounts.aliases(left).some((a) => mounts.aliases(right).some((b) => mounts.contains(a, b) || mounts.contains(b, a)));
}

function demote(entry: PreviewEntry, reason: string) {
  if (entry.disposition === 'candidate') entry.reasons = [];
  entry.disposition = 'retain';
  entry.reasons.push(reason);
}

export function formatWorkspaceCleanupPreview(report: Awaited<ReturnType<typeof previewWorkspaceCleanup>>): string {
  return [
    'Managed workspace cleanup preview (read-only, advisory).',
    `Observed: ${report.observedAt}; minimum age: ${report.minimumAgeDays} days; status: ${report.status}.`,
    `Protected: sources, caches, toolchains, formal artifacts, unknown or unregistered directories.`,
    `Unregistered entries observed: ${report.unregisteredObserved}.`,
    ...report.observations.map((reason) => `Observation: ${reason}`),
    ...report.entries.map(({ disposition, leaf, workload, runStatus, reasons, usage }) =>
      `${disposition}: ${leaf} (${workload}, ${runStatus})${usage ? `, ${usage.apparentBytes} bytes${usage.complete ? '' : ' (partial)'}` : ''}: ${reasons.join(', ')}`),
  ].join('\n');
}
