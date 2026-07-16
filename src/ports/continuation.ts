import type {
  ContinuationClaim,
  ContinuationCreateRequest,
  ContinuationDeliveryClaim,
  ContinuationDeliveryResult,
  ContinuationExecutionResult,
  ContinuationFailure,
  ContinuationJob,
  ContinuationStepOutcome,
} from '../domain/continuation.js';

export interface ContinuationRepository {
  initialize(): Promise<void>;
  healthCheck(): Promise<void>;
  create(request: ContinuationCreateRequest): Promise<{ job: ContinuationJob; created: boolean }>;
  get(jobId: string): Promise<ContinuationJob | null>;
  listByCreator(creatorOpenId: string, limit: number): Promise<ContinuationJob[]>;
  listAll(limit: number): Promise<ContinuationJob[]>;
  claimDue(workerId: string, now: string, leaseExpiresAt: string): Promise<ContinuationClaim | null>;
  heartbeat(jobId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  completeStep(claim: ContinuationClaim, outcome: ContinuationStepOutcome, now: string): Promise<void>;
  failAttempt(claim: ContinuationClaim, failure: ContinuationFailure, now: string): Promise<void>;
  requestCancel(jobId: string, now: string): Promise<'cancelled' | 'cancel_requested' | 'terminal' | 'missing'>;
  recoverExpiredLeases(now: string): Promise<number>;
  cloneForRetry(jobId: string, requestId: string, now: string): Promise<ContinuationJob>;
  redactTerminal(jobId: string, now: string): Promise<boolean>;
  claimPendingDelivery(workerId: string, now: string): Promise<ContinuationDeliveryClaim | null>;
  markDeliveryResult(
    claim: ContinuationDeliveryClaim,
    result: ContinuationDeliveryResult,
    now: string,
  ): Promise<void>;
  purgeExpired(retainAfter: string, now: string): Promise<number>;
  close(): void;
}

export interface ContinuationExecutor {
  execute(claim: ContinuationClaim, signal: AbortSignal): Promise<ContinuationExecutionResult>;
}

export interface ContinuationTerminalDelivery {
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
