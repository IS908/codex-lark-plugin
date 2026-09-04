import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CONTINUATION_CONTRACT_ID_PATTERN,
  CONTINUATION_LIMITS,
  continuationArtifactStatus,
  type AsyncTaskContract,
  type AsyncTaskFactSnapshot,
  type ContinuationClaim,
  type ContinuationAttemptDelta,
  type ContinuationCheckpoint,
  type ContinuationCheckpointV2,
  type ContinuationCreateRequest,
  type ContinuationDeliveryRoute,
  type ContinuationFailure,
  type ContinuationJob,
  type ContinuationPendingInterruptRoute,
  type ContinuationPermissionEnvelope,
  type ContinuationRecoveryState,
  type ContinuationStatus,
  type ContinuationStepOutcome,
  type ContinuationToolRequest,
  type ContinuationToolResult,
  type ContinuationVerificationVerdict,
} from '../domain/continuation.js';
import type { ContinuationInputStorePort } from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { redactContinuationText } from './redaction.js';
import type { DurableRunFailure } from '../domain/durable-run.js';

export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

const PROGRESS_PAYLOAD_MAX_CHARS = 4_000;
export const MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT = 2;
export const MAX_TOTAL_RECOVERY_ATTEMPTS = 4;
export const EMPTY_CHECKPOINT = {
  summary: '',
  completedSteps: [],
  remainingSteps: [],
  constraints: [],
  decisions: [],
  references: [],
};
export const EMPTY_PERMISSION_ENVELOPE: ContinuationPermissionEnvelope = {
  profile: 'bounded',
  filesystem: { root: '', mode: 'read-only', requestedPaths: [] },
  hostTools: [],
  network: 'none',
  externalSideEffects: 'denied',
  approval: { mode: 'never' },
};

class LegacyPersistedRowError extends Error {}
class LegacyRouteProjectionError extends LegacyPersistedRowError {}

function jobSelectSql(includeOutcomeState = true, includeInterruptState = includeOutcomeState): string {
  const outcomeState = includeOutcomeState
    ? `(SELECT a.delta_json FROM continuation_attempts a
            WHERE a.job_id = j.job_id AND a.finished_at IS NOT NULL AND a.delta_json IS NOT NULL
            ORDER BY a.ordinal DESC LIMIT 1) AS last_delta_json,
           (SELECT a.verification_json FROM continuation_attempts a
            WHERE a.job_id = j.job_id AND a.finished_at IS NOT NULL AND a.verification_json IS NOT NULL
            ORDER BY a.ordinal DESC LIMIT 1) AS last_verification_json`
    : `0 AS no_progress_count, NULL AS last_delta_json, NULL AS last_verification_json`;
  const interruptState = includeInterruptState
    ? `(SELECT i.interrupt_id FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_id,
           (SELECT i.attempt_id FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_attempt_id,
           (SELECT i.status FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_status,
           (SELECT i.prompt FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_prompt,
           (SELECT i.response_text FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_response,
           (SELECT i.created_at FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_created_at,
           (SELECT i.resolved_at FROM continuation_interrupts i
            WHERE i.job_id = j.job_id ORDER BY i.created_at DESC LIMIT 1) AS current_interrupt_resolved_at,
           (SELECT o.message_id FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'interrupt'
            ORDER BY o.created_at DESC LIMIT 1) AS current_interrupt_message_id,
           (SELECT o.updated_at FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'interrupt' AND o.status = 'delivered'
            ORDER BY o.created_at DESC LIMIT 1) AS current_interrupt_delivered_at`
    : `NULL AS current_interrupt_id, NULL AS current_interrupt_attempt_id,
       NULL AS current_interrupt_status, NULL AS current_interrupt_prompt,
       NULL AS current_interrupt_response, NULL AS current_interrupt_created_at,
       NULL AS current_interrupt_resolved_at, NULL AS current_interrupt_message_id,
       NULL AS current_interrupt_delivered_at`;
  return `
    SELECT j.*,
           (SELECT o.status FROM continuation_outbox o
            WHERE o.job_id = j.job_id AND o.kind = 'terminal'
            LIMIT 1) AS delivery_status,
           (SELECT COUNT(*) FROM continuation_attempts a WHERE a.job_id = j.job_id) AS attempt_count,
           ${interruptState},
           ${outcomeState}
    FROM continuation_jobs j
  `;
}

function stringField(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Invalid continuation database field: ${field}.`);
  return value;
}

function optionalStringField(row: SqlRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Invalid continuation database number field: ${field}.`);
  }
  return Number(value);
}

function mapPendingInterruptRoute(row: SqlRow): ContinuationPendingInterruptRoute {
  const route = parseTrustedJson(row.route_json, 'continuation interrupt route');
  if (!isDeliveryRoute(route)) throw new Error('Continuation interrupt route is invalid.');
  return {
    interruptId: stringField(row, 'interrupt_id'),
    jobId: stringField(row, 'job_id'),
    route,
    deliveredMessageId: optionalStringField(row, 'message_id'),
  };
}

