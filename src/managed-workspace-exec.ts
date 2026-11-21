import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexExecRequest, CodexExecSandbox } from './codex-exec.js';
import { appConfig } from './config.js';
import type { ManagedRunAllocation } from './domain/managed-workspace.js';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { createManagedGitSandboxOptions } from './managed-git-sandbox.js';
import { resolveManagedGitLauncher } from './managed-git-launcher.js';
import { hasManagedGitRegistry, resolveManagedGitSelection } from './managed-git-registry.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { validateWorkspaceGitCheckout, WorkspaceGitSnapshotError } from './workspace-git-snapshot.js';

export function assertManagedWorkspaceSandbox(sandbox: CodexExecSandbox | undefined, project?: WorkspaceProjectBinding): void {
  if (sandbox !== 'read-only' && (sandbox !== 'workspace-write' || !project)) {
    throw new ManagedWorkspaceStorageError('unisolated_source');
  }
}

export function managedGitCheckoutSessionScope(allocation?: ManagedRunAllocation): string | undefined {
  if (!allocation?.git || !allocation.gitCheckout) return undefined;
  const { directory, device, inode } = allocation.gitCheckout.checkout;
  return createHash('sha256').update(JSON.stringify([allocation.owner.kind, allocation.owner.runId,
    allocation.git.key, allocation.git.storeFingerprint, directory, device, inode])).digest('hex');
}

type GitRegistryPolicy = Pick<Parameters<typeof resolveManagedGitSelection>[0], 'configPath' | 'sourceRegistryPath' | 'sourceRegistryRoot'>;

function pluginExecutionRoots(...roots: string[]): string[] {
  return [...roots, appConfig.codexExecCwd, appConfig.continuationWorkingRoot, appConfig.continuationArtifactsDir];
}

export async function protectProfileDistillation(request: CodexExecRequest, configPath: string): Promise<CodexExecRequest> {
  if (!await hasManagedGitRegistry(configPath)) return request;
  const cwd = await fs.realpath(request.cwd ?? process.cwd());
  await assertCompatibleCodexLayers(process.env, [cwd]);
  return { ...request, cwd, sandbox: 'read-only', profile: undefined, ignoreUserConfig: true, strictConfig: true,
    configOverrides: ['approval_policy="never"'],
    validateManagedGitLaunch: (command, env) => resolveManagedGitLauncher(command, env, [], pluginExecutionRoots(cwd)) };
}

export async function protectLegacyGitWorkspace(request: CodexExecRequest, configPath?: string): Promise<CodexExecRequest> {
  if (!await hasManagedGitRegistry(configPath)) return request;
  if ((request.sandbox !== 'read-only' && request.sandbox !== 'workspace-write') || request.profile || request.ignoreUserConfig === false) {
    throw new ManagedWorkspaceStorageError('git_sandbox_layers_unsupported');
  }
  const cwd = await fs.realpath(request.cwd ?? process.cwd());
  const protectedRequest = { ...request, cwd, ignoreUserConfig: true,
    validateManagedGitLaunch: async (command: string, env: NodeJS.ProcessEnv) => {
      const writable = request.additionalWritableDirs ?? [];
      await assertCompatibleCodexLayers(env, [cwd, ...writable]);
      return resolveManagedGitLauncher(command, env, [], pluginExecutionRoots(cwd, ...writable));
    } };
  if (request.sandbox === 'read-only') return protectedRequest;
  // An active cache registry must not inherit Codex's implicit temp-directory grants.
  return { ...protectedRequest, configOverrides: [...(request.configOverrides ?? []),
    'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true'] };
}

