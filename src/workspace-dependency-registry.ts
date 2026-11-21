import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ManagedGitSelection, ManagedWorkspaceRoots } from './domain/managed-workspace.js';
import { workspaceDependencyBindingSchema as binding, workspaceDependencyNpmRegistrySchema,
  type WorkspaceDependencySelection } from './domain/workspace-dependency.js';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { resolveManagedGitSelection } from './managed-git-registry.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities } from './managed-workspace-ancestry.js';
import { verifyWorkspaceDependencyCache } from './workspace-dependency-cache.js';
import { describeWorkspaceDependencies, type WorkspaceDependencyInput } from './workspace-dependency-input.js';
import { readWorkspaceGitDependencyInputs } from './workspace-git-snapshot.js';
import { readWorkspaceDependencyMountPolicy, type WorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { pinWorkspacePath, validateWorkspaceProject } from './workspace-projects.js';

const REGISTRY = 'workspace-dependencies.json';
const MANIFESTS = 'workspace-dependency-manifests';
const REGISTRY_BYTES = 256 * 1024;
const MANIFEST_BYTES = 8 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const ecosystem = z.enum(['npm', 'pip']);
const policy = z.discriminatedUnion('ecosystem', [
  z.strictObject({ ecosystem: z.literal('npm'), registry: workspaceDependencyNpmRegistrySchema }),
  z.strictObject({ ecosystem: z.literal('pip') }),
]);
const registrySchema = z.strictObject({ version: z.literal(1),
  projects: z.array(z.strictObject({ source: binding, repositoryId: digest, policies: z.array(policy).min(1).max(2)
    .refine((policies) => new Set(policies.map(({ ecosystem }) => ecosystem)).size === policies.length) })).max(128),
  caches: z.array(z.strictObject({ scope, key: digest, ecosystem, cache: binding, artifactManifestSha256: digest })).max(128),
});

const messages = {
  dependency_registry_invalid: 'The operator dependency cache registry is invalid or unreadable.',
  dependency_write_overlap: 'An effective write directory overlaps the registered dependency caches or their policy directory.',
  dependency_write_layout_unsupported: 'The effective writable directory has an unsupported mount layout.',
  dependency_launch_unsupported: 'This Codex launch configuration cannot enforce the dependency cache write boundary.',
  dependency_runtime_home_required: 'Dependency cache protection requires a pre-existing, dedicated absolute CODEX_HOME outside the policy and cache locations.',
  dependency_storage_unverifiable: 'A host storage path cannot be verified against the dependency cache boundary.',
  dependency_project_unavailable: 'Dependency reuse requires the registered project and its authorized isolated Git commit.',
  dependency_toolchain_unavailable: 'A selected dependency installer toolchain is unavailable.',
  dependency_cache_unavailable: 'No operator-approved cache matches the dependency compatibility key.',
  dependency_manifest_missing: 'The selected dependency artifact manifest is missing.',
  dependency_manifest_invalid: 'The selected dependency artifact manifest is invalid or unreadable.',
  dependency_manifest_mismatch: 'The selected dependency artifact manifest does not match the approved digest.',
  dependency_selection_revoked: 'The saved dependency selection no longer matches the operator policy.',
} as const;

export class WorkspaceDependencyPolicyError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'WorkspaceDependencyPolicyError';
  }
}

type PreparedDependency = { selection: WorkspaceDependencySelection; stagedLock: string; npmManifest?: Buffer };