function mapJob(row: SqlRow): ContinuationJob {
  const routeValue = parseTrustedJson(row.route_json, 'route_json');
  if (!isDeliveryRoute(routeValue)) throw new Error('Continuation delivery route is invalid.');
  const sourceFactsValue = parseTrustedJson(row.source_facts_json, 'source_facts_json');
  validateSourceFacts(sourceFactsValue);
  const taskContractValue = parseTrustedJson(row.task_contract_json, 'task_contract_json');
  validateTaskContract(taskContractValue, sourceFactsValue.provenance === 'captured');
  const creatorOpenId = stringField(row, 'creator_open_id');
  const sourceMessageId = stringField(row, 'source_message_id');
  const sourceThreadId = optionalStringField(row, 'source_thread_id');
  const title = stringField(row, 'title');
  const objective = stringField(row, 'objective');
  const acceptanceCriteria = parseTrustedStringArray(
    row.acceptance_criteria_json,
    'acceptance_criteria_json',
  );
  const contextSnapshot = parseTrustedCheckpoint(
    row.context_snapshot_json,
    'context_snapshot_json',
  );
  const workingDirectory = stringField(row, 'working_directory');
  const permissions = parsePermissionEnvelope(row.permissions_json);
  const requiredTools = parseTrustedStringArray(row.required_tools_json, 'required_tools_json');
  if (!sameStringSet(requiredTools, permissions.hostTools)) {
    throw new Error('Continuation persisted host tools are inconsistent.');
  }
  const model = optionalStringField(row, 'model');
  const recovery = row.recovery_json
    ? parseTrustedRecoveryState(row.recovery_json, 'recovery_json')
    : undefined;
  const recoveryFingerprintCounts = row.recovery_fingerprint_counts_json === undefined
    ? {}
    : parseTrustedCountRecord(
        row.recovery_fingerprint_counts_json,
        'recovery_fingerprint_counts_json',
      );
  const interruptId = optionalStringField(row, 'current_interrupt_id');
  validatePersistedFactProjection(row, {
    route: routeValue,
    sourceFacts: sourceFactsValue,
    taskContract: taskContractValue,
    creatorOpenId,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    workingDirectory,
    permissions,
    model,
  });
  return {
    jobId: stringField(row, 'job_id'),
    idempotencyKey: stringField(row, 'idempotency_key'),
    retryOfJobId: optionalStringField(row, 'retry_of_job_id'),
    creatorOpenId,
    route: routeValue,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    sourceFacts: sourceFactsValue,
    taskContract: taskContractValue,
    requiredTools,
    workingDirectory,
    permissions,
    model,
    parentSessionId: optionalStringField(row, 'parent_session_id'),
    maxAttempts: numberField(row, 'max_attempts'),
    maxRetries: numberField(row, 'max_retries'),
    timeoutSeconds: numberField(row, 'timeout_seconds'),
    createdAt: stringField(row, 'created_at'),
    expiresAt: stringField(row, 'expires_at'),
    rowVersion: numberField(row, 'row_version'),
    status: stringField(row, 'status') as ContinuationStatus,
    executionSessionId: optionalStringField(row, 'execution_session_id'),
    checkpoint: row.checkpoint_json
      ? parseTrustedCheckpointV2(row.checkpoint_json, 'checkpoint_json')
      : undefined,
    lastAttemptDelta: row.last_delta_json
      ? parseTrustedAttemptDelta(row.last_delta_json, 'last_delta_json')
      : undefined,
    lastVerification: row.last_verification_json
      ? parseTrustedVerification(row.last_verification_json, 'last_verification_json')
      : undefined,
    recovery,
    recoveryTotalCount: row.recovery_total_count === undefined
      ? 0
      : numberField(row, 'recovery_total_count'),
    recoveryFingerprintCounts,
    currentInterrupt: interruptId ? {
      interruptId,
      jobId: stringField(row, 'job_id'),
      attemptId: stringField(row, 'current_interrupt_attempt_id'),
      status: optionalStringField(row, 'current_interrupt_status') === 'resolved'
        ? 'resolved'
        : optionalStringField(row, 'current_interrupt_message_id')
          ? 'delivered'
          : 'pending',
      prompt: stringField(row, 'current_interrupt_prompt'),
      deliveredMessageId: optionalStringField(row, 'current_interrupt_message_id'),
      responseText: optionalStringField(row, 'current_interrupt_response'),
      createdAt: stringField(row, 'current_interrupt_created_at'),
      deliveredAt: optionalStringField(row, 'current_interrupt_delivered_at'),
      resolvedAt: optionalStringField(row, 'current_interrupt_resolved_at'),
    } : undefined,
    noProgressCount: numberField(row, 'no_progress_count'),
    attemptCount: numberField(row, 'attempt_count'),
    stepCount: numberField(row, 'step_count'),
    failureCount: numberField(row, 'failure_count'),
    nextRunAt: stringField(row, 'next_run_at'),
    leaseOwner: optionalStringField(row, 'lease_owner'),
    leaseExpiresAt: optionalStringField(row, 'lease_expires_at'),
    heartbeatAt: optionalStringField(row, 'heartbeat_at'),
    resultSummary: optionalStringField(row, 'result_summary'),
    resultArtifacts: parseTrustedResultArtifacts(
      row.result_artifacts_json,
      'result_artifacts_json',
    ),
    errorCode: optionalStringField(row, 'error_code'),
    errorSummary: optionalStringField(row, 'error_summary'),
    startedAt: optionalStringField(row, 'started_at'),
    updatedAt: stringField(row, 'updated_at'),
    completedAt: optionalStringField(row, 'completed_at'),
    deletedAt: optionalStringField(row, 'deleted_at'),
    retained: numberField(row, 'retain') === 1,
    deliveryStatus: optionalStringField(row, 'delivery_status') as ContinuationJob['deliveryStatus'],
  };
}

function validatePersistedFactProjection(
  row: SqlRow,
  value: {
    route: ContinuationDeliveryRoute;
    sourceFacts: AsyncTaskFactSnapshot;
    taskContract: AsyncTaskContract;
    creatorOpenId: string;
    sourceMessageId: string;
    sourceThreadId: string | undefined;
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    contextSnapshot: ContinuationCheckpoint;
    workingDirectory: string;
    permissions: ContinuationPermissionEnvelope;
    model: string | undefined;
  },
): void {
  const {
    route,
    sourceFacts,
    taskContract,
    creatorOpenId,
    sourceMessageId,
    sourceThreadId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    workingDirectory,
    permissions,
    model,
  } = value;
  const expectedChatId = route.kind === 'message_thread'
    ? route.conversationId
    : `doc:${route.documentToken}`;
  if (
    stringField(row, 'origin_kind') !== route.kind
    || !isDeepStrictEqual(route, sourceFacts.route)
    || sourceFacts.sourceMessageId !== sourceMessageId
    || sourceFacts.sourceThreadId !== sourceThreadId
    || sourceFacts.chatId !== expectedChatId
    || sourceFacts.workingDirectory !== workingDirectory
    || sourceFacts.model !== (model ?? null)
    || !isDeepStrictEqual(sourceFacts.permissions, permissions)
    || taskContract.title !== title
    || taskContract.objective !== objective
    || !isDeepStrictEqual(
      taskContract.acceptanceCriteria.map((criterion) => criterion.description),
      acceptanceCriteria,
    )
    || !isDeepStrictEqual(taskContract.initialContext, contextSnapshot)
    || (route.kind === 'message_thread' && route.sourceMessageId !== sourceMessageId)
    || !routeMatchesSourceThread(route, sourceThreadId)
    || (sourceFacts.provenance === 'captured' && sourceFacts.creatorOpenId !== creatorOpenId)
  ) {
    throw new Error('Continuation persisted facts and execution projection are inconsistent.');
  }
}

function projectCreateRequest(
  request: ContinuationCreateRequest,
  inputs: AsyncTaskFactSnapshot['inputs'],
): ContinuationCreateRequest {
  const taskContract: AsyncTaskContract = {
    schemaVersion: 1,
    title: redactContinuationText(request.taskContract.title),
    objective: redactContinuationText(request.taskContract.objective),
    deliverables: request.taskContract.deliverables.map((deliverable) => ({
      id: deliverable.id,
      description: redactContinuationText(deliverable.description),
      required: deliverable.required,
    })),
    acceptanceCriteria: request.taskContract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: redactContinuationText(criterion.description),
      deliverableIds: [...criterion.deliverableIds],
    })),
    verificationRequirements: request.taskContract.verificationRequirements.map((requirement) => ({
      id: requirement.id,
      description: redactContinuationText(requirement.description),
      kind: requirement.kind,
    })),
    initialContext: redactCheckpoint(request.taskContract.initialContext),
  };
  const sourceFacts: AsyncTaskFactSnapshot = {
    schemaVersion: 1,
    provenance: request.sourceFacts.provenance,
    originalUserText: request.sourceFacts.originalUserText === null
      ? null
      : redactContinuationText(request.sourceFacts.originalUserText),
    sourceContextText: request.sourceFacts.sourceContextText === null
      ? null
      : redactContinuationText(request.sourceFacts.sourceContextText),
    quotedMessageText: request.sourceFacts.quotedMessageText === null
      ? null
      : redactContinuationText(request.sourceFacts.quotedMessageText),
    route: request.route,
    creatorOpenId: request.creatorOpenId,
    chatId: request.sourceFacts.chatId,
    chatType: request.sourceFacts.chatType,
    sourceMessageId: request.sourceMessageId,
    ...(request.sourceThreadId ? { sourceThreadId: request.sourceThreadId } : {}),
    sourceMessageType: request.sourceFacts.sourceMessageType,
    sourceTimestamp: request.sourceFacts.sourceTimestamp,
    inputs: inputs.map((input) => ({ ...input })),
    workingDirectory: request.workingDirectory,
    model: request.model ?? null,
    permissions: request.permissions,
  };
  return {
    ...request,
    title: taskContract.title,
    objective: taskContract.objective,
    acceptanceCriteria: taskContract.acceptanceCriteria.map((criterion) => criterion.description),
    contextSnapshot: taskContract.initialContext,
    sourceFacts,
    taskContract,
  };
}

