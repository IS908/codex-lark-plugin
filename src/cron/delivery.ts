import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isFeishuOpenMessageId } from '../codex-exec-error.js';
import type {
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
} from '../domain/durable-run.js';
import type { DurableRunDelivery, DurableRunDeliveryContext, DurableRunRepository } from '../ports/durable-run.js';
import type { ReplyRequest, ReplySendResult } from '../reply-sender.js';
import {
  getFeishuApiCode,
  isFeishuTimeoutError,
  isRetryableFeishuError,
} from '../feishu-retry.js';
import { isPermanentTargetError } from '../scheduler-policy.js';
import { sanitizeDiagnosticText } from '../cronjob-diagnostics.js';
import { cronArtifactPayloadSchema, parseCronRunState, type CronArtifactPayload, type CronTerminalPayload } from './contracts.js';
import { loadCommittedCronArtifact } from './managed-artifacts.js';
import {
  autoPauseCronJobForDeliveryFailure,
  projectCronDeliveryPending,
  projectCronDeliveryResult,
  type CronDeliveryRoute,
  type CronRuntimeProjectionRepository,
} from './runtime-projection.js';
import type { CronMessageOriginRecorder } from './message-origin-store.js';

export interface CronDeliveryOptions {
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  projectionRepository?: CronRuntimeProjectionRepository;
  originRecorder?: CronMessageOriginRecorder;
  now?: () => Date;
  artifacts?: {
    repository: DurableRunRepository;
    authorizedRoot: () => string;
    uploadFile: (data: Buffer, fileName: string) => Promise<string | undefined>;
  };
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;
const AMBIGUOUS_SOCKET_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
]);

export function createCronDelivery(options: CronDeliveryOptions): DurableRunDelivery {
  return {
    managesExternalSendBoundary: true,
    async recoverInterruptedDelivery(claim): Promise<DurableRunDeliveryResult> {
      const result: DurableRunDeliveryResult = {
        status: 'unknown',
        errorCode: 'cron_delivery_interrupted_unknown',
        errorSummary: 'Delivery was interrupted after sending may have started; it was not replayed.',
      };
      if (claim.kind === 'cron_artifact') return result;
      try {
        const route = parseCronDeliveryRoute(claim.route);
        const payload = parseCronTerminalPayload(claim.payload);
        assertMatchingCronEnvelope(route, payload);
        await projectDeliveryResultSafely(
          claim,
          route,
          payload,
          result,
          options.projectionRepository,
        );
      } catch {
        // SQLite outbox state remains authoritative when compatibility data is invalid.
      }
      return result;
    },
    async deliver(claim, context): Promise<DurableRunDeliveryResult> {
      const now = (options.now ?? (() => new Date()))().toISOString();
      if (claim.kind === 'cron_artifact') return deliverCronArtifact(options, claim, now, context);
      let route: CronDeliveryRoute;
      let payload: CronTerminalPayload;
      try {
        route = parseCronDeliveryRoute(claim.route);
        payload = parseCronTerminalPayload(claim.payload);
        assertMatchingCronEnvelope(route, payload);
      } catch (error) {
        return {
          status: 'failed',
          errorCode: 'cron_delivery_envelope_invalid',
          errorSummary: deliveryErrorSummary(error, 'Stored Cron delivery data is invalid.'),
        };
      }

      if (claim.recoveredFromExpiredLease) {
        return this.recoverInterruptedDelivery!(claim);
      }

      let pendingProjected: boolean;
      try {
        pendingProjected = await projectCronDeliveryPending(
          claim,
          route,
          payload,
          now,
          options.projectionRepository,
        );
      } catch (error) {
        return {
          status: 'retry',
          errorCode: 'cron_delivery_projection_failed',
          errorSummary: deliveryErrorSummary(error, 'Cron delivery projection failed before send.'),
          retryAt: new Date(Date.parse(now) + retryDelayMs(claim.attemptCount)).toISOString(),
        };
      }

      let result: DurableRunDeliveryResult;
      try {
        if (context && !await context.markExternalSendStarted()) {
          return { status: 'superseded' };
        }
        const response = await options.sendReply(replyRequest(claim, route, payload));
        await recordMessageOriginsSafely(options.originRecorder, response, claim, route, now);
        result = classifyReplyResult(response);
      } catch (error) {
        result = classifyDeliveryError(error, claim, now);
      }
      const projected = pendingProjected
        ? await projectDeliveryResultSafely(
            claim,
            route,
            payload,
            result,
            options.projectionRepository,
          )
        : false;
      if (
        pendingProjected
        && projected
        && result.status === 'failed'
        && result.errorCode === 'cron_delivery_target_permanent'
      ) {
        await autoPauseSafely(
          route,
          result.errorSummary,
          options.projectionRepository,
          claim.runId,
        );
      }
      return result;
    },
  };
}

