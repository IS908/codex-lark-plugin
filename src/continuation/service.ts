import type {
  AsyncTaskSourceInput,
  ContinuationCreateRequest,
  ContinuationDeliveryRoute,
  ContinuationFilesystemMode,
  ContinuationJob,
  ContinuationStatus,
} from '../domain/continuation.js';
import { CONTINUATION_LIMITS, isContinuationTerminal } from '../domain/continuation.js';
import type { LarkMessage } from '../lark-message.js';
import type { ContinuationClock, ContinuationRepository } from '../ports/continuation.js';
import {
  continuationCreateIdempotencyKey,
  continuationJobId,
  continuationRetryJobId,
} from './idempotency.js';
import { redactContinuationText } from './redaction.js';
import {
  resolveContinuationRequestedPaths,
  resolveContinuationWorkingDirectory,
} from './working-directory.js';

export interface ContinuationServiceOptions {
  repository: ContinuationRepository;
  allowedWorkingRoot: string;
  filesystemMode: ContinuationFilesystemMode;
  maxAttempts: number;
  maxRetries: number;
  maxTotalMinutes: number;
  timeoutMs: number;
  defaultModel?: string | null;
  canUseTrustedPersonalWorkspace?: (actorOpenId: string) => boolean;
  clock: ContinuationClock;
}

export interface ContinuationActionInput {
  title: string;
  objective: string;
  deliverables: Array<{ id: string; description: string; required: boolean }>;
  acceptance_criteria: Array<{ id: string; description: string; deliverable_ids: string[] }>;
  verification_requirements: Array<{
    id: string;
    description: string;
    kind: 'artifact_exists' | 'artifact_sha256' | 'evidence_reference';
  }>;
  context_snapshot: {
    summary: string;
    completed_steps: string[];
    remaining_steps: string[];
    constraints: string[];
    decisions: string[];
    references: string[];
  };
  required_tools: string[];
  working_directory?: string;
  requested_paths?: string[];
}

export interface ContinuationTaskService {
  findExistingFromMessage(message: LarkMessage): Promise<ContinuationJob | null>;
  createFromMessage(
    action: ContinuationActionInput,
    message: LarkMessage,
    parentSessionId?: string | null,
    selectedModel?: string | null,
    sourceInputs?: AsyncTaskSourceInput[],
  ): Promise<{ job: ContinuationJob; created: boolean }>;
  listForActor(
    actorOpenId: string,
    ownerOpenId?: string | null,
    statuses?: ContinuationListStatus[],
    limit?: number,
  ): Promise<ContinuationJob[]>;
  getForActor(jobId: string, actorOpenId: string, ownerOpenId?: string | null): Promise<ContinuationJob>;
  cancelForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<{ job: ContinuationJob; result: 'cancelled' | 'cancel_requested' | 'terminal' }>;
  retryForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId: string | null | undefined,
    requestId: string,
  ): Promise<ContinuationJob>;
  deleteForActor(jobId: string, actorOpenId: string, ownerOpenId?: string | null): Promise<void>;
  setRetainedForActor(
    jobId: string,
    retained: boolean,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<ContinuationJob>;
}

export type ContinuationListStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export const CONTINUATION_RUNTIME_UNAVAILABLE = 'Continuation runtime is unavailable.';

export type ContinuationServiceErrorCode =
  | 'not_accessible'
  | 'invalid_state'
  | 'delivery_unknown';

export class ContinuationServiceError extends Error {
  constructor(
    readonly code: ContinuationServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContinuationServiceError';
  }
}

export class ContinuationService implements ContinuationTaskService {
  constructor(private readonly options: ContinuationServiceOptions) {}

  async findExistingFromMessage(message: LarkMessage): Promise<ContinuationJob | null> {
    assertEligibleSource(message);
    const jobId = continuationJobId(continuationCreateIdempotencyKey(message.messageId));
    const existing = await this.options.repository.get(jobId);
    if (!existing) return null;
    if (existing.deletedAt) {
      if (existing.creatorOpenId !== message.senderId) {
        throw new Error('Continuation deterministic Job identity conflicts with the authenticated source message.');
      }
      throw new ContinuationServiceError(
        'invalid_state',
        'This background task was already created, but its retained data has been deleted.',
      );
    }
    if (
      existing.sourceMessageId !== message.messageId
      || existing.creatorOpenId !== message.senderId
      || existing.retryOfJobId
    ) {
      throw new Error('Continuation deterministic Job identity conflicts with the authenticated source message.');
    }
    if (existing.errorCode === 'continuation_persisted_state_invalid') {
      throw new ContinuationServiceError(
        'invalid_state',
        'This background task cannot be reused because its stored state failed integrity validation.',
      );
    }
    return existing;
  }