export async function resolveWorkspaceDependencySelections(request: {
  configPath?: string;
  authorizedRoots: readonly [string, ...string[]];
  roots?: ManagedWorkspaceRoots;
  project?: WorkspaceProjectBinding;
  git?: ManagedGitSelection;
  sourceRegistryPath?: string;
  sourceRegistryRoot?: string;
  toolchains: Partial<Record<z.infer<typeof ecosystem>, WorkspaceDependencyInput['toolchain']>>;
  expected?: readonly WorkspaceDependencySelection[];
}): Promise<PreparedDependency[]> {
  const { project, git, authorizedRoots, expected, roots } = request;
  if (expected?.length === 0) return [];
  const registry = await readRegistry(request.configPath);
  const inactive = () => expected ? fail('dependency_selection_revoked') : [];
  if (!registry || !project) return inactive();
  const entry = registry.projects.find(({ source }) => source.directory === project.directory);
  if (!entry) return inactive();
  if (!roots || !git || git.repositoryId !== entry.repositoryId || !sameWorkspaceProject(entry.source, project)) {
    return fail(expected ? 'dependency_selection_revoked' : 'dependency_project_unavailable');
  }
  const assertGit = async (revoked: boolean) => {
    try {
      if (await resolveManagedGitSelection({ configPath: request.configPath, roots, project, authorizedRoots,
        sourceRegistryPath: request.sourceRegistryPath, sourceRegistryRoot: request.sourceRegistryRoot, expected: git })) return;
    } catch { /* Do not surface Git policy details from dependency selection. */ }
    fail(revoked ? 'dependency_selection_revoked' : 'dependency_project_unavailable');
  };
  await assertGit(Boolean(expected));
  const policies = [...entry.policies].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem));
  if (expected && (expected.length !== policies.length || policies.some(({ ecosystem }) =>
    expected.filter(({ identity }) => identity.ecosystem === ecosystem).length !== 1))) fail('dependency_selection_revoked');
  const filenames = policies.flatMap(({ ecosystem }) => ecosystem === 'pip' ? ['requirements.lock'] : ['package.json', 'package-lock.json']);
  const files = await readWorkspaceGitDependencyInputs({ gitDirectory: git.cache, authorizedRoots, ...git }, git, filenames);
  const prepared: PreparedDependency[] = [];
  const approvedEntries: typeof registry.caches = [];
  for (const policy of policies) {
    const toolchain = request.toolchains[policy.ecosystem] ?? fail('dependency_toolchain_unavailable');
    const identityFields = { scope: git.scope, toolchain };
    const input = policy.ecosystem === 'pip'
      ? { ...policy, ...identityFields, lock: files.get('requirements.lock')! }
      : { ...policy, ...identityFields, lock: files.get('package-lock.json')!, manifest: files.get('package.json')! };
    const { key } = describeWorkspaceDependencies(input);
    const approved = registry.caches.find((entry) => entry.key === key && entry.scope === input.scope && entry.ecosystem === input.ecosystem);
    if (!approved) fail(expected ? 'dependency_selection_revoked' : 'dependency_cache_unavailable');
    approvedEntries.push(approved);
    const previous = expected?.find(({ identity }) => identity.ecosystem === input.ecosystem);
    if (previous && (previous.identity.key !== key || !sameWorkspaceProject(previous.cache, approved.cache)
      || previous.artifactManifestSha256 !== approved.artifactManifestSha256)) fail('dependency_selection_revoked');
    const artifactManifest = await readProtectedJson(path.join(registry.directory, MANIFESTS, `${key}.json`), MANIFEST_BYTES,
      'dependency_manifest_invalid');
    if (artifactManifest === undefined) fail('dependency_manifest_missing');
    if (!Array.isArray(artifactManifest)) fail('dependency_manifest_invalid');
    const measured = await verifyWorkspaceDependencyCache({ input, artifactManifest, cache: approved.cache, authorizedRoots,
      expectedFingerprint: previous?.cacheFingerprint });
    if (measured.artifactManifestSha256 !== approved.artifactManifestSha256) fail('dependency_manifest_mismatch');
    const { cache, identity, artifactManifestSha256, cacheFingerprint } = measured;
    prepared.push({ selection: { cache, identity, artifactManifestSha256, cacheFingerprint }, stagedLock: measured.stagedLock,
      ...(input.ecosystem === 'npm' ? { npmManifest: input.manifest } : {}) });
  }
  // Revoke, rather than substitute, if observed policy changed during expensive verification.
  await assertGit(true);
  const current = await readRegistry(request.configPath);
  const currentProject = current?.projects.find(({ source }) => source.directory === project.directory);
  if (JSON.stringify(currentProject) !== JSON.stringify(entry) || approvedEntries.some((approved) =>
    JSON.stringify(current?.caches.find(({ key }) => key === approved.key)) !== JSON.stringify(approved))) fail('dependency_selection_revoked');
  return prepared;
}