function continuationJobForCreate(
  jobId: string,
  request: ContinuationCreateRequest,
): ContinuationJob {
  const {
    sourceInputs: _sourceInputs,
    resumeCheckpoint,
    resumeArtifactSourceJobId: _resumeArtifactSourceJobId,
    ...persisted
  } = request;
  return {
    ...persisted,
    jobId,
    rowVersion: 1,
    status: 'queued',
    ...(resumeCheckpoint ? { checkpoint: resumeCheckpoint } : {}),
    recoveryTotalCount: 0,
    recoveryFingerprintCounts: {},
    noProgressCount: 0,
    attemptCount: 0,
    stepCount: 0,
    failureCount: 0,
    nextRunAt: request.createdAt,
    resultArtifacts: [],
    updatedAt: request.createdAt,
    retained: false,
  };
}

function createRequestFingerprint(request: ContinuationCreateRequest): string {
  const sourceInputDescriptors = request.sourceInputs.map((input) => ({
    kind: input.kind,
  }));
  return createHash('sha256').update(JSON.stringify({
    idempotencyKey: request.idempotencyKey,
    retryOfJobId: request.retryOfJobId ?? null,
    creatorOpenId: request.creatorOpenId,
    route: request.route,
    sourceMessageId: request.sourceMessageId,
    sourceThreadId: request.sourceThreadId ?? null,
    sourceFacts: { ...request.sourceFacts, inputs: [] },
    taskContract: request.taskContract,
    sourceInputDescriptors,
    resumeCheckpoint: request.resumeCheckpoint ?? null,
    resumeArtifactSourceJobId: request.resumeArtifactSourceJobId ?? null,
  })).digest('hex');
}

function redactCheckpoint(checkpoint: ContinuationCheckpoint): ContinuationCheckpoint {
  return {
    summary: redactContinuationText(checkpoint.summary),
    completedSteps: checkpoint.completedSteps.map(redactContinuationText),
    remainingSteps: checkpoint.remainingSteps.map(redactContinuationText),
    constraints: checkpoint.constraints.map(redactContinuationText),
    decisions: checkpoint.decisions.map(redactContinuationText),
    references: checkpoint.references.map(redactContinuationText),
  };
}

function legacyFactsAndContract(row: SqlRow): ReturnType<typeof parseLegacyFactsAndContract> {
  try {
    return parseLegacyFactsAndContract(row);
  } catch (error) {
    if (error instanceof LegacyPersistedRowError) throw error;
    throw new LegacyPersistedRowError('Legacy continuation row is malformed.', { cause: error });
  }
}

function parseLegacyFactsAndContract(row: SqlRow): {
  route: ContinuationDeliveryRoute;
  sourceFacts: AsyncTaskFactSnapshot;
  taskContract: AsyncTaskContract;
} {
  const rawRoute = parseTrustedJson(row.route_json, 'route_json');
  if (!isDeliveryRoute(rawRoute)) throw new Error('Continuation delivery route is invalid.');
  const persistedSourceThreadId = optionalStringField(row, 'source_thread_id');
  if (
    rawRoute.kind === 'message_thread'
    && rawRoute.threadId !== undefined
    && persistedSourceThreadId !== undefined
    && rawRoute.threadId !== persistedSourceThreadId
  ) {
    throw new LegacyRouteProjectionError('Legacy message route conflicts with source_thread_id.');
  }
  if (
    rawRoute.kind === 'comment_thread'
    && persistedSourceThreadId !== undefined
    && rawRoute.commentId !== persistedSourceThreadId
  ) {
    throw new LegacyRouteProjectionError('Legacy comment route conflicts with source_thread_id.');
  }
  const sourceThreadId = rawRoute.kind === 'comment_thread'
    ? rawRoute.commentId
    : persistedSourceThreadId ?? rawRoute.threadId;
  const route: ContinuationDeliveryRoute = rawRoute.kind === 'message_thread'
    ? {
        ...rawRoute,
        ...(sourceThreadId ? { threadId: sourceThreadId } : {}),
      }
    : rawRoute;
  const permissions = parsePermissionEnvelope(row.permissions_json);
  const criteria = parseTrustedStringArray(row.acceptance_criteria_json, 'acceptance_criteria_json');
  const initialContext = parseTrustedCheckpoint(row.context_snapshot_json, 'context_snapshot_json');
  return {
    route,
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'legacy_unavailable',
      originalUserText: null,
      sourceContextText: null,
      quotedMessageText: null,
      creatorOpenId: stringField(row, 'creator_open_id'),
      chatId: route.kind === 'message_thread'
        ? route.conversationId
        : `doc:${route.documentToken}`,
      chatType: route.kind === 'comment_thread' ? 'doc_comment' : '',
      route,
      sourceMessageId: stringField(row, 'source_message_id'),
      ...(sourceThreadId ? { sourceThreadId } : {}),
      sourceMessageType: null,
      sourceTimestamp: null,
      inputs: [],
      workingDirectory: stringField(row, 'working_directory'),
      model: optionalStringField(row, 'model') ?? null,
      permissions,
    },
    taskContract: {
      schemaVersion: 1,
      title: stringField(row, 'title'),
      objective: stringField(row, 'objective'),
      deliverables: [],
      acceptanceCriteria: criteria.map((description, index) => ({
        id: legacyCriterionId(description, index),
        description,
        deliverableIds: [],
      })),
      verificationRequirements: [],
      initialContext,
    },
  };
}

function legacyCriterionId(description: string, index: number): string {
  return `criterion_${index + 1}_${createHash('sha256').update(description).digest('hex').slice(0, 12)}`;
}

function redactedLegacyFacts(): AsyncTaskFactSnapshot {
  return {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: '',
    chatId: '',
    chatType: '',
    route: emptyRoute(),
    sourceMessageId: '',
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: '',
    model: null,
    permissions: EMPTY_PERMISSION_ENVELOPE,
  };
}

function redactedLegacyContract(): AsyncTaskContract {
  return {
    schemaVersion: 1,
    title: '',
    objective: '',
    deliverables: [],
    acceptanceCriteria: [],
    verificationRequirements: [],
    initialContext: EMPTY_CHECKPOINT,
  };
}

function trustedRouteFromCorruptRow(row: SqlRow): ContinuationDeliveryRoute | null {
  try {
    const route = parseTrustedJson(row.route_json, 'route_json');
    const rawFacts = parseTrustedJson(row.source_facts_json, 'source_facts_json');
    if (!isDeliveryRoute(route) || !isRecord(rawFacts) || !isDeliveryRoute(rawFacts.route)) {
      return null;
    }
    const sourceMessageId = stringField(row, 'source_message_id');
    const sourceThreadId = optionalStringField(row, 'source_thread_id');
    const expectedChatId = route.kind === 'message_thread'
      ? route.conversationId
      : `doc:${route.documentToken}`;
    if (
      stringField(row, 'origin_kind') !== route.kind
      || !isDeepStrictEqual(route, rawFacts.route)
      || rawFacts.sourceMessageId !== sourceMessageId
      || rawFacts.sourceThreadId !== sourceThreadId
      || rawFacts.chatId !== expectedChatId
      || (route.kind === 'message_thread' && route.sourceMessageId !== sourceMessageId)
      || !routeMatchesSourceThread(route, sourceThreadId)
    ) return null;
    return route;
  } catch {
    return null;
  }
}

