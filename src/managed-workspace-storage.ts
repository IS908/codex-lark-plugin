import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  managedRunAllocationSchema,
  managedRunOwnerSchema,
  type ManagedRunAllocation,
  type ManagedRunOwner,
  type ManagedWorkspacePurpose,
  type ManagedWorkspaceRoots,
} from './domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import type { WorkspaceDependencySelection } from './domain/workspace-dependency.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { mkdirInsidePinnedRoot } from './managed-workspace-mkdir.js';
import { assertProtectedWorkspacePath, readWorkspaceAncestorIdentities } from './managed-workspace-ancestry.js';
import { listWorkspaceSourceProjects, pinWorkspacePath, validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const absolutePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const configSchema = z.strictObject({ version: z.literal(1), scratchRoot: absolutePath, artifactRoot: absolutePath });

export { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';

type AuthorizedRoots = readonly [string, ...string[]];
interface WorkspaceAuthorization {
  authorizedRoots: AuthorizedRoots;
  project?: WorkspaceProjectBinding;
  fallbackWorkspace?: WorkspaceProjectBinding;
  sourceRegistryPath?: string;
  sourceRegistryRoot?: string;
  gitCache?: WorkspaceProjectBinding;
}

export async function readManagedWorkspaceRoots({
  configPath, ...authorization
}: WorkspaceAuthorization & { configPath: string }): Promise<ManagedWorkspaceRoots | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ManagedWorkspaceStorageError('invalid_config');
  }
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(JSON.parse(contents));
  } catch {
    throw new ManagedWorkspaceStorageError('invalid_config');
  }
  const [scratch, artifacts] = await Promise.all([
    pinWorkspacePath(authorization.authorizedRoots[0], config.scratchRoot),
    pinWorkspacePath(authorization.authorizedRoots[0], config.artifactRoot),
  ]);
  const roots = { scratch, artifacts };
  await validateManagedWorkspaceRoots(roots, authorization);
  return roots;
}

export async function allocateManagedRunDirectories({
  roots, owner, createdAt, foregroundSessionKey, dependencySelections, ...authorization
}: WorkspaceAuthorization & {
  roots: ManagedWorkspaceRoots;
  owner: ManagedRunOwner;
  createdAt: string;
  foregroundSessionKey?: string;
  dependencySelections?: WorkspaceDependencySelection[];
}): Promise<ManagedRunAllocation> {
  if (!managedRunOwnerSchema.safeParse(owner).success || !z.iso.datetime().safeParse(createdAt).success) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  await validateManagedWorkspaceRoots(roots, authorization);
  const scratch = await allocateDirectory(roots.scratch, owner, authorization.authorizedRoots);
  const artifacts = await allocateDirectory(roots.artifacts, owner, authorization.authorizedRoots);
  return {
    version: 1, owner, roots, scratch, artifacts, createdAt,
    ...(dependencySelections !== undefined ? { dependencySelections } : {}),
    ...(foregroundSessionKey ? { foregroundSessionKey } : {}),
    ...(authorization.project ? { project: authorization.project } : {}),
    ...(authorization.fallbackWorkspace ? { fallbackWorkspace: authorization.fallbackWorkspace } : {}),
  };
}

export async function validateManagedRunDirectory(
  value: unknown,
  purpose: ManagedWorkspacePurpose,
  authorizedRoots: AuthorizedRoots,
): Promise<string> {
  const parsed = managedRunAllocationSchema.safeParse(value);
  if (!parsed.success) throw new ManagedWorkspaceStorageError('invalid_binding');
  const allocation = parsed.data;
  assertDisjoint(allocation.roots, allocation.project);
  const directory = allocation[purpose];
  const root = allocation.roots[purpose];
  if (directory.directory !== managedRunDirectoryPath(root, allocation.owner)) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  await validateWorkspaceProject(authorizedRoots, root);
  const binding = await validateWorkspaceProject(authorizedRoots, directory);
  await Promise.all([assertProtectedWorkspacePath(root, true), assertProtectedWorkspacePath(binding, true)]);
  return binding.directory;
}