  async createFromMessage(
    action: ContinuationActionInput,
    message: LarkMessage,
    parentSessionId?: string | null,
    selectedModel?: string | null,
    sourceInputs: AsyncTaskSourceInput[] = [],
  ): Promise<{ job: ContinuationJob; created: boolean }> {
    assertEligibleSource(message);
    const now = this.options.clock.now();
    const resolvedWorkingDirectory = await resolveContinuationWorkingDirectory(
      this.options.allowedWorkingRoot,
      action.working_directory ?? '.',
    );
    const route = deriveRoute(message);
    const brief = sanitizeBrief(action);
    const profile = this.options.canUseTrustedPersonalWorkspace?.(message.senderId)
      ? 'trusted_personal_workspace'
      : 'bounded';
    const requestedPaths = await this.resolveRequestedPaths(
      action,
      resolvedWorkingDirectory.workingDirectory,
    );
    const request: ContinuationCreateRequest = {
      idempotencyKey: continuationCreateIdempotencyKey(message.messageId),
      creatorOpenId: message.senderId,
      route,
      sourceMessageId: message.messageId,
      ...(message.threadId ? { sourceThreadId: message.threadId } : {}),
      title: brief.title,
      objective: brief.objective,
      acceptanceCriteria: brief.acceptanceCriteria,
      contextSnapshot: brief.contextSnapshot,
      sourceFacts: {
        schemaVersion: 1,
        provenance: 'captured',
        originalUserText: boundedFactText(message.currentUserText ?? message.text),
        sourceContextText: message.sourceContextText
          ? boundedFactText(message.sourceContextText)
          : null,
        quotedMessageText: message.parentContent
          ? boundedFactText(message.parentContent)
          : null,
        creatorOpenId: message.senderId,
        chatId: message.chatId,
        chatType: message.chatType,
        route,
        sourceMessageId: message.messageId,
        ...(message.threadId ? { sourceThreadId: message.threadId } : {}),
        sourceMessageType: message.messageType || null,
        sourceTimestamp: message.timestampMs === undefined
          ? null
          : new Date(message.timestampMs).toISOString(),
        inputs: [],
        workingDirectory: resolvedWorkingDirectory.workingDirectory,
        model: selectedModel ?? this.options.defaultModel ?? null,
        permissions: {
          profile,
          filesystem: {
            root: resolvedWorkingDirectory.root,
            mode: this.options.filesystemMode,
            requestedPaths,
          },
          hostTools: brief.requiredTools,
          network: profile === 'trusted_personal_workspace' ? 'enabled' : 'none',
          externalSideEffects: profile === 'trusted_personal_workspace' ? 'allowed' : 'denied',
          approval: { mode: 'never' },
        },
      },
      taskContract: {
        schemaVersion: 1,
        title: brief.title,
        objective: brief.objective,
        deliverables: brief.deliverables,
        acceptanceCriteria: brief.structuredAcceptanceCriteria,
        verificationRequirements: brief.verificationRequirements,
        initialContext: brief.contextSnapshot,
      },
      sourceInputs,
      requiredTools: brief.requiredTools,
      workingDirectory: resolvedWorkingDirectory.workingDirectory,
      permissions: {
        profile,
        filesystem: {
          root: resolvedWorkingDirectory.root,
          mode: this.options.filesystemMode,
          requestedPaths,
        },
        hostTools: brief.requiredTools,
        network: profile === 'trusted_personal_workspace' ? 'enabled' : 'none',
        externalSideEffects: profile === 'trusted_personal_workspace' ? 'allowed' : 'denied',
        approval: { mode: 'never' },
      },
      ...((selectedModel ?? this.options.defaultModel)
        ? { model: (selectedModel ?? this.options.defaultModel)! }
        : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      maxAttempts: this.options.maxAttempts,
      maxRetries: this.options.maxRetries,
      timeoutSeconds: Math.max(1, Math.ceil(this.options.timeoutMs / 1_000)),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.options.maxTotalMinutes * 60 * 1_000,
      ).toISOString(),
    };
    return this.options.repository.create(request);
  }

