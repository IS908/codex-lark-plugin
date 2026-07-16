import assert from 'node:assert/strict';
import type { ContinuationDeliveryClaim } from '../src/domain/continuation.js';
import type { LarkTransport, LarkTransportSendRequest } from '../src/lark-transport-contracts.js';
import { createLarkContinuationDelivery } from '../src/continuation/lark-delivery.js';

const now = new Date('2026-07-17T10:00:00.000Z');
const sendCalls: LarkTransportSendRequest[] = [];
const commentCalls: Array<{
  docToken: string;
  commentId: string;
  content: string;
  fileType: string;
  retry?: { attempts?: number; retryTimeout?: boolean };
}> = [];
const markerCalls: Array<{
  docToken: string;
  commentId: string;
  fileType: string;
  marker: string;
}> = [];

let sendResult: { messageId?: string } = { messageId: 'om_terminal' };
let sendError: unknown;
let commentResult: { replyId?: string } = { replyId: 'reply_terminal' };
let commentError: unknown;
let markerResult: { replyId?: string } | null = null;
let markerError: unknown;

const transport = {
  sendMessage: async (request: LarkTransportSendRequest) => {
    sendCalls.push(request);
    if (sendError) throw sendError;
    return sendResult;
  },
  replyDocComment: async (request: {
    docToken: string;
    commentId: string;
    content: string;
    fileType: string;
  }) => {
    commentCalls.push(request);
    if (commentError) throw commentError;
    return commentResult;
  },
  findDocCommentReplyByMarker: async (request: {
    docToken: string;
    commentId: string;
    fileType: string;
    marker: string;
  }) => {
    markerCalls.push(request);
    if (markerError) throw markerError;
    return markerResult;
  },
} as unknown as LarkTransport;

const delivery = createLarkContinuationDelivery(
  () => transport,
  { now: () => new Date(now) },
);
const unavailableDelivery = createLarkContinuationDelivery(
  () => {
    throw new Error('provider secret must not escape');
  },
  { now: () => new Date(now) },
);

function imClaim(overrides: Partial<ContinuationDeliveryClaim> = {}): ContinuationDeliveryClaim {
  return {
    outboxId: 'out_0123456789abcdef01234567',
    jobId: 'job_0123456789abcdef01234567',
    workerId: 'delivery-worker',
    route: {
      kind: 'message_thread',
      conversationId: 'oc_delivery',
      sourceMessageId: 'om_source',
      threadId: 'omt_source',
    },
    idempotencyKey: 'ct_0123456789abcdef0123456789abcdef',
    payload: 'Task completed: job_0123456789abcdef01234567\nThe task completed.',
    status: 'sending',
    attemptCount: 1,
    firstAttemptAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    ...overrides,
  };
}

function commentClaim(overrides: Partial<ContinuationDeliveryClaim> = {}): ContinuationDeliveryClaim {
  return {
    ...imClaim(),
    route: {
      kind: 'comment_thread',
      documentToken: 'doc_delivery',
      commentId: 'comment_delivery',
      fileType: 'docx',
    },
    ...overrides,
  };
}

assert.deepEqual(await unavailableDelivery.deliver(imClaim()), {
  status: 'retry',
  errorCode: 'lark_pre_send_unavailable',
  errorSummary: 'Lark was unavailable before the terminal message could be sent.',
});

assert.deepEqual(await delivery.deliver(imClaim()), {
  status: 'delivered',
  messageId: 'om_terminal',
});
assert.deepEqual(sendCalls.at(-1), {
  chatId: 'oc_delivery',
  input: { text: 'Task completed: job_0123456789abcdef01234567\nThe task completed.' },
  replyTo: 'om_source',
  replyInThread: true,
  uuid: 'ct_0123456789abcdef0123456789abcdef',
  forceRaw: true,
  retry: { attempts: 1, retryTimeout: false },
});

sendResult = { messageId: 'om_terminal_retry' };
assert.deepEqual(await delivery.deliver(imClaim({
  attemptCount: 2,
  firstAttemptAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
})), {
  status: 'delivered',
  messageId: 'om_terminal_retry',
});
assert.equal(sendCalls.at(-1)?.uuid, 'ct_0123456789abcdef0123456789abcdef');

