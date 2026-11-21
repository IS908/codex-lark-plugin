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
import { pinWorkspacePath, validateWorkspaceProject, workspacePathContains, WorkspaceProjectError } from './workspace-projects.js';

const absolutePath = z.string().refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const configSchema = z.strictObject({ version: z.literal(1), scratchRoot: absolutePath, artifactRoot: absolutePath });

const diagnostic = {
  invalid_config: 'The operator managed workspace configuration is invalid or unreadable.',
  overlapping_roots: 'Managed scratch, artifacts, and the selected source project must use disjoint directories.',
  overlapping_runs: 'The managed workspace would overlap an existing or reserved run directory.',
  allocation_conflict: 'The managed run directory already exists without a matching stored allocation.',
  allocation_failed: 'The managed run directories could not be allocated.',
  allocation_incomplete: 'The stored managed workspace allocation is incomplete.',
  allocation_transaction: 'Managed workspace provisioning requires a committed database context.',
  invalid_binding: 'The managed workspace allocation is invalid.',
} as const;

export class ManagedWorkspaceStorageError extends Error {
  constructor(readonly code: keyof typeof diagnostic) {
    super(diagnostic[code]);
    this.name = 'ManagedWorkspaceStorageError';
  }
}

type AuthorizedRoots = readonly [string, ...string[]];
interface WorkspaceAuthorization {
  authorizedRoots: AuthorizedRoots;
  project?: WorkspaceProjectBinding;
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
  roots, owner, createdAt, ...authorization
}: WorkspaceAuthorization & {
  roots: ManagedWorkspaceRoots;
  owner: ManagedRunOwner;
  createdAt: string;
}): Promise<ManagedRunAllocation> {
  if (!managedRunOwnerSchema.safeParse(owner).success || !z.iso.datetime().safeParse(createdAt).success) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  await validateManagedWorkspaceRoots(roots, authorization);
  const scratch = await allocateDirectory(roots.scratch, owner, authorization.authorizedRoots);
  const artifacts = await allocateDirectory(roots.artifacts, owner, authorization.authorizedRoots);
  return {
    version: 1, owner, roots, scratch, artifacts, createdAt,
    ...(authorization.project ? { project: authorization.project } : {}),
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
  return binding.directory;
}

export async function validateManagedWorkspaceRoots(roots: ManagedWorkspaceRoots, authorization: WorkspaceAuthorization): Promise<void> {
  await Promise.all([
    validateWorkspaceProject(authorization.authorizedRoots, roots.scratch),
    validateWorkspaceProject(authorization.authorizedRoots, roots.artifacts),
    ...(authorization.project ? [validateWorkspaceProject(authorization.authorizedRoots, authorization.project)] : []),
  ]);
  assertDisjoint(roots, authorization.project);
}

function assertDisjoint(roots: ManagedWorkspaceRoots, project?: WorkspaceProjectBinding): void {
  const directories = [roots.scratch.directory, roots.artifacts.directory, ...(project ? [project.directory] : [])];
  for (const [index, directory] of directories.entries()) {
    if (directories.slice(index + 1).some((other) =>
      workspacePathContains(directory, other) || workspacePathContains(other, directory))) {
      throw new ManagedWorkspaceStorageError('overlapping_roots');
    }
  }
}

async function allocateDirectory(
  root: WorkspaceProjectBinding, owner: ManagedRunOwner, authorizedRoots: AuthorizedRoots,
): Promise<WorkspaceProjectBinding> {
  await validateWorkspaceProject(authorizedRoots, root);
  const directory = managedRunDirectoryPath(root, owner);
  try {
    // Non-recursive creation rejects preexisting entries, including unowned links.
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    throw new ManagedWorkspaceStorageError((error as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'allocation_conflict' : 'allocation_failed');
  }
  const binding = await pinWorkspacePath(root.directory, directory);
  if (binding.directory !== directory) throw new WorkspaceProjectError('directory_changed');
  await validateWorkspaceProject(authorizedRoots, root);
  return binding;
}

export function managedRunDirectoryPath(root: WorkspaceProjectBinding, owner: ManagedRunOwner): string {
  const key = createHash('sha256').update(owner.runId).digest('hex');
  return path.join(root.directory, `${owner.kind}-${key}`);
}