export async function withManagedWorkspace(request: CodexExecRequest, allocation: ManagedRunAllocation,
  gitRegistry?: GitRegistryPolicy): Promise<CodexExecRequest> {
  assertManagedWorkspaceSandbox(request.sandbox, allocation.project);
  if (request.sandbox === 'workspace-write' && request.cwd !== allocation.project?.directory) {
    throw new ManagedWorkspaceStorageError('unisolated_source');
  }
  const scratch = allocation.scratch.directory;
  const artifacts = allocation.artifacts.directory;
  const mayWrite = request.sandbox === 'workspace-write';
  const enriched: CodexExecRequest = {
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
  return allocation.git || allocation.gitCheckout ? withGitCheckout(request, enriched, allocation, gitRegistry)
    : protectLegacyGitWorkspace(enriched, gitRegistry?.configPath);
}

async function withGitCheckout(request: CodexExecRequest, enriched: CodexExecRequest, allocation: ManagedRunAllocation,
  gitRegistry?: GitRegistryPolicy): Promise<CodexExecRequest> {
  const { project, git, gitCheckout, scratch, artifacts } = allocation;
  const guard = request.workspaceDirectory;
  const mode = request.sandbox;
  if (!project || !git || !gitCheckout || request.cwd !== project.directory || !guard || !sameWorkspaceProject(guard.binding, project)
    || (mode !== 'read-only' && mode !== 'workspace-write') || request.profile || request.ignoreUserConfig === false) {
    throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  }
  const existing = request.configOverrides ?? [];
  const supported = new Set(['approval_policy="never"', 'sandbox_permissions=["disk-full-read-access"]',
    'sandbox_workspace_write.network_access=true', 'sandbox_workspace_write.network_access=false']);
  if (existing.some((entry) => !supported.has(entry)) || existing.filter((entry) => entry.startsWith('sandbox_workspace_write.network_access=')).length > 1) {
    throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  }
  const writable = new Set(request.additionalWritableDirs ?? []);
  const extra = (guard.auxiliaryBindings ?? []).filter((binding) => writable.delete(binding.directory));
  if (writable.size || (mode === 'read-only' && extra.length)) throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
  const input = {
    mode, authorizedRoots: guard.authorizedRoots, source: project, cache: git.cache, scratch, artifacts, checkout: gitCheckout,
    additionalWritable: extra, networkEnabled: existing.includes('sandbox_workspace_write.network_access=true'),
  };
  const selection = { cache: { gitDirectory: git.cache, authorizedRoots: guard.authorizedRoots,
    commit: git.commit, scope: git.scope, repositoryId: git.repositoryId }, expected: git, source: project, scratch,
    protectedRoots: [allocation.roots.scratch, allocation.roots.artifacts, ...extra] };
  const extraEnv = { ...enriched.extraEnv };
  for (const name of Object.keys({ ...process.env, ...extraEnv })) if (name.startsWith('GIT_')) extraEnv[name] = undefined;
  Object.assign(extraEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const validate = async () => {
    await resolveManagedGitSelection({ ...gitRegistry, project, roots: allocation.roots, authorizedRoots: guard.authorizedRoots, expected: git });
    await assertCompatibleCodexLayers({ ...process.env, ...extraEnv }, [project.directory, gitCheckout.checkout.directory]);
    try {
      await validateWorkspaceGitCheckout(selection, gitCheckout);
    } catch (error) {
      if (error instanceof WorkspaceGitSnapshotError) throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
      throw error;
    }
    return createManagedGitSandboxOptions(input);
  };
  const options = await validate();
  return {
    ...enriched, cwd: gitCheckout.checkout.directory, sandbox: undefined, additionalWritableDirs: undefined,
    ignoreUserConfig: true, strictConfig: true, configOverrides: options.overrides, extraEnv,
    workspaceDirectory: { ...guard, binding: gitCheckout.checkout, requireProtectedAncestry: true,
      auxiliaryBindings: [...guard.auxiliaryBindings ?? [], scratch, artifacts, gitCheckout.gitDirectory],
      readOnlyBindings: [...guard.readOnlyBindings ?? [], project, git.cache] },
    validateManagedGitLaunch: async (command, env) => {
      const current = await validate();
      if (current.overrides.some((override, index) => override !== options.overrides[index])) {
        throw new ManagedWorkspaceStorageError('git_sandbox_invalid');
      }
      return resolveManagedGitLauncher(command, env, [project, git.cache, allocation.roots.scratch, allocation.roots.artifacts, ...extra],
        pluginExecutionRoots(...guard.authorizedRoots));
    },
    prompt: `${enriched.prompt}\n\n[Isolated Git checkout]\nWork in the current checkout. It started at ${git.commit}. Do not use the original source as a working directory.`,
  };
}

async function assertCompatibleCodexLayers(env: NodeJS.ProcessEnv, workspaces: string[]): Promise<void> {
  const unsupported = () => new ManagedWorkspaceStorageError('git_sandbox_layers_unsupported');
  const exists = async (target: string) => fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw unsupported();
  });
  const rejectRules = async (root: string) => {
    const folder = path.join(root, 'rules');
    if (!await exists(folder)) return;
    try {
      for await (const entry of await fs.opendir(folder)) if (entry.name.endsWith('.rules')) throw unsupported();
    } catch { throw unsupported(); }
  };
  const home = env.CODEX_HOME?.trim() || path.join(env.HOME || os.homedir(), '.codex');
  if (!path.isAbsolute(home)) throw unsupported();
  await rejectRules(home);
  if (await exists(path.join(home, 'hooks.json'))) throw unsupported();
  for (const name of ['config.toml', 'managed_config.toml', 'requirements.toml', 'hooks.json']) {
    if (await exists(path.join('/etc/codex', name))) throw unsupported();
  }
  await rejectRules('/etc/codex');
  const inspected = new Set<string>();
  for (const workspace of workspaces) {
    for (let directory = workspace; !inspected.has(directory); directory = path.dirname(directory)) {
      inspected.add(directory);
      const local = path.join(directory, '.codex');
      if (await exists(path.join(local, 'config.toml')) || await exists(path.join(local, 'hooks.json'))) throw unsupported();
      await rejectRules(local);
    }
  }
}