async function deliverCronArtifact(
  options: CronDeliveryOptions, claim: DurableRunDeliveryClaim, now: string, context?: DurableRunDeliveryContext,
): Promise<DurableRunDeliveryResult> {
  if (claim.recoveredFromExpiredLease) return {
    status: 'unknown', errorCode: 'cron_delivery_interrupted_unknown',
    errorSummary: 'An interrupted attachment send was not replayed.',
  };
  const { artifacts } = options;
  let route: CronDeliveryRoute;
  let payload: CronArtifactPayload;
  let reportId: string;
  let content: Buffer;
  try {
    route = parseCronDeliveryRoute(claim.route);
    payload = cronArtifactPayloadSchema.parse(claim.payload);
    if (!artifacts || claim.workloadKind !== 'cron_prompt' || claim.eventKey !== `cron_artifact:${payload.index}`
      || claim.idempotencyKey !== `cron:${claim.runId}:artifact:${payload.index}`
      || route.jobId !== payload.jobId || route.createdAt !== payload.jobCreatedAt || route.revision !== payload.jobRevision) {
      throw new Error('Mismatched Cron artifact delivery identity.');
    }
    const report = await artifacts.repository.getDeliverySnapshot?.(claim.runId, 'cron_terminal');
    if (!report || !isDeepStrictEqual(report.route, claim.route)) throw new Error('Missing original report.');
    if (report.status === 'pending' || report.status === 'sending') return {
      status: 'retry', errorCode: 'cron_artifact_report_pending', errorSummary: 'Waiting for the original Cron report receipt.',
      retryAt: new Date(Date.parse(now) + 1000).toISOString(), resetAttemptCount: true,
    };
    if (report.status !== 'sent' || !report.messageId || !isFeishuOpenMessageId(report.messageId)) return {
      status: 'failed', errorCode: 'cron_artifact_report_unconfirmed', errorSummary: 'The original report was not confirmed sent.',
    };
    reportId = report.messageId;
    content = await loadCommittedCronArtifact(artifacts.repository, artifacts.authorizedRoot(), claim, payload);
  } catch {
    return {
      status: 'failed', errorCode: 'cron_artifact_reference_invalid',
      errorSummary: 'The committed Cron attachment or report reference is unavailable or no longer matches.',
    };
  }
  try {
    if (context && !await context.markExternalSendStarted()) return { status: 'superseded' };
    const key = await artifacts.uploadFile(content, path.posix.basename(payload.artifact.relativePath));
    if (!key) throw new Error('Lark returned no attachment key.');
    const response = await options.sendReply({
      chat_id: route.targetChatId, reply_to: reportId, text: '', routing: 'standalone',
      rawMessage: { msgType: 'file', content: JSON.stringify({ file_key: key }) },
      idempotencyKey: claim.idempotencyKey, retry: { attempts: 1, retryTimeout: false },
    });
    const result = classifyReplyResult(response);
    if (result.status === 'sent') await recordMessageOriginsSafely(options.originRecorder, response, claim, route, now);
    return result;
  } catch (error) {
    return classifyDeliveryError(error, claim, now);
  }
}

function deliveryErrorSummary(error: unknown, fallback: string): string {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 1000)
    || fallback;
}

async function autoPauseSafely(
  route: CronDeliveryRoute,
  reason: string,
  repository: CronRuntimeProjectionRepository | undefined,
  runId: string,
): Promise<void> {
  try {
    await autoPauseCronJobForDeliveryFailure(route, reason, repository, runId);
  } catch (error) {
    const detail = sanitizeDiagnosticText(
      error instanceof Error ? error.message : String(error),
      1000,
    ) || 'unknown auto-pause error';
    console.error(`[cron] Auto-pause projection failed for run ${runId}: ${detail}`);
  }
}

