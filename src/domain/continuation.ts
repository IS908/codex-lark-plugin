export const CONTINUATION_LIMITS = {
  titleChars: 200,
  objectiveBytes: 16 * 1024,
  acceptanceCriteriaCount: 32,
  contextSnapshotBytes: 64 * 1024,
  checkpointBytes: 64 * 1024,
  finalMessageBytes: 256 * 1024,
  artifactCount: 20,
  managedArtifactBytesPerJob: 100 * 1024 * 1024,
} as const;

export type ContinuationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ContinuationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'delivery_unknown'
  | 'failed';

export interface ContinuationCheckpoint {
  summary: string;
  completedSteps: string[];
  remainingSteps: string[];
  constraints: string[];
  decisions: string[];
  references: string[];
}

export type ContinuationDeliveryRoute =
  | {
      kind: 'message_thread';
      conversationId: string;
      sourceMessageId: string;
      threadId?: string;
    }
  | {
      kind: 'comment_thread';
      documentToken: string;
      commentId: string;
      fileType: string;
    };

export interface ContinuationCreateRequest {
  idempotencyKey: string;
  retryOfJobId?: string;
  creatorOpenId: string;
  route: ContinuationDeliveryRoute;
  sourceMessageId: string;
  sourceThreadId?: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  contextSnapshot: ContinuationCheckpoint;
  requiredTools: string[];
  workingDirectory: string;
  model?: string;
  parentSessionId?: string;
  maxSteps: number;
  maxRetries: number;
  timeoutSeconds: number;
  createdAt: string;
  expiresAt: string;
}

export interface ContinuationJob extends ContinuationCreateRequest {
  jobId: string;
  rowVersion: number;
  status: ContinuationStatus;
  executionSessionId?: string;
  checkpoint?: ContinuationCheckpoint;
  stepCount: number;
  failureCount: number;
  nextRunAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  resultSummary?: string;
  resultArtifacts: string[];
  errorCode?: string;
  errorSummary?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  deletedAt?: string;
  deliveryStatus?: ContinuationDeliveryStatus;
}

export interface ContinuationAttempt {
  attemptId: string;
  jobId: string;
  ordinal: number;
  workerId: string;
  executionSessionId?: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  outcome?: ContinuationStepOutcome['outcome'] | 'error' | 'cancelled';
  errorCode?: string;
  errorSummary?: string;
}

export interface ContinuationClaim {
  job: ContinuationJob;
  attempt: ContinuationAttempt;
  workerId: string;
  claimedRowVersion: number;
}

export type ContinuationStepOutcome =
  | {
      outcome: 'continue';
      checkpoint: ContinuationCheckpoint;
      nextStep: string;
      resumeAfterSeconds?: number;
    }
  | {
      outcome: 'completed';
      finalMessage: string;
      resultSummary?: string;
      artifacts: string[];
    }
  | {
      outcome: 'failed';
      errorCode: string;
      errorSummary: string;
      retryable: boolean;
      completedWork: string[];
      unperformedWork: string[];
    }
  | {
      outcome: 'blocked';
      errorCode: string;
      errorSummary: string;
      requiredCapability: string;
      completedWork: string[];
      unperformedWork: string[];
    };

export interface ContinuationExecutionResult {
  outcome: ContinuationStepOutcome;
  executionSessionId?: string | null;
}

export interface ContinuationFailure {
  errorCode: string;
  errorSummary: string;
  retryable: boolean;
}

export class ContinuationExecutionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly errorSummary: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(errorSummary, options);
    this.name = 'ContinuationExecutionError';
  }
}

export interface ContinuationDeliveryClaim {
  outboxId: string;
  jobId: string;
  workerId: string;
  route: ContinuationDeliveryRoute;
  idempotencyKey: string;
  payload: string;
  status: Extract<ContinuationDeliveryStatus, 'pending' | 'sending'>;
  attemptCount: number;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
}

export type ContinuationDeliveryResult =
  | { status: 'delivered'; messageId: string }
  | { status: 'retry'; errorCode: string; errorSummary: string }
  | { status: 'delivery_unknown'; errorCode: string; errorSummary: string }
  | { status: 'failed'; errorCode: string; errorSummary: string };

const TERMINAL_STATUSES = new Set<ContinuationStatus>([
  'completed',
  'failed',
  'cancelled',
]);

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export function isContinuationTerminal(status: ContinuationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function retryDelayMs(failureCount: number, jitterUnit: number): number {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Math.floor(failureCount) - 1));
  const base = RETRY_DELAYS_MS[index];
  const boundedJitter = Math.max(0, Math.min(1, jitterUnit));
  return Math.round(base * (1 + boundedJitter * 0.2));
}
