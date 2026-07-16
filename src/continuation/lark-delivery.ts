import {
  getFeishuApiCode,
  isRetryableFeishuError,
} from '../feishu-retry.js';
import type {
  ContinuationDeliveryClaim,
  ContinuationDeliveryResult,
  ContinuationDeliveryRoute,
} from '../domain/continuation.js';
import type { LarkTransport } from '../lark-transport-contracts.js';
import type {
  ContinuationClock,
  ContinuationTerminalDelivery,
} from '../ports/continuation.js';

const IM_UUID_WINDOW_MS = 60 * 60 * 1_000;
const DOC_COMMENT_MAX_CHARS = 1_000;
const SINGLE_ATTEMPT = { attempts: 1, retryTimeout: false } as const;

type DeliveryErrorKind = 'pre_send' | 'rejected' | 'ambiguous';

export function createLarkContinuationDelivery(
  getTransport: () => LarkTransport,
  clock: ContinuationClock,
): ContinuationTerminalDelivery {
  return {
    deliver: async (claim) => {
      let transport: LarkTransport;
      try {
        transport = getTransport();
      } catch {
        return deliveryErrorResult('pre_send', claim.route.kind === 'message_thread' ? 'im' : 'doc_comment');
      }
      return deliverContinuation(transport, clock, claim);
    },
  };
}

async function deliverContinuation(
  transport: LarkTransport,
  clock: ContinuationClock,
  claim: ContinuationDeliveryClaim,
): Promise<ContinuationDeliveryResult> {
  const marker = terminalMarker(claim);
  if (!marker) {
    return {
      status: 'failed',
      errorCode: 'invalid_terminal_payload',
      errorSummary: 'The terminal message did not contain a valid task marker.',
    };
  }
  return claim.route.kind === 'message_thread'
    ? deliverIm(transport, clock, claim, claim.route)
    : deliverDocComment(transport, claim, claim.route, marker);
}

async function deliverIm(
  transport: LarkTransport,
  clock: ContinuationClock,
  claim: ContinuationDeliveryClaim,
  route: Extract<ContinuationDeliveryRoute, { kind: 'message_thread' }>,
): Promise<ContinuationDeliveryResult> {
  if (
    claim.attemptCount > 1
    && claim.firstAttemptAt
    && claim.lastErrorCode !== 'lark_pre_send_unavailable'
    && clock.now().getTime() - Date.parse(claim.firstAttemptAt) >= IM_UUID_WINDOW_MS
  ) {
    return {
      status: 'delivery_unknown',
      errorCode: 'im_uuid_window_expired',
      errorSummary: 'The prior IM delivery could not be confirmed before the UUID deduplication window expired.',
    };
  }
  try {
    const result = await transport.sendMessage({
      chatId: route.conversationId,
      input: { text: claim.payload },
      replyTo: route.sourceMessageId,
      ...(route.threadId ? { replyInThread: true } : {}),
      uuid: claim.idempotencyKey,
      forceRaw: true,
      retry: SINGLE_ATTEMPT,
    });
    if (result.messageId) return { status: 'delivered', messageId: result.messageId };
    return {
      status: 'delivery_unknown',
      errorCode: 'im_delivery_unconfirmed',
      errorSummary: 'Lark returned no message ID for the terminal message.',
    };
  } catch (error) {
    return deliveryErrorResult(classifyDeliveryError(error), 'im');
  }
}

async function deliverDocComment(
  transport: LarkTransport,
  claim: ContinuationDeliveryClaim,
  route: Extract<ContinuationDeliveryRoute, { kind: 'comment_thread' }>,
  marker: string,
): Promise<ContinuationDeliveryResult> {
  if (claim.attemptCount > 1 && claim.lastErrorCode !== 'lark_pre_send_unavailable') {
    return reconcileDocComment(transport, route, marker);
  }
  try {
    const result = await transport.replyDocComment({
      docToken: route.documentToken,
      commentId: route.commentId,
      fileType: route.fileType,
      content: fitDocCommentPayload(claim.payload),
      retry: SINGLE_ATTEMPT,
    });
    if (result.replyId) return { status: 'delivered', messageId: result.replyId };
    return await reconcileDocComment(transport, route, marker);
  } catch (error) {
    const kind = classifyDeliveryError(error);
    if (kind === 'pre_send' || kind === 'rejected') {
      return deliveryErrorResult(kind, 'doc_comment');
    }
    return reconcileDocComment(transport, route, marker);
  }
}