// Call with actual effective write roots, regardless of whether the run opted in to dependency reuse.
export async function assertWorkspaceDependencyWriteIsolation(configPath: string | undefined, writableRoots: readonly string[]): Promise<void> {
  await (await loadWorkspaceDependencyWriteGuard(configPath))?.assertWrites(writableRoots);
}

// Verify current operator approval independently of the stored intent. Installer preflight verifies artifact bytes and the actual toolchain.
export async function assertWorkspaceDependencySelectionAuthorized(configPath: string, project: WorkspaceProjectBinding | undefined,
  git: ManagedGitSelection | undefined, dependencies: readonly WorkspaceDependencySelection[] | undefined): Promise<void> {
  if (!dependencies?.length) return;
  const registry = await readRegistry(configPath);
  const entry = registry?.projects.find(({ source }) => sameWorkspaceProject(source, project));
  if (!registry || !entry || !git || git.repositoryId !== entry.repositoryId || dependencies.length !== entry.policies.length) {
    fail('dependency_selection_revoked');
  }
  for (const dependency of dependencies) {
    const { identity, cache, artifactManifestSha256 } = dependency;
    const policy = entry.policies.find(({ ecosystem }) => ecosystem === identity.ecosystem);
    if (!policy || (policy.ecosystem === 'npm' && (identity.ecosystem !== 'npm' || policy.registry !== identity.registry))
      || identity.scope !== git.scope || !registry.caches.some((candidate) => candidate.ecosystem === identity.ecosystem
        && candidate.key === identity.key && candidate.scope === identity.scope && candidate.artifactManifestSha256 === artifactManifestSha256
        && sameWorkspaceProject(candidate.cache, cache))) fail('dependency_selection_revoked');
  }
}

export async function loadWorkspaceDependencyWriteGuard(configPath?: string, options?: { allowMissingCachesForStorage?: boolean }) {
  const registry = await readRegistry(configPath, options?.allowMissingCachesForStorage);
  if (!registry) return undefined;
  const check = (directory: string, writable: Location, protectedLocations: Location[]) => {
    if (protectedLocations.some((protectedLocation) => overlap(writable, protectedLocation, registry.mounts.contains))) fail('dependency_write_overlap');
    if (!registry.mounts.supports(directory)) fail('dependency_write_layout_unsupported');
  };
  return {
    protectedBindings: registry.protected.map(({ binding }) => binding),
    async assertWrites(writableRoots: readonly string[], additionalProtected: readonly string[] = []) {
      const protectedLocations = [...registry.protected];
      for (const directory of additionalProtected) {
        protectedLocations.push(await describeLocation(await pinWorkspacePath(directory, '.'), registry.mounts));
      }
      for (const directory of new Set(writableRoots)) {
        const binding = await pinWorkspacePath(directory, '.');
        check(binding.directory, await describeLocation(binding, registry.mounts), protectedLocations);
      }
    },
    async assertNewDirectory(directory: string) {
      const parent = await pinWorkspacePath(path.dirname(directory), '.');
      const canonical = path.join(parent.directory, path.basename(directory));
      check(canonical, { id: '', ancestors: await readWorkspaceAncestorIdentities(parent.directory),
        aliases: registry.mounts.aliases(canonical) }, registry.protected);
      await assertProtectedWorkspacePath(parent, false, true);
      return parent;
    },
    async assertStorageDirectories(directories: readonly string[]) {
      for (const directory of new Set(directories)) {
        const { parent, target, missing } = await projectStorageDirectory(directory);
        check(target, { id: missing ? '' : `${parent.device}:${parent.inode}`,
          ancestors: await readWorkspaceAncestorIdentities(parent.directory), aliases: registry.mounts.aliases(target) }, registry.protected);
        await assertProtectedWorkspacePath(parent, false, missing);
      }
    },
  };
}

export async function hasWorkspaceDependencyRegistry(configPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(path.dirname(path.resolve(configPath)), REGISTRY));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return fail('dependency_registry_invalid');
  }
}

