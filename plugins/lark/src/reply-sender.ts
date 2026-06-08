import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appConfig } from './config.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker } from './channel.js';
import { buildCards, shouldUseCard } from './feishu-card.js';
import { JOB_THREAD_PREFIX } from './scheduler.js';
import { feishuApiCall } from './feishu-retry.js';

const ACK_REVOKED_SENTINEL = '__codex_ack_revoked__';

function markAckRevoked(ackReactions: Map<string, string>, messageId: string): void {
  if (!messageId || ackReactions.has(messageId)) return;
  ackReactions.set(messageId, ACK_REVOKED_SENTINEL);
  const timer = setTimeout(() => {
    if (ackReactions.get(messageId) === ACK_REVOKED_SENTINEL) {
      ackReactions.delete(messageId);
    }
  }, Math.max(1_000, appConfig.feishuApiTimeoutMs + 5_000));
  timer.unref?.();
}

function wrapFeishuApiError(err: any): Error | null {
  const apiError = err?.response?.data ?? err?.data;
  if (!apiError?.code || !apiError?.msg) return null;
  console.error(`[reply-sender] Feishu API error [${apiError.code}]: ${apiError.msg}`);
  const wrapped = new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
  (wrapped as Error & { response?: unknown }).response = err?.response;
  (wrapped as Error & { data?: unknown }).data = apiError;
  (wrapped as Error & { cause?: unknown }).cause = err;
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
  files?: Array<{ path: string; type: 'image' | 'file' }>;
}

export interface ReplySenderDeps {
  client: Lark.Client;
  conversationBuffer?: ConversationBuffer;
  ackReactions?: Map<string, string>;
  botMessageTracker?: BotMessageTracker;
  latestMessageTracker?: LatestMessageTracker;
}