const beforeExpiredWindow = sendCalls.length;
assert.deepEqual(await delivery.deliver(imClaim({
  attemptCount: 2,
  firstAttemptAt: new Date(now.getTime() - 61 * 60_000).toISOString(),
})), {
  status: 'delivery_unknown',
  errorCode: 'im_uuid_window_expired',
  errorSummary: 'The prior IM delivery could not be confirmed before the UUID deduplication window expired.',
});
assert.equal(sendCalls.length, beforeExpiredWindow);

const beforeExpiredWindowAfterPreSend = sendCalls.length;
assert.deepEqual(await delivery.deliver(imClaim({
  attemptCount: 5,
  firstAttemptAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
  lastErrorCode: 'lark_pre_send_unavailable',
})), {
  status: 'delivery_unknown',
  errorCode: 'im_uuid_window_expired',
  errorSummary: 'The prior IM delivery could not be confirmed before the UUID deduplication window expired.',
});
assert.equal(sendCalls.length, beforeExpiredWindowAfterPreSend);

sendError = Object.assign(new Error('dns details should not escape'), { code: 'ENOTFOUND' });
assert.deepEqual(await delivery.deliver(imClaim()), {
  status: 'retry',
  errorCode: 'lark_pre_send_unavailable',
  errorSummary: 'Lark was unavailable before the terminal message could be sent.',
});
sendError = undefined;

assert.deepEqual(await delivery.deliver(commentClaim()), {
  status: 'delivered',
  messageId: 'reply_terminal',
});
assert.deepEqual(commentCalls.at(-1), {
  docToken: 'doc_delivery',
  commentId: 'comment_delivery',
  fileType: 'docx',
  content: 'Task completed: job_0123456789abcdef01234567\nThe task completed.',
  retry: { attempts: 1, retryTimeout: false },
});

markerResult = { replyId: 'reply_reconciled' };
const beforeReconcileReply = commentCalls.length;
assert.deepEqual(await delivery.deliver(commentClaim({
  attemptCount: 2,
  firstAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
})), {
  status: 'delivered',
  messageId: 'reply_reconciled',
});
assert.equal(commentCalls.length, beforeReconcileReply);
assert.deepEqual(markerCalls.at(-1), {
  docToken: 'doc_delivery',
  commentId: 'comment_delivery',
  fileType: 'docx',
  marker: 'Task completed: job_0123456789abcdef01234567',
});

markerResult = null;
const beforeUnknownReply = commentCalls.length;
assert.deepEqual(await delivery.deliver(commentClaim({
  attemptCount: 2,
  firstAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
})), {
  status: 'delivery_unknown',
  errorCode: 'doc_comment_delivery_unconfirmed',
  errorSummary: 'The prior document-comment delivery could not be confirmed and was not resent.',
});
assert.equal(commentCalls.length, beforeUnknownReply);

markerError = new Error('read-back provider body should not escape');
assert.deepEqual(await delivery.deliver(commentClaim({
  attemptCount: 2,
  firstAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
})), {
  status: 'delivery_unknown',
  errorCode: 'doc_comment_reconciliation_failed',
  errorSummary: 'The prior document-comment delivery could not be reconciled and was not resent.',
});
markerError = undefined;

commentError = Object.assign(new Error('socket reset after send'), { code: 'ECONNRESET' });
markerResult = { replyId: 'reply_after_timeout' };
assert.deepEqual(await delivery.deliver(commentClaim()), {
  status: 'delivered',
  messageId: 'reply_after_timeout',
});
commentError = undefined;

const longPayload = `Task completed: job_0123456789abcdef01234567\n${'x'.repeat(2_000)}`;
await delivery.deliver(commentClaim({ payload: longPayload }));
assert.ok((commentCalls.at(-1)?.content.length ?? 0) <= 1_000);
assert.match(commentCalls.at(-1)?.content ?? '', /^Task completed:/);
assert.match(commentCalls.at(-1)?.content ?? '', /Result truncated/);

commentError = Object.assign(new Error('permission denied'), {
  response: { status: 403, data: { token: 'must-not-escape' } },
});
assert.deepEqual(await delivery.deliver(commentClaim()), {
  status: 'failed',
  errorCode: 'lark_delivery_rejected',
  errorSummary: 'Lark rejected the terminal message.',
});

console.log('continuation delivery smoke: PASS');
