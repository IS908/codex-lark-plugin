import type { ForegroundArtifactBatch, ManagedArtifactStage, ManagedRunAllocation, ManagedRunIntent, ManagedRunOwner, ManagedWorkspacePurpose, UnmanagedForegroundAdmission } from '../domain/managed-workspace.js';

export type { ManagedArtifactStage } from '../domain/managed-workspace.js';

export type ManagedWorkspaceAuthorizedRoots = readonly [string, ...string[]];

export interface ManagedWorkspaceRecord {
  allocation: ManagedRunAllocation;
  lastUsedAt: string;
}

export interface ManagedArtifactStageJournal {
  get(relativePath: string): ManagedArtifactStage | null;
  reserve(relativePath: string, stage: ManagedArtifactStage): void;
  pin(relativePath: string, nonce: string, identity: NonNullable<ManagedArtifactStage['identity']>): void;
  release(relativePath: string, nonce: string): void;
}

export interface ManagedWorkspaceStore {
  get(owner: ManagedRunOwner): ManagedWorkspaceRecord | null;
  getUnmanagedForeground(runId: string): UnmanagedForegroundAdmission | null;
  rememberUnmanagedForeground(runId: string, admission: UnmanagedForegroundAdmission): void;
  getForegroundArtifacts(runId: string): ForegroundArtifactBatch | null;
  listPendingForegroundRuns(afterRunId: string): string[];
  rememberForegroundArtifacts(runId: string, batch: ForegroundArtifactBatch): void;
  retryArtifactStages(owner: ManagedRunOwner): ManagedArtifactStageJournal;
  transitionForegroundArtifact(runId: string, part: number | 'reply', expected: 'pending' | 'sending',
    status: Exclude<ForegroundArtifactBatch['files'][number]['status'], 'pending'>, messageId?: string): boolean;
  ensure(request: Omit<ManagedRunIntent, 'version'> & {
    authorizedRoots: ManagedWorkspaceAuthorizedRoots;
    usedAt?: string;
    sourceRegistryPath?: string;
    sourceRegistryRoot?: string;
  }): Promise<ManagedRunAllocation>;
  openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: ManagedWorkspaceAuthorizedRoots): Promise<string>;
}