function trustedOutboxRoute(row: SqlRow): boolean {
  try {
    const outboxRoute = parseTrustedJson(row.route_json, 'continuation_outbox.route_json');
    const jobRoute = parseTrustedJson(row.job_route_json, 'continuation_jobs.route_json');
    const rawFacts = parseTrustedJson(
      row.job_source_facts_json,
      'continuation_jobs.source_facts_json',
    );
    if (
      !isDeliveryRoute(outboxRoute)
      || !isDeliveryRoute(jobRoute)
      || !isRecord(rawFacts)
      || !isDeliveryRoute(rawFacts.route)
    ) return false;
    const sourceMessageId = stringField(row, 'job_source_message_id');
    const sourceThreadId = optionalStringField(row, 'job_source_thread_id');
    const expectedChatId = jobRoute.kind === 'message_thread'
      ? jobRoute.conversationId
      : `doc:${jobRoute.documentToken}`;
    return stringField(row, 'job_origin_kind') === jobRoute.kind
      && isDeepStrictEqual(outboxRoute, jobRoute)
      && isDeepStrictEqual(jobRoute, rawFacts.route)
      && rawFacts.sourceMessageId === sourceMessageId
      && rawFacts.sourceThreadId === sourceThreadId
      && rawFacts.chatId === expectedChatId
      && (jobRoute.kind !== 'message_thread' || jobRoute.sourceMessageId === sourceMessageId)
      && routeMatchesSourceThread(jobRoute, sourceThreadId);
  } catch {
    return false;
  }
}

function corruptTombstoneFacts(
  row: SqlRow,
  route: ContinuationDeliveryRoute,
  sourceMessageId: string,
  sourceThreadId: string | undefined,
): AsyncTaskFactSnapshot {
  return {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: stringField(row, 'creator_open_id'),
    chatId: route.kind === 'message_thread'
      ? route.conversationId
      : `doc:${route.documentToken}`,
    chatType: route.kind === 'comment_thread' ? 'doc_comment' : '',
    route,
    sourceMessageId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: '',
    model: null,
    permissions: EMPTY_PERMISSION_ENVELOPE,
  };
}

function corruptTombstoneContract(): AsyncTaskContract {
  return {
    schemaVersion: 1,
    title: 'Unavailable task state',
    objective: 'Stored task state failed integrity validation.',
    deliverables: [],
    acceptanceCriteria: [],
    verificationRequirements: [],
    initialContext: EMPTY_CHECKPOINT,
  };
}

function validateCreateRequest(request: ContinuationCreateRequest): void {
  if (!request.idempotencyKey) throw new Error('Continuation idempotency key is required.');
  if (request.title.length > CONTINUATION_LIMITS.titleChars) {
    throw new Error(`Continuation title exceeds ${CONTINUATION_LIMITS.titleChars} characters.`);
  }
  assertUtf8Bytes('objective', request.objective, CONTINUATION_LIMITS.objectiveBytes);
  if (request.acceptanceCriteria.length > CONTINUATION_LIMITS.acceptanceCriteriaCount) {
    throw new Error('Continuation acceptance criteria count exceeds the configured limit.');
  }
  assertJsonBytes(
    'acceptance criteria',
    request.acceptanceCriteria,
    CONTINUATION_LIMITS.contextSnapshotBytes,
  );
  assertJsonBytes(
    'context snapshot',
    request.contextSnapshot,
    CONTINUATION_LIMITS.contextSnapshotBytes,
  );
  assertJsonBytes('required tools', request.requiredTools, CONTINUATION_LIMITS.objectiveBytes);
  validatePermissionEnvelope(request.permissions, true);
  if (!sameStringSet(request.permissions.hostTools, request.requiredTools)) {
    throw new Error('Continuation permission host tools must match required tools.');
  }
  assertJsonBytes('permission envelope', request.permissions, CONTINUATION_LIMITS.contextSnapshotBytes);
  if (!isDeliveryRoute(request.route)) throw new Error('Continuation delivery route is invalid.');
  if (!routeMatchesSourceThread(request.route, request.sourceThreadId)) {
    throw new Error('Continuation delivery route does not match the source thread.');
  }
  assertJsonBytes('delivery route', request.route, CONTINUATION_LIMITS.contextSnapshotBytes);
  validateSourceFacts(request.sourceFacts);
  validateTaskContract(request.taskContract, request.sourceFacts.provenance === 'captured');
  assertJsonBytes('source inputs', request.sourceInputs.map((input) => ({
    kind: input.kind,
    fileName: input.fileName,
  })), CONTINUATION_LIMITS.contextSnapshotBytes);
  if (request.resumeCheckpoint && !isCheckpointV2(request.resumeCheckpoint)) {
    throw new Error('Continuation resume checkpoint is invalid.');
  }
  if (request.resumeCheckpoint?.artifacts.length && !request.resumeArtifactSourceJobId) {
    throw new Error('Continuation resume artifacts require a source Job ID.');
  }
  if (request.resumeArtifactSourceJobId && !request.resumeCheckpoint?.artifacts.length) {
    throw new Error('Continuation resume artifact source is not needed without checkpoint artifacts.');
  }
  if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 20) {
    throw new Error('Continuation maxAttempts must be an integer between 1 and 20.');
  }
  if (!Number.isInteger(request.maxRetries) || request.maxRetries < 0) {
    throw new Error('Continuation maxRetries must be a non-negative integer.');
  }
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1) {
    throw new Error('Continuation timeoutSeconds must be a positive integer.');
  }
  if (!Number.isFinite(Date.parse(request.createdAt)) || !Number.isFinite(Date.parse(request.expiresAt))) {
    throw new Error('Continuation timestamps must be valid ISO timestamps.');
  }
}

