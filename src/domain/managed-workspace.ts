import { z } from 'zod';
import { workspaceProjectBindingSchema } from './workspace.js';

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

export const managedWorkspaceAdmissionSchema = z.strictObject({
  roots: managedWorkspaceRootsSchema,
  createdAt: z.iso.datetime(),
  fallbackWorkspace: workspaceProjectBindingSchema.optional(),
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

export const managedRunIntentSchema = z.strictObject({
  version: z.literal(1),
  owner: managedRunOwnerSchema,
  roots: managedWorkspaceRootsSchema,
  project: workspaceProjectBindingSchema.optional(),
  fallbackWorkspace: workspaceProjectBindingSchema.optional(),
  foregroundSessionKey: foregroundSessionKey.optional(),
  createdAt: z.iso.datetime(),
});

export const managedRunAllocationSchema = managedRunIntentSchema.extend({
  scratch: workspaceProjectBindingSchema,
  artifacts: workspaceProjectBindingSchema,
});

export type ManagedRunOwner = z.infer<typeof managedRunOwnerSchema>;
export type ManagedWorkspaceRoots = z.infer<typeof managedWorkspaceRootsSchema>;
export type ManagedWorkspaceAdmission = z.infer<typeof managedWorkspaceAdmissionSchema>;
export type UnmanagedForegroundAdmission = z.infer<typeof unmanagedForegroundAdmissionSchema>;
export type ManagedRunIntent = z.infer<typeof managedRunIntentSchema>;
export type ManagedRunAllocation = z.infer<typeof managedRunAllocationSchema>;
export type ManagedWorkspacePurpose = 'scratch' | 'artifacts';
