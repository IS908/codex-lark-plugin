import * as Lark from '@larksuiteoapi/node-sdk';
import {
  getFeishuApiCode,
  isFeishuWithdrawnMessageError,
  type FeishuRetryOptions,
} from './feishu-retry.js';
import {
  LarkTransportCardContext,
  type LarkFetchedMessageContext,
  type LarkOutboundMessageContextCache,
  type LarkUserMessageFetcher,
} from './lark-transport-card-context.js';
import { createLarkCliUserMessageFetcher } from './lark-user-message-fetch.js';
import { formatSdkFallbackLog } from './lark-transport-diagnostics.js';
import {
  editMessageViaRaw,
  recallMessageViaRaw,
  sendMessageViaRaw,
  updateCardViaRaw,
} from './lark-transport-message-api.js';
import {
  addReactionViaRaw,
  removeReactionViaRaw,
} from './lark-transport-reaction-api.js';
import {
  downloadResourceViaRaw,
  uploadFileViaRaw,
  uploadImageViaRaw,
} from './lark-transport-resource-api.js';
import {
  createDocCommentViaRaw,
  replyDocCommentViaRaw,
} from './lark-transport-doc-comment-api.js';

export { isPlaceholderCardText } from './message-content.js';

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
  fetchMessageContext(messageId: string): Promise<LarkFetchedMessageContext | null>;
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
    messageId?: string;
    chatId?: string;
    chat_id?: string;
    parentId?: string;
    parent_id?: string;
    replyTo?: string;
    reply_to?: string;
    rootMessageId?: string;
    root_id?: string;
    threadId?: string;
    thread_id?: string;
    timestampMs?: number;
    timestamp?: string;
    createTime?: string;
    create_time?: string;
    updateTime?: string;
    update_time?: string;
    messagePosition?: string;
    message_position?: string;
    sender?: unknown;
    content?: string;
    rawContentType?: string;
    messageType?: string;
    msg_type?: string;
    message_type?: string;
  } | undefined>;
  comments?: {
    resolveTarget?: (fileToken: string, fileType: string) => Promise<unknown | null>;
    reply?: (target: unknown, commentId: string, text: string) => Promise<void>;
  };
}

export interface LarkTransportOptions {
  sdkChannel?: SdkLarkTransportChannel;
  rawClient?: Lark.Client;
  outboundMessageContextCache?: LarkOutboundMessageContextCache;
  userMessageFetcher?: LarkUserMessageFetcher;
}

class DefaultLarkTransport implements LarkTransport {
  private readonly sdkChannel?: SdkLarkTransportChannel;
  private readonly rawClient?: Lark.Client;
  private readonly cardContext: LarkTransportCardContext;

  constructor(opts: LarkTransportOptions) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.sdkChannel?.rawClient ?? opts.rawClient;
    this.cardContext = new LarkTransportCardContext({
      sdkChannel: this.sdkChannel,
      rawClient: this.rawClient,
      outboundMessageContextCache: opts.outboundMessageContextCache,
      userMessageFetcher: opts.userMessageFetcher,
    });
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
        if (isFeishuWithdrawnMessageError(err)) {
          console.error(
            `[lark-transport] SDK send skipped: target message ${request.replyTo ?? '(none)'} was withdrawn; code=${getFeishuApiCode(err)}; raw OpenAPI fallback suppressed`,
          );
          throw err;
        }
        console.error(formatSdkFallbackLog('send', err));
        if (!this.rawClient) throw err;
      }
    }

    return await sendMessageViaRaw(this.requireRawClient(), request);
  }

  async editMessage(request: { messageId: string; text: string }): Promise<void> {
    if (this.sdkChannel?.editMessage) {
      await this.sdkChannel.editMessage(request.messageId, request.text);
      return;
    }
    await editMessageViaRaw(this.requireRawClient(), request);
  }

  async updateCard(request: { messageId: string; card: object | string }): Promise<void> {
    if (this.sdkChannel?.updateCard) {
      const card = typeof request.card === 'string' ? JSON.parse(request.card) : request.card;
      await this.sdkChannel.updateCard(request.messageId, card);
      return;
    }
    await updateCardViaRaw(this.requireRawClient(), request);
  }

  async recallMessage(messageId: string): Promise<void> {
    if (this.sdkChannel?.recallMessage) {
      try {
        await this.sdkChannel.recallMessage(messageId);
        return;
      } catch (err) {
        console.error(formatSdkFallbackLog('recall', err));
        if (!this.rawClient) throw err;
      }
    }
    await recallMessageViaRaw(this.requireRawClient(), messageId);
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    if (this.sdkChannel?.addReaction) {
      return await this.sdkChannel.addReaction(messageId, emojiType);
    }
    return await addReactionViaRaw(this.requireRawClient(), messageId, emojiType);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (this.sdkChannel?.removeReaction) {
      await this.sdkChannel.removeReaction(messageId, reactionId);
      return;
    }
    await removeReactionViaRaw(this.requireRawClient(), messageId, reactionId);
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
    return await downloadResourceViaRaw(this.requireRawClient(), messageId, fileKey, resourceType);
  }

  async uploadImage(data: Buffer): Promise<string | undefined> {
    return await uploadImageViaRaw(this.requireRawClient(), data);
  }

  async uploadFile(data: Buffer, fileName: string): Promise<string | undefined> {
    return await uploadFileViaRaw(this.requireRawClient(), data, fileName);
  }

  async replyDocComment(
    request: Required<Pick<LarkDocCommentRequest, 'docToken' | 'commentId' | 'content' | 'fileType'>>,
  ): Promise<{ replyId?: string }> {
    return await replyDocCommentViaRaw(this.requireRawClient(), request);
  }

  async createDocComment(request: Omit<LarkDocCommentRequest, 'commentId'>): Promise<{ commentId?: string }> {
    return await createDocCommentViaRaw(this.requireRawClient(), request);
  }

  async fetchMessageText(messageId: string): Promise<string | null> {
    return await this.cardContext.fetchMessageText(messageId);
  }

  async fetchMessageContext(messageId: string): Promise<LarkFetchedMessageContext | null> {
    return await this.cardContext.fetchMessageContext(messageId);
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

export function createOpenApiLarkTransport(
  client: Lark.Client,
  opts: Pick<LarkTransportOptions, 'outboundMessageContextCache' | 'userMessageFetcher'> = {},
): LarkTransport {
  return createLarkTransport({
    rawClient: client,
    ...opts,
    userMessageFetcher: opts.userMessageFetcher ?? createLarkCliUserMessageFetcher(),
  });
}

export function createSdkLarkTransport(
  sdkChannel: SdkLarkTransportChannel,
  fallbackClient?: Lark.Client,
  opts: Pick<LarkTransportOptions, 'outboundMessageContextCache' | 'userMessageFetcher'> = {},
): LarkTransport {
  return createLarkTransport({
    sdkChannel,
    rawClient: fallbackClient,
    ...opts,
    userMessageFetcher: opts.userMessageFetcher ?? createLarkCliUserMessageFetcher(),
  });
}