export async function validateManagedWorkspaceRoots(roots: ManagedWorkspaceRoots, authorization: WorkspaceAuthorization) {
  if (authorization.fallbackWorkspace && authorization.project) throw new ManagedWorkspaceStorageError('invalid_binding');
  const storage = [roots.scratch, roots.artifacts, ...(authorization.gitCache ? [authorization.gitCache] : [])];
  const bindings = [...storage, ...(authorization.project ? [authorization.project] : [])];
  await Promise.all([
    ...bindings.map((binding) => validateWorkspaceProject(authorization.authorizedRoots, binding)),
    ...(authorization.fallbackWorkspace ? [validateWorkspaceProject(authorization.authorizedRoots, authorization.fallbackWorkspace)] : []),
  ]);
  assertDisjoint(roots, authorization.project, authorization.gitCache);
  const ancestry = await Promise.all(bindings.map(({ directory }) => readWorkspaceAncestorIdentities(directory)));
  for (const [index, binding] of bindings.entries()) {
    if (ancestry.some((ancestors, other) => index !== other && ancestors.has(directoryIdentity(binding)))) {
      throw new ManagedWorkspaceStorageError('overlapping_roots');
    }
  }
  if (authorization.sourceRegistryPath) {
    const knownSources = await listWorkspaceSourceProjects(authorization.sourceRegistryPath,
      authorization.sourceRegistryRoot ?? authorization.authorizedRoots[0]);
    for (const source of knownSources) {
      const sourceAncestors = await readWorkspaceAncestorIdentities(source.directory);
      if (storage.some((root, index) => workspacePathContains(root.directory, source.directory)
        || workspacePathContains(source.directory, root.directory) || ancestry[index].has(directoryIdentity(source))
        || sourceAncestors.has(directoryIdentity(root)))) throw new ManagedWorkspaceStorageError('overlapping_source');
    }
  }
  await Promise.all([
    assertProtectedWorkspacePath(roots.scratch, true), assertProtectedWorkspacePath(roots.artifacts, true),
    ...(authorization.gitCache ? [assertProtectedWorkspacePath(authorization.gitCache)] : []),
    ...(authorization.project ? [assertProtectedWorkspacePath(authorization.project)] : []),
    ...(authorization.fallbackWorkspace ? [assertProtectedWorkspacePath(authorization.fallbackWorkspace)] : []),
  ]);
  return {
    all: new Set(ancestry.flatMap((ancestors) => [...ancestors])),
    storage: new Set(ancestry.slice(0, 2).flatMap((ancestors) => [...ancestors])),
    cache: authorization.gitCache ? ancestry[2] : undefined,
    project: authorization.project ? ancestry[storage.length] : undefined,
  };
}

function assertDisjoint(roots: ManagedWorkspaceRoots, project?: WorkspaceProjectBinding, cache?: WorkspaceProjectBinding): void {
  const bindings = [roots.scratch, roots.artifacts, ...(project ? [project] : []), ...(cache ? [cache] : [])];
  for (const [index, binding] of bindings.entries()) {
    if (bindings.slice(index + 1).some((other) => directoryIdentity(binding) === directoryIdentity(other)
      || workspacePathContains(binding.directory, other.directory) || workspacePathContains(other.directory, binding.directory))) {
      throw new ManagedWorkspaceStorageError('overlapping_roots');
    }
  }
}

export function directoryIdentity(binding: Pick<WorkspaceProjectBinding, 'device' | 'inode'>): string {
  return `${binding.device}:${binding.inode}`;
}

async function allocateDirectory(
  root: WorkspaceProjectBinding, owner: ManagedRunOwner, authorizedRoots: AuthorizedRoots,
): Promise<WorkspaceProjectBinding> {
  await validateWorkspaceProject(authorizedRoots, root);
  await assertProtectedWorkspacePath(root, true);
  const directory = managedRunDirectoryPath(root, owner);
  const binding = await mkdirInsidePinnedRoot(root, path.basename(directory));
  await validateWorkspaceProject(authorizedRoots, root);
  return validateWorkspaceProject(authorizedRoots, binding);
}

export function managedRunDirectoryPath(root: WorkspaceProjectBinding, owner: ManagedRunOwner): string {
  const key = createHash('sha256').update(owner.runId).digest('hex');
  return path.join(root.directory, `${owner.kind}-${key}`);
}
