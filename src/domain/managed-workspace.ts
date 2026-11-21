import { z } from 'zod';
import { workspaceProjectBindingSchema } from './workspace.js';

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
});

const foregroundSessionKey = z.string().min(1).max(1024);

export const unmanagedForegroundAdmissionSchema = z.union([
  z.strictObject({ sessionKey: foregroundSessionKey, project: workspaceProjectBindingSchema }),
  z.strictObject({ sessionKey: foregroundSessionKey, fallbackCwd: workspaceProjectBindingSchema.shape.directory }),
]);

export const managedRunIntentSchema = z.strictObject({
  version: z.literal(1),
  owner: managedRunOwnerSchema,
  roots: managedWorkspaceRootsSchema,
  project: workspaceProjectBindingSchema.optional(),
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
