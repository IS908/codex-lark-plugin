import * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { feishuApiCall, type FeishuRetryOptions } from './feishu-retry.js';
import { extractInteractiveCardText } from './interactive-card-text.js';
import { buildCommentElements } from './doc-comment-api.js';
import { appConfig } from './config.js';
import { redactErrorForLog } from './safe-log.js';

const CARD_CLIENT_PLACEHOLDER = '请升级至最新版本客户端，以查看内容';

export type LarkTransportInput =
  | { text: string }
  | { card: object }
  | { imageKey: string }
  | { fileKey: string; fileName: string }
  | { raw: { msgType: string; content: string } };

export interface LarkTransportSendRequest {
  chatId: string;
  input: LarkTransportInput;
  replyTo?: string;
  replyInThread?: boolean;
  uuid?: string;
  receiveIdType?: 'chat_id' | 'open_id' | 'user_id';
  forceRaw?: boolean;
  retry?: FeishuRetryOptions;
}

export interface LarkTransportSendResult {
  messageId?: string;
  chunkIds?: string[];
}

export interface LarkDocCommentRequest {
  docToken: string;
  commentId?: string;
  content: string;
  fileType: string;
}

export interface LarkTransport {
  sendMessage(request: LarkTransportSendRequest): Promise<LarkTransportSendResult>;
  editMessage(request: { messageId: string; text: string }): Promise<void>;
  updateCard(request: { messageId: string; card: object | string }): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string | undefined>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>;
  downloadResource(messageId: string, fileKey: string, resourceType: 'image' | 'file'): Promise<unknown>;
  uploadImage(data: Buffer): Promise<string | undefined>;
  uploadFile(data: Buffer, fileName: string): Promise<string | undefined>;
  replyDocComment(request: Required<Pick<LarkDocCommentRequest, 'docToken' | 'commentId' | 'content' | 'fileType'>>): Promise<{ replyId?: string }>;
  createDocComment(request: Omit<LarkDocCommentRequest, 'commentId'>): Promise<{ commentId?: string }>;
  fetchMessageText(messageId: string): Promise<string | null>;
}

export interface SdkLarkTransportChannel {
  rawClient?: Lark.Client;
  send?: (
    to: string,
    input: { text: string } | { card: object },
    opts?: { replyTo?: string; replyInThread?: boolean },
  ) => Promise<{ messageId?: string; chunkIds?: string[] }>;
  editMessage?: (messageId: string, text: string) => Promise<void>;
  updateCard?: (messageId: string, card: object) => Promise<void>;
  recallMessage?: (messageId: string) => Promise<void>;
  addReaction?: (messageId: string, emojiType: string) => Promise<string>;
  removeReaction?: (messageId: string, reactionId: string) => Promise<void>;
  removeReactionByEmoji?: (messageId: string, emojiType: string) => Promise<boolean>;
  downloadResource?: (messageId: string, fileKey: string, resourceType: 'image' | 'file') => Promise<unknown>;
  fetchMessage?: (messageId: string) => Promise<{
    content?: string;
    rawContentType?: string;
    messageType?: string;
  } | undefined>;
  comments?: {
    resolveTarget?: (fileToken: string, fileType: string) => Promise<unknown | null>;
    reply?: (target: unknown, commentId: string, text: string) => Promise<void>;
  };
}

export interface LarkTransportOptions {
  sdkChannel?: SdkLarkTransportChannel;
  rawClient?: Lark.Client;
}

function compactCardAttribute(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(re);
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim() || null;
}

function stripCompactCardTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCompactCardText(text: string): string | null {
  const match = text.match(/<card\b([^>]*)>([\s\S]*?)<\/card>/i);
  if (!match) return null;
  const title = compactCardAttribute(match[1] ?? '', 'title');
  const body = stripCompactCardTags(match[2] ?? '');
  const parts = [title, body].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

function normalizeFetchedMessageText(text: string): string {
  return extractCompactCardText(text) ?? text;
}

export function isPlaceholderCardText(text: string, messageType: string | undefined): boolean {
  const trimmed = text.trim();
  return (
    trimmed === '[Interactive Card]' ||
    trimmed.includes(CARD_CLIENT_PLACEHOLDER) ||
    /^<card\b/i.test(trimmed) ||
    (messageType === 'interactive' && !trimmed)
  );
}

function normalizeMessageMentions(item: any): Array<{ id: string; name: string }> {
  return (item?.mentions ?? []).map((m: any) => ({
    id:
      m.id?.open_id ??
      m.id?.union_id ??
      (typeof m.id === 'string' ? m.id : ''),
    name: m.name ?? '',
  }));
}

function resolveMentionPlaceholders(
  text: string,
  mentions: Array<{ id: string; name: string }> | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) return text;
  return text.replace(/@_user_(\d+)/g, (match, n) => {
    const idx = Number(n) - 1;
    const mention = mentions[idx];
    return mention?.name ? `@${mention.name}` : match;
  });
}

function extractText(rawContent: string, messageType: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    switch (messageType) {
      case 'text':
        return parsed.text ?? rawContent;
      case 'post': {
        const lines: string[] = [];
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        for (const line of content) {
          const texts = (line as any[])
            .filter((node: any) => node.tag === 'text' || node.tag === 'a')
            .map((node: any) => node.text ?? node.href ?? '');
          lines.push(texts.join(''));
        }
        return lines.join('\n') || rawContent;
      }
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name ?? 'attachment'}]`;
      case 'audio':
        return '[Audio]';
      case 'video':
        return '[Video]';
      case 'interactive':
        return extractInteractiveCardText(rawContent) ?? '[Interactive Card]';
      default:
        return parsed.text ?? rawContent;
    }
  } catch {
    if (messageType === 'interactive') return '[Interactive Card]';
    return rawContent;
  }
}

function messageItemText(item: any): { text: string; messageType: string } | null {
  const content = item?.body?.content;
  if (!content) return null;
  const messageType = item.msg_type ?? item.message_type ?? 'text';
  const text = normalizeFetchedMessageText(resolveMentionPlaceholders(
    extractText(content, messageType),
    normalizeMessageMentions(item),
  ));
  return { text, messageType };
}

function serializeInput(input: LarkTransportInput): { msg_type: string; content: string } {
  if ('text' in input) {
    return { msg_type: 'text', content: JSON.stringify({ text: input.text }) };
  }
  if ('card' in input) {
    return { msg_type: 'interactive', content: JSON.stringify(input.card) };
  }
  if ('imageKey' in input) {
    return { msg_type: 'image', content: JSON.stringify({ image_key: input.imageKey }) };
  }
  if ('fileKey' in input) {
    return {
      msg_type: 'file',
      content: JSON.stringify({ file_key: input.fileKey, file_name: input.fileName }),
    };
  }
  return { msg_type: input.raw.msgType, content: input.raw.content };
}

function rawMessageId(resp: any): string | undefined {
  return resp?.data?.message_id ?? resp?.message_id;
}

function valuePart(name: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${name}=${String(value)}`;
}

function safeJsonPart(name: string, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return `${name}=${JSON.stringify(value)}`;
  } catch {
    return null;
  }
}

function sdkSendFailureDiagnostic(err: unknown): string {
  const direct = redactErrorForLog(err);
  const raw = err as any;
  const cause = redactErrorForLog(raw?.cause);
  const directRecord = direct && typeof direct === 'object' ? (direct as any) : {};
  const causeRecord = cause && typeof cause === 'object' ? (cause as any) : {};
  const feishu = directRecord.feishu ?? causeRecord.feishu;
  const parts = [
    valuePart('name', directRecord.name ?? raw?.name),
    valuePart('message', directRecord.message ?? raw?.message ?? String(err)),
    valuePart('code', directRecord.code ?? raw?.code),
    valuePart('status', directRecord.status ?? causeRecord.status),
    valuePart('feishu_code', feishu?.code),
    valuePart('feishu_msg', feishu?.msg),
    safeJsonPart('context', raw?.context),
    safeJsonPart('cause', cause),
  ].filter((part): part is string => !!part);
  return parts.join(' ');
}