function validateTaskContract(
  value: unknown,
  requireRequirements = false,
): asserts value is AsyncTaskContract {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'title',
    'objective',
    'deliverables',
    'acceptanceCriteria',
    'verificationRequirements',
    'initialContext',
  ])) throw new Error('Continuation task contract is invalid.');
  const contract = value as Partial<AsyncTaskContract>;
  if (
    typeof contract.title !== 'string'
    || typeof contract.objective !== 'string'
    || !Array.isArray(contract.deliverables)
    || !Array.isArray(contract.acceptanceCriteria)
    || !Array.isArray(contract.verificationRequirements)
    || !isCheckpoint(contract.initialContext)
    || !contract.deliverables.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'required'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && typeof entry.required === 'boolean')
    || !contract.acceptanceCriteria.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'deliverableIds'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && Array.isArray(entry.deliverableIds)
      && entry.deliverableIds.every((id) => typeof id === 'string'))
    || !contract.verificationRequirements.every((entry) =>
      isRecord(entry)
      && hasExactKeys(entry, ['id', 'description', 'kind'])
      && typeof entry.id === 'string'
      && typeof entry.description === 'string'
      && (entry.kind === 'artifact_exists'
        || entry.kind === 'artifact_sha256'
        || entry.kind === 'evidence_reference'))
  ) {
    throw new Error('Continuation task contract is invalid.');
  }
  if (contract.schemaVersion !== 1) throw new Error('Continuation task contract schema version is invalid.');
  if (
    requireRequirements
    && (
      contract.title.trim().length === 0
      || contract.objective.trim().length === 0
      || contract.deliverables.length === 0
      || !contract.deliverables.some((deliverable) => deliverable.required)
      || contract.deliverables.some((deliverable) => deliverable.description.trim().length === 0)
      || contract.acceptanceCriteria.length === 0
      || contract.acceptanceCriteria.some((criterion) =>
        criterion.description.trim().length === 0 || criterion.deliverableIds.length === 0)
      || contract.verificationRequirements.length === 0
      || contract.verificationRequirements.some((requirement) =>
        requirement.description.trim().length === 0)
    )
  ) {
    throw new Error('Captured continuation task contract requirements must not be empty.');
  }
  if (contract.deliverables.length > CONTINUATION_LIMITS.deliverableCount) {
    throw new Error('Continuation deliverable count exceeds the configured limit.');
  }
  if (contract.acceptanceCriteria.length > CONTINUATION_LIMITS.acceptanceCriteriaCount) {
    throw new Error('Continuation acceptance criteria count exceeds the configured limit.');
  }
  if (contract.verificationRequirements.length > CONTINUATION_LIMITS.verificationRequirementCount) {
    throw new Error('Continuation verification requirement count exceeds the configured limit.');
  }
  const validateIds = (label: string, entries: Array<{ id: string }>): Set<string> => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!CONTINUATION_CONTRACT_ID_PATTERN.test(entry.id)) {
        throw new Error(`Continuation ${label} id is invalid.`);
      }
      if (redactContinuationText(entry.id) !== entry.id) {
        throw new Error(`Continuation ${label} id must not contain a credential-shaped value.`);
      }
      if (ids.has(entry.id)) throw new Error(`Continuation ${label} ids must be unique.`);
      ids.add(entry.id);
    }
    return ids;
  };
  const deliverableIds = validateIds('deliverable', contract.deliverables);
  validateIds('acceptance criterion', contract.acceptanceCriteria);
  validateIds('verification requirement', contract.verificationRequirements);
  for (const criterion of contract.acceptanceCriteria) {
    for (const deliverableId of criterion.deliverableIds) {
      if (!deliverableIds.has(deliverableId)) {
        throw new Error(`Continuation acceptance criterion references unknown deliverable ${deliverableId}.`);
      }
    }
  }
  assertJsonBytes('task contract', contract, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validateSourceFacts(value: unknown): asserts value is AsyncTaskFactSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'provenance',
    'originalUserText',
    'sourceContextText',
    'quotedMessageText',
    'creatorOpenId',
    'chatId',
    'chatType',
    'route',
    'sourceMessageId',
    'sourceThreadId',
    'sourceMessageType',
    'sourceTimestamp',
    'inputs',
    'workingDirectory',
    'model',
    'permissions',
  ])) throw new Error('Continuation source facts are invalid.');
  const facts = value as Partial<AsyncTaskFactSnapshot>;
  if (
    facts.schemaVersion !== 1
    || (facts.provenance !== 'captured' && facts.provenance !== 'legacy_unavailable')
    || !isNullableString(facts.originalUserText)
    || !isNullableString(facts.sourceContextText)
    || !isNullableString(facts.quotedMessageText)
    || typeof facts.creatorOpenId !== 'string'
    || typeof facts.chatId !== 'string'
    || typeof facts.chatType !== 'string'
    || !isDeliveryRoute(facts.route)
    || typeof facts.sourceMessageId !== 'string'
    || (facts.sourceThreadId !== undefined && typeof facts.sourceThreadId !== 'string')
    || !isNullableString(facts.sourceMessageType)
    || !isNullableString(facts.sourceTimestamp)
    || !Array.isArray(facts.inputs)
    || !facts.inputs.every(isManagedInputArtifact)
    || typeof facts.workingDirectory !== 'string'
    || !isNullableString(facts.model)
  ) {
    throw new Error('Continuation source facts are invalid.');
  }
  validateManagedInputArtifacts(facts.inputs);
  validatePermissionEnvelope(facts.permissions, false);
  assertJsonBytes('source facts', facts, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validateManagedInputArtifacts(
  inputs: AsyncTaskFactSnapshot['inputs'],
): void {
  if (inputs.length > CONTINUATION_LIMITS.inputFileCount) {
    throw new Error('Continuation persisted input file count is invalid.');
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const input of inputs) {
    if (ids.has(input.id) || paths.has(input.relativePath)) {
      throw new Error('Continuation persisted input identities must be unique.');
    }
    ids.add(input.id);
    paths.add(input.relativePath);
    if (input.sizeBytes > CONTINUATION_LIMITS.inputBytesPerFile) {
      throw new Error('Continuation persisted input file size is invalid.');
    }
    totalBytes += input.sizeBytes;
    if (totalBytes > CONTINUATION_LIMITS.managedInputBytesPerJob) {
      throw new Error('Continuation persisted input total size is invalid.');
    }
  }
}

function validateFinalResult(
  finalMessage: string,
  resultSummary: string | undefined,
  artifacts: string[],
): void {
  assertJsonBytes('final message', finalMessage, CONTINUATION_LIMITS.finalMessageBytes);
  if (resultSummary !== undefined) {
    assertJsonBytes('result summary', resultSummary, CONTINUATION_LIMITS.objectiveBytes);
  }
  if (artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Continuation result exceeds ${CONTINUATION_LIMITS.artifactCount} artifacts.`);
  }
  assertJsonBytes('result artifacts', artifacts, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validatePartialResult(
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
): void {
  assertJsonBytes('partial result', outcome, CONTINUATION_LIMITS.finalMessageBytes);
  if (outcome.artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Continuation result exceeds ${CONTINUATION_LIMITS.artifactCount} artifacts.`);
  }
}

function partialResultSummary(
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
): string {
  return outcome.keyFindings[0]
    ?? outcome.completedWork[0]
    ?? 'The task produced a partial result.';
}

function renderPartialPayload(
  jobId: string,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'partial' }>,
  reason = 'The continuation completed with a partial result.',
): string {
  return [
    `Task partially completed: ${jobId}`,
    `Reason: ${reason}`,
    renderResultSection('Completed work', outcome.completedWork),
    renderResultSection('Key findings', outcome.keyFindings),
    renderResultSection('Remaining work', outcome.unperformedWork),
    renderResultSection('Risks', outcome.risks),
    renderResultSection('Next steps', outcome.nextSteps),
  ].filter(Boolean).join('\n');
}

function renderBlockedPayload(
  jobId: string,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'blocked' }>,
  recovery?: ContinuationRecoveryState,
): string {
  return [
    `Task blocked: ${jobId}`,
    `Reason: ${outcome.errorSummary}`,
    `Required capability: ${outcome.requiredCapability}`,
    recovery ? `Failed step: ${recovery.failure.failedStep}` : '',
    recovery ? `Failure category: ${recovery.failure.category}` : '',
    recovery
      ? `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`
      : '',
    recovery ? `Diagnostic: ${recovery.failure.diagnostic}` : '',
    renderResultSection('Completed work', outcome.completedWork),
    renderResultSection('Remaining work', outcome.unperformedWork),
  ].filter(Boolean).join('\n');
}

function renderFailedPayload(
  jobId: string,
  errorSummary: string,
  recovery?: ContinuationRecoveryState,
): string {
  return [
    `Task failed: ${jobId}`,
    `Reason: ${errorSummary}`,
    recovery ? `Failed step: ${recovery.failure.failedStep}` : '',
    recovery ? `Failure category: ${recovery.failure.category}` : '',
    recovery
      ? `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`
      : '',
    recovery ? `Diagnostic: ${recovery.failure.diagnostic}` : '',
  ].filter(Boolean).join('\n');
}

function renderProgressPayload(
  job: ContinuationJob,
  claim: ContinuationClaim,
  outcome: Extract<ContinuationStepOutcome, { outcome: 'continue' }>,
): string {
  const payload = [
    `Task progress: ${job.jobId} (${claim.attempt.attemptId})`,
    `Attempt: ${claim.attempt.ordinal} / ${job.maxAttempts}`,
    renderResultSection('Completed work', boundedProgressValues(outcome.checkpoint.completedStepIds)),
    renderResultSection('Key findings', boundedProgressValues(
      outcome.checkpoint.summary ? [outcome.checkpoint.summary] : [],
    )),
    renderResultSection(
      'Remaining work',
      boundedProgressValues(outcome.checkpoint.remainingSteps.map((step) => step.description)),
    ),
    outcome.checkpoint.nextAction
      ? `Next attempt: ${truncateCharacters(outcome.checkpoint.nextAction.description.trim(), 500)}`
      : '',
  ].filter(Boolean).join('\n');
  return truncateCharacters(payload, PROGRESS_PAYLOAD_MAX_CHARS);
}

