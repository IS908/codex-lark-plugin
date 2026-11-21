import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { readWorkspaceCleanupLedger, verifyWorkspaceCleanupLedger, WorkspaceCleanupLedgerError } from './durable-run/workspace-cleanup-ledger.js';
import { readWorkspaceCleanupReferences, type WorkspaceCleanupReference } from './durable-run/workspace-cleanup-references.js';
import { readManagedWorkspaceRoots, validateManagedRunDirectory } from './managed-workspace-storage.js';
import { resolveManagedGitSelection } from './managed-git-registry.js';
import { loadWorkspaceDependencyWriteGuard } from './workspace-dependency-registry.js';
import { readWorkspaceDependencyMountPolicy, type WorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { inventoryWorkspaceStorage } from './workspace-storage.js';

const day = 24 * 60 * 60 * 1000;
const terminalStatuses = new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled']);
const runStatuses = new Set([...terminalStatuses, 'queued', 'running', 'waiting_retry', 'waiting_user', 'recovering', 'cancel_requested']);
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
    const { roots, mounts, guard } = layout;
    report.scratchRoot = roots.scratch.directory;
    const snapshot = await readWorkspaceCleanupLedger(request.databasePath, (db) => readWorkspaceCleanupReferences(db, roots.scratch), async (temp) => {
      const authorized = await Promise.all(request.authorizedRoots.map((directory) => fs.realpath(directory)));
      const protectedPaths = [roots.scratch.directory, roots.artifacts.directory, path.dirname(request.databasePath), path.dirname(request.configPath), ...authorized];
      if (!mounts.supports(temp) || protectedPaths.some((protectedPath) => pathsOverlap(temp, protectedPath, mounts))) {
        throw new WorkspaceCleanupLedgerError('ledger_unavailable');
      }
      await guard?.assertNewDirectory(temp);
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
    const candidates = new Map<PreviewEntry, { binding: WorkspaceProjectBinding; stamp: string }>();
    for (const reference of references) {
      const result = await inspect(reference, request, roots, mounts, truncated || invalidRows > 0);
      report.entries.push(result.entry);
      if (result.candidate) candidates.set(result.entry, result.candidate);
    }
    if (candidates.size > 0) {
      const current = await observeRoots().catch(() => undefined);
      if (!current || !sameWorkspaceProject(roots.scratch, current.roots.scratch)
        || !sameWorkspaceProject(roots.artifacts, current.roots.artifacts)) report.observations.push('policy_changed');
      const referenced = current && await resolveProtectedPaths(paths, request.authorizedRoots[0]);
      if (!referenced || !referenced.complete) report.observations.push('saved_references_unverified');
      for (const [entry, { binding, stamp }] of candidates) {
        if (!current || !supportsScratch(binding.directory, roots.scratch, current.mounts)
          || await directoryStamp(binding).catch(() => undefined) !== stamp) demote(entry, 'directory_changed');
        if (current && referenced?.directories.some((directory) => pathsOverlap(binding.directory, directory, current.mounts))) {
          demote(entry, 'saved_workspace_reference');
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
  roots: { scratch: WorkspaceProjectBinding; artifacts: WorkspaceProjectBinding }, mounts: WorkspaceDependencyMountPolicy, incomplete: boolean) {
  const entry: PreviewEntry = { leaf: reference.leaf, workload: reference.owner.kind, disposition: 'retain', reasons: [],
    runStatus: reference.runStatus && runStatuses.has(reference.runStatus) ? reference.runStatus : 'untracked' };
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
    if (inventory.status !== 'complete') entry.reasons.push('usage_incomplete');
    if (reference.owner.kind === 'foreground') {
      entry.reasons.push('foreground_quiescence_untracked');
      if (reference.foregroundDeliveryPending) entry.reasons.push('delivery_not_confirmed');
    }
    else if (!reference.runStatus) entry.reasons.push('run_missing');
    else if (!terminalStatuses.has(reference.runStatus) || reference.lease) entry.reasons.push('live_or_recoverable_run');
    else {
      if (reference.retained) entry.reasons.push('explicitly_retained');
      if (reference.unsettledDelivery || !reference.terminalDeliverySent) entry.reasons.push('delivery_not_confirmed');
      if (reference.attemptExists || (reference.attemptCount !== 0 && reference.attemptCount !== 0n)) entry.reasons.push('process_quiescence_unverified');
      const terminalAt = Date.parse(reference.terminalAt ?? '');
      const cutoff = request.now.getTime() - request.minimumAgeDays * day;
      if (!Number.isFinite(terminalAt) || terminalAt > cutoff || Date.parse(lastUsedAt) > cutoff) entry.reasons.push('retention_window');
    }
    if (reference.retryReference || reference.pendingStage) entry.reasons.push('retry_or_staging_reference');
    if (allocation.git || allocation.gitCheckout) entry.reasons.push('git_preservation_unverified');
    if (!entry.reasons.length && !await isPinnedScratchEmpty(allocation.scratch)) entry.reasons.push('scratch_contains_files');
    if (await directoryStamp(allocation.scratch) !== stamp) entry.reasons.push('directory_changed');
    if (incomplete) entry.reasons.push('incomplete_observation');
    if (!entry.reasons.length) {
      entry.disposition = 'candidate';
      entry.reasons.push('expired_unused_scratch');
      return { entry, candidate: { binding: allocation.scratch, stamp } };
    }
  } catch { entry.reasons.push('directory_unverified'); }
  return { entry };
}

function supportsScratch(directory: string, root: WorkspaceProjectBinding, mounts: WorkspaceDependencyMountPolicy): boolean {
  if (!mounts.supports(directory) || path.dirname(directory) !== root.directory) return false;
  const allowed = new Set(mounts.aliases(root.directory).map((alias) => path.join(alias, path.basename(directory))));
  return mounts.aliases(directory).every((alias) => allowed.has(alias));
}

async function directoryStamp(binding: WorkspaceProjectBinding) {
  const stat = await fs.lstat(binding.directory, { bigint: true });
  if (!stat.isDirectory() || `${stat.dev}` !== binding.device || `${stat.ino}` !== binding.inode) throw new Error('Displaced directory.');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function isPinnedScratchEmpty(binding: WorkspaceProjectBinding): Promise<boolean> {
  // The helper holds cwd as a kernel directory reference while checking identity and emptiness.
  const program = `const fs = require('node:fs');
    const stat = fs.statSync('.', { bigint: true });
    if (String(stat.dev) !== process.argv[1] || String(stat.ino) !== process.argv[2]) process.exit(2);
    const directory = fs.opendirSync('.');
    try { process.stdout.write(directory.readSync() === null ? 'empty' : 'occupied'); } finally { directory.closeSync(); }`;
  const { stdout } = await exec(process.execPath, ['--input-type=commonjs', '-e', program, '--', binding.device, binding.inode],
    { cwd: binding.directory, env: {}, maxBuffer: 64, timeout: 5000 });
  if (stdout !== 'empty' && stdout !== 'occupied') throw new Error('Directory observation failed.');
  return stdout === 'empty';
}

async function resolveProtectedPaths(input: { paths: string[]; incomplete: boolean; unresolvedActiveCron: boolean }, execRoot: string) {
  let complete = !input.incomplete;
  const directories = new Set(input.paths);
  if (input.unresolvedActiveCron) directories.add(execRoot);
  for (const directory of [...directories]) {
    try { directories.add(await fs.realpath(directory)); }
    catch { complete = false; }
  }
  return { directories: [...directories], complete };
}

function pathsOverlap(left: string, right: string, mounts: WorkspaceDependencyMountPolicy) {
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
