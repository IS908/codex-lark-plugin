import path from 'node:path';
import { z } from 'zod';

export const workspaceProjectBindingSchema = z.strictObject({
  directory: z.string().refine((value) => path.isAbsolute(value) && !value.includes('\0')),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});

export type WorkspaceProjectBinding = z.infer<typeof workspaceProjectBindingSchema>;

export interface WorkspaceDirectoryGuard {
  binding: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
  auxiliaryBindings?: WorkspaceProjectBinding[];
}

export function sameWorkspaceProject(
  first: WorkspaceProjectBinding | undefined,
  second: WorkspaceProjectBinding | undefined,
): boolean {
  return first === second || !!first && !!second &&
    first.directory === second.directory && first.device === second.device && first.inode === second.inode;
}
