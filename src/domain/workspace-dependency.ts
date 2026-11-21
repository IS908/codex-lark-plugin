import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { sameWorkspaceProject, workspaceProjectBindingSchema } from './workspace.js';

export const dependencyScopeSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/);
export const dependencyDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const dependencyToolchainSchema = z.strictObject({
  runtime: token,
  installer: token,
  abi: token,
  platform: z.enum(['darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  platformAbi: token,
});

export const workspaceDependencyNpmRegistrySchema = z.string().max(2048).refine((value) => {
  if (/[\s\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.href === value
      && /^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(url.pathname);
  } catch { return false; }
});

const commonIdentity = { version: z.literal(1), scope: dependencyScopeSchema, toolchain: dependencyToolchainSchema, lockSha256: dependencyDigestSchema };
const identityShape = z.discriminatedUnion('ecosystem', [
  z.strictObject({ ...commonIdentity, ecosystem: z.literal('npm'), policy: z.literal('npm-ci-offline-no-scripts-v1'),
    registry: workspaceDependencyNpmRegistrySchema, manifestSha256: dependencyDigestSchema, key: dependencyDigestSchema }),
  z.strictObject({ ...commonIdentity, ecosystem: z.literal('pip'), policy: z.literal('pip-offline-hashed-wheels-v1'), key: dependencyDigestSchema }),
]);
export type WorkspaceDependencyIdentity = z.infer<typeof identityShape>;
export type WorkspaceDependencyEcosystem = WorkspaceDependencyIdentity['ecosystem'];

type CompatibilityInputs = Omit<Extract<WorkspaceDependencyIdentity, { ecosystem: 'npm' }>, 'key'>
  | Omit<Extract<WorkspaceDependencyIdentity, { ecosystem: 'pip' }>, 'key'>;

export function workspaceDependencyCompatibilityKey(identity: CompatibilityInputs): string {
  const { ecosystem, policy, scope, lockSha256, toolchain: { runtime, installer, abi, platform, arch, platformAbi } } = identity;
  const parts = ['workspace-dependencies-v1', scope, runtime, installer, abi, platform, arch, platformAbi, lockSha256, ecosystem, policy];
  if (identity.ecosystem === 'npm') parts.push(identity.registry, identity.manifestSha256);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export const workspaceDependencyIdentitySchema = identityShape.refine((identity) =>
  workspaceDependencyCompatibilityKey(identity) === identity.key, 'Invalid dependency compatibility identity.');

export const workspaceDependencyBindingSchema = workspaceProjectBindingSchema.refine(({ directory }) => path.resolve(directory) === directory
  && directory.length <= 4096 && !/[\u0000-\u001f\u007f*?\[\]]/.test(directory));

export const workspaceDependencyToolchainConfigSchema = z.strictObject({
  ecosystem: z.enum(['npm', 'pip']),
  executable: z.string().max(4096).refine((value) => path.isAbsolute(value) && path.resolve(value) === value
    && !/[\u0000-\u001f\u007f*?\[\]]/.test(value)),
  runtime: workspaceDependencyBindingSchema,
  installer: workspaceDependencyBindingSchema,
});
export type WorkspaceDependencyToolchainConfig = z.infer<typeof workspaceDependencyToolchainConfigSchema>;

export function workspaceDependencyToolchainBindingDigest({ ecosystem, executable, runtime, installer }: WorkspaceDependencyToolchainConfig): string {
  return createHash('sha256').update(JSON.stringify(['workspace-toolchain-binding-v1', ecosystem, executable,
    [runtime.directory, runtime.device, runtime.inode], [installer.directory, installer.device, installer.inode]])).digest('hex');
}

export const workspaceDependencySelectionSchema = z.strictObject({
  identity: workspaceDependencyIdentitySchema,
  cache: workspaceDependencyBindingSchema,
  artifactManifestSha256: dependencyDigestSchema,
  cacheFingerprint: dependencyDigestSchema,
  toolchainFingerprint: dependencyDigestSchema.optional(),
  toolchainBindingDigest: dependencyDigestSchema.optional(),
}).refine(({ toolchainFingerprint, toolchainBindingDigest }) => (toolchainFingerprint === undefined) === (toolchainBindingDigest === undefined),
  'A measured toolchain requires its declared binding.');
export type WorkspaceDependencySelection = z.infer<typeof workspaceDependencySelectionSchema>;

export const workspaceDependencyInstallNonceSchema = z.string().regex(/^[0-9a-f]{24}$/);
export const workspaceDependencyInstallReceiptSchema = z.strictObject({
  output: workspaceDependencyBindingSchema,
  measurement: z.strictObject({ digest: dependencyDigestSchema, bytes: z.int().min(0).max(4 * 1024 ** 3), entries: z.int().min(1).max(200_000) }),
});
export type WorkspaceDependencyInstallReceipt = z.infer<typeof workspaceDependencyInstallReceiptSchema>;
export type WorkspaceDependencyInstallRecord = { nonce: string; receipt?: WorkspaceDependencyInstallReceipt };

export function workspaceDependencyInstallLeaf(nonce: string): string {
  return `lark-dependency-install-${workspaceDependencyInstallNonceSchema.parse(nonce)}`;
}

export function workspaceDependencyOutputName(ecosystem: WorkspaceDependencyEcosystem): string {
  return ecosystem === 'npm' ? 'node_modules' : 'python-deps';
}

export const workspaceDependencySelectionsSchema = z.array(workspaceDependencySelectionSchema).max(2).refine((selections) =>
  new Set(selections.map(({ identity }) => identity.ecosystem)).size === selections.length
  && new Set(selections.map(({ cache }) => `${cache.device}:${cache.inode}`)).size === selections.length
  && new Set(selections.map(({ cache }) => cache.directory)).size === selections.length,
  'Select distinct dependency caches with at most one per ecosystem.');

export function sameWorkspaceDependencySelections(a?: readonly WorkspaceDependencySelection[], b?: readonly WorkspaceDependencySelection[]): boolean {
  return a === b || !!a && !!b && a.length === b.length && a.every((selection) => {
    const other = b.find(({ identity }) => identity.ecosystem === selection.identity.ecosystem);
    return !!other && selection.identity.key === other.identity.key && sameWorkspaceProject(selection.cache, other.cache)
      && selection.artifactManifestSha256 === other.artifactManifestSha256 && selection.cacheFingerprint === other.cacheFingerprint
      && selection.toolchainFingerprint === other.toolchainFingerprint && selection.toolchainBindingDigest === other.toolchainBindingDigest;
  });
}