  private async resolveRequestedPaths(
    action: ContinuationActionInput,
    defaultPath: string,
  ): Promise<string[]> {
    const requestedPaths = action.requested_paths?.length
      ? action.requested_paths
      : [defaultPath];
    if (requestedPaths.length > CONTINUATION_LIMITS.requestedPathCount) {
      throw new Error('Continuation requested path count exceeds the configured limit.');
    }
    return resolveContinuationRequestedPaths(
      this.options.allowedWorkingRoot,
      requestedPaths,
    );
  }

  async listForActor(
    actorOpenId: string,
    ownerOpenId?: string | null,
    statuses: ContinuationListStatus[] = [],
    limit = 20,
  ): Promise<ContinuationJob[]> {
    const repositoryStatuses = expandListStatuses(statuses);
    return isOwner(actorOpenId, ownerOpenId)
      ? this.options.repository.listAll(limit, repositoryStatuses)
      : this.options.repository.listByCreator(actorOpenId, limit, repositoryStatuses);
  }

  async getForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<ContinuationJob> {
    return this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
  }

  async cancelForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<{ job: ContinuationJob; result: 'cancelled' | 'cancel_requested' | 'terminal' }> {
    const job = await this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
    const result = await this.options.repository.requestCancel(
      job.jobId,
      this.options.clock.now().toISOString(),
    );
    if (result === 'missing') throw notAccessibleError();
    const updated = await this.options.repository.get(job.jobId);
    if (!updated || updated.deletedAt) throw notAccessibleError();
    return { job: updated, result };
  }

