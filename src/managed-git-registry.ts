import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sameManagedGitSelection, type ManagedGitSelection, type ManagedWorkspaceRoots } from './domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities, readWorkspaceMountTable,
  workspaceBackingAliases, type WorkspaceMount } from './managed-workspace-ancestry.js';
import { ManagedWorkspaceStorageError, validateManagedWorkspaceRoots } from './managed-workspace-storage.js';
import { assertWorkspaceGitCheckoutMounts, readWorkspaceGitCacheIdentity, WorkspaceGitSnapshotError } from './workspace-git-snapshot.js';
import { pinWorkspacePath, validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const registryName = 'workspace-git-sources.json';
const maxRegistryBytes = 128 * 1024;
const canonicalPath = z.string().max(4096).refine((value) => path.isAbsolute(value) && path.resolve(value) === value && !/[\u0000-\u001f\u007f]/.test(value));
const registrySchema = z.strictObject({ version: z.literal(1), projects: z.array(z.strictObject({
  source: canonicalPath, cache: canonicalPath, repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
})).max(128) }).refine(({ projects }) => new Set(projects.map(({ source }) => source)).size === projects.length);

function registryPath(configPath: string): string {
  return path.join(path.dirname(path.resolve(configPath)), registryName);
}

export async function hasManagedGitRegistry(configPath?: string): Promise<boolean> {
  return !!(configPath && (await readRegistry(registryPath(configPath)))?.projects.length);
}

export async function resolveManagedGitSelection(input: {
  configPath?: string;
  roots?: ManagedWorkspaceRoots;
  project?: WorkspaceProjectBinding;
  fallbackDirectory?: string;
  authorizedRoots: readonly [string, ...string[]];
  sourceRegistryPath?: string;
  sourceRegistryRoot?: string;
  expected?: ManagedGitSelection;
  preserveOptOut?: boolean;
}): Promise<ManagedGitSelection | undefined> {
  const inactive = () => {
    if (input.expected) throw new ManagedWorkspaceStorageError('git_selection_revoked');
    return undefined;
  };
  if (!input.configPath) return inactive();
  const configPath = registryPath(input.configPath);
  const registry = await readRegistry(configPath);
  if (!registry?.projects.length) return inactive();
  const { roots, authorizedRoots, sourceRegistryPath, sourceRegistryRoot } = input;
  const mounts = readWorkspaceMountTable();
  const configAliases = workspaceBackingAliases(configPath, mounts);
  const executionRoots = await Promise.all(authorizedRoots.map((root) => fs.realpath(root)));
  if (executionRoots.some((directory) => workspaceBackingAliases(directory, mounts).some((alias) =>
    configAliases.some((file) => workspacePathContains(alias, file))))) throw new ManagedWorkspaceStorageError('git_registry_invalid');
  const project = input.project ? await validateWorkspaceProject(authorizedRoots, input.project)
    : input.fallbackDirectory ? await validateWorkspaceProject(authorizedRoots,
      await pinWorkspacePath(authorizedRoots[0], input.fallbackDirectory)) : undefined;
  const storage = await Promise.all((roots ? [roots.scratch, roots.artifacts] : []).map((binding) => describe(binding, mounts)));
  const projectLocation = project && await describe(project, mounts);
  const writable = [...storage, ...(projectLocation ? [projectLocation] : [])];
  const selected = registry.projects.find(({ source }) => source === project?.directory);
  for (const entry of registry.projects) {
    const cache = await registeredDirectory(entry.cache);
    if (writable.some((root) => overlap(root, cache))) throw new ManagedWorkspaceStorageError('overlapping_git_cache');
    const source = selected === entry && projectLocation ? projectLocation : await registeredDirectory(entry.source);
    if (storage.some((root) => overlap(root, source))) throw new ManagedWorkspaceStorageError('overlapping_source');
    if (projectLocation && selected !== entry && overlap(projectLocation, source)) throw new ManagedWorkspaceStorageError('git_project_overlap');
  }
  if (!selected || !project) return inactive();
  if (input.preserveOptOut || !roots) throw new ManagedWorkspaceStorageError('git_project_overlap');
  const cache = await pinWorkspacePath(authorizedRoots[0], selected.cache);
  if (cache.directory !== selected.cache) throw new ManagedWorkspaceStorageError('git_registry_invalid');
  await validateManagedWorkspaceRoots(roots, { authorizedRoots, project, sourceRegistryPath, sourceRegistryRoot, gitCache: cache });
  const bindings = [project, cache, roots.scratch, roots.artifacts];
  try {
    await assertWorkspaceGitCheckoutMounts(bindings);
    const { commit, repositoryId, scope } = selected;
    if (input.expected && (input.expected.commit !== commit || input.expected.repositoryId !== repositoryId || input.expected.scope !== scope)) return inactive();
    const snapshot = await readWorkspaceGitCacheIdentity({ gitDirectory: cache, authorizedRoots, commit, repositoryId, scope });
    const selection = { cache, ...snapshot };
    if (input.expected && !sameManagedGitSelection(selection, input.expected)) return inactive();
    return selection;
  } catch (error) {
    if (error instanceof WorkspaceGitSnapshotError) throw new ManagedWorkspaceStorageError(input.expected ? 'git_selection_revoked' : 'git_registry_invalid');
    throw error;
  }

  async function registeredDirectory(directory: string) {
    const binding = await pinWorkspacePath(directory, '.');
    if (binding.directory !== directory) throw new ManagedWorkspaceStorageError('git_registry_invalid');
    return describe(binding, mounts);
  }
}

async function describe(binding: WorkspaceProjectBinding, mounts: WorkspaceMount[]) {
  return { id: `${binding.device}:${binding.inode}`, ancestors: await readWorkspaceAncestorIdentities(binding.directory),
    aliases: workspaceBackingAliases(binding.directory, mounts) };
}

function overlap(a: Awaited<ReturnType<typeof describe>>, b: Awaited<ReturnType<typeof describe>>): boolean {
  return a.ancestors.has(b.id) || b.ancestors.has(a.id) || a.aliases.some((left) => b.aliases.some((right) =>
    workspacePathContains(left, right) || workspacePathContains(right, left)));
}

async function readRegistry(filename: string): Promise<z.infer<typeof registrySchema> | undefined> {
  const invalid = () => new ManagedWorkspaceStorageError('git_registry_invalid');
  let fd;
  try {
    fd = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw invalid();
  }
  try {
    const parent = path.dirname(filename);
    const binding = await pinWorkspacePath(parent, '.');
    if (binding.directory !== parent || !process.geteuid) throw invalid();
    await assertProtectedWorkspacePath(binding, true);
    const info = await fd.stat({ bigint: true });
    if (!info.isFile() || info.uid !== BigInt(process.geteuid()) || info.nlink !== 1n
      || (info.mode & 0o022n) !== 0n || info.size < 1n || info.size > BigInt(maxRegistryBytes)) throw invalid();
    await assertDenyOnlyWorkspaceAcls([filename]);
    const bytes = Buffer.alloc(Number(info.size));
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    const current = await fs.lstat(filename, { bigint: true });
    if (bytesRead !== bytes.length || info.dev !== current.dev || info.ino !== current.ino || info.size !== current.size
      || info.ctimeNs !== current.ctimeNs || info.mtimeNs !== current.mtimeNs) throw invalid();
    return registrySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw invalid();
  } finally {
    await fd.close();
  }
}
