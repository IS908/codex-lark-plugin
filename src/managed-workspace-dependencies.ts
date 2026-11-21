import type { ManagedRunAllocation } from './domain/managed-workspace.js';
import type { ManagedWorkspaceStore } from './ports/managed-workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { ensureManagedWorkspaceDependencyOutput } from './workspace-dependency-install.js';
import { resolveWorkspaceDependencySelections, assertWorkspaceDependencySelectionAuthorized } from './workspace-dependency-registry.js';
import { probeWorkspaceDependencyToolchain } from './workspace-dependency-toolchain.js';

type Resolution = Pick<Parameters<typeof resolveWorkspaceDependencySelections>[0],
  'configPath' | 'authorizedRoots' | 'roots' | 'project' | 'git' | 'sourceRegistryPath' | 'sourceRegistryRoot'> & { codexCommand: string; signal?: AbortSignal };

export function isManagedWorkspaceDependencyError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('dependency_');
}

function resolve(request: Resolution, expected?: ManagedRunAllocation['dependencySelections']) {
  return resolveWorkspaceDependencySelections({ ...request, expected, probeToolchain: (configured, expectedFingerprint) => {
    if (!request.roots) throw new ManagedWorkspaceStorageError('invalid_binding');
    return probeWorkspaceDependencyToolchain({ configured, expectedFingerprint, codexCommand: request.codexCommand,
      temporaryRoot: request.roots.scratch, configPath: request.configPath, signal: request.signal });
  } });
}

export async function admitManagedWorkspaceDependencies(request: Resolution) {
  try {
    return (await resolve(request)).map(({ selection }) => selection);
  } catch (cause) {
    if (isManagedWorkspaceDependencyError(cause)) throw cause;
    throw new ManagedWorkspaceStorageError('dependency_selection_failed', { cause });
  }
}

export async function prepareManagedWorkspaceDependencies(allocation: ManagedRunAllocation, store: ManagedWorkspaceStore,
  policy: Pick<Resolution, 'codexCommand' | 'configPath' | 'authorizedRoots' | 'sourceRegistryPath' | 'sourceRegistryRoot'> & { signal?: AbortSignal }) {
  const { project, git, roots, dependencySelections, owner } = allocation;
  if (!dependencySelections?.length) return {};
  policy.signal?.throwIfAborted();
  const prepared = await resolve({ ...policy, project, git, roots }, dependencySelections);
  let pythonDirectory: string | undefined;
  for (const { selection, execution, input, artifactManifest } of prepared) {
    policy.signal?.throwIfAborted();
    if (!execution) throw new ManagedWorkspaceStorageError('invalid_binding');
    const receipt = await ensureManagedWorkspaceDependencyOutput(store, owner, selection.identity.ecosystem, {
      ...policy, input, artifactManifest, configured: execution,
      validateApproval: () => validateManagedWorkspaceDependencyApproval(allocation, policy.configPath),
    });
    if (selection.identity.ecosystem === 'pip') pythonDirectory = receipt.output.directory;
  }
  policy.signal?.throwIfAborted();
  return { pythonDirectory };
}

export async function validateManagedWorkspaceDependencyApproval(allocation: ManagedRunAllocation, configPath?: string) {
  const { project, git, dependencySelections } = allocation;
  if (!dependencySelections?.length) return;
  if (!configPath) throw new ManagedWorkspaceStorageError('invalid_binding');
  await assertWorkspaceDependencySelectionAuthorized(configPath, project, git, dependencySelections);
}

export async function validateManagedWorkspaceDependencyReceipts(allocation: ManagedRunAllocation, store: ManagedWorkspaceStore) {
  for (const { identity } of allocation.dependencySelections ?? []) {
    await ensureManagedWorkspaceDependencyOutput(store, allocation.owner, identity.ecosystem);
  }
}