async function reconcileDocComment(
  transport: LarkTransport,
  route: Extract<ContinuationDeliveryRoute, { kind: 'comment_thread' }>,
  marker: string,
): Promise<ContinuationDeliveryResult> {
  try {
    const existing = await transport.findDocCommentReplyByMarker({
      docToken: route.documentToken,
      commentId: route.commentId,
      fileType: route.fileType,
      marker,
    });
    if (existing?.replyId) return { status: 'delivered', messageId: existing.replyId };
    return {
      status: 'delivery_unknown',
      errorCode: 'doc_comment_delivery_unconfirmed',
      errorSummary: 'The prior document-comment delivery could not be confirmed and was not resent.',
    };
  } catch {
    return {
      status: 'delivery_unknown',
      errorCode: 'doc_comment_reconciliation_failed',
      errorSummary: 'The prior document-comment delivery could not be reconciled and was not resent.',
    };
  }
}

function terminalMarker(claim: ContinuationDeliveryClaim): string | null {
  const firstLine = claim.payload.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const escapedJobId = claim.jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Task (?:completed|failed|cancelled): ${escapedJobId}$`).test(firstLine)
    ? firstLine
    : null;
}

function fitDocCommentPayload(payload: string): string {
  if (payload.length <= DOC_COMMENT_MAX_CHARS) return payload;
  const suffix = '\n[Result truncated. Use /task status for task state and artifact references.]';
  return `${payload.slice(0, DOC_COMMENT_MAX_CHARS - suffix.length).trimEnd()}${suffix}`;
}

function deliveryErrorResult(
  kind: DeliveryErrorKind,
  route: 'im' | 'doc_comment',
): ContinuationDeliveryResult {
  if (kind === 'pre_send') {
    return {
      status: 'retry',
      errorCode: 'lark_pre_send_unavailable',
      errorSummary: 'Lark was unavailable before the terminal message could be sent.',
    };
  }
  if (kind === 'rejected') {
    return {
      status: 'failed',
      errorCode: 'lark_delivery_rejected',
      errorSummary: 'Lark rejected the terminal message.',
    };
  }
  return route === 'im'
    ? {
        status: 'retry',
        errorCode: 'lark_im_send_ambiguous',
        errorSummary: 'The IM delivery result was ambiguous; the same UUID will be retried within its deduplication window.',
      }
    : {
        status: 'delivery_unknown',
        errorCode: 'doc_comment_delivery_unconfirmed',
        errorSummary: 'The document-comment delivery result was ambiguous and was not resent.',
      };
}

function classifyDeliveryError(error: unknown): DeliveryErrorKind {
  const networkCode = nestedProperty(error, 'code');
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(String(networkCode))) {
    return 'pre_send';
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'FEISHU_TIMEOUT'].includes(String(networkCode))) {
    return 'ambiguous';
  }
  const status = Number(nestedProperty(error, 'status'));
  if (status === 429) return 'pre_send';
  if (status === 408 || status >= 500) return 'ambiguous';
  if ((status >= 400 && status < 500) || getFeishuApiCode(error) !== null) {
    return 'rejected';
  }
  if (/timed?\s*out|timeout|socket hang up|connection reset/i.test(nestedErrorMessage(error))) {
    return 'ambiguous';
  }
  return isRetryableFeishuError(error) ? 'ambiguous' : 'rejected';
}

function nestedProperty(error: unknown, property: 'code' | 'status'): unknown {
  const seen = new Set<unknown>();
  let current = error as any;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const value = property === 'status'
      ? current?.response?.status ?? current?.status
      : current?.code;
    if (value !== undefined) return value;
    current = current?.cause;
  }
  return undefined;
}

function nestedErrorMessage(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error as any;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current?.message === 'string') parts.push(current.message);
    current = current?.cause;
  }
  return parts.join(' ');
}
