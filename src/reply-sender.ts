import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker, TrackedBotMessageQuotedContext } from './channel.js';
import { buildCards, shouldUseCard } from './feishu-card.js';
import { mergeCardFooterWithRuntimeMetrics } from './codex-exec-metrics.js';
import { JOB_THREAD_PREFIX } from './scheduler.js';
import {
  revokeAckReactionWithTransport,
  revokeAllAckReactionsWithTransport,
  type AckReactionTracker,
} from './ack-reactions.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { isFeishuOpenMessageId, isSyntheticSystemMessageId } from './codex-exec-error.js';
import { logSafeError } from './safe-log.js';
import {
  createOpenApiLarkTransport,
  type LarkTransport,
  type LarkTransportInput,
} from './lark-transport.js';
import {
  fetchedMessageContentText,
  isPlaceholderCardText,
} from './message-content.js';
import {
  getFeishuApiCode,
  isFeishuWithdrawnMessageError,
} from './feishu-retry.js';

function wrapFeishuApiError(err: any): Error | null {
  const apiError = err?.response?.data ?? err?.data;
  if (!apiError?.code || !apiError?.msg) return null;
  const wrapped = new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
  (wrapped as Error & { response?: unknown }).response = err?.response;
  (wrapped as Error & { data?: unknown }).data = apiError;
  (wrapped as Error & { cause?: unknown }).cause = err;
  if (!isFeishuWithdrawnMessageError(wrapped)) {
    console.error(`[reply-sender] Feishu API error [${apiError.code}]: ${apiError.msg}`);
  }
  return wrapped;
}

export interface ReplyRequest {
  chat_id: string;
  text: string;
  card?: string;
  reply_to?: string;
  thread_id?: string;
  format?: 'text' | 'card';
  footer?: string;
  runtimeFooter?: string;
  files?: Array<{ path: string; type: 'image' | 'file' }>;
  richParts?: ReplyRichPart[];
}

export type ReplyRichPart =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; alt?: string };

export interface ReplySenderDeps {
  client: Lark.Client;
  transport?: LarkTransport;
  conversationBuffer?: ConversationBuffer;
  ackReactions?: AckReactionTracker;
  botMessageTracker?: BotMessageTracker;
  latestMessageTracker?: LatestMessageTracker;
  turnObligations?: TurnObligationTracker;
}

export interface ReplySendResult {
  sentCount: number;
  statusText: string;
  fileSentCount?: number;
  richDeliveryMode?: 'rich_post' | 'split';
  isError?: boolean;
  errorText?: string;
  skippedReason?: 'withdrawn_message';
}

type UploadedRichPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageKey: string; alt?: string };

function summarizeRichParts(parts: ReplyRichPart[]): string {
  const text = parts
    .map((part) => part.type === 'text' ? part.text : part.alt ? `[image: ${part.alt}]` : '[image]')
    .join('')
    .trim();
  return text || '[rich message]';
}

