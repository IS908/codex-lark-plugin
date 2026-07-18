import type {
  AsyncTaskInputArtifact,
  AsyncTaskSourceInput,
  ContinuationClaim,
  ContinuationCleanupResult,
  ContinuationCreateRequest,
  ContinuationDeliveryClaim,
  ContinuationDeliveryResult,
  ContinuationExecutionResult,
  ContinuationFailure,
  ContinuationJob,
  ContinuationStatus,
  ContinuationToolCallDecision,
  ContinuationToolCallRecovery,
  ContinuationToolRequest,
  ContinuationToolResult,
} from '../domain/continuation.js';

export interface ContinuationInputInstallResult {
  artifacts: AsyncTaskInputArtifact[];
  installed: boolean;
}

export type ContinuationInputVerification =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'modified' | 'invalid' };

export interface ContinuationInputStorePort {
  ensureRoot(): Promise<void>;
  withCreationLock<T>(jobId: string, operation: () => Promise<T>): Promise<T>;
  install(
    jobId: string,
    sources: readonly AsyncTaskSourceInput[],
    requestFingerprint?: string,
  ): Promise<ContinuationInputInstallResult>;
  clone(
    sourceJobId: string,
    targetJobId: string,
    artifacts: readonly AsyncTaskInputArtifact[],
    requestFingerprint?: string,
  ): Promise<ContinuationInputInstallResult>;
  verify(jobId: string, artifacts: readonly AsyncTaskInputArtifact[]): Promise<ContinuationInputVerification>;
  resolve(jobId: string, relativePath: string): string;
  remove(jobId: string): Promise<void>;
  quarantine(jobId: string): Promise<string | null>;
  restoreQuarantine(jobId: string, token: string): Promise<void>;
  discardQuarantine(jobId: string, token: string): Promise<void>;
  cleanupOrphans(jobIds: ReadonlySet<string>, nowMs?: number): Promise<void>;
}

export interface ContinuationRepository {
  initialize(): Promise<void>;
  healthCheck(): Promise<void>;
  create(request: ContinuationCreateRequest): Promise<{ job: ContinuationJob; created: boolean }>;
  get(jobId: string): Promise<ContinuationJob | null>;
  listByCreator(
    creatorOpenId: string,
    limit: number,
    statuses?: ContinuationStatus[],
  ): Promise<ContinuationJob[]>;
  listAll(limit: number, statuses?: ContinuationStatus[]): Promise<ContinuationJob[]>;
  claimDue(workerId: string, now: string, leaseExpiresAt: string): Promise<ContinuationClaim | null>;
  heartbeat(jobId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  inspectToolCall(claim: ContinuationClaim): Promise<ContinuationToolCallRecovery | null>;
  beginToolCall(
    claim: ContinuationClaim,
    request: ContinuationToolRequest,
    now: string,
  ): Promise<ContinuationToolCallDecision>;
  completeToolCall(
    claim: ContinuationClaim,
    callId: string,
    result: ContinuationToolResult,
    now: string,
  ): Promise<void>;
  completeStep(claim: ContinuationClaim, result: ContinuationExecutionResult, now: string): Promise<void>;
  failAttempt(claim: ContinuationClaim, failure: ContinuationFailure, now: string): Promise<void>;
  requestCancel(jobId: string, now: string): Promise<'cancelled' | 'cancel_requested' | 'terminal' | 'missing'>;
  completeCancellation(claim: ContinuationClaim, now: string): Promise<void>;
  recoverExpiredLeases(now: string): Promise<number>;
  expireOverdue(now: string): Promise<number>;
  cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob>;
  redactTerminal(jobId: string, now: string): Promise<boolean>;
  setRetained(jobId: string, retained: boolean, now: string): Promise<boolean>;
  claimPendingDelivery(workerId: string, now: string): Promise<ContinuationDeliveryClaim | null>;
  markDeliveryResult(
    claim: ContinuationDeliveryClaim,
    result: ContinuationDeliveryResult,
    now: string,
  ): Promise<void>;
  purgeExpired(retainAfter: string, now: string): Promise<ContinuationCleanupResult[]>;
  close(): void;
}

export interface ContinuationExecutor {
  execute(claim: ContinuationClaim, signal: AbortSignal): Promise<ContinuationExecutionResult>;
}

export type ContinuationToolInvocationResult =
  | { status: 'completed'; result: ContinuationToolResult }
  | { status: 'blocked'; errorCode: string; errorSummary: string };

export type ContinuationToolRecoveryResult =
  | { status: 'completed'; tool: string; result: ContinuationToolResult }
  | { status: 'blocked'; tool: string; errorCode: string; errorSummary: string };

export interface ContinuationToolInvoker {
  recover(claim: ContinuationClaim): Promise<ContinuationToolRecoveryResult | null>;
  invoke(
    claim: ContinuationClaim,
    request: ContinuationToolRequest,
    signal: AbortSignal,
  ): Promise<ContinuationToolInvocationResult>;
}

export interface ContinuationDelivery {
  deliver(claim: ContinuationDeliveryClaim): Promise<ContinuationDeliveryResult>;
}

export interface ContinuationClock {
  now(): Date;
}

export interface ContinuationAuditEvent {
  action: string;
  actorOpenId?: string;
  jobId?: string;
  attemptId?: string;
  result: 'ok' | 'denied' | 'error';
  detail?: string;
}

export interface ContinuationAudit {
  record(event: ContinuationAuditEvent): Promise<void>;
}
