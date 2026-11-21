import path from 'node:path';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertProtectedWorkspacePath, readWorkspaceAncestorIdentities, readWorkspaceMountTable,
  workspaceBackingAliases, workspaceMountLayoutSupported } from './managed-workspace-ancestry.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { MANAGED_GIT_CHECKOUT_LEAF } from './managed-workspace-mkdir.js';
import { validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const profile = 'lark-managed-git';
const protectedWorkspaceNames = ['.git', '.agents', '.codex', '.aws'];
const protectedGitNames = ['config', 'config.worktree', 'commondir', 'hooks', 'objects/info'];

interface ManagedGitSandboxInput {
  mode: 'read-only' | 'workspace-write';
  authorizedRoots: readonly [string, ...string[]];
  source: WorkspaceProjectBinding;
  cache: WorkspaceProjectBinding;
  scratch: WorkspaceProjectBinding;
  artifacts: WorkspaceProjectBinding;
  checkout: { checkout: WorkspaceProjectBinding; gitDirectory: WorkspaceProjectBinding };
  additionalWritable?: readonly WorkspaceProjectBinding[];
  networkEnabled?: boolean;
}

export interface ManagedGitSandboxOptions {
  readonly profile: string;
  readonly overrides: readonly string[];
  readonly writableDirectories: readonly string[];
}

const generatedGitSandboxes = new WeakSet<ManagedGitSandboxOptions>();

export function isGeneratedManagedGitSandbox(options: ManagedGitSandboxOptions): boolean {
  return generatedGitSandboxes.has(options);
}

export function namedCodexSandboxOverrides(name: string, rules: ReadonlyMap<string, 'read' | 'write'>, networkEnabled: boolean): string[] {
  const filesystem = Array.from(rules, ([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  return [
    `default_permissions=${JSON.stringify(name)}`,
    `permissions={${name}={filesystem={${filesystem}},network={enabled=${networkEnabled}}}}`,
    'approval_policy="never"',
  ];
}

export function addCodexWorkspaceWriteRoot(rules: Map<string, 'read' | 'write'>, directory: string): void {
  if (/[\u0000-\u001f\u007f*?\[\]]/.test(directory)) throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  rules.set(directory, 'write');
  for (const name of protectedWorkspaceNames) rules.set(path.join(directory, name), 'read');
}

export const DEPENDENCY_GUARD_PROFILE = 'lark-dependency-guard';

export function dependencyGuardSandboxOverrides(writableDirectories: readonly string[], networkEnabled: boolean): string[] {
  const rules = new Map<string, 'read' | 'write'>([[':root', 'read']]);
  for (const directory of writableDirectories) addCodexWorkspaceWriteRoot(rules, directory);
  return namedCodexSandboxOverrides(DEPENDENCY_GUARD_PROFILE, rules, writableDirectories.length > 0 && networkEnabled);
}

// The launcher must omit legacy --sandbox/profile flags and reject incompatible config and rule layers.
export async function createManagedGitSandboxOptions(input: ManagedGitSandboxInput): Promise<ManagedGitSandboxOptions> {
  const { source, cache, scratch, artifacts, checkout: { checkout, gitDirectory }, authorizedRoots } = input;
  if (checkout.directory !== path.join(scratch.directory, MANAGED_GIT_CHECKOUT_LEAF)
    || gitDirectory.directory !== path.join(checkout.directory, '.git')) throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  const separate = [source, cache, scratch, artifacts, ...(input.additionalWritable ?? [])];
  const all = [...separate, checkout, gitDirectory];
  for (const binding of all) {
    // Codex interprets glob syntax in permission keys, so accept only literal filesystem paths here.
    if (/[\u0000-\u001f\u007f*?\[\]]/.test(binding.directory)) throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
    await validateWorkspaceProject(authorizedRoots, binding);
    await assertProtectedWorkspacePath(binding, binding !== source && binding !== cache);
  }
  const mounts = readWorkspaceMountTable();
  const writable = input.mode === 'workspace-write' ? [scratch, artifacts, checkout, ...(input.additionalWritable ?? [])] : [];
  if (!workspaceMountLayoutSupported(writable.map(({ directory }) => directory), mounts)) {
    throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  }
  const locations = await Promise.all(separate.map(async (binding) => ({
    identity: `${binding.device}:${binding.inode}`,
    ancestors: await readWorkspaceAncestorIdentities(binding.directory),
    aliases: workspaceBackingAliases(binding.directory, mounts),
  })));
  for (const [index, first] of locations.entries()) {
    if (locations.slice(index + 1).some((second) => first.ancestors.has(second.identity) || second.ancestors.has(first.identity)
      || first.aliases.some((a) => second.aliases.some((b) => workspacePathContains(a, b) || workspacePathContains(b, a))))) {
      throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
    }
  }
  const rules = new Map<string, 'read' | 'write'>([[':root', 'read'], [source.directory, 'read'], [cache.directory, 'read']]);
  if (input.mode === 'workspace-write') {
    for (const { directory } of writable) addCodexWorkspaceWriteRoot(rules, directory);
    rules.set(gitDirectory.directory, 'write');
    for (const name of protectedGitNames) rules.set(path.join(gitDirectory.directory, name), 'read');
  }
  const networkEnabled = input.mode === 'workspace-write' && input.networkEnabled === true;
  const options = Object.freeze({ profile, writableDirectories: Object.freeze(writable.map(({ directory }) => directory)),
    overrides: Object.freeze(namedCodexSandboxOverrides(profile, rules, networkEnabled)) });
  generatedGitSandboxes.add(options);
  return options;
}
