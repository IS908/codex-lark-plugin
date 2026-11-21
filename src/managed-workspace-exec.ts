import type { CodexExecRequest, CodexExecSandbox } from './codex-exec.js';
import type { ManagedRunAllocation } from './domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';

export function assertManagedWorkspaceSandbox(sandbox: CodexExecSandbox | undefined, project?: WorkspaceProjectBinding): void {
  if (sandbox !== 'read-only' && (sandbox !== 'workspace-write' || !project)) {
    throw new ManagedWorkspaceStorageError('unisolated_source');
  }
}

export function withManagedWorkspace(request: CodexExecRequest, allocation: ManagedRunAllocation): CodexExecRequest {
  assertManagedWorkspaceSandbox(request.sandbox, allocation.project);
  if (request.sandbox === 'workspace-write' && request.cwd !== allocation.project?.directory) {
    throw new ManagedWorkspaceStorageError('unisolated_source');
  }
  const scratch = allocation.scratch.directory;
  const artifacts = allocation.artifacts.directory;
  const mayWrite = request.sandbox === 'workspace-write';
  return {
    ...request,
    prompt: `${request.prompt}\n\n[Managed run storage]\n${[
      `Scratch directory: ${JSON.stringify(scratch)}`,
      `Formal artifact directory: ${JSON.stringify(artifacts)}`,
      'Use scratch for temporary files. Keep files intended for delivery in the formal artifact directory.',
      'These paths do not extend the source workspace authorization or override the current sandbox mode.',
    ].join('\n')}`,
    extraEnv: {
      ...request.extraEnv,
      LARK_MANAGED_SCRATCH_DIR: scratch,
      LARK_MANAGED_ARTIFACTS_DIR: artifacts,
      ...(mayWrite ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}),
    },
    ...(request.sandbox === 'workspace-write' ? {
      additionalWritableDirs: [...new Set([...(request.additionalWritableDirs ?? []), scratch, artifacts])],
    } : {}),
  };
}