class DefaultLarkTransport implements LarkTransport {
  private readonly sdkChannel?: SdkLarkTransportChannel;
  private readonly rawClient?: Lark.Client;
  private readonly cardContextCache = new Map<string, { text: string; expiresAt: number }>();

  constructor(opts: LarkTransportOptions) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.sdkChannel?.rawClient ?? opts.rawClient;
  }

  async sendMessage(request: LarkTransportSendRequest): Promise<LarkTransportSendResult> {
    if (
      !request.forceRaw &&
      !request.uuid &&
      this.sdkChannel?.send &&
      ('text' in request.input || 'card' in request.input)
    ) {
      const opts =
        request.replyTo || request.replyInThread
          ? {
              ...(request.replyTo ? { replyTo: request.replyTo } : {}),
              ...(request.replyInThread ? { replyInThread: true } : {}),
            }
          : undefined;
      try {
        return await this.sdkChannel.send(request.chatId, request.input, opts);
      } catch (err) {
        console.error(
          `[lark-transport] SDK send failed; falling back to raw OpenAPI ${sdkSendFailureDiagnostic(err)}`,
        );
        if (!this.rawClient) throw err;
      }
    }

    const raw = this.requireRawClient();
    const payload = serializeInput(request.input);
    const uuid = request.uuid ?? randomUUID();
    if (request.replyTo) {
      const resp = await feishuApiCall('lark_transport.message.reply', () =>
        raw.im.v1.message.reply({
          path: { message_id: request.replyTo! },
          data: {
            content: payload.content,
            msg_type: payload.msg_type,
            ...(request.replyInThread ? { reply_in_thread: true } : {}),
            uuid,
          } as any,
        }),
        request.retry,
      );
      return { messageId: rawMessageId(resp) };
    }

    const resp = await feishuApiCall('lark_transport.message.create', () =>
      raw.im.v1.message.create({
        params: { receive_id_type: request.receiveIdType ?? 'chat_id' },
        data: {
          receive_id: request.chatId,
          content: payload.content,
          msg_type: payload.msg_type,
          uuid,
        },
      }),
      request.retry,
    );
    return { messageId: rawMessageId(resp) };
  }

  async editMessage(request: { messageId: string; text: string }): Promise<void> {
    if (this.sdkChannel?.editMessage) {
      await this.sdkChannel.editMessage(request.messageId, request.text);
      return;
    }
    const raw = this.requireRawClient();
    await feishuApiCall('lark_transport.message.patch.text', () =>
      raw.im.v1.message.patch({
        path: { message_id: request.messageId },
        data: { content: JSON.stringify({ text: request.text }) },
      }),
      { retryTimeout: false },
    );
  }

  async updateCard(request: { messageId: string; card: object | string }): Promise<void> {
    if (this.sdkChannel?.updateCard) {
      const card = typeof request.card === 'string' ? JSON.parse(request.card) : request.card;
      await this.sdkChannel.updateCard(request.messageId, card);
      return;
    }
    const raw = this.requireRawClient();
    const content = typeof request.card === 'string' ? request.card : JSON.stringify(request.card);
    await feishuApiCall('lark_transport.message.patch.card', () =>
      raw.im.v1.message.patch({
        path: { message_id: request.messageId },
        data: { content },
      }),
      { retryTimeout: false },
    );
  }

  async recallMessage(messageId: string): Promise<void> {
    if (this.sdkChannel?.recallMessage) {
      try {
        await this.sdkChannel.recallMessage(messageId);
        return;
      } catch (err) {
        console.error(
          `[lark-transport] SDK recall failed; falling back to raw OpenAPI ${sdkSendFailureDiagnostic(err)}`,
        );
        if (!this.rawClient) throw err;
      }
    }
    const raw = this.requireRawClient();
    await feishuApiCall('lark_transport.message.delete', () =>
      raw.im.v1.message.delete({
        path: { message_id: messageId },
      }),
      { retryTimeout: false },
    );
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    if (this.sdkChannel?.addReaction) {
      return await this.sdkChannel.addReaction(messageId, emojiType);
    }
    const raw = this.requireRawClient();
    const resp = await feishuApiCall('lark_transport.reaction.create', () =>
      raw.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      }),
      { retryTimeout: false },
    );
    return (resp as any)?.data?.reaction_id;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (this.sdkChannel?.removeReaction) {
      await this.sdkChannel.removeReaction(messageId, reactionId);
      return;
    }
    const raw = this.requireRawClient();
    await feishuApiCall('lark_transport.reaction.delete', () =>
      raw.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }),
    );
  }

  async removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean> {
    if (this.sdkChannel?.removeReactionByEmoji) {
      return await this.sdkChannel.removeReactionByEmoji(messageId, emojiType);
    }
    return false;
  }

  async downloadResource(messageId: string, fileKey: string, resourceType: 'image' | 'file'): Promise<unknown> {
    if (this.sdkChannel?.downloadResource) {
      return await this.sdkChannel.downloadResource(messageId, fileKey, resourceType);
    }
    const raw = this.requireRawClient();
    return await feishuApiCall(
      'lark_transport.messageResource.get',
      () =>
        raw.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: resourceType },
        }),
    );
  }

  async uploadImage(data: Buffer): Promise<string | undefined> {
    const raw = this.requireRawClient();
    const resp = await feishuApiCall('lark_transport.image.create', () =>
      raw.im.v1.image.create({
        data: {
          image_type: 'message',
          image: data as any,
        },
      }),
      { retryTimeout: false },
    );
    return (resp as any)?.data?.image_key ?? (resp as any)?.image_key;
  }

  async uploadFile(data: Buffer, fileName: string): Promise<string | undefined> {
    const raw = this.requireRawClient();
    const resp = await feishuApiCall('lark_transport.file.create', () =>
      raw.im.v1.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: data as any,
        },
      }),
      { retryTimeout: false },
    );
    return (resp as any)?.data?.file_key ?? (resp as any)?.file_key;
  }

  async replyDocComment(
    request: Required<Pick<LarkDocCommentRequest, 'docToken' | 'commentId' | 'content' | 'fileType'>>,
  ): Promise<{ replyId?: string }> {
    const raw = this.requireRawClient();
    const elements = buildCommentElements(request.content);
    const resp = await feishuApiCall(
      'lark_transport.doc_comment.reply',
      () => raw.request({
        method: 'POST',
        url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(request.docToken)}/comments/${encodeURIComponent(request.commentId)}/replies`,
        params: { file_type: request.fileType, user_id_type: 'open_id' },
        data: { content: { elements } },
      }),
      { retryTimeout: false },
    );
    return { replyId: (resp as any)?.data?.reply_id };
  }

  async createDocComment(request: Omit<LarkDocCommentRequest, 'commentId'>): Promise<{ commentId?: string }> {
    const raw = this.requireRawClient();
    const elements = buildCommentElements(request.content);
    const resp = await feishuApiCall(
      'lark_transport.doc_comment.create',
      () => raw.request({
        method: 'POST',
        url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(request.docToken)}/comments`,
        params: { file_type: request.fileType, user_id_type: 'open_id' },
        data: { reply_list: { replies: [{ content: { elements } }] } },
      }),
      { retryTimeout: false },
    );
    return { commentId: (resp as any)?.data?.comment_id };
  }

  async fetchMessageText(messageId: string): Promise<string | null> {
    const cached = this.getCachedMessageText(messageId);
    if (cached) return cached;

    const sdkText = await this.fetchMessageTextViaSdk(messageId);
    if (sdkText && !isPlaceholderCardText(sdkText.text, sdkText.messageType)) return sdkText.text;

    const rawGetText = sdkText ? null : await this.fetchMessageTextViaRawGet(messageId);
    if (rawGetText && !isPlaceholderCardText(rawGetText.text, rawGetText.messageType)) return rawGetText.text;

    const fallback = await this.fetchCardContextViaMget(messageId);
    if (fallback && !isPlaceholderCardText(fallback.text, fallback.messageType)) {
      this.setCachedMessageText(messageId, fallback.text);
      return fallback.text;
    }

    return sdkText?.text ?? rawGetText?.text ?? null;
  }

  private getCachedMessageText(messageId: string): string | null {
    const cached = this.cardContextCache.get(messageId);
    if (!cached) return null;
    if (cached.expiresAt > Date.now()) return cached.text;
    this.cardContextCache.delete(messageId);
    return null;
  }

  private setCachedMessageText(messageId: string, text: string): void {
    if (appConfig.cardContextCacheSize <= 0) return;
    this.cardContextCache.set(messageId, {
      text,
      expiresAt: Date.now() + appConfig.cardContextCacheTtlMs,
    });
    while (this.cardContextCache.size > appConfig.cardContextCacheSize) {
      const oldest = this.cardContextCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cardContextCache.delete(oldest);
    }
  }

  private async fetchMessageTextViaSdk(messageId: string): Promise<{ text: string; messageType: string } | null> {
    if (!this.sdkChannel?.fetchMessage) return null;
    try {
      const message = await this.sdkChannel.fetchMessage(messageId);
      if (!message?.content) return null;
      const messageType = message.rawContentType ?? message.messageType ?? 'text';
      return { text: normalizeFetchedMessageText(message.content), messageType };
    } catch {
      return null;
    }
  }

  private async fetchMessageTextViaRawGet(messageId: string): Promise<{ text: string; messageType: string } | null> {
    const raw = this.rawClient;
    if (!raw) return null;
    try {
      const resp = await feishuApiCall('lark_transport.message.get', () =>
        raw.im.v1.message.get({
          path: { message_id: messageId },
        }),
      );
      const item = (resp as any)?.data?.items?.[0];
      return messageItemText(item);
    } catch {
      return null;
    }
  }

  private async fetchCardContextViaMget(messageId: string): Promise<{ text: string; messageType: string } | null> {
    const raw = this.rawClient;
    if (!raw?.request) return null;
    try {
      const resp = await feishuApiCall('lark_transport.message.mget', () =>
        raw.request({
          method: 'POST',
          url: 'https://open.feishu.cn/open-apis/im/v1/messages/mget',
          params: { user_id_type: 'open_id' },
          data: { message_ids: [messageId] },
        }),
      );
      const items = (resp as any)?.data?.items ?? (resp as any)?.data?.messages ?? [];
      const item = Array.isArray(items)
        ? items.find((candidate: any) => !candidate?.message_id || candidate.message_id === messageId) ?? items[0]
        : null;
      return messageItemText(item);
    } catch {
      return null;
    }
  }

  private requireRawClient(): Lark.Client {
    if (!this.rawClient) {
      throw new Error('Lark rawClient is required for this transport operation but is unavailable');
    }
    return this.rawClient;
  }
}

export function createLarkTransport(opts: LarkTransportOptions): LarkTransport {
  return new DefaultLarkTransport(opts);
}

export function createOpenApiLarkTransport(client: Lark.Client): LarkTransport {
  return createLarkTransport({ rawClient: client });
}

export function createSdkLarkTransport(
  sdkChannel: SdkLarkTransportChannel,
  fallbackClient?: Lark.Client,
): LarkTransport {
  return createLarkTransport({ sdkChannel, rawClient: fallbackClient });
}
