import { z } from 'zod';
import { sameWorkspaceProject, workspaceProjectBindingSchema } from './workspace.js';
import { workspaceDependencySelectionsSchema, type WorkspaceDependencySelection } from './workspace-dependency.js';

export const MANAGED_DELIVERY_MAX_BYTES = 30_000_000;
export const MANAGED_DELIVERY_MAX_FILES = 5;

export function isManagedArtifactRelativePath(value: string): boolean {
  return value.length <= 2048 && value.split('/').every((part) => part && part !== '.' && part !== '..'
    && !part.startsWith('.lark-retry-') && !/[\\\u0000-\u001f\u007f]/.test(part));
}

export const managedArtifactReferenceSchema = z.strictObject({
  relativePath: z.string().refine(isManagedArtifactRelativePath),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ManagedArtifactReference = z.infer<typeof managedArtifactReferenceSchema>;

export const managedArtifactIdentitySchema = workspaceProjectBindingSchema.pick({ device: true, inode: true });
export const managedArtifactStageSchema = z.strictObject({
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  sha256: managedArtifactReferenceSchema.shape.sha256,
  identity: managedArtifactIdentitySchema.optional(),
});
export type ManagedArtifactStage = z.infer<typeof managedArtifactStageSchema>;

export const managedRunOwnerSchema = z.strictObject({
  kind: z.enum(['foreground', 'cron_prompt', 'async_task']),
  runId: z.string().min(1).max(512),
});

export const managedWorkspaceRootsSchema = z.strictObject({
  scratch: workspaceProjectBindingSchema,
  artifacts: workspaceProjectBindingSchema,
});

const foregroundSessionKey = z.string().min(1).max(1024);
const foregroundDeliveryReceipt = {
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown']),
  messageId: z.string().regex(/^om_/).max(512).optional(),
};

export const foregroundArtifactBatchSchema = z.strictObject({
  version: z.literal(2),
  sessionKey: foregroundSessionKey,
  actorId: z.string().min(1).max(512),
  messageType: z.string().min(1).max(128).refine((type) => type !== 'reaction'),
  chatId: z.string().min(1).max(512),
  sourceMessageId: z.string().regex(/^om_/).max(512),
  threadId: z.string().min(1).max(512).optional(),
  reply: z.strictObject({ text: z.string().min(1), runtimeFooter: z.string().optional(), ...foregroundDeliveryReceipt })
    .refine(({ status, messageId }) => (status === 'sent') === Boolean(messageId)),
  files: z.array(z.strictObject({
    reference: managedArtifactReferenceSchema,
    ...foregroundDeliveryReceipt,
  })).min(1).max(MANAGED_DELIVERY_MAX_FILES).refine((files) =>
    new Set(files.map(({ reference }) => reference.relativePath)).size === files.length
    && files.every(({ status, messageId }) => (status === 'sent') === Boolean(messageId))),
});
export type ForegroundArtifactBatch = z.infer<typeof foregroundArtifactBatchSchema>;

export const unmanagedForegroundAdmissionSchema = z.union([
  z.strictObject({ sessionKey: foregroundSessionKey, project: workspaceProjectBindingSchema }),
  z.strictObject({ sessionKey: foregroundSessionKey, fallbackCwd: workspaceProjectBindingSchema.shape.directory }),
]);

const gitDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const managedGitSelectionSchema = z.strictObject({
  cache: workspaceProjectBindingSchema,
  repositoryId: gitDigest,
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  objectFormat: z.enum(['sha1', 'sha256']),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  key: gitDigest,
  storeFingerprint: gitDigest,
}).refine(({ commit, objectFormat }) => commit.length === (objectFormat === 'sha1' ? 40 : 64));
export type ManagedGitSelection = z.infer<typeof managedGitSelectionSchema>;

export function dependenciesMatchManagedGit(dependencySelections?: WorkspaceDependencySelection[], git?: ManagedGitSelection): boolean {
  return !dependencySelections?.length || !!git && dependencySelections.every(({ identity }) => identity.scope === git.scope);
}

export const managedWorkspaceAdmissionSchema = z.strictObject({
  roots: managedWorkspaceRootsSchema,
  createdAt: z.iso.datetime(),
  fallbackWorkspace: workspaceProjectBindingSchema.optional(),
  git: managedGitSelectionSchema.optional(),
  dependencySelections: workspaceDependencySelectionsSchema.optional(),
}).refine(({ git, fallbackWorkspace, dependencySelections }) => (!git || !fallbackWorkspace) && dependenciesMatchManagedGit(dependencySelections, git));

export function sameManagedGitSelection(a?: ManagedGitSelection, b?: ManagedGitSelection): boolean {
  return a === b || !!a && !!b && sameWorkspaceProject(a.cache, b.cache) && a.repositoryId === b.repositoryId
    && a.scope === b.scope && a.objectFormat === b.objectFormat && a.commit === b.commit
    && a.key === b.key && a.storeFingerprint === b.storeFingerprint;
}

const managedRunIntentObject = z.strictObject({
  version: z.literal(1),
  owner: managedRunOwnerSchema,
  roots: managedWorkspaceRootsSchema,
  project: workspaceProjectBindingSchema.optional(),
  fallbackWorkspace: workspaceProjectBindingSchema.optional(),
  git: managedGitSelectionSchema.optional(),
  dependencySelections: workspaceDependencySelectionsSchema.optional(),
  foregroundSessionKey: foregroundSessionKey.optional(),
  createdAt: z.iso.datetime(),
});
function validDependencyBinding({ dependencySelections, git, project }: z.infer<typeof managedRunIntentObject>): boolean {
  return (!dependencySelections?.length || !!project) && dependenciesMatchManagedGit(dependencySelections, git);
}

export const managedRunIntentSchema = managedRunIntentObject.refine(validDependencyBinding);

export const managedRunAllocationSchema = managedRunIntentObject.extend({
  scratch: workspaceProjectBindingSchema,
  artifacts: workspaceProjectBindingSchema,
  gitCheckout: z.strictObject({ checkout: workspaceProjectBindingSchema, gitDirectory: workspaceProjectBindingSchema }).optional(),
}).refine(validDependencyBinding);

export type ManagedRunOwner = z.infer<typeof managedRunOwnerSchema>;
export type ManagedWorkspaceRoots = z.infer<typeof managedWorkspaceRootsSchema>;
export type ManagedWorkspaceAdmission = z.infer<typeof managedWorkspaceAdmissionSchema>;
export type UnmanagedForegroundAdmission = z.infer<typeof unmanagedForegroundAdmissionSchema>;
export type ManagedRunIntent = z.infer<typeof managedRunIntentSchema>;
export type ManagedRunAllocation = z.infer<typeof managedRunAllocationSchema>;
export type ManagedWorkspacePurpose = 'scratch' | 'artifacts';