function attemptBudgetTerminalReason(
  job: ContinuationJob,
  checkpoint: ContinuationCheckpointV2,
): { errorCode: string; errorSummary: string } {
  const artifactStatus = continuationArtifactStatus({ ...job, checkpoint });
  if (artifactStatus === 'not_started' || artifactStatus === 'creating') {
    return {
      errorCode: 'attempts_exhausted_artifact_not_started',
      errorSummary: 'The execution budget was exhausted before a required user-facing artifact was ready.',
    };
  }
  if (artifactStatus === 'created') {
    return {
      errorCode: 'attempts_exhausted_artifact_unverified',
      errorSummary: 'The execution budget was exhausted after artifact creation but before all required verification completed.',
    };
  }
  return {
    errorCode: 'attempts_exhausted_acceptance_incomplete',
    errorSummary: 'The execution budget was exhausted with one or more acceptance criteria still incomplete.',
  };
}

function renderInterruptPayload(
  job: ContinuationJob,
  claim: ContinuationClaim,
  interruptId: string,
  prompt: string,
  failure: DurableRunFailure,
  recovery: ContinuationRecoveryState,
  checkpoint: ContinuationCheckpointV2,
): string {
  return [
    `Task waiting for input: ${job.jobId} (${interruptId})`,
    `Attempt: ${claim.attempt.ordinal} / ${job.maxAttempts}`,
    `Failed step: ${failure.failedStep}`,
    `Failure category: ${failure.category}`,
    `Recovery attempts: ${recovery.fingerprintAttempts} for this failure, ${recovery.totalAttempts} total`,
    `Diagnostic: ${failure.diagnostic}`,
    `Action needed: ${prompt}`,
    renderResultSection('Completed work', boundedProgressValues(checkpoint.completedStepIds)),
    `Resume: /task resume ${job.jobId} <input>`,
  ].filter(Boolean).join('\n');
}

