import { appConfig } from './config.js';
import { debugLog } from './debug-log.js';
import { feishuApiCall } from './feishu-retry.js';
import { DOC_CHAT_ID_PREFIX, type IdentitySession } from './identity-session.js';
import { accessControlStore } from './runtime-access-control.js';
import type { MessageQueue } from './queue.js';
import type { BoundedCache } from './resource-governance.js';
import type { LarkMessage, MessageHandler } from './lark-message.js';

const DOC_COMMENT_BODY_CAP_BYTES = 8 * 1024;

export interface CommentEventDeps {
  botOpenId: string;
  seenEventIds: BoundedCache<string, true>;
  identitySession: IdentitySession;
  queue: MessageQueue;
  messageHandler: MessageHandler | null;
  processMessage?: (message: LarkMessage) => Promise<void>;
  resolveUserName: (openId: string) => Promise<string>;
  client: {
    request?: (req: {
      method: 'POST';
      url: string;
      params: { file_type: string };
      data: { action: 'add'; reply_id: string; reaction_type: string };
    }) => Promise<any>;
    drive: {
      fileComment: { list: (req: any) => Promise<any> };
      fileCommentReply: { list: (req: any) => Promise<any> };
      meta: { batchQuery: (req: any) => Promise<any> };
    };
  };
}

export function passesDocCommentWhitelist(senderId: string): boolean {
  return accessControlStore.allowsDocComment(senderId);
}

function capUtf8(s: string | undefined, maxBytes: number): string | undefined {
  if (s === undefined) return undefined;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}

function extractCommentText(content: any): string | undefined {
  if (!content) return undefined;
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content.elements)) {
    const text = content.elements
      .map((el: any) => el?.text_run?.text ?? el?.docs_link?.url ?? '')
      .join('');
    return text || undefined;
  }
  return undefined;
}

