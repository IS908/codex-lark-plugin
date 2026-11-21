import type { ContinuationJob } from '../domain/continuation.js';
import type { ManagedRunAllocation } from '../domain/managed-workspace.js';
import { sameWorkspaceProject } from '../domain/workspace.js';
import { ManagedWorkspaceStorageError } from '../managed-workspace-errors.js';
import type { ManagedWorkspaceStore } from '../ports/managed-workspace.js';
import type { ContinuationArtifactStore } from './artifact-store.js';

export interface ContinuationWorkspacePolicy {
  currentWorkingRoot: string;
  foregroundWorkingRoot?: string;
  sourceRegistryPath?: string;
}

export function continuationWorkspaceRoots(job: ContinuationJob, policy: ContinuationWorkspacePolicy) {
  return [job.permissions.filesystem.root, policy.currentWorkingRoot,
    policy.foregroundWorkingRoot ?? policy.currentWorkingRoot] as const;
}

export async function allocateContinuationWorkspace(
  job: ContinuationJob, store: ManagedWorkspaceStore | undefined, policy: ContinuationWorkspacePolicy | undefined,
): Promise<ManagedRunAllocation | undefined> {
  const { managedWorkspaceRoots, workspaceProject } = job.permissions.filesystem;
  if (!managedWorkspaceRoots) return undefined;
  if (!store || !policy || !workspaceProject || workspaceProject.directory !== job.workingDirectory) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  return store.ensure({
    roots: managedWorkspaceRoots, project: workspaceProject, owner: { kind: 'async_task', runId: job.jobId },
    createdAt: job.createdAt, usedAt: new Date().toISOString(),
    authorizedRoots: continuationWorkspaceRoots(job, policy),
    sourceRegistryPath: policy.sourceRegistryPath,
    sourceRegistryRoot: policy.foregroundWorkingRoot ?? policy.currentWorkingRoot,
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
    () => store.openDirectory(owner, 'artifacts', continuationWorkspaceRoots(job, policy)));
}