function boundedProgressValues(values: string[]): string[] {
  return uniqueNonEmpty(values).slice(0, 3).map((value) => truncateCharacters(value, 500));
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, Math.max(0, maxCharacters - 3)).join('').trimEnd()}...`;
}

function cleanupErrorSummary(error: unknown): string {
  const summary = error instanceof Error
    ? `${error.name}: ${error.message}`
    : 'Unknown continuation cleanup error.';
  return truncateCharacters(summary.replace(/[\r\n\t]+/g, ' '), 500);
}

function renderResultSection(title: string, values: string[]): string {
  const filtered = uniqueNonEmpty(values);
  return filtered.length > 0 ? `${title}:\n${filtered.map((value) => `- ${value}`).join('\n')}` : '';
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validateToolRequest(request: ContinuationToolRequest): void {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(request.tool)) {
    throw new Error('Continuation local CLI tool name is invalid.');
  }
  if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
    throw new Error('Continuation local CLI tool args must be strings.');
  }
  assertJsonBytes('tool request', request, CONTINUATION_LIMITS.contextSnapshotBytes);
}

function validateToolResult(result: ContinuationToolResult): void {
  if (typeof result.ok !== 'boolean' || typeof result.message !== 'string') {
    throw new Error('Continuation local CLI tool result is invalid.');
  }
  if (result.failure !== undefined && !isDurableRunFailure(result.failure)) {
    throw new Error('Continuation local CLI tool failure is invalid.');
  }
  assertJsonBytes('tool result', result, CONTINUATION_LIMITS.toolResultBytes);
}

function parseToolResult(value: SqlRow[string] | undefined): ContinuationToolResult {
  const parsed = parseJson<unknown>(value, null);
  if (
    !parsed
    || typeof parsed !== 'object'
    || typeof (parsed as { ok?: unknown }).ok !== 'boolean'
    || typeof (parsed as { message?: unknown }).message !== 'string'
  ) {
    throw new Error('Invalid continuation tool result in database.');
  }
  if (
    (parsed as { failure?: unknown }).failure !== undefined
    && !isDurableRunFailure((parsed as { failure?: unknown }).failure)
  ) throw new Error('Invalid continuation tool failure in database.');
  return parsed as ContinuationToolResult;
}

function parsePermissionEnvelope(value: SqlRow[string] | undefined): ContinuationPermissionEnvelope {
  const parsed = parseJson<unknown>(value, null);
  const normalized = normalizePermissionEnvelope(parsed);
  validatePermissionEnvelope(normalized, false);
  return normalized;
}

function normalizePermissionEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  const rawFilesystem = envelope.filesystem;
  if (!rawFilesystem || typeof rawFilesystem !== 'object' || Array.isArray(rawFilesystem)) {
    return value;
  }
  const filesystem = rawFilesystem as Record<string, unknown>;
  return {
    ...envelope,
    profile: envelope.profile ?? 'bounded',
    filesystem: {
      ...filesystem,
      requestedPaths: filesystem.requestedPaths ?? [],
    },
    externalSideEffects: envelope.externalSideEffects ?? 'denied',
  };
}

function validatePermissionEnvelope(
  value: unknown,
  requireAbsoluteRoot: boolean,
): asserts value is ContinuationPermissionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Continuation permission envelope is invalid.');
  }
  if (!hasExactKeys(value as Record<string, unknown>, [
    'profile',
    'filesystem',
    'hostTools',
    'network',
    'externalSideEffects',
    'approval',
  ])) throw new Error('Continuation permission envelope is invalid.');
  const envelope = value as Partial<ContinuationPermissionEnvelope>;
  const filesystem = envelope.filesystem;
  const approval = envelope.approval;
  const requestedPaths = filesystem?.requestedPaths;
  if (
    (envelope.profile !== 'bounded' && envelope.profile !== 'trusted_personal_workspace')
    || !filesystem
    || !hasExactKeys(filesystem as unknown as Record<string, unknown>, [
      'root', 'mode', 'requestedPaths',
    ])
    || typeof filesystem.root !== 'string'
    || (requireAbsoluteRoot && !path.isAbsolute(filesystem.root))
    || (filesystem.mode !== 'read-only' && filesystem.mode !== 'workspace-write')
    || !Array.isArray(requestedPaths)
    || requestedPaths.length > CONTINUATION_LIMITS.requestedPathCount
    || !requestedPaths.every((requestedPath) =>
      typeof requestedPath === 'string' && path.isAbsolute(requestedPath))
    || !Array.isArray(envelope.hostTools)
    || !envelope.hostTools.every((tool) => typeof tool === 'string' && tool.length > 0)
    || (envelope.network !== 'none' && envelope.network !== 'enabled')
    || (envelope.externalSideEffects !== 'denied' && envelope.externalSideEffects !== 'allowed')
    || !approval
    || !hasExactKeys(approval as unknown as Record<string, unknown>, ['mode'])
    || (approval.mode !== 'never' && approval.mode !== 'interactive')
  ) {
    throw new Error('Continuation permission envelope is invalid.');
  }
  if (
    (envelope.profile === 'bounded'
      && (envelope.network !== 'none'
        || envelope.externalSideEffects !== 'denied'))
    || (envelope.profile === 'trusted_personal_workspace'
      && (requestedPaths.length === 0
        || envelope.network !== 'enabled'
        || envelope.externalSideEffects !== 'allowed'))
  ) {
    throw new Error('Continuation permission envelope profile is inconsistent.');
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

interface RedactionQuarantines {
  artifact: string | null;
  input: string | null;
}

async function restoreRedactionQuarantines(
  jobId: string,
  quarantines: RedactionQuarantines,
  artifacts: ContinuationArtifactStore,
  inputs: ContinuationInputStorePort,
): Promise<unknown[]> {
  const operations: Promise<void>[] = [];
  if (quarantines.artifact) {
    operations.push(artifacts.restoreQuarantine(jobId, quarantines.artifact));
  }
  if (quarantines.input) {
    operations.push(inputs.restoreQuarantine(jobId, quarantines.input));
  }
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

async function discardRedactionQuarantines(
  jobId: string,
  quarantines: RedactionQuarantines,
  artifacts: ContinuationArtifactStore,
  inputs: ContinuationInputStorePort,
): Promise<unknown[]> {
  const operations: Promise<void>[] = [];
  if (quarantines.artifact) {
    operations.push(artifacts.discardQuarantine(jobId, quarantines.artifact));
  }
  if (quarantines.input) {
    operations.push(inputs.discardQuarantine(jobId, quarantines.input));
  }
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function boundedFailure(failure: ContinuationFailure): ContinuationFailure {
  return {
    errorCode: failure.errorCode.slice(0, 128) || 'continuation_failed',
    errorSummary: truncateUtf8(failure.errorSummary, CONTINUATION_LIMITS.objectiveBytes),
    retryable: failure.retryable,
  };
}

function boundedDurableRunFailure(failure: DurableRunFailure): DurableRunFailure {
  const bounded: DurableRunFailure = {
    category: failure.category,
    retrySafety: failure.retrySafety,
    capabilityAvailable: failure.capabilityAvailable,
    operationRisk: failure.operationRisk,
    hints: failure.hints.slice(0, 8).map((hint) => truncateCharacters(
      redactContinuationText(hint),
      500,
    )),
    failedStep: truncateCharacters(failure.failedStep, 80),
    diagnostic: truncateCharacters(redactContinuationText(failure.diagnostic), 1_000),
    fingerprint: failure.fingerprint.slice(0, 128),
  };
  if (!bounded.fingerprint || !bounded.failedStep) {
    throw new Error('Continuation durable failure identity is invalid.');
  }
  assertJsonBytes('durable failure', bounded, CONTINUATION_LIMITS.contextSnapshotBytes);
  return bounded;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  const suffix = '...';
  const buffer = Buffer.from(value, 'utf-8').subarray(0, maxBytes - suffix.length);
  return `${buffer.toString('utf-8').replace(/\uFFFD+$/u, '')}${suffix}`;
}

function assertJsonBytes(name: string, value: unknown, limit: number): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error(`Continuation ${name} is not serializable.`);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > limit) throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
}

function assertUtf8Bytes(name: string, value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf-8') > limit) {
    throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
  }
}

function makeId(prefix: 'job' | 'att' | 'out' | 'int'): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function deliveryIdempotencyKey(jobId: string, eventKey: string): string {
  return `ct_${createHash('sha256')
    .update(`${jobId}\0${eventKey}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function toolCallId(jobId: string, stepId: string, requestHash: string): string {
  return `call_${createHash('sha256')
    .update(`${jobId}\0${stepId}\0${requestHash}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function continuationStepId(job: ContinuationJob): string {
  return job.checkpoint?.nextAction?.id
    ?? job.checkpoint?.currentStepId
    ?? 'initial-step';
}

function canReexecuteSameToolRequest(
  job: ContinuationJob,
  failure: DurableRunFailure,
): boolean {
  const userResolvedAccess = Boolean(
    job.recovery?.userInput
    && ['authentication_required', 'permission_required'].includes(failure.category),
  );
  const boundedAutomaticRetry = Boolean(
    job.recovery?.lastDecision === 'retry'
    && job.recovery.failure.fingerprint === failure.fingerprint
    && failure.retrySafety === 'safe'
    && ['transient', 'unknown'].includes(failure.category),
  );
  return userResolvedAccess || boundedAutomaticRetry;
}

function canReplaceCompletedToolFailure(
  job: ContinuationJob,
  failure: DurableRunFailure,
): boolean {
  return (failure.category === 'invalid_invocation' && failure.retrySafety === 'safe')
    || canReexecuteSameToolRequest(job, failure);
}

function hasOpaqueExecutionEffects(job: ContinuationJob): boolean {
  return job.permissions.filesystem.mode === 'workspace-write'
    || job.permissions.network === 'enabled'
    || job.permissions.externalSideEffects === 'allowed';
}

function toolRequestHash(request: ContinuationToolRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function emptyRoute(): ContinuationDeliveryRoute {
  return {
    kind: 'message_thread',
    conversationId: '',
    sourceMessageId: '',
  };
}

function parseJson<T>(value: SqlRow[string] | undefined, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseTrustedJson(value: SqlRow[string] | undefined, field: string): unknown {
  if (typeof value !== 'string') {
    throw new Error(`Invalid continuation database field: ${field}.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid trusted continuation JSON field: ${field}.`, { cause: error });
  }
}

function parseTrustedStringArray(
  value: SqlRow[string] | undefined,
  field: string,
): string[] {
  const parsed = parseTrustedJson(value, field);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid continuation string-array field: ${field}.`);
  }
  return parsed;
}

function parseTrustedCheckpoint(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationCheckpoint {
  const parsed = parseTrustedJson(value, field);
  if (!isCheckpoint(parsed)) throw new Error(`Invalid continuation checkpoint field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.checkpointBytes);
  return parsed;
}

function parseTrustedCheckpointV2(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationCheckpointV2 {
  const parsed = parseTrustedJson(value, field);
  const checkpoint = isCheckpoint(parsed) ? legacyCheckpointToV2(parsed) : parsed;
  if (!isCheckpointV2(checkpoint)) {
    throw new Error(`Invalid continuation V2 checkpoint field: ${field}.`);
  }
  assertJsonBytes(field, checkpoint, CONTINUATION_LIMITS.checkpointBytes);
  return checkpoint;
}

function parseTrustedAttemptDelta(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationAttemptDelta {
  const parsed = parseTrustedJson(value, field);
  if (!isAttemptDelta(parsed)) throw new Error(`Invalid continuation attempt delta field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.checkpointBytes);
  return parsed;
}

function parseTrustedVerification(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationVerificationVerdict {
  const parsed = parseTrustedJson(value, field);
  if (!isVerificationVerdict(parsed)) {
    throw new Error(`Invalid continuation verification field: ${field}.`);
  }
  return parsed;
}

function parseTrustedRecoveryState(
  value: SqlRow[string] | undefined,
  field: string,
): ContinuationRecoveryState {
  const parsed = parseTrustedJson(value, field);
  if (
    !isRecord(parsed)
    || !isDurableRunFailure(parsed.failure)
    || !Number.isInteger(parsed.fingerprintAttempts)
    || Number(parsed.fingerprintAttempts) < 1
    || !Number.isInteger(parsed.totalAttempts)
    || Number(parsed.totalAttempts) < 1
    || !['retry', 'wait_user', 'block', 'fail'].includes(String(parsed.lastDecision))
    || (parsed.userInput !== undefined && typeof parsed.userInput !== 'string')
  ) throw new Error(`Invalid continuation recovery field: ${field}.`);
  assertJsonBytes(field, parsed, CONTINUATION_LIMITS.contextSnapshotBytes);
  return parsed as unknown as ContinuationRecoveryState;
}

function parseTrustedCountRecord(
  value: SqlRow[string] | undefined,
  field: string,
): Record<string, number> {
  const parsed = parseTrustedJson(value, field);
  if (
    !isRecord(parsed)
    || Object.entries(parsed).some(([key, count]) =>
      !key || !Number.isInteger(count) || Number(count) < 0)
  ) throw new Error(`Invalid continuation count record: ${field}.`);
  return parsed as Record<string, number>;
}

function isDurableRunFailure(value: unknown): value is DurableRunFailure {
  return isRecord(value)
    && ['invalid_invocation', 'transient', 'authentication_required', 'permission_required',
      'capability_unavailable', 'terminal', 'unknown'].includes(String(value.category))
    && ['safe', 'unsafe', 'unknown'].includes(String(value.retrySafety))
    && typeof value.capabilityAvailable === 'boolean'
    && ['pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown']
      .includes(String(value.operationRisk))
    && Array.isArray(value.hints)
    && value.hints.every((hint) => typeof hint === 'string')
    && typeof value.failedStep === 'string'
    && typeof value.diagnostic === 'string'
    && typeof value.fingerprint === 'string';
}

function parseTrustedResultArtifacts(
  value: SqlRow[string] | undefined,
  field: string,
): string[] {
  const artifacts = parseTrustedStringArray(value, field);
  if (artifacts.length > CONTINUATION_LIMITS.artifactCount) {
    throw new Error(`Invalid continuation artifact count in field: ${field}.`);
  }
  assertJsonBytes(field, artifacts, CONTINUATION_LIMITS.contextSnapshotBytes);
  return artifacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCheckpoint(value: unknown): value is ContinuationCheckpoint {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'summary',
      'completedSteps',
      'remainingSteps',
      'constraints',
      'decisions',
      'references',
    ])
    || typeof value.summary !== 'string'
  ) return false;
  return ['completedSteps', 'remainingSteps', 'constraints', 'decisions', 'references']
    .every((field) => Array.isArray(value[field])
      && (value[field] as unknown[]).every((entry) => typeof entry === 'string'));
}

function legacyCheckpointToV2(value: ContinuationCheckpoint): ContinuationCheckpointV2 {
  const remainingSteps = value.remainingSteps.map((description, index) => ({
    id: `legacy-step-${index + 1}`,
    description,
  }));
  return {
    schemaVersion: 2,
    summary: value.summary,
    currentStepId: 'legacy-handoff',
    completedStepIds: [],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps,
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: value.constraints,
    decisions: value.decisions,
    nextAction: remainingSteps[0] ?? null,
    stopReason: 'Migrated from a legacy checkpoint without inventing completion evidence.',
  };
}

function checkpointFromInitialContext(value: ContinuationCheckpoint): ContinuationCheckpointV2 {
  return legacyCheckpointToV2(value);
}

function isCheckpointV2(value: unknown): value is ContinuationCheckpointV2 {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (
    typeof value.summary !== 'string'
    || typeof value.currentStepId !== 'string'
    || typeof value.stopReason !== 'string'
    || !isCheckpointStepOrNull(value.nextAction)
  ) return false;
  if (!['completedStepIds', 'completedCriterionIds', 'completedDeliverableIds', 'constraints', 'decisions']
    .every((field) => isStringArray(value[field]))) return false;
  if (!Array.isArray(value.remainingSteps) || !value.remainingSteps.every(isCheckpointStep)) return false;
  if (!Array.isArray(value.artifacts) || !value.artifacts.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.deliverableId === 'string'
    && typeof entry.path === 'string'
    && typeof entry.sha256 === 'string')) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.requirementId === 'string'
    && isStringArray(entry.criterionIds)
    && (entry.artifactId === undefined || typeof entry.artifactId === 'string')
    && (entry.reference === undefined || typeof entry.reference === 'string'))) return false;
  return Array.isArray(value.sideEffects) && value.sideEffects.every((entry) =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.description === 'string'
    && typeof entry.idempotencyKey === 'string');
}

