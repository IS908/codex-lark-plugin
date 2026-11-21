import type { ContinuationJob } from '../domain/continuation.js';
import type { ManagedRunAllocation } from '../domain/managed-workspace.js';
import { sameWorkspaceProject } from '../domain/workspace.js';
import { ManagedWorkspaceStorageError } from '../managed-workspace-errors.js';
import type { ManagedWorkspaceStore } from '../ports/managed-workspace.js';
import type { ContinuationArtifactStore } from './artifact-store.js';
import { resolveManagedGitSelection } from '../managed-git-registry.js';

export interface ContinuationWorkspacePolicy {
  currentWorkingRoot: string;
  foregroundWorkingRoot?: string;
  sourceRegistryPath?: string;
  managedWorkspaceConfigPath?: string;
}

export function continuationWorkspaceRoots(job: ContinuationJob, policy: ContinuationWorkspacePolicy) {
  return [job.permissions.filesystem.root, policy.currentWorkingRoot,
    policy.foregroundWorkingRoot ?? policy.currentWorkingRoot] as const;
}

export async function allocateContinuationWorkspace(
  job: ContinuationJob, store: ManagedWorkspaceStore | undefined, policy: ContinuationWorkspacePolicy | undefined,
): Promise<ManagedRunAllocation | undefined> {
  const { managedWorkspaceRoots, workspaceProject, managedWorkspaceGit } = job.permissions.filesystem;
  if (!managedWorkspaceRoots) {
    if (policy) await resolveManagedGitSelection({ configPath: policy.managedWorkspaceConfigPath,
      authorizedRoots: workspaceProject ? continuationWorkspaceRoots(job, policy)
        : [job.permissions.filesystem.root, policy.currentWorkingRoot], project: workspaceProject, fallbackDirectory: job.workingDirectory,
      expected: managedWorkspaceGit, preserveOptOut: true });
    return undefined;
  }
  if (!store || !policy || !workspaceProject || workspaceProject.directory !== job.workingDirectory) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  const authorizedRoots = continuationWorkspaceRoots(job, policy);
  const sourceRegistryRoot = policy.foregroundWorkingRoot ?? policy.currentWorkingRoot;
  await resolveManagedGitSelection({ configPath: policy.managedWorkspaceConfigPath,
    roots: managedWorkspaceRoots, project: workspaceProject, authorizedRoots,
    sourceRegistryPath: policy.sourceRegistryPath, sourceRegistryRoot, expected: managedWorkspaceGit, preserveOptOut: !managedWorkspaceGit });
  return store.ensure({
    roots: managedWorkspaceRoots, project: workspaceProject, owner: { kind: 'async_task', runId: job.jobId },
    createdAt: job.createdAt, usedAt: new Date().toISOString(),
    authorizedRoots,
    sourceRegistryPath: policy.sourceRegistryPath,
    sourceRegistryRoot,
    ...(managedWorkspaceGit ? { git: managedWorkspaceGit } : {}),
  });
}

export function continuationArtifactView(
  legacy: ContinuationArtifactStore,
  job: ContinuationJob,
  store: ManagedWorkspaceStore | undefined,
  policy: ContinuationWorkspacePolicy | undefined,
): ContinuationArtifactStore {
  const { managedWorkspaceRoots, workspaceProject } = job.permissions.filesystem;
  if (!managedWorkspaceRoots) return legacy;
  if (!store || !policy) throw new ManagedWorkspaceStorageError('invalid_binding');
  const owner = { kind: 'async_task', runId: job.jobId } as const;
  const recorded = store.get(owner);
  if (!recorded || !sameWorkspaceProject(recorded.allocation.project, workspaceProject)
    || !sameWorkspaceProject(recorded.allocation.roots.scratch, managedWorkspaceRoots.scratch)
    || !sameWorkspaceProject(recorded.allocation.roots.artifacts, managedWorkspaceRoots.artifacts)) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  return legacy.forManagedJob(job.jobId, recorded.allocation.artifacts,
    () => store.openDirectory(owner, 'artifacts', continuationWorkspaceRoots(job, policy)), store.retryArtifactStages(owner));
}
