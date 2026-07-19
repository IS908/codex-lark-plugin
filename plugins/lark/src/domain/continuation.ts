import type {
  DurableRunClaim,
  DurableRunDeliveryClaim,
  DurableRunFailure,
} from './durable-run.js';

export const CONTINUATION_LIMITS = {
  titleChars: 200,
  objectiveBytes: 16 * 1024,
  deliverableCount: 32,
  acceptanceCriteriaCount: 32,
  verificationRequirementCount: 32,
  inputFileCount: 32,
  inputBytesPerFile: 25 * 1024 * 1024,
  managedInputBytesPerJob: 100 * 1024 * 1024,
  contextSnapshotBytes: 64 * 1024,
  checkpointBytes: 64 * 1024,
  toolResultBytes: 64 * 1024,
  finalMessageBytes: 256 * 1024,
  artifactCount: 20,
  requestedPathCount: 32,
  managedArtifactBytesPerJob: 100 * 1024 * 1024,
  managedArtifactEntriesPerJob: 256,
  managedArtifactDirectoryDepth: 8,
  resumeInputChars: 4_096,
} as const;

export const CONTINUATION_CONTRACT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;

export interface AsyncTaskDeliverable {
  id: string;
  description: string;
  required: boolean;
}

export interface AsyncTaskAcceptanceCriterion {
  id: string;
  description: string;
  deliverableIds: string[];
}

export type AsyncTaskVerificationKind =
  | 'artifact_exists'
  | 'artifact_sha256'
  | 'evidence_reference';

export interface AsyncTaskVerificationRequirement {
  id: string;
  description: string;
  kind: AsyncTaskVerificationKind;
}

export type ContinuationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'recovering'
  | 'waiting_user'
  | 'cancel_requested'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type ContinuationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'delivery_unknown'
  | 'failed'
  | 'superseded';

export type ContinuationDeliveryKind = 'progress' | 'interrupt' | 'terminal';