  async retryForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId: string | null | undefined,
    requestId: string,
  ): Promise<ContinuationJob> {
    const existingRetry = await this.options.repository.get(
      continuationRetryJobId(jobId, requestId),
    );
    if (existingRetry && !existingRetry.deletedAt) {
      if (existingRetry.retryOfJobId !== jobId) throw notAccessibleError();
      if (
        existingRetry.creatorOpenId !== actorOpenId
        && !isOwner(actorOpenId, ownerOpenId)
      ) throw notAccessibleError();
      return existingRetry;
    }
    const job = await this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
    if (job.errorCode === 'continuation_persisted_state_invalid') {
      throw new ContinuationServiceError(
        'invalid_state',
        'This task cannot be retried because its stored state failed integrity validation.',
      );
    }
    if (job.deliveryStatus === 'delivery_unknown') {
      throw new ContinuationServiceError(
        'delivery_unknown',
        'This task has an unknown delivery outcome. Retrying could duplicate completed work, so it was not started.',
      );
    }
    if (!['partial', 'blocked', 'failed', 'cancelled'].includes(job.status)) {
      throw new ContinuationServiceError(
        'invalid_state',
        'Only partial, blocked, failed, or cancelled tasks can be retried.',
      );
    }
    return this.options.repository.cloneForRetry(
      job.jobId,
      requestId,
      this.options.clock.now().toISOString(),
    );
  }

  async deleteForActor(
    jobId: string,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<void> {
    const job = await this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
    if (!isContinuationTerminal(job.status)) {
      throw new ContinuationServiceError(
        'invalid_state',
        'Only terminal tasks can be deleted. Cancel the task first.',
      );
    }
    const deleted = await this.options.repository.redactTerminal(
      job.jobId,
      this.options.clock.now().toISOString(),
    );
    if (!deleted) throw notAccessibleError();
  }

  async setRetainedForActor(
    jobId: string,
    retained: boolean,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<ContinuationJob> {
    const job = await this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
    const updated = await this.options.repository.setRetained(
      job.jobId,
      retained,
      this.options.clock.now().toISOString(),
    );
    if (!updated) throw notAccessibleError();
    const refreshed = await this.options.repository.get(job.jobId);
    if (!refreshed || refreshed.deletedAt) throw notAccessibleError();
    return refreshed;
  }

  private async requireAuthorizedJob(
    jobId: string,
    actorOpenId: string,
    ownerOpenId?: string | null,
  ): Promise<ContinuationJob> {
    const job = await this.options.repository.get(jobId);
    if (
      !job
      || job.deletedAt
      || (job.creatorOpenId !== actorOpenId && !isOwner(actorOpenId, ownerOpenId))
    ) {
      throw notAccessibleError();
    }
    return job;
  }

}

export class UnavailableContinuationService implements ContinuationTaskService {
  async findExistingFromMessage(): Promise<never> { throw unavailableError(); }
  async createFromMessage(): Promise<never> { throw unavailableError(); }
  async listForActor(): Promise<never> { throw unavailableError(); }
  async getForActor(): Promise<never> { throw unavailableError(); }
  async cancelForActor(): Promise<never> { throw unavailableError(); }
  async retryForActor(): Promise<never> { throw unavailableError(); }
  async deleteForActor(): Promise<never> { throw unavailableError(); }
  async setRetainedForActor(): Promise<never> { throw unavailableError(); }
}

function expandListStatuses(statuses: ContinuationListStatus[]): ContinuationStatus[] {
  return [...new Set(statuses.flatMap((status): ContinuationStatus[] => {
    if (status === 'pending') return ['queued', 'waiting_retry'];
    if (status === 'running') return ['running', 'cancel_requested'];
    return [status];
  }))];
}

function isOwner(actorOpenId: string, ownerOpenId?: string | null): boolean {
  return Boolean(ownerOpenId && actorOpenId === ownerOpenId);
}

function notAccessibleError(): ContinuationServiceError {
  return new ContinuationServiceError(
    'not_accessible',
    'Task not found or not accessible.',
  );
}

function unavailableError(): Error {
  return new Error(CONTINUATION_RUNTIME_UNAVAILABLE);
}

function assertEligibleSource(message: LarkMessage): void {
  if (message.messageType === 'reaction' || message.reaction) {
    throw new Error('Continuation creation is not available for reaction events.');
  }
  if (!['p2p', 'group', 'doc_comment'].includes(message.chatType)) {
    throw new Error(`Continuation creation is not available for ${message.chatType} messages.`);
  }
  if (!message.senderId || !message.messageId) {
    throw new Error('Continuation creation requires an authenticated source message.');
  }
}

function deriveRoute(message: LarkMessage): ContinuationDeliveryRoute {
  if (message.chatType === 'doc_comment') {
    if (!message.docComment) {
      throw new Error('Continuation creation from a document comment requires trusted comment metadata.');
    }
    return {
      kind: 'comment_thread',
      documentToken: message.docComment.fileToken,
      commentId: message.docComment.commentId,
      fileType: message.docComment.fileType,
    };
  }
  return {
    kind: 'message_thread',
    conversationId: message.chatId,
    sourceMessageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}

function sanitizeBrief(action: ContinuationActionInput) {
  const title = redactContinuationText(action.title).replace(/\s+/g, ' ').trim();
  const objective = redactContinuationText(action.objective);
  if (!title) throw new Error('Continuation title is empty after normalization.');
  if (objective.replace(/\[redacted\]/g, '').trim().length < 3) {
    throw new Error('Continuation objective is not usable after credential redaction.');
  }
  return {
    title,
    objective,
    deliverables: action.deliverables.map((deliverable) => ({
      ...deliverable,
      description: redactContinuationText(deliverable.description),
    })),
    acceptanceCriteria: action.acceptance_criteria.map((criterion) =>
      redactContinuationText(criterion.description)),
    structuredAcceptanceCriteria: action.acceptance_criteria.map((criterion) => ({
      id: criterion.id,
      description: redactContinuationText(criterion.description),
      deliverableIds: [...criterion.deliverable_ids],
    })),
    verificationRequirements: action.verification_requirements.map((requirement) => ({
      ...requirement,
      description: redactContinuationText(requirement.description),
    })),
    contextSnapshot: {
      summary: redactContinuationText(action.context_snapshot.summary),
      completedSteps: action.context_snapshot.completed_steps.map(redactContinuationText),
      remainingSteps: action.context_snapshot.remaining_steps.map(redactContinuationText),
      constraints: action.context_snapshot.constraints.map(redactContinuationText),
      decisions: action.context_snapshot.decisions.map(redactContinuationText),
      references: action.context_snapshot.references.map(redactContinuationText),
    },
    requiredTools: [...new Set(action.required_tools.map(redactContinuationText))],
  };
}

function boundedFactText(value: string): string {
  const redacted = redactContinuationText(value);
  if (Buffer.byteLength(redacted, 'utf8') <= CONTINUATION_LIMITS.objectiveBytes) return redacted;
  const suffix = '\n[truncated]';
  let end = Math.min(redacted.length, CONTINUATION_LIMITS.objectiveBytes - suffix.length);
  while (
    end > 0
    && Buffer.byteLength(`${redacted.slice(0, end)}${suffix}`, 'utf8') > CONTINUATION_LIMITS.objectiveBytes
  ) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}${suffix}`;
}