function buildPostContent(parts: UploadedRichPart[]): object {
  const content: Array<Array<Record<string, string>>> = [];
  let line: Array<Record<string, string>> = [];

  function flushLine() {
    if (line.length > 0) {
      content.push(line);
      line = [];
    }
  }

  for (const part of parts) {
    if (part.type === 'image') {
      flushLine();
      content.push([{ tag: 'img', image_key: part.imageKey }]);
      continue;
    }

    const lines = part.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) flushLine();
      if (lines[i]) {
        line.push({ tag: 'text', text: lines[i] });
      }
    }
  }
  flushLine();

  return {
    zh_cn: {
      title: '',
      content: content.length > 0 ? content : [[{ tag: 'text', text: '' }]],
    },
  };
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function sendFeishuReply(
  deps: ReplySenderDeps,
  request: ReplyRequest,
): Promise<ReplySendResult> {
  const {
    chat_id,
    text,
    card,
    reply_to,
    thread_id,
    format,
    footer,
    runtimeFooter,
    files,
    richParts,
  } = request;
  const {
    client,
    conversationBuffer,
    ackReactions,
    botMessageTracker,
    latestMessageTracker,
    turnObligations,
  } = deps;
  const transport = deps.transport ?? createOpenApiLarkTransport(client, {
    outboundMessageContextCache: botMessageTracker,
  });

  // Auto-correct reply_to from the plugin's per-thread tracker when Codex
  // omits it. Works for both threaded and non-threaded (P2P) messages.
  // Explicit reply_to from Codex always wins.
  let effectiveReplyTo = reply_to;
  if (!effectiveReplyTo && turnObligations) {
    const fallback = turnObligations.resolveFallback(chat_id, thread_id);
    if (fallback.status === 'ambiguous') {
      throw new Error(
        `reply_to is required: ${fallback.count} pending Lark turns match chat=${chat_id} thread=${thread_id ?? '(none)'}.`,
      );
    }
    if (fallback.status === 'active' || fallback.status === 'single-pending') {
      effectiveReplyTo = fallback.messageId;
      console.error(
        `[reply-sender] Auto-filled reply_to=${effectiveReplyTo} from ${fallback.status} turn for chat=${chat_id} thread=${thread_id ?? '(none)'}`
      );
    }
  }
  if (!effectiveReplyTo && latestMessageTracker) {
    const latest = latestMessageTracker.getLatest(chat_id, thread_id);
    if (latest) {
      effectiveReplyTo = latest.messageId;
      console.error(
        `[reply-sender] Auto-filled reply_to=${latest.messageId} for chat=${chat_id} thread=${thread_id ?? '(none)'}`
      );
    }
  }
  if (effectiveReplyTo && !isFeishuOpenMessageId(effectiveReplyTo)) {
    if (isSyntheticSystemMessageId(effectiveReplyTo)) {
      console.error(`[reply-sender] Skipping visible reply for synthetic system message ${effectiveReplyTo}`);
      return {
        sentCount: 0,
        statusText: `Skipped reply for synthetic system message ${effectiveReplyTo}`,
      };
    }
    return {
      sentCount: 0,
      statusText: `Invalid reply_to: ${effectiveReplyTo}`,
      isError: true,
      errorText: `Invalid reply_to: expected a Feishu open_message_id starting with "om_", got "${effectiveReplyTo}".`,
    };
  }

  // Thread-aware routing: follow-up messages (text chunks 2..N, card 2..N,
  // attachments) must stay in the same thread as the first reply.
  const isSyntheticThread = !!thread_id && thread_id.startsWith(JOB_THREAD_PREFIX);
  const shouldStayInThread = !!thread_id && !isSyntheticThread && !!effectiveReplyTo;
  async function sendTransportMessage(args: {
    input: LarkTransportInput;
    replyTo?: string;
    replyInThread?: boolean;
  }) {
    return await transport.sendMessage({
      chatId: chat_id,
      input: args.input,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      ...(args.replyInThread ? { replyInThread: true } : {}),
    });
  }

  async function sendFollowup(input: LarkTransportInput): Promise<any> {
    return sendTransportMessage({
      input,
      ...(shouldStayInThread ? { replyTo: effectiveReplyTo!, replyInThread: true } : {}),
    });
  }

  function trackBotMessage(
    messageId: string | undefined,
    quotedContext?: TrackedBotMessageQuotedContext,
  ): void {
    if (messageId && botMessageTracker) {
      botMessageTracker.add(messageId, { chatId: chat_id, threadId: thread_id, quotedContext });
    }
  }

  // Helper: record in buffer + revoke ack (shared by card & normal paths).
  let satisfactionRecorded = false;
  function recordAndRevokeAck(replyText: string, messageId?: string) {
    if (satisfactionRecorded) return;
    satisfactionRecorded = true;

    conversationBuffer?.record(chat_id, {
      role: 'assistant',
      senderId: 'bot',
      text: replyText.slice(0, 500),
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      ...(messageId ? { messageId } : {}),
      ...(thread_id ? { threadId: thread_id } : {}),
      messageType: 'text',
    });

    if (effectiveReplyTo) {
      turnObligations?.markSatisfied(effectiveReplyTo, 'reply');
      revokeAckReactionWithTransport(transport, ackReactions, effectiveReplyTo, 'reply');
    } else {
      revokeAllAckReactionsWithTransport(transport, ackReactions, 'reply.bulk');
    }
  }

  let deliveredCount = 0;
  function skipWithdrawnReply(err: unknown): ReplySendResult {
    const code = getFeishuApiCode(err);
    const target = effectiveReplyTo ?? '(none)';
    const reason = 'Target Feishu message was withdrawn before reply delivery.';
    console.error(
      `[reply-sender] Skipping reply because target message ${target} was withdrawn; code=${code ?? 'unknown'}`,
    );
    if (effectiveReplyTo) {
      turnObligations?.markDeferred(effectiveReplyTo, 'delivery_skip', 'LARK_NO_REPLY', reason);
      revokeAckReactionWithTransport(transport, ackReactions, effectiveReplyTo, 'reply.withdrawn');
    } else {
      revokeAllAckReactionsWithTransport(transport, ackReactions, 'reply.withdrawn.bulk');
    }
    return {
      sentCount: deliveredCount,
      statusText: `Skipped reply because target message ${target} was withdrawn.`,
      skippedReason: 'withdrawn_message',
    };
  }

  function handleSendFailure(err: any): ReplySendResult | null {
    const wrapped = wrapFeishuApiError(err);
    const candidate = wrapped ?? err;
    if (isFeishuWithdrawnMessageError(candidate)) {
      return skipWithdrawnReply(candidate);
    }
    if (wrapped) throw wrapped;
    return null;
  }

  function normalizeSendFailure(err: any): { skipped?: ReplySendResult; error: any } {
    const wrapped = wrapFeishuApiError(err);
    const candidate = wrapped ?? err;
    if (isFeishuWithdrawnMessageError(candidate)) {
      return { skipped: skipWithdrawnReply(candidate), error: candidate };
    }
    return { error: candidate };
  }

  let sentCount = 0;
  let fileSentCount = 0;

  async function sendRichPartsAsSplit(parts: ReplyRichPart[], replyText: string): Promise<ReplySendResult> {
    let deliveredAny = false;
    try {
      for (const part of parts) {
        if (part.type === 'text') {
          if (!part.text) continue;
          const chunks = chunkText(part.text, appConfig.textChunkLimit);
          for (const chunk of chunks) {
            const replyTo = effectiveReplyTo && (!deliveredAny || shouldStayInThread) ? effectiveReplyTo : undefined;
            const resp = await sendTransportMessage({
              input: { text: chunk },
              ...(replyTo ? { replyTo } : {}),
              ...(shouldStayInThread && deliveredAny ? { replyInThread: true } : {}),
            });
            trackBotMessage(resp?.messageId);
            sentCount++;
            deliveredCount++;
            deliveredAny = true;
            recordAndRevokeAck(replyText, resp?.messageId);
          }
          continue;
        }

        const fileData = await fs.readFile(part.path);
        const imageKey = await transport.uploadImage(fileData);
        if (!imageKey) throw new Error(`Image upload returned no image_key for ${part.path}`);
        const resp = await sendTransportMessage({
          input: { imageKey },
          ...(shouldStayInThread ? { replyTo: effectiveReplyTo!, replyInThread: true } : {}),
        });
        trackBotMessage(resp?.messageId);
        sentCount++;
        deliveredCount++;
        fileSentCount++;
        deliveredAny = true;
        recordAndRevokeAck(replyText, resp?.messageId);
      }
    } catch (err) {
      const failure = normalizeSendFailure(err);
      if (failure.skipped) return failure.skipped;
      logSafeError('[reply-sender] rich split delivery failed:', failure.error);
      return {
        sentCount,
        statusText: `Failed during rich split delivery after ${sentCount} message(s)`,
        fileSentCount,
        richDeliveryMode: 'split',
        isError: true,
        errorText: messageFromError(failure.error),
      };
    }

    if (sentCount > 0) recordAndRevokeAck(replyText);
    return {
      sentCount,
      statusText: `Sent ${sentCount} split message(s)`,
      fileSentCount,
      richDeliveryMode: 'split',
    };
  }

  if (richParts?.length) {
    const replyText = summarizeRichParts(richParts);
    const imageCount = richParts.filter((part) => part.type === 'image').length;
    const hasText = richParts.some((part) => part.type === 'text' && part.text.trim());
    const hasImage = imageCount > 0;
    if (!hasText || !hasImage) {
      return sendRichPartsAsSplit(richParts, replyText);
    }

    try {
      const uploadedParts: UploadedRichPart[] = [];
      for (const part of richParts) {
        if (part.type === 'text') {
          uploadedParts.push(part);
          continue;
        }
        const fileData = await fs.readFile(part.path);
        const imageKey = await transport.uploadImage(fileData);
        if (!imageKey) throw new Error(`Image upload returned no image_key for ${part.path}`);
        uploadedParts.push({ type: 'image', imageKey, alt: part.alt });
      }
      const postContent = buildPostContent(uploadedParts);
      const resp = await sendTransportMessage({
        input: { raw: { msgType: 'post', content: JSON.stringify(postContent) } },
        ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
      });
      trackBotMessage(resp?.messageId);
      sentCount = 1;
      deliveredCount++;
      fileSentCount = imageCount;
      recordAndRevokeAck(replyText, resp?.messageId);
      recordAndRevokeAck(replyText);
      return {
        sentCount,
        statusText: 'Sent 1 rich post message',
        fileSentCount,
        richDeliveryMode: 'rich_post',
      };
    } catch (err) {
      const failure = normalizeSendFailure(err);
      if (failure.skipped) return failure.skipped;
      console.error(
        '[reply-sender] rich post delivery failed; falling back to ordered split:',
        messageFromError(failure.error),
      );
      sentCount = 0;
      fileSentCount = 0;
      return sendRichPartsAsSplit(richParts, replyText);
    }
  }

  // Raw card JSON path — bypass buildCards entirely.
  if (card) {
    let cardObj: object;
    try {
      cardObj = JSON.parse(card);
    } catch {
      return {
        sentCount: 0,
        statusText: 'Invalid card JSON',
        isError: true,
        errorText: 'Invalid card JSON',
      };
    }
    const content = JSON.stringify(cardObj);
    const quotedContext = createQuotedContextFromCardContent(content, text);
    try {
      const resp = await sendTransportMessage({
        input: { card: cardObj },
        ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
      });
      trackBotMessage(resp?.messageId, quotedContext);
      deliveredCount++;
      recordAndRevokeAck(text || '[card]', resp?.messageId);
    } catch (err: any) {
      const skipped = handleSendFailure(err);
      if (skipped) return skipped;
      throw err;
    }

    recordAndRevokeAck(text || '[card]');

    return {
      sentCount: 1,
      statusText: 'Sent 1 card message',
    };
  }

  // Short/simple replies stay as copyable text. Rich Markdown that Feishu text
  // messages cannot render well is upgraded to Schema 2.0 cards unless the
  // caller explicitly forces format="text".
  const useCard = format === 'card' || (format !== 'text' && shouldUseCard(text));

  async function sendTextChunks(): Promise<number | ReplySendResult> {
    if (!text) return 0;
    const chunks = chunkText(text, appConfig.textChunkLimit);
    for (let i = 0; i < chunks.length; i++) {
      try {
        const replyTo = effectiveReplyTo && (i === 0 || shouldStayInThread) ? effectiveReplyTo : undefined;
        const resp = await sendTransportMessage({
          input: { text: chunks[i] },
          ...(replyTo ? { replyTo } : {}),
          ...(shouldStayInThread && i > 0 ? { replyInThread: true } : {}),
        });
        trackBotMessage(resp?.messageId);
        deliveredCount++;
        recordAndRevokeAck(text, resp?.messageId);
      } catch (err: any) {
        const skipped = handleSendFailure(err);
        if (skipped) return skipped;
        console.error(
          `[reply-sender] send message failed:`,
          err?.message ?? String(err)
        );
        throw err;
      }
    }
    return chunks.length;
  }

  if (useCard) {
    const deliveredBeforeCard = deliveredCount;
    try {
      const mergedFooter = mergeCardFooterWithRuntimeMetrics(footer, runtimeFooter);
      const cards = buildCards(text, { footer: mergedFooter });
      sentCount = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const replyTo = effectiveReplyTo && (i === 0 || shouldStayInThread) ? effectiveReplyTo : undefined;
        const resp = await sendTransportMessage({
          input: { card: cards[i] },
          ...(replyTo ? { replyTo } : {}),
          ...(shouldStayInThread && i > 0 ? { replyInThread: true } : {}),
        });
        trackBotMessage(
          resp?.messageId,
          createQuotedContextFromCardContent(JSON.stringify(cards[i]), text),
        );
        deliveredCount++;
        recordAndRevokeAck(text, resp?.messageId);
      }
    } catch (err: any) {
      const failure = normalizeSendFailure(err);
      if (failure.skipped) return failure.skipped;
      if (deliveredCount === deliveredBeforeCard) {
        console.error(
          `[reply-sender] generated card build/delivery failed; falling back to text:`,
          failure.error?.message ?? String(failure.error),
        );
        const textResult = await sendTextChunks();
        if (typeof textResult !== 'number') return textResult;
        sentCount = textResult;
      } else {
        console.error(
          `[reply-sender] send card failed after partial delivery:`,
          failure.error?.message ?? String(failure.error),
        );
        throw failure.error;
      }
    }
  } else {
    const textResult = await sendTextChunks();
    if (typeof textResult !== 'number') return textResult;
    sentCount = textResult;
  }

  // Upload and send attachments if any.
  if (files?.length) {
    for (const file of files) {
      try {
        const fileData = await fs.readFile(file.path);
        if (file.type === 'image') {
          const imageKey = await transport.uploadImage(fileData);
          if (imageKey) {
            const sent = await sendFollowup({ imageKey });
            trackBotMessage((sent as any)?.messageId);
            sentCount++;
            deliveredCount++;
            fileSentCount++;
            recordAndRevokeAck(text || '[image]', (sent as any)?.messageId);
          }
        } else {
          const fileName = path.basename(file.path);
          const fileKey = await transport.uploadFile(fileData, fileName);
          if (fileKey) {
            const sent = await sendFollowup({ fileKey, fileName });
            trackBotMessage((sent as any)?.messageId);
            sentCount++;
            deliveredCount++;
            fileSentCount++;
            recordAndRevokeAck(text || '[file]', (sent as any)?.messageId);
          }
        }
      } catch (err) {
        logSafeError(`[reply-sender] Failed to upload file ${file.path}:`, err);
      }
    }
  }

  recordAndRevokeAck(text);

  return {
    sentCount,
    statusText: `Sent ${sentCount} message(s)`,
    fileSentCount,
  };
}

/**
 * Split long text into chunks, respecting paragraph/line/word boundaries.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try to split at paragraph boundary.
    const paraIdx = remaining.lastIndexOf('\n\n', limit);
    if (paraIdx > limit * 0.3) {
      splitAt = paraIdx + 2;
    }

    // Try newline.
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', limit);
      if (nlIdx > limit * 0.3) {
        splitAt = nlIdx + 1;
      }
    }

    // Try space.
    if (splitAt === -1) {
      const spIdx = remaining.lastIndexOf(' ', limit);
      if (spIdx > limit * 0.3) {
        splitAt = spIdx + 1;
      }
    }

    // Hard split.
    if (splitAt === -1) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

function createQuotedContextFromCardContent(
  content: string,
  fallbackText: string | undefined,
): TrackedBotMessageQuotedContext {
  const extracted = fetchedMessageContentText(content, 'interactive');
  const fallback = fallbackText?.trim();
  const text = isPlaceholderCardText(extracted, 'interactive')
    ? (fallback || content)
    : extracted;
  return {
    text: capUtf8Text(text, 12_000),
    msgType: 'interactive',
  };
}

function capUtf8Text(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}