async function readRegistry(configPath?: string, allowMissingCachesForStorage = false) {
  if (!configPath) return undefined;
  const directory = path.dirname(path.resolve(configPath));
  const raw = await readProtectedJson(path.join(directory, REGISTRY), REGISTRY_BYTES, 'dependency_registry_invalid');
  if (raw === undefined) return undefined;
  try {
    const registry = registrySchema.parse(raw);
    const projectIds = new Set<string>();
    const projectPaths = new Set<string>();
    const keys = new Set<string>();
    const mounts = await readWorkspaceDependencyMountPolicy();
    if (!mounts.supports(directory)) fail('dependency_registry_invalid');
    const protectedLocations = [await describeLocation(await pinWorkspacePath(directory, '.'), mounts)];
    for (const { source } of registry.projects) {
      const id = `${source.device}:${source.inode}`;
      if (projectIds.has(id) || projectPaths.has(source.directory)) fail('dependency_registry_invalid');
      projectIds.add(id);
      projectPaths.add(source.directory);
    }
    for (const { cache, key } of registry.caches) {
      if (keys.has(key)) fail('dependency_registry_invalid');
      keys.add(key);
      let location;
      if (allowMissingCachesForStorage && !await pathExists(cache.directory)) {
        const { parent, target } = await projectStorageDirectory(cache.directory);
        await assertProtectedWorkspacePath(parent, false, true);
        if (!mounts.supports(target)) fail('dependency_registry_invalid');
        location = { binding: cache, id: `${cache.device}:${cache.inode}`, ancestors: await readWorkspaceAncestorIdentities(parent.directory),
          aliases: mounts.aliases(target) };
      } else {
        const current = await validateWorkspaceProject(cache.directory, cache);
        await assertProtectedWorkspacePath(current);
        if (!mounts.supports(current.directory)) fail('dependency_registry_invalid');
        location = await describeLocation(current, mounts);
      }
      if (protectedLocations.some((other) => overlap(location, other, mounts.contains))) fail('dependency_registry_invalid');
      protectedLocations.push(location);
    }
    return { ...registry, directory, mounts, protected: protectedLocations };
  } catch { return fail('dependency_registry_invalid'); }
}

async function projectStorageDirectory(directory: string) {
  const suffix: string[] = [];
  let current = path.resolve(directory);
  while (!await pathExists(current)) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  const parent = await pinWorkspacePath(current, '.');
  return { parent, target: path.join(parent.directory, ...suffix), missing: suffix.length > 0 };
}

async function pathExists(candidate: string): Promise<boolean> {
  try { await fs.lstat(candidate); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readProtectedJson(filename: string, limit: number,
  code: 'dependency_registry_invalid' | 'dependency_manifest_invalid'): Promise<unknown | undefined> {
  try {
    const first = await fs.lstat(filename, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!first) return undefined;
    const directory = path.dirname(filename);
    const parent = await pinWorkspacePath(directory, '.');
    if (!process.geteuid || parent.directory !== directory || !first.isFile() || first.uid !== BigInt(process.geteuid())
      || first.nlink !== 1n || (first.mode & 0o022n) !== 0n || first.size < 1n || first.size > BigInt(limit)) fail(code);
    await assertProtectedWorkspacePath(parent, true);
    await assertDenyOnlyWorkspaceAcls([filename]);
    const descriptor = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!sameFile(first, await descriptor.stat({ bigint: true }))) fail(code);
      const buffer = Buffer.alloc(Number(first.size));
      const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length || !sameFile(first, await descriptor.stat({ bigint: true }))
        || !sameFile(first, await fs.lstat(filename, { bigint: true }))) fail(code);
      await validateWorkspaceProject(directory, parent);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } finally { await descriptor.close(); }
  } catch { return fail(code); }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.uid === b.uid
    && a.gid === b.gid && a.nlink === b.nlink && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

async function describeLocation(binding: WorkspaceProjectBinding, mounts: WorkspaceDependencyMountPolicy) {
  return { binding, id: `${binding.device}:${binding.inode}`, ancestors: await readWorkspaceAncestorIdentities(binding.directory),
    aliases: mounts.aliases(binding.directory) };
}

type Location = Omit<Awaited<ReturnType<typeof describeLocation>>, 'binding'>;

function overlap(a: Location, b: Location, contains: WorkspaceDependencyMountPolicy['contains']): boolean {
  return a.ancestors.has(b.id) || b.ancestors.has(a.id) || a.aliases.some((left) => b.aliases.some((right) =>
    contains(left, right) || contains(right, left)));
}

function fail(code: keyof typeof messages): never { throw new WorkspaceDependencyPolicyError(code); }
