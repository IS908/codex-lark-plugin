import { isFeishuOpenMessageId, isSyntheticSystemMessageId } from './codex-exec-error.js';
import type { LatestMessageTracker } from './message-trackers.js';
import { JOB_THREAD_PREFIX } from './job-thread.js';
import type { TurnObligationTracker } from './turn-obligation.js';

export interface ResolveReplyRoutingInput {
  chatId: string;
  threadId?: string;
  replyTo?: string;
  turnObligations?: Pick<TurnObligationTracker, 'resolveFallback'>;
  latestMessageTracker?: Pick<LatestMessageTracker, 'getLatest'>;
}

export type ReplyRoutingResolution =
  | {
      ok: true;
      effectiveReplyTo?: string;
      isSyntheticThread: boolean;
      shouldStayInThread: boolean;
    }
  | {
      ok: false;
      result: {
        sentCount: number;
        statusText: string;
        isError?: boolean;
        errorText?: string;
      };
    };

export function resolveReplyRouting(input: ResolveReplyRoutingInput): ReplyRoutingResolution {
  const {
    chatId,
    threadId,
    turnObligations,
    latestMessageTracker,
  } = input;

  let effectiveReplyTo = input.replyTo;
  if (!effectiveReplyTo && turnObligations) {
    const fallback = turnObligations.resolveFallback(chatId, threadId);
    if (fallback.status === 'ambiguous') {
      throw new Error(
        `reply_to is required: ${fallback.count} pending Lark turns match chat=${chatId} thread=${threadId ?? '(none)'}.`,
      );
    }
    if (fallback.status === 'active' || fallback.status === 'single-pending') {
      effectiveReplyTo = fallback.messageId;
      console.error(
        `[reply-sender] Auto-filled reply_to=${effectiveReplyTo} from ${fallback.status} turn for chat=${chatId} thread=${threadId ?? '(none)'}`,
      );
    }
  }
  if (!effectiveReplyTo && latestMessageTracker) {
    const latest = latestMessageTracker.getLatest(chatId, threadId);
    if (latest) {
      effectiveReplyTo = latest.messageId;
      console.error(
        `[reply-sender] Auto-filled reply_to=${latest.messageId} for chat=${chatId} thread=${threadId ?? '(none)'}`,
      );
    }
  }
  if (effectiveReplyTo && !isFeishuOpenMessageId(effectiveReplyTo)) {
    if (isSyntheticSystemMessageId(effectiveReplyTo)) {
      console.error(`[reply-sender] Skipping visible reply for synthetic system message ${effectiveReplyTo}`);
      return {
        ok: false,
        result: {
          sentCount: 0,
          statusText: `Skipped reply for synthetic system message ${effectiveReplyTo}`,
        },
      };
    }
    return {
      ok: false,
      result: {
        sentCount: 0,
        statusText: `Invalid reply_to: ${effectiveReplyTo}`,
        isError: true,
        errorText: `Invalid reply_to: expected a Feishu open_message_id starting with "om_", got "${effectiveReplyTo}".`,
      },
    };
  }

  const isSyntheticThread = !!threadId && threadId.startsWith(JOB_THREAD_PREFIX);
  return {
    ok: true,
    ...(effectiveReplyTo ? { effectiveReplyTo } : {}),
    isSyntheticThread,
    shouldStayInThread: !!threadId && !isSyntheticThread && !!effectiveReplyTo,
  };
}