export interface ReplySendResult {
  sentCount: number;
  statusText: string;
  isError?: boolean;
  errorText?: string;
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
    files,
  } = request;
  const {
    client,
    conversationBuffer,
    ackReactions,
    botMessageTracker,
    latestMessageTracker,
  } = deps;

  // Auto-correct reply_to from the plugin's per-thread tracker when Codex
  // omits it. Works for both threaded and non-threaded (P2P) messages.
  // Explicit reply_to from Codex always wins.
  let effectiveReplyTo = reply_to;
  if (!effectiveReplyTo && latestMessageTracker) {
    const latest = latestMessageTracker.getLatest(chat_id, thread_id);
    if (latest) {
      effectiveReplyTo = latest.messageId;
      console.error(
        `[reply-sender] Auto-filled reply_to=${latest.messageId} for chat=${chat_id} thread=${thread_id ?? '(none)'}`
      );
    }
  }

  // Thread-aware routing: follow-up messages (text chunks 2..N, card 2..N,
  // attachments) must stay in the same thread as the first reply.
  const isSyntheticThread = !!thread_id && thread_id.startsWith(JOB_THREAD_PREFIX);
  const shouldStayInThread = !!thread_id && !isSyntheticThread && !!effectiveReplyTo;
  async function sendFollowup(data: { content: string; msg_type: string }): Promise<any> {
    const uuid = randomUUID();
    if (shouldStayInThread) {
      return feishuApiCall('reply.followup.message.reply', () =>
        client.im.v1.message.reply({
          path: { message_id: effectiveReplyTo! },
          data: { ...data, reply_in_thread: true, uuid } as any,
        }),
      );
    }
    return feishuApiCall('reply.followup.message.create', () =>
      client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat_id, ...data, uuid },
      }),
    );
  }

  // Helper: record in buffer + revoke ack (shared by card & normal paths).
  function recordAndRevokeAck(replyText: string) {
    conversationBuffer?.record(chat_id, {
      role: 'assistant',
      senderId: 'bot',
      text: replyText.slice(0, 500),
      timestamp: new Date().toISOString(),
    });

    if (ackReactions) {
      const msgId = effectiveReplyTo || '';
      markAckRevoked(ackReactions, msgId);
    }

    if (ackReactions && ackReactions.size > 0) {
      const msgId = effectiveReplyTo || '';
      const reactionId = msgId ? ackReactions.get(msgId) : undefined;
      if (reactionId && reactionId !== ACK_REVOKED_SENTINEL) {
        ackReactions.delete(msgId);
        feishuApiCall('reply.ackReaction.delete', () =>
          client.im.v1.messageReaction.delete({
            path: { message_id: msgId, reaction_id: reactionId },
          }),
        ).catch(() => {});
      } else {
        markAckRevoked(ackReactions, msgId);
        for (const [mid, rid] of ackReactions.entries()) {
          if (rid === ACK_REVOKED_SENTINEL) continue;
          ackReactions.delete(mid);
          feishuApiCall('reply.ackReaction.delete', () =>
            client.im.v1.messageReaction.delete({
              path: { message_id: mid, reaction_id: rid },
            }),
          ).catch(() => {});
        }
      }
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
    try {
      let resp: any;
      const uuid = randomUUID();
      if (effectiveReplyTo) {
        resp = await feishuApiCall('reply.raw_card.message.reply', () =>
          client.im.v1.message.reply({
            path: { message_id: effectiveReplyTo },
            data: { content, msg_type: 'interactive', uuid },
          }),
        );
      } else {
        resp = await feishuApiCall('reply.raw_card.message.create', () =>
          client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chat_id,
              content,
              msg_type: 'interactive',
              uuid,
            },
          }),
        );
      }
      const sentId = resp?.data?.message_id;
      if (sentId && botMessageTracker) botMessageTracker.add(sentId);
    } catch (err: any) {
      const wrapped = wrapFeishuApiError(err);
      if (wrapped) throw wrapped;
      throw err;
    }

    recordAndRevokeAck(text || '[card]');

    return {
      sentCount: 1,
      statusText: 'Sent 1 card message',
    };
  }

  // Dispatch: card path vs plain-text path.
  const useCard =
    format === 'card' || (format !== 'text' && shouldUseCard(text));

  let sentCount = 0;

  if (useCard) {
    const cards = buildCards(text, { footer });
    sentCount = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const content = JSON.stringify(cards[i]);
      try {
        let resp: any;
        const uuid = randomUUID();
        if (i === 0 && effectiveReplyTo) {
          resp = await feishuApiCall('reply.card.message.reply', () =>
            client.im.v1.message.reply({
              path: { message_id: effectiveReplyTo },
              data: { content, msg_type: 'interactive', uuid },
            }),
          );
        } else {
          resp = await sendFollowup({ content, msg_type: 'interactive' });
        }
        const sentId = resp?.data?.message_id;
        if (sentId && botMessageTracker) botMessageTracker.add(sentId);
      } catch (err: any) {
        const wrapped = wrapFeishuApiError(err);
        if (wrapped) throw wrapped;
        console.error(
          `[reply-sender] send card failed:`,
          err?.message ?? String(err)
        );
        throw err;
      }
    }
  } else {
    const chunks = chunkText(text, appConfig.textChunkLimit);
    sentCount = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      try {
        let resp: any;
        const uuid = randomUUID();
        if (effectiveReplyTo && i === 0) {
          resp = await feishuApiCall('reply.text.message.reply', () =>
            client.im.v1.message.reply({
              path: { message_id: effectiveReplyTo },
              data: {
                content: JSON.stringify({ text: chunks[i] }),
                msg_type: 'text',
                uuid,
              },
            }),
          );
        } else {
          resp = await sendFollowup({
            content: JSON.stringify({ text: chunks[i] }),
            msg_type: 'text',
          });
        }
        const sentId = resp?.data?.message_id;
        if (sentId && botMessageTracker) botMessageTracker.add(sentId);
      } catch (err: any) {
        const wrapped = wrapFeishuApiError(err);
        if (wrapped) throw wrapped;
        console.error(
          `[reply-sender] send message failed:`,
          err?.message ?? String(err)
        );
        throw err;
      }
    }
  }

  // Upload and send attachments if any.
  if (files?.length) {
    for (const file of files) {
      try {
        const fileData = await fs.readFile(file.path);
        if (file.type === 'image') {
          const resp = await feishuApiCall('reply.image.create', () =>
            client.im.v1.image.create({
              data: {
                image_type: 'message',
                image: fileData as any,
              },
            }),
            { retryTimeout: false },
          );
          const imageKey = (resp as any)?.data?.image_key ?? (resp as any)?.image_key;
          if (imageKey) {
            const sent = await sendFollowup({
              content: JSON.stringify({ image_key: imageKey }),
              msg_type: 'image',
            });
            const sentId = (sent as any)?.data?.message_id;
            if (sentId && botMessageTracker) botMessageTracker.add(sentId);
          }
        } else {
          const resp = await feishuApiCall('reply.file.create', () =>
            client.im.v1.file.create({
              data: {
                file_type: 'stream',
                file_name: path.basename(file.path),
                file: fileData as any,
              },
            }),
            { retryTimeout: false },
          );
          const fileKey = (resp as any)?.data?.file_key ?? (resp as any)?.file_key;
          if (fileKey) {
            const sent = await sendFollowup({
              content: JSON.stringify({
                file_key: fileKey,
                file_name: path.basename(file.path),
              }),
              msg_type: 'file',
            });
            const sentId = (sent as any)?.data?.message_id;
            if (sentId && botMessageTracker) botMessageTracker.add(sentId);
          }
        }
      } catch (err) {
        console.error(`[reply-sender] Failed to upload file ${file.path}:`, err);
      }
    }
  }

  recordAndRevokeAck(text);

  return {
    sentCount,
    statusText: `Sent ${sentCount} message(s)`,
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
