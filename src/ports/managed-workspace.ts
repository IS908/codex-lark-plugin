import type { ManagedRunAllocation, ManagedRunIntent, ManagedRunOwner, ManagedWorkspacePurpose, UnmanagedForegroundAdmission } from '../domain/managed-workspace.js';

export type ManagedWorkspaceAuthorizedRoots = readonly [string, ...string[]];

export interface ManagedWorkspaceRecord {
  allocation: ManagedRunAllocation;
  lastUsedAt: string;
}

export interface ManagedWorkspaceStore {
  get(owner: ManagedRunOwner): ManagedWorkspaceRecord | null;
  getUnmanagedForeground(runId: string): UnmanagedForegroundAdmission | null;
  rememberUnmanagedForeground(runId: string, admission: UnmanagedForegroundAdmission): void;
  ensure(request: Omit<ManagedRunIntent, 'version'> & {
    authorizedRoots: ManagedWorkspaceAuthorizedRoots;
    usedAt?: string;
    sourceRegistryPath?: string;
    sourceRegistryRoot?: string;
  }): Promise<ManagedRunAllocation>;
  openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: ManagedWorkspaceAuthorizedRoots): Promise<string>;
}
