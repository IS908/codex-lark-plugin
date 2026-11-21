import { isDeepStrictEqual } from 'node:util';
import { MANAGED_DELIVERY_MAX_BYTES } from '../domain/managed-workspace.js';
import { sameWorkspaceProject } from '../domain/workspace.js';
import { readManagedArtifact } from '../managed-workspace-artifact.js';
import type { DurableRunDeliveryClaim } from '../domain/durable-run.js';
import type { DurableRunRepository } from '../ports/durable-run.js';
import { parseCronRunInput, parseCronRunState, type CronArtifactPayload } from './contracts.js';

export async function loadCommittedCronArtifact(
  repository: DurableRunRepository, authorizedRoot: string, claim: DurableRunDeliveryClaim, payload: CronArtifactPayload,
): Promise<Buffer> {
  const run = await repository.get(claim.runId);
  if (!run || run.workloadKind !== 'cron_prompt' || run.status !== 'completed' || !isDeepStrictEqual(run.route, claim.route)) {
    throw new Error('Cron artifact run is unavailable.');
  }
  const { job, managedWorkspace } = parseCronRunInput(run.input, run.inputVersion, 'prompt');
  const { commit } = parseCronRunState(run.state, run.stateVersion);
  if (!managedWorkspace || job.id !== payload.jobId || job.createdAt !== payload.jobCreatedAt || job.revision !== payload.jobRevision
    || commit?.kind !== 'prompt' || commit.runStatus !== 'success' || !isDeepStrictEqual(commit.artifacts?.[payload.index], payload.artifact)) {
    throw new Error('Cron artifact does not match its committed reference.');
  }
  const store = repository.getManagedWorkspaceStore?.();
  const owner = { kind: 'cron_prompt', runId: run.runId } as const;
  const recorded = store?.get(owner)?.allocation;
  if (!store || !recorded || recorded.createdAt !== managedWorkspace.createdAt
    || !sameWorkspaceProject(recorded.project, job.workspaceProject)
    || !sameWorkspaceProject(recorded.roots.scratch, managedWorkspace.roots.scratch)
    || !sameWorkspaceProject(recorded.roots.artifacts, managedWorkspace.roots.artifacts)) {
    throw new Error('Cron artifact workspace binding is unavailable.');
  }
  const { content } = await readManagedArtifact({
    binding: recorded.artifacts, relativePath: payload.artifact.relativePath, expectedSha256: payload.artifact.sha256,
    maxBytes: MANAGED_DELIVERY_MAX_BYTES, revalidate: () => store.openDirectory(owner, 'artifacts', [authorizedRoot]),
  });
  if (!content.length) throw new Error('Cron artifact is empty.');
  return content;
}
