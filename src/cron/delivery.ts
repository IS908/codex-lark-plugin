import type {
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
} from '../domain/durable-run.js';
import type { DurableRunDelivery } from '../ports/durable-run.js';
import type { ReplyRequest, ReplySendResult } from '../reply-sender.js';
import {
  getFeishuApiCode,
  isFeishuTimeoutError,
  isRetryableFeishuError,
} from '../feishu-retry.js';
import { isPermanentTargetError } from '../scheduler-policy.js';
import { sanitizeDiagnosticText } from '../cronjob-diagnostics.js';
import { parseCronRunState, type CronTerminalPayload } from './contracts.js';
import {
  autoPauseCronJobForDeliveryFailure,
  projectCronDeliveryPending,
  projectCronDeliveryResult,
  type CronDeliveryRoute,
  type CronRuntimeProjectionRepository,
} from './runtime-projection.js';

export interface CronDeliveryOptions {
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  projectionRepository?: CronRuntimeProjectionRepository;
  now?: () => Date;
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;

export function createCronDelivery(options: CronDeliveryOptions): DurableRunDelivery {
  return {
    async deliver(claim): Promise<DurableRunDeliveryResult> {
      const route = parseCronDeliveryRoute(claim.route);
      const payload = parseCronTerminalPayload(claim.payload);
      assertMatchingCronEnvelope(route, payload);
      const now = (options.now ?? (() => new Date()))().toISOString();
      await projectCronDeliveryPending(
        claim,
        route,
        payload,
        now,
        options.projectionRepository,
      );

      let result: DurableRunDeliveryResult;
      try {
        const response = await options.sendReply(replyRequest(claim, route, payload));
        result = classifyReplyResult(response);
      } catch (error) {
        result = classifyDeliveryError(error, claim, now);
      }
      await projectCronDeliveryResult(
        claim,
        route,
        payload,
        result,
        options.projectionRepository,
      );
      if (result.status === 'failed' && result.errorCode === 'cron_delivery_target_permanent') {
        await autoPauseCronJobForDeliveryFailure(
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

function replyRequest(
  claim: DurableRunDeliveryClaim,
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
): ReplyRequest {
  return {
    chat_id: route.targetChatId,
    text: payload.kind === 'report' ? payload.report : payload.content,
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
  const summary = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 1000)
    || 'Feishu delivery failed.';
  if (isFeishuTimeoutError(error)) {
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
  return {
    kind: 'cron_job',
    targetChatId: requiredString(raw.targetChatId, 'route.targetChatId'),
    originChatId: requiredString(raw.originChatId, 'route.originChatId'),
    jobId: requiredString(raw.jobId, 'route.jobId'),
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
    return {
      ...base,
      kind,
      content: requiredString(raw.content, 'payload.content'),
      messageType: requiredString(raw.messageType, 'payload.messageType'),
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