function replyRequest(
  claim: DurableRunDeliveryClaim,
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
): ReplyRequest {
  return {
    chat_id: route.targetChatId,
    text: payload.kind === 'report' ? payload.report : payload.content,
    ...(payload.kind === 'report'
      ? {
          format: 'card' as const,
          footer: `Source task: ${route.jobName} · ${route.jobId}`,
        }
      : {}),
    ...(payload.kind === 'message'
      ? {
          rawMessage: {
            msgType: payload.messageType,
            content: JSON.stringify(
              payload.messageType === 'text'
                ? { text: payload.content }
                : { content: payload.content },
            ),
          },
        }
      : {}),
    idempotencyKey: claim.idempotencyKey,
    retry: { attempts: 1, retryTimeout: false },
    routing: 'standalone',
  };
}

async function recordMessageOriginsSafely(
  recorder: CronMessageOriginRecorder | undefined,
  response: ReplySendResult,
  claim: DurableRunDeliveryClaim,
  route: CronDeliveryRoute,
  recordedAt: string,
): Promise<void> {
  if (!recorder || !response.messageIds?.length) return;
  try {
    await recorder.recordDelivery({
      messageIds: response.messageIds,
      chatId: route.targetChatId,
      jobId: route.jobId,
      runId: claim.runId,
      jobName: route.jobName,
      jobCreatedAt: route.createdAt,
      recordedAt,
    });
  } catch (error) {
    const detail = deliveryErrorSummary(error, 'Cron message origin recording failed.');
    console.error(`[cron] Message origin recording failed for run ${claim.runId}: ${detail}`);
  }
}

function classifyReplyResult(response: ReplySendResult): DurableRunDeliveryResult {
  const messageId = response.messageIds?.find((candidate) => candidate.trim());
  if (!response.isError && response.sentCount > 0 && messageId) {
    return { status: 'sent', messageId };
  }
  const summary = sanitizeDiagnosticText(
    response.errorText ?? response.statusText ?? 'Feishu delivery returned no confirmed message ID.',
    1000,
  );
  if (response.sentCount > 0 || (!response.isError && response.sentCount > 0)) {
    return {
      status: 'unknown',
      errorCode: 'cron_delivery_confirmation_missing',
      errorSummary: summary || 'Feishu delivery outcome is unknown.',
    };
  }
  return {
    status: 'failed',
    errorCode: 'cron_delivery_rejected',
    errorSummary: summary || 'Feishu delivery failed.',
  };
}

function classifyDeliveryError(
  error: unknown,
  claim: DurableRunDeliveryClaim,
  now: string,
): DurableRunDeliveryResult {
  const summary = deliveryErrorSummary(error, 'Feishu delivery failed.');
  if (isFeishuTimeoutError(error)) {
    return {
      status: 'unknown',
      errorCode: 'cron_delivery_outcome_unknown',
      errorSummary: summary,
    };
  }
  if (isAmbiguousSocketError(error)) {
    return {
      status: 'unknown',
      errorCode: 'cron_delivery_outcome_unknown',
      errorSummary: summary,
    };
  }
  if (isAmbiguousHttpResponse(error)) {
    return {
      status: 'unknown',
      errorCode: 'cron_delivery_outcome_unknown',
      errorSummary: summary,
    };
  }
  if (isRetryableFeishuError(error)) {
    return {
      status: 'retry',
      errorCode: 'cron_delivery_transient',
      errorSummary: summary,
      retryAt: new Date(
        Date.parse(now) + retryDelayMs(claim.attemptCount),
      ).toISOString(),
    };
  }
  return {
    status: 'failed',
    errorCode: isPermanentCronTargetError(error)
      ? 'cron_delivery_target_permanent'
      : 'cron_delivery_failed',
    errorSummary: summary,
  };
}

function isAmbiguousHttpResponse(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const status = Number(current.status ?? current.response?.status);
    if (status === 408 || status >= 500) return true;
    current = current.cause;
  }
  return false;
}

async function projectDeliveryResultSafely(
  claim: DurableRunDeliveryClaim,
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
  result: DurableRunDeliveryResult,
  repository: CronRuntimeProjectionRepository | undefined,
): Promise<boolean> {
  try {
    return await projectCronDeliveryResult(claim, route, payload, result, repository);
  } catch (error) {
    // SQLite outbox state is authoritative. A compatibility projection failure
    // must not turn a Feishu-confirmed send into a duplicate delivery attempt.
    const detail = sanitizeDiagnosticText(
      error instanceof Error ? error.message : String(error),
      1000,
    ) || 'unknown projection error';
    console.error(`[cron] Delivery projection failed for run ${claim.runId}: ${detail}`);
    return false;
  }
}

