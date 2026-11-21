import type { ManagedRunOwner } from './domain/managed-workspace.js';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import type { SqliteWorkspaceCleanupClaims, WorkspaceCleanupClaim } from './durable-run/workspace-cleanup-claims.js';
import { workspaceCleanupLedgerEligibility } from './durable-run/workspace-cleanup-references.js';
import { validateManagedRunDirectory } from './managed-workspace-storage.js';
import { observeWorkspaceCleanupTree, type WorkspaceCleanupEpoch } from './workspace-cleanup-evidence.js';
import { type createWorkspaceCleanupFiles, workspaceCleanupQuarantinePath } from './workspace-cleanup-files.js';
import { pathsOverlap, resolveProtectedPaths, supportsScratch, verifyGitBacking } from './workspace-cleanup-preview.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';

export interface WorkspaceCleanupContext {
  claims: SqliteWorkspaceCleanupClaims;
  files: NonNullable<Awaited<ReturnType<typeof createWorkspaceCleanupFiles>>>;
  roots: { scratch: WorkspaceProjectBinding; artifacts: WorkspaceProjectBinding };
  authorizedRoots: readonly [string, ...string[]];
  minimumAgeDays: number;
  now(): Date;
  signal: AbortSignal;
  epoch?: WorkspaceCleanupEpoch;
  revalidatePolicy(): Promise<boolean>;
}

// The caller owns the global instance lock and provides fresh mount and registry policy.
export async function reserveWorkspaceCleanupCandidate(context: WorkspaceCleanupContext, owner: ManagedRunOwner) {
  try {
    const approved = await authorize(context, owner);
    if (!approved) return;
    const { allocation, baseline, request } = approved;
    if (await validateManagedRunDirectory(allocation, 'scratch', context.authorizedRoots) !== allocation.scratch.directory) return;
    const tree = await observeWorkspaceCleanupTree(allocation.scratch, context.signal, !allocation.gitCheckout);
    if (tree?.digest !== baseline || context.files.readiness() !== 'ready' || !context.files.canStage(owner, tree)
      || !await context.revalidatePolicy() || !await tree.unchanged() || context.signal.aborted) return;
    return context.claims.reserve(request);
  } catch { return undefined; }
}

export async function recoverWorkspaceCleanupClaim(context: WorkspaceCleanupContext, claim: WorkspaceCleanupClaim):
  Promise<'removed' | 'held' | 'deferred'> {
  const { claims, files, signal } = context;
  const hold = (reason: NonNullable<WorkspaceCleanupClaim['reason']>) =>
    claims.hold(claim, context.now().toISOString(), reason) ? 'held' as const : 'deferred' as const;
  try {
    if (claim.state === 'removed' || claim.state === 'held') return claim.state;
    for (let step = 0; step < 3 && !signal.aborted; step++) {
      if (files.readiness() !== 'ready') return 'deferred';
      const approved = await authorize(context, claim.owner, claim);
      if (!approved) return 'deferred';
      const { allocation, request, baseline, quarantine } = approved;
      const location = await files.location(claim);
      if (location === 'ambiguous' || (location === 'source' && claim.state !== 'reserved')
        || (location === 'missing' && claim.state !== 'purging')) return hold('identity_unverified');
      const binding = location === 'source' ? claim.scratch : { ...claim.scratch, directory: quarantine! };
      const tree = location === 'missing' ? undefined
        : await observeWorkspaceCleanupTree(binding, signal, !allocation.gitCheckout, claim.scratch.directory);
      if (signal.aborted) return 'deferred';
      if (location !== 'missing' && tree?.digest !== baseline) {
        return hold(location === 'source' ? 'identity_unverified' : claim.state === 'purging' ? 'purge_incomplete' : 'quarantine_unverified');
      }
      if (!await context.revalidatePolicy() || await files.location(claim) !== location || (tree && !await tree.unchanged()) || signal.aborted) {
        return 'deferred';
      }
      const permit = () => !signal.aborted && claims.confirm(claim, request);
      let updated: WorkspaceCleanupClaim | undefined;
      if (claim.state === 'reserved') {
        const performed = location === 'source' && tree ? await files.move(claim, tree, permit) : await files.flush(claim, 'quarantine', permit);
        if (performed) updated = claims.perform(claim, request, 'isolated', () => true);
      } else if (claim.state === 'isolated') {
        updated = claims.perform(claim, request, 'purging');
      } else {
        const performed = tree ? await files.purge(claim, tree, permit) : await files.flush(claim, 'missing', permit);
        if (performed) updated = claims.perform(claim, request, 'removed', () => true);
      }
      // An interrupted or unacknowledged native operation is reconciled from the next fresh location and manifest.
      if (!updated) return 'deferred';
      claim = updated;
      if (claim.state === 'removed') return 'removed';
    }
  } catch { /* Preserve the durable intent when a prerequisite or transition is uncertain. */ }
  return 'deferred';
}

async function authorize(context: WorkspaceCleanupContext, owner: ManagedRunOwner, claim?: WorkspaceCleanupClaim) {
  const { roots, signal, epoch } = context;
  if (signal.aborted || context.claims.databasePath !== context.files.databasePath || !await context.revalidatePolicy()) return;
  const observation = context.claims.observe(roots.scratch, owner);
  const reference = observation?.reference;
  const record = reference?.record;
  const now = context.now();
  if (!observation || !reference || !record || !reference.scratchBaseline || observation.paths.unresolvedActiveCron
    || workspaceCleanupLedgerEligibility({ ...reference, cleanupClaimed: !claim && reference.cleanupClaimed },
      now, context.minimumAgeDays, epoch).reasons.length) return;
  const allocation = record.allocation;
  if (!sameWorkspaceProject(roots.scratch, allocation.roots.scratch) || !sameWorkspaceProject(roots.artifacts, allocation.roots.artifacts)
    || (claim && (!sameWorkspaceProject(claim.scratch, allocation.scratch) || claim.baseline !== reference.scratchBaseline))) return;
  const mounts = await readWorkspaceDependencyMountPolicy();
  const quarantine = claim && workspaceCleanupQuarantinePath(roots.scratch, claim);
  const protectedPaths = await resolveProtectedPaths(observation.paths, context.authorizedRoots[0]);
  if (!protectedPaths.complete || [allocation.scratch.directory, ...(quarantine ? [quarantine] : [])].some((directory) =>
    !supportsScratch(directory, roots.scratch, mounts)
    || [roots.artifacts.directory, ...protectedPaths.directories].some((entry) => pathsOverlap(directory, entry, mounts)))) return;
  if (allocation.git && !await verifyGitBacking(allocation.git, context.authorizedRoots, new Map(), signal)) return;
  return { allocation, quarantine, baseline: reference.scratchBaseline,
    request: { roots, observation, minimumAgeDays: context.minimumAgeDays, now: now.toISOString(), epoch } };
}