export interface ContinuationDeliveryRecord {
  eventKey: string;
  kind: ContinuationDeliveryKind;
  attemptId?: string;
  status: ContinuationDeliveryStatus;
  attemptCount: number;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationCleanupResult {
  jobId: string;
  creatorOpenId: string;
  status: Extract<ContinuationStatus, 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled'>;
  completedAt: string;
  result: 'cleaned' | 'error';
  errorSummary?: string;
}

export interface ContinuationCheckpoint {
  summary: string;
  completedSteps: string[];
  remainingSteps: string[];
  constraints: string[];
  decisions: string[];
  references: string[];
}

export interface ContinuationCheckpointStep {
  id: string;
  description: string;
}

export interface ContinuationCheckpointArtifact {
  id: string;
  deliverableId: string;
  path: string;
  sha256: string;
}

export interface ContinuationCheckpointEvidence {
  id: string;
  requirementId: string;
  criterionIds: string[];
  artifactId?: string;
  reference?: string;
}

export interface ContinuationCheckpointSideEffect {
  id: string;
  description: string;
  idempotencyKey: string;
}

export interface ContinuationCheckpointV2 {
  schemaVersion: 2;
  summary: string;
  currentStepId: string;
  completedStepIds: string[];
  completedCriterionIds: string[];
  completedDeliverableIds: string[];
  remainingSteps: ContinuationCheckpointStep[];
  artifacts: ContinuationCheckpointArtifact[];
  evidence: ContinuationCheckpointEvidence[];
  sideEffects: ContinuationCheckpointSideEffect[];
  constraints: string[];
  decisions: string[];
  nextAction: ContinuationCheckpointStep | null;
  stopReason: string;
}

export interface ContinuationRecoveryState {
  failure: DurableRunFailure;
  fingerprintAttempts: number;
  totalAttempts: number;
  lastDecision: 'retry' | 'wait_user' | 'block' | 'fail';
  userInput?: string;
}

export type ContinuationInterruptStatus = 'pending' | 'delivered' | 'resolved';

export interface ContinuationInterrupt {
  interruptId: string;
  jobId: string;
  attemptId: string;
  status: ContinuationInterruptStatus;
  prompt: string;
  deliveredMessageId?: string;
  responseText?: string;
  createdAt: string;
  deliveredAt?: string;
  resolvedAt?: string;
}

export interface ContinuationPendingInterruptRoute {
  interruptId: string;
  jobId: string;
  route: ContinuationDeliveryRoute;
  deliveredMessageId?: string;
}

export interface ContinuationAttemptDelta {
  schemaVersion: 1;
  stepId: string;
  checkpointHash: string;
  materialHash: string;
  stateChanged: boolean;
  newCompletedStepIds: string[];
  newCompletedCriterionIds: string[];
  newCompletedDeliverableIds: string[];
  newArtifactIds: string[];
  newEvidenceIds: string[];
  newSideEffectIds: string[];
  nextActionStepId?: string;
}

export interface ContinuationVerificationVerdict {
  status: 'accepted' | 'revision_required';
  findings: string[];
}

export type AsyncTaskInputKind = 'message_image' | 'message_attachment';

export interface AsyncTaskInputArtifact {
  id: string;
  kind: AsyncTaskInputKind;
  fileName: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface AsyncTaskSourceInput {
  kind: AsyncTaskInputKind;
  fileName: string;
  sourcePath: string;
  expectedSha256?: string;
  expectedSizeBytes?: number;
}

export type ContinuationFilesystemMode = 'read-only' | 'workspace-write';
export type ContinuationApprovalMode = 'never' | 'interactive';
export type ContinuationCapabilityProfile = 'bounded' | 'trusted_personal_workspace';

export interface ContinuationPermissionEnvelope {
  profile: ContinuationCapabilityProfile;
  filesystem: {
    root: string;
    mode: ContinuationFilesystemMode;
    requestedPaths: string[];
  };
  hostTools: string[];
  network: 'none' | 'enabled';
  externalSideEffects: 'denied' | 'allowed';
  approval: {
    mode: ContinuationApprovalMode;
  };
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

export interface AsyncTaskFactSnapshot {
  schemaVersion: 1;
  provenance: 'captured' | 'legacy_unavailable';
  originalUserText: string | null;
  sourceContextText: string | null;
  quotedMessageText: string | null;
  creatorOpenId: string;
  chatId: string;
  chatType: string;
  route: ContinuationDeliveryRoute;
  sourceMessageId: string;
  sourceThreadId?: string;
  sourceMessageType: string | null;
  sourceTimestamp: string | null;
  inputs: AsyncTaskInputArtifact[];
  workingDirectory: string;
  model: string | null;
  permissions: ContinuationPermissionEnvelope;
}

export interface AsyncTaskContract {
  schemaVersion: 1;
  title: string;
  objective: string;
  deliverables: AsyncTaskDeliverable[];
  acceptanceCriteria: AsyncTaskAcceptanceCriterion[];
  verificationRequirements: AsyncTaskVerificationRequirement[];
  initialContext: ContinuationCheckpoint;
}

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
  sourceFacts: AsyncTaskFactSnapshot;
  taskContract: AsyncTaskContract;
  sourceInputs: AsyncTaskSourceInput[];
  resumeCheckpoint?: ContinuationCheckpointV2;
  resumeArtifactSourceJobId?: string;
  requiredTools: string[];
  workingDirectory: string;
  permissions: ContinuationPermissionEnvelope;
  model?: string;
  parentSessionId?: string;
  maxAttempts: number;
  maxRetries: number;
  timeoutSeconds: number;
  createdAt: string;
  expiresAt: string;
}

export interface ContinuationJob extends Omit<ContinuationCreateRequest, 'sourceInputs'> {
  jobId: string;
  rowVersion: number;
  status: ContinuationStatus;
  executionSessionId?: string;
  checkpoint?: ContinuationCheckpointV2;
  lastAttemptDelta?: ContinuationAttemptDelta;
  lastVerification?: ContinuationVerificationVerdict;
  recovery?: ContinuationRecoveryState;
  recoveryTotalCount: number;
  recoveryFingerprintCounts: Record<string, number>;
  currentInterrupt?: ContinuationInterrupt;
  noProgressCount: number;
  attemptCount?: number;
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
  retained: boolean;
  deliveryStatus?: ContinuationDeliveryStatus;
  deliveryEvents?: ContinuationDeliveryRecord[];
}

export type ContinuationAttemptPhase = 'work' | 'finalize' | 'verify_and_deliver';
export type ContinuationArtifactStatus = 'not_started' | 'creating' | 'created' | 'verified' | 'failed';

export function continuationAttemptPhase(
  attemptOrdinal: number,
  maxAttempts: number,
): ContinuationAttemptPhase {
  if (attemptOrdinal >= maxAttempts) return 'verify_and_deliver';
  if (attemptOrdinal >= Math.max(1, maxAttempts - 1)) return 'finalize';
  return 'work';
}

export function continuationArtifactStatus(job: ContinuationJob): ContinuationArtifactStatus {
  if (job.errorCode?.includes('artifact_creation_failed') || job.errorCode?.includes('artifact_verification_failed')) {
    return 'failed';
  }
  const checkpoint = job.checkpoint;
  const hasMaterialArtifact = Boolean(
    checkpoint
    && (checkpoint.artifacts.length > 0
      || checkpoint.sideEffects.length > 0
      || checkpoint.completedDeliverableIds.length > 0),
  );
  if (checkpoint && requiredTaskOutputVerified(job.taskContract, checkpoint)) return 'verified';
  if (hasMaterialArtifact) return 'created';
  const activeOrdinal = job.status === 'running'
    ? job.attemptCount ?? 1
    : (job.attemptCount ?? 0) + 1;
  return job.status === 'running'
    && continuationAttemptPhase(activeOrdinal, job.maxAttempts) !== 'work'
    ? 'creating'
    : 'not_started';
}

export function continuationUnmetAcceptanceCriteria(job: ContinuationJob): string[] {
  const completed = new Set(job.checkpoint?.completedCriterionIds ?? []);
  return job.taskContract.acceptanceCriteria
    .filter((criterion) => !completed.has(criterion.id))
    .map((criterion) => criterion.id);
}

export function continuationResumeAvailable(job: ContinuationJob): boolean {
  return ['partial', 'blocked', 'failed'].includes(job.status)
    && Boolean(job.checkpoint)
    && !job.deletedAt
    && job.errorCode !== 'continuation_persisted_state_invalid'
    && job.deliveryStatus !== 'delivery_unknown';
}

function requiredTaskOutputVerified(
  contract: AsyncTaskContract,
  checkpoint: ContinuationCheckpointV2,
): boolean {
  if (
    contract.deliverables.length === 0
    && contract.acceptanceCriteria.length === 0
    && contract.verificationRequirements.length === 0
  ) return false;
  const completedDeliverables = new Set(checkpoint.completedDeliverableIds);
  const completedCriteria = new Set(checkpoint.completedCriterionIds);
  const evidencedRequirements = new Set(checkpoint.evidence.map((entry) => entry.requirementId));
  return contract.deliverables.every((item) => !item.required || completedDeliverables.has(item.id))
    && contract.acceptanceCriteria.every((item) => completedCriteria.has(item.id))
    && contract.verificationRequirements.every((item) => evidencedRequirements.has(item.id));
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
  stepId?: string;
  delta?: ContinuationAttemptDelta;
  verification?: ContinuationVerificationVerdict;
}

export interface ContinuationClaim {
  job: ContinuationJob;
  attempt: ContinuationAttempt;
  workerId: string;
  claimedRowVersion: number;
  /** Exact persisted claim used by the generic Durable Run repository. */
  durableClaim?: DurableRunClaim;
}

export interface ContinuationToolRequest {
  tool: string;
  args: string[];
}

export interface ContinuationToolResult {
  ok: boolean;
  message: string;
  failure?: DurableRunFailure;
}

export type ContinuationToolCallDecision =
  | { status: 'execute'; callId: string }
  | { status: 'replay'; callId: string; result: ContinuationToolResult }
  | { status: 'unknown'; callId: string }
  | { status: 'conflict'; callId: string };

export type ContinuationToolCallRecovery =
  | { status: 'completed'; tool: string; result: ContinuationToolResult }
  | { status: 'unknown'; tool: string };

export type ContinuationStepOutcome =
  | {
      outcome: 'continue';
      checkpoint: ContinuationCheckpointV2;
      resumeAfterSeconds?: number;
    }
  | {
      outcome: 'completed';
      checkpoint: ContinuationCheckpointV2;
      finalMessage: string;
      resultSummary?: string;
      artifacts: string[];
    }
  | {
      outcome: 'partial';
      checkpoint: ContinuationCheckpointV2;
      completedWork: string[];
      keyFindings: string[];
      unperformedWork: string[];
      risks: string[];
      nextSteps: string[];
      artifacts: string[];
    }
  | {
      outcome: 'recovering';
      checkpoint: ContinuationCheckpointV2;
      failure: DurableRunFailure;
      delaySeconds: number;
      reason: string;
    }
  | {
      outcome: 'waiting_user';
      checkpoint: ContinuationCheckpointV2;
      failure: DurableRunFailure;
      prompt: string;
      reason: string;
    }
  | {
      outcome: 'failed';
      checkpoint: ContinuationCheckpointV2;
      errorCode: string;
      errorSummary: string;
      retryable: boolean;
      completedWork: string[];
      unperformedWork: string[];
      recoveryFailure?: DurableRunFailure;
    }
  | {
      outcome: 'blocked';
      checkpoint: ContinuationCheckpointV2;
      errorCode: string;
      errorSummary: string;
      requiredCapability: string;
      completedWork: string[];
      unperformedWork: string[];
      recoveryFailure?: DurableRunFailure;
    };

export function partialOutcomeFromCheckpoint(
  checkpoint: ContinuationCheckpointV2,
): Extract<ContinuationStepOutcome, { outcome: 'partial' }> {
  return {
    outcome: 'partial',
    checkpoint,
    completedWork: checkpoint.completedStepIds,
    keyFindings: checkpoint.summary ? [checkpoint.summary] : [],
    unperformedWork: checkpoint.remainingSteps.map((step) => step.description),
    risks: checkpoint.constraints,
    nextSteps: [...new Set(
      [checkpoint.nextAction?.description ?? '', ...checkpoint.remainingSteps.map((step) => step.description)]
        .map((value) => value.trim())
        .filter(Boolean),
    )],
    artifacts: checkpoint.artifacts.map((artifact) => artifact.path),
  };
}

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
  eventKey: string;
  kind: ContinuationDeliveryKind;
  attemptId?: string;
  interruptId?: string;
  workerId: string;
  route: ContinuationDeliveryRoute;
  idempotencyKey: string;
  payload: string;
  status: Extract<ContinuationDeliveryStatus, 'pending' | 'sending'>;
  attemptCount: number;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorSummary?: string;
  durableClaim?: DurableRunDeliveryClaim;
}

export type ContinuationDeliveryResult =
  | { status: 'delivered'; messageId: string }
  | { status: 'retry'; errorCode: string; errorSummary: string }
  | { status: 'delivery_unknown'; errorCode: string; errorSummary: string }
  | { status: 'failed'; errorCode: string; errorSummary: string };

const TERMINAL_STATUSES = new Set<ContinuationStatus>([
  'completed',
  'partial',
  'blocked',
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