function escapeAttr(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeBody(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface DocCommentEnvelopeArgs {
  fileToken: string;
  commentId: string;
  replyId?: string;
  fileType: string;
  operator: string;
  isMentioned: boolean;
  docTitle?: string;
  quote?: string;
  parentBody?: string;
  body?: string;
  fetchError?: string;
}

function buildDocCommentEnvelope(args: DocCommentEnvelopeArgs): string {
  const kind = args.replyId ? 'reply' : 'comment';
  const attrs = [
    `doc_token="${escapeAttr(args.fileToken)}"`,
    `comment_id="${escapeAttr(args.commentId)}"`,
    args.replyId ? `reply_id="${escapeAttr(args.replyId)}"` : '',
    `kind="${kind}"`,
    `operator="${escapeAttr(args.operator)}"`,
    args.docTitle ? `doc_title="${escapeAttr(args.docTitle)}"` : '',
    `file_type="${escapeAttr(args.fileType)}"`,
    `is_mentioned="${args.isMentioned}"`,
  ].filter(Boolean).join(' ');

  const inner: string[] = [];
  if (args.fetchError) inner.push(`  <fetch_error>${escapeBody(args.fetchError)}</fetch_error>`);
  if (args.quote) inner.push(`  <selected_text>${escapeBody(args.quote)}</selected_text>`);
  if (args.parentBody) inner.push(`  <parent>${escapeBody(args.parentBody)}</parent>`);
  if (args.body !== undefined) {
    inner.push(`  <body>${escapeBody(args.body)}</body>`);
  } else {
    inner.push(`  <body unknown="true"></body>`);
  }
  return `<doc_comment ${attrs}>\n${inner.join('\n')}\n</doc_comment>`;
}

function addDocCommentAckReaction(
  deps: CommentEventDeps,
  args: { fileToken: string; fileType: string; replyId: string; eventId?: string },
): void {
  const reactionType = appConfig.docCommentAckEmoji;
  if (!reactionType) return;

  if (!deps.client.request) {
    debugLog(`[channel] Doc comment ack skipped: client.request unavailable (event_id=${args.eventId ?? '<none>'})`);
    return;
  }

  void feishuApiCall(
    'doc_comment_ack_reaction.update',
    () => deps.client.request!({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v2/files/${encodeURIComponent(args.fileToken)}/comments/reaction`,
      params: { file_type: args.fileType },
      data: {
        action: 'add',
        reply_id: args.replyId,
        reaction_type: reactionType,
      },
    }),
    { retryTimeout: false },
  ).catch((err) => {
    debugLog(
      `[channel] Failed to add doc-comment ack ${reactionType} on reply ${args.replyId} (event_id=${args.eventId ?? '<none>'}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

export async function handleCommentEvent(data: any, deps: CommentEventDeps): Promise<void> {
  const eventId = data?.event_id;
  if (eventId && deps.seenEventIds.has(eventId)) return;
  if (eventId) deps.seenEventIds.set(eventId, true);

  const meta = data?.notice_meta;
  if (!meta) {
    debugLog(`[channel] Doc comment event missing notice_meta — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (data?.is_mentioned !== true) {
    debugLog(`[channel] Doc comment event is_mentioned=false — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (meta.to_user_id?.open_id !== deps.botOpenId) {
    debugLog(
      `[channel] Doc comment to_user_id=${meta.to_user_id?.open_id ?? '<none>'} != bot=${deps.botOpenId} — dropped (event_id=${eventId ?? '<none>'})`,
    );
    return;
  }
  if (meta.from_user_id?.open_id === deps.botOpenId) {
    debugLog(`[channel] Doc comment from bot itself — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }

  const fileToken = String(meta.file_token ?? '');
  const commentId = String(data?.comment_id ?? '');
  const replyId = typeof data?.reply_id === 'string' && data.reply_id ? data.reply_id : undefined;
  const fileType = String(meta.file_type ?? '');
  const fromOpenId = String(meta.from_user_id?.open_id ?? '');
  if (!fileToken || !commentId || !fileType || !fromOpenId) {
    debugLog(`[channel] Doc comment event missing required fields — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (!passesDocCommentWhitelist(fromOpenId)) {
    debugLog(`[channel] Doc comment from ${fromOpenId} on doc ${fileToken} rejected by whitelist`);
    return;
  }

  let parentBody: string | undefined;
  let body: string | undefined;
  let quote: string | undefined;
  let fetchError: string | undefined;

  if (replyId) {
    addDocCommentAckReaction(deps, { fileToken, fileType, replyId, eventId });
  }

  const [repliesResult, commentsResult] = await Promise.allSettled([
    deps.client.drive.fileCommentReply.list({
      path: { file_token: fileToken, comment_id: commentId },
      params: { file_type: fileType, page_size: 100 },
    }),
    deps.client.drive.fileComment.list({
      path: { file_token: fileToken },
      params: { file_type: fileType, page_size: 100 },
    }),
  ]);

  const replies: any[] =
    repliesResult.status === 'fulfilled' ? (repliesResult.value?.data?.items ?? []) : [];
  const comments: any[] =
    commentsResult.status === 'fulfilled' ? (commentsResult.value?.data?.items ?? []) : [];

  if (!replyId) {
    const originalReplyId = replies.find((reply: any) => typeof reply?.reply_id === 'string' && reply.reply_id)?.reply_id;
    if (originalReplyId) {
      addDocCommentAckReaction(deps, { fileToken, fileType, replyId: originalReplyId, eventId });
    } else {
      debugLog(`[channel] Doc comment ack skipped: original reply_id unavailable (event_id=${eventId ?? '<none>'})`);
    }
  }

  if (repliesResult.status === 'rejected' && commentsResult.status === 'rejected') {
    const err: any = repliesResult.reason;
    fetchError = err?.message ?? String(err);
    debugLog(`[channel] Doc comment pre-fetch failed (event_id=${eventId ?? '<none>'}): ${fetchError}`);
  } else if (repliesResult.status === 'rejected') {
    const err: any = repliesResult.reason;
    fetchError = err?.message ?? String(err);
    debugLog(`[channel] Doc comment replies list failed (event_id=${eventId ?? '<none>'}): ${fetchError}`);
  } else if (commentsResult.status === 'rejected') {
    const err: any = commentsResult.reason;
    debugLog(
      `[channel] Doc comment list failed; selected text omitted (event_id=${eventId ?? '<none>'}): ${err?.message ?? String(err)}`,
    );
  }

  const targetComment = comments.find((comment: any) => comment?.comment_id === commentId);
  quote = typeof targetComment?.quote === 'string' && targetComment.quote ? targetComment.quote : undefined;

  if (replyId) {
    parentBody = extractCommentText(replies[0]?.content);
    const targetReply = replies.find((reply: any) => reply?.reply_id === replyId);
    body = targetReply ? extractCommentText(targetReply.content) : undefined;
  } else {
    body = extractCommentText(replies[0]?.content);
  }

  body = capUtf8(body, DOC_COMMENT_BODY_CAP_BYTES);
  parentBody = capUtf8(parentBody, DOC_COMMENT_BODY_CAP_BYTES);

  let docTitle: string | undefined;
  try {
    const metaResp = await deps.client.drive.meta.batchQuery({
      data: { request_docs: [{ doc_token: fileToken, doc_type: fileType }] },
    });
    docTitle = metaResp?.data?.metas?.[0]?.title;
  } catch {
    docTitle = undefined;
  }

  const senderName = await deps.resolveUserName(fromOpenId);
  const envelope = buildDocCommentEnvelope({
    fileToken,
    commentId,
    replyId,
    fileType,
    operator: senderName,
    isMentioned: true,
    docTitle,
    quote,
    parentBody,
    body,
    fetchError,
  });

  const chatId = `${DOC_CHAT_ID_PREFIX}${fileToken}`;
  const syntheticMessage: LarkMessage = {
    messageId: replyId ?? commentId,
    chatId,
    chatType: 'doc_comment',
    senderId: fromOpenId,
    senderName,
    text: envelope,
    messageType: 'doc_comment',
    threadId: commentId,
    rawContent: JSON.stringify(data),
    docComment: {
      fileToken,
      commentId,
      fileType,
      ...(replyId ? { replyId } : {}),
    },
  };

  deps.queue.enqueue(chatId, commentId, async () => {
    if (deps.processMessage) {
      await deps.processMessage(syntheticMessage);
      return;
    }
    deps.identitySession.setCaller(chatId, commentId, fromOpenId);
    if (deps.messageHandler) await deps.messageHandler(syntheticMessage);
  });
}
