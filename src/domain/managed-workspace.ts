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

export const managedRunIntentSchema = z.strictObject({
  version: z.literal(1),
  owner: managedRunOwnerSchema,
  roots: managedWorkspaceRootsSchema,
  project: workspaceProjectBindingSchema.optional(),
  foregroundSessionKey: z.string().min(1).max(1024).optional(),
  createdAt: z.iso.datetime(),
});

export const managedRunAllocationSchema = managedRunIntentSchema.extend({
  scratch: workspaceProjectBindingSchema,
  artifacts: workspaceProjectBindingSchema,
});

export type ManagedRunOwner = z.infer<typeof managedRunOwnerSchema>;
export type ManagedWorkspaceRoots = z.infer<typeof managedWorkspaceRootsSchema>;
export type ManagedWorkspaceAdmission = z.infer<typeof managedWorkspaceAdmissionSchema>;
export type ManagedRunIntent = z.infer<typeof managedRunIntentSchema>;
export type ManagedRunAllocation = z.infer<typeof managedRunAllocationSchema>;
export type ManagedWorkspacePurpose = 'scratch' | 'artifacts';
