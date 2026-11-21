import type { ManagedRunAllocation, ManagedRunIntent, ManagedRunOwner, ManagedWorkspacePurpose } from '../domain/managed-workspace.js';

export type ManagedWorkspaceAuthorizedRoots = readonly [string, ...string[]];

export interface ManagedWorkspaceRecord {
  allocation: ManagedRunAllocation;
  lastUsedAt: string;
}

export interface ManagedWorkspaceStore {
  get(owner: ManagedRunOwner): ManagedWorkspaceRecord | null;
  ensure(request: Omit<ManagedRunIntent, 'version'> & {
    authorizedRoots: ManagedWorkspaceAuthorizedRoots;
    usedAt?: string;
  }): Promise<ManagedRunAllocation>;
  openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: ManagedWorkspaceAuthorizedRoots): Promise<string>;
}