function isCheckpointStep(value: unknown): value is ContinuationCheckpointV2['remainingSteps'][number] {
  return isRecord(value) && typeof value.id === 'string' && typeof value.description === 'string';
}

function isCheckpointStepOrNull(value: unknown): value is ContinuationCheckpointV2['nextAction'] {
  return value === null || isCheckpointStep(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isAttemptDelta(value: unknown): value is ContinuationAttemptDelta {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.stepId === 'string'
    && typeof value.checkpointHash === 'string'
    && typeof value.materialHash === 'string'
    && typeof value.stateChanged === 'boolean'
    && ['newCompletedStepIds', 'newCompletedCriterionIds', 'newCompletedDeliverableIds',
      'newArtifactIds', 'newEvidenceIds', 'newSideEffectIds']
      .every((field) => isStringArray(value[field]))
    && (value.nextActionStepId === undefined || typeof value.nextActionStepId === 'string');
}

function isVerificationVerdict(value: unknown): value is ContinuationVerificationVerdict {
  return isRecord(value)
    && (value.status === 'accepted' || value.status === 'revision_required')
    && isStringArray(value.findings);
}

function isDeliveryRoute(value: unknown): value is ContinuationDeliveryRoute {
  if (!isRecord(value)) return false;
  if (value.kind === 'message_thread') {
    return hasExactKeys(value, ['kind', 'conversationId', 'sourceMessageId', 'threadId'])
      && typeof value.conversationId === 'string'
      && typeof value.sourceMessageId === 'string'
      && (value.threadId === undefined || typeof value.threadId === 'string');
  }
  return hasExactKeys(value, ['kind', 'documentToken', 'commentId', 'fileType'])
    && value.kind === 'comment_thread'
    && typeof value.documentToken === 'string'
    && typeof value.commentId === 'string'
    && typeof value.fileType === 'string';
}

function routeMatchesSourceThread(
  route: ContinuationDeliveryRoute,
  sourceThreadId: string | undefined,
): boolean {
  return route.kind === 'message_thread'
    ? route.threadId === sourceThreadId
    : route.commentId === sourceThreadId;
}

function isManagedInputArtifact(value: unknown): value is AsyncTaskFactSnapshot['inputs'][number] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'kind', 'fileName', 'relativePath', 'sha256', 'sizeBytes',
  ])) return false;
  return /^input_\d{3}$/.test(String(value.id ?? ''))
    && (value.kind === 'message_image' || value.kind === 'message_attachment')
    && typeof value.fileName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.fileName)
    && typeof value.relativePath === 'string'
    && value.relativePath === value.fileName
    && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.sizeBytes === 'number'
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0;
}

export {
  addMilliseconds,
  assertJsonBytes,
  attemptBudgetTerminalReason,
  boundedDurableRunFailure,
  boundedFailure,
  canReexecuteSameToolRequest,
  canReplaceCompletedToolFailure,
  checkpointFromInitialContext,
  cleanupErrorSummary,
  continuationJobForCreate,
  continuationStepId,
  corruptTombstoneContract,
  corruptTombstoneFacts,
  createRequestFingerprint,
  deliveryIdempotencyKey,
  emptyRoute,
  hasOpaqueExecutionEffects,
  isDeliveryRoute,
  jobSelectSql,
  makeId,
  mapJob,
  mapPendingInterruptRoute,
  numberField,
  optionalStringField,
  parseToolResult,
  parseTrustedJson,
  partialResultSummary,
  projectCreateRequest,
  redactedLegacyContract,
  redactedLegacyFacts,
  restoreRedactionQuarantines,
  renderBlockedPayload,
  renderFailedPayload,
  renderInterruptPayload,
  renderPartialPayload,
  renderProgressPayload,
  stringField,
  toolCallId,
  toolRequestHash,
  trustedRouteFromCorruptRow,
  truncateCharacters,
  validateCreateRequest,
  validateFinalResult,
  validatePartialResult,
  validateToolRequest,
  validateToolResult,
  discardRedactionQuarantines,
};
export type { RedactionQuarantines };
