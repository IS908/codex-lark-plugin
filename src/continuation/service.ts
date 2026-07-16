import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ContinuationCreateRequest,
  ContinuationDeliveryRoute,
  ContinuationJob,
} from '../domain/continuation.js';
import { isContinuationTerminal } from '../domain/continuation.js';
import type { LarkMessage } from '../lark-message.js';
import type { ContinuationClock, ContinuationRepository } from '../ports/continuation.js';

export interface ContinuationServiceOptions {
  repository: ContinuationRepository;
  allowedWorkingRoot: string;
  maxSteps: number;
  maxRetries: number;
  maxAgeHours: number;
  timeoutMs: number;
  defaultModel?: string | null;
  clock: ContinuationClock;
}

export interface ContinuationActionInput {
  title: string;
  objective: string;
  acceptance_criteria: string[];
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
}

export interface ContinuationTaskService {
  createFromMessage(
    action: ContinuationActionInput,
    message: LarkMessage,
    parentSessionId?: string | null,
    selectedModel?: string | null,
  ): Promise<{ job: ContinuationJob; created: boolean }>;
  listForActor(actorOpenId: string, ownerOpenId?: string | null, limit?: number): Promise<ContinuationJob[]>;
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
}

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

  async createFromMessage(
    action: ContinuationActionInput,
    message: LarkMessage,
    parentSessionId?: string | null,
    selectedModel?: string | null,
  ): Promise<{ job: ContinuationJob; created: boolean }> {
    assertEligibleSource(message);
    const now = this.options.clock.now();
    const workingDirectory = await this.resolveWorkingDirectory(
      action.working_directory ?? '.',
    );
    const route = deriveRoute(message);
    const brief = sanitizeBrief(action);
    const request: ContinuationCreateRequest = {
      idempotencyKey: continuationIdempotencyKey(message.messageId),
      creatorOpenId: message.senderId,
      route,
      sourceMessageId: message.messageId,
      ...(message.threadId ? { sourceThreadId: message.threadId } : {}),
      title: brief.title,
      objective: brief.objective,
      acceptanceCriteria: brief.acceptanceCriteria,
      contextSnapshot: brief.contextSnapshot,
      requiredTools: brief.requiredTools,
      workingDirectory,
      ...((selectedModel ?? this.options.defaultModel)
        ? { model: (selectedModel ?? this.options.defaultModel)! }
        : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      maxSteps: this.options.maxSteps,
      maxRetries: this.options.maxRetries,
      timeoutSeconds: Math.max(1, Math.ceil(this.options.timeoutMs / 1_000)),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.options.maxAgeHours * 60 * 60 * 1_000,
      ).toISOString(),
    };
    return this.options.repository.create(request);
  }

  async listForActor(
    actorOpenId: string,
    ownerOpenId?: string | null,
    limit = 20,
  ): Promise<ContinuationJob[]> {
    return isOwner(actorOpenId, ownerOpenId)
      ? this.options.repository.listAll(limit)
      : this.options.repository.listByCreator(actorOpenId, limit);
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
    const job = await this.requireAuthorizedJob(jobId, actorOpenId, ownerOpenId);
    if (job.deliveryStatus === 'delivery_unknown') {
      throw new ContinuationServiceError(
        'delivery_unknown',
        'This task has an unknown delivery outcome. Retrying could duplicate completed work, so it was not started.',
      );
    }
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new ContinuationServiceError(
        'invalid_state',
        'Only failed or cancelled tasks can be retried.',
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

  private async resolveWorkingDirectory(relativeDirectory: string): Promise<string> {
    if (
      path.isAbsolute(relativeDirectory)
      || /^[A-Za-z]:[\\/]/.test(relativeDirectory)
      || relativeDirectory.split(/[\\/]+/).includes('..')
    ) {
      throw new Error('Continuation working directory must remain within the configured root.');
    }
    const configuredRoot = path.resolve(this.options.allowedWorkingRoot);
    const candidate = path.resolve(configuredRoot, relativeDirectory);
    if (candidate !== configuredRoot && !candidate.startsWith(`${configuredRoot}${path.sep}`)) {
      throw new Error('Continuation working directory must remain within the configured root.');
    }
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(configuredRoot),
      fs.realpath(candidate),
    ]).catch(() => {
      throw new Error('Continuation working directory must be an existing directory.');
    });
    const metadata = await fs.stat(realCandidate);
    if (!metadata.isDirectory()) {
      throw new Error('Continuation working directory must be an existing directory.');
    }
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('Continuation working directory resolves outside the configured root.');
    }
    return realCandidate;
  }
}

export class UnavailableContinuationService implements ContinuationTaskService {
  async createFromMessage(): Promise<never> { throw unavailableError(); }
  async listForActor(): Promise<never> { throw unavailableError(); }
  async getForActor(): Promise<never> { throw unavailableError(); }
  async cancelForActor(): Promise<never> { throw unavailableError(); }
  async retryForActor(): Promise<never> { throw unavailableError(); }
  async deleteForActor(): Promise<never> { throw unavailableError(); }
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

function continuationIdempotencyKey(sourceMessageId: string): string {
  return `create-continuation:${createHash('sha256')
    .update(`${sourceMessageId}\0create_continuation_job`)
    .digest('hex')}`;
}

function sanitizeBrief(action: ContinuationActionInput) {
  const title = sanitizeText(action.title).replace(/\s+/g, ' ').trim();
  const objective = sanitizeText(action.objective);
  if (!title) throw new Error('Continuation title is empty after normalization.');
  if (objective.replace(/\[redacted\]/g, '').trim().length < 3) {
    throw new Error('Continuation objective is not usable after credential redaction.');
  }
  return {
    title,
    objective,
    acceptanceCriteria: action.acceptance_criteria.map(sanitizeText),
    contextSnapshot: {
      summary: sanitizeText(action.context_snapshot.summary),
      completedSteps: action.context_snapshot.completed_steps.map(sanitizeText),
      remainingSteps: action.context_snapshot.remaining_steps.map(sanitizeText),
      constraints: action.context_snapshot.constraints.map(sanitizeText),
      decisions: action.context_snapshot.decisions.map(sanitizeText),
      references: action.context_snapshot.references.map(sanitizeText),
    },
    requiredTools: action.required_tools.map(sanitizeText),
  };
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{12,}\b/gi, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/((?:app|tenant)_access_token|authorization|password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[redacted]');
}