function isAmbiguousSocketError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (AMBIGUOUS_SOCKET_ERROR_CODES.has(String(current.code ?? '').toUpperCase())) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function assertMatchingCronEnvelope(
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
): void {
  if (
    route.jobId !== payload.jobId
    || route.createdAt !== payload.jobCreatedAt
    || route.revision !== payload.jobRevision
  ) {
    throw new Error('Cron delivery route and payload identify different CronJob definitions.');
  }
}

function isPermanentCronTargetError(error: unknown): boolean {
  if (isPermanentTargetError(error)) return true;
  if (getFeishuApiCode(error) !== 230001) return false;
  const detail = [
    error instanceof Error ? error.message : String(error),
    (error as any)?.response?.data?.msg,
    (error as any)?.data?.msg,
  ].filter(Boolean).join(' ').toLowerCase();
  return /(?:chat|conversation|target).*(?:not found|missing|deleted|invalid)/.test(detail);
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 30_000 * 2 ** Math.max(0, attemptCount - 1));
}

export function parseCronDeliveryRoute(value: unknown): CronDeliveryRoute {
  const raw = object(value, 'Cron delivery route');
  if (raw.kind !== 'cron_job') throw new Error('Cron delivery route kind must be cron_job.');
  const jobId = requiredString(raw.jobId, 'route.jobId');
  return {
    kind: 'cron_job',
    targetChatId: requiredString(raw.targetChatId, 'route.targetChatId'),
    originChatId: requiredString(raw.originChatId, 'route.originChatId'),
    jobId,
    jobName: raw.jobName === undefined
      ? jobId
      : requiredString(raw.jobName, 'route.jobName'),
    createdAt: iso(raw.createdAt, 'route.createdAt'),
    revision: positiveInteger(raw.revision, 'route.revision'),
  };
}

export function parseCronTerminalPayload(value: unknown): CronTerminalPayload {
  const raw = object(value, 'Cron terminal payload');
  if (raw.schemaVersion !== 1) throw new Error('Cron terminal payload schemaVersion must be 1.');
  const kind = raw.kind;
  const base = {
    schemaVersion: 1 as const,
    jobId: requiredString(raw.jobId, 'payload.jobId'),
    jobCreatedAt: iso(raw.jobCreatedAt, 'payload.jobCreatedAt'),
    jobRevision: positiveInteger(raw.jobRevision, 'payload.jobRevision'),
  };
  if (kind === 'message') {
    const runStatus = raw.runStatus === 'success' || raw.runStatus === 'failed'
      ? raw.runStatus
      : (() => { throw new Error('payload.runStatus is invalid.'); })();
    const failureReason = raw.failureReason === null
      ? null
      : requiredString(raw.failureReason, 'payload.failureReason');
    if ((runStatus === 'failed') !== Boolean(failureReason)) {
      throw new Error('Cron message payload status and failureReason are inconsistent.');
    }
    return {
      ...base,
      kind,
      content: requiredString(raw.content, 'payload.content'),
      messageType: requiredString(raw.messageType, 'payload.messageType'),
      runStatus,
      failureReason,
    };
  }
  if (kind !== 'report') throw new Error('Cron terminal payload kind must be report or message.');
  const runStatus = raw.runStatus === 'success' || raw.runStatus === 'failed'
    ? raw.runStatus
    : (() => { throw new Error('payload.runStatus is invalid.'); })();
  const reportType = raw.reportType === 'job_result' || raw.reportType === 'error_report'
    ? raw.reportType
    : (() => { throw new Error('payload.reportType is invalid.'); })();
  if ((runStatus === 'success') !== (reportType === 'job_result')) {
    throw new Error('Cron terminal payload status and report type are inconsistent.');
  }
  const state = parseCronRunState({
    schemaVersion: 1,
    phase: 'completed',
    commit: {
      kind: 'prompt',
      report: raw.report,
      reportType,
      runStatus,
      failureReason: raw.failureReason,
      diagnostics: raw.diagnostics,
    },
  }, 1);
  if (state.commit?.kind !== 'prompt') throw new Error('Cron report payload commit is invalid.');
  return {
    ...base,
    kind,
    report: state.commit.report,
    reportType: state.commit.reportType,
    runStatus: state.commit.runStatus,
    failureReason: state.commit.failureReason,
    diagnostics: state.commit.diagnostics,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function iso(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}
