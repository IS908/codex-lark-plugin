import * as Lark from '@larksuiteoapi/node-sdk';
import {
  feishuApiCall,
  getFeishuApiCode,
  isFeishuWithdrawnMessageError,
} from './feishu-retry.js';
import { LarkTransportCardContext } from './lark-transport-card-context.js';
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
  findDocCommentReplyByMarkerViaRaw,
  replyDocCommentViaRaw,
} from './lark-transport-doc-comment-api.js';
import type {
  LarkDocCommentRequest,
  LarkDocCommentReplyMarkerRequest,
  LarkDocCommentReplyRequest,
  LarkChatMember,
  LarkFetchedMessageContext,
  LarkTransport,
  LarkTransportOptions,
  LarkTransportSendRequest,
  LarkTransportSendResult,
  SdkLarkTransportChannel,
} from './lark-transport-contracts.js';

export { isPlaceholderCardText } from './message-content.js';
export type * from './lark-transport-contracts.js';

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

  async getChatMembers(chatId: string): Promise<LarkChatMember[]> {
    if (this.sdkChannel?.getChatMembers) {
      return await this.sdkChannel.getChatMembers(chatId, {
        idType: 'open_id',
        pageSize: 100,
        maxPages: 1000,
      });
    }

    const members: LarkChatMember[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const response = await feishuApiCall('lark_transport.chat_members.get', () =>
        this.requireRawClient().im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: 'open_id',
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        } as any));
      for (const item of response?.data?.items ?? []) {
        if (!item.member_id) continue;
        members.push({
          id: item.member_id,
          idType: 'open_id',
          ...(item.name ? { name: item.name } : {}),
          ...(item.tenant_key ? { tenantKey: item.tenant_key } : {}),
        });
      }
      if (!response?.data?.has_more || !response.data.page_token) return members;
      pageToken = response.data.page_token;
    }
    throw new Error(`Chat ${chatId} roster exceeds the safe pagination limit`);
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
    request: LarkDocCommentReplyRequest,
  ): Promise<{ replyId?: string }> {
    return await replyDocCommentViaRaw(this.requireRawClient(), request);
  }

  async findDocCommentReplyByMarker(
    request: LarkDocCommentReplyMarkerRequest,
  ): Promise<{ replyId?: string } | null> {
    return await findDocCommentReplyByMarkerViaRaw(this.requireRawClient(), request);
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
