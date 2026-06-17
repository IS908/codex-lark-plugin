import type * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { feishuApiCall } from './feishu-retry.js';
import {
  fetchedMessageContentText,
  isPlaceholderCardText,
  messageItemText,
} from './message-content.js';
import type { SdkLarkTransportChannel } from './lark-transport.js';

export interface LarkFetchedMessageContext {
  messageId: string;
  text: string | null;
  msgType: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
}

export class LarkTransportCardContext {
  private readonly sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
  private readonly rawClient?: Lark.Client;
  private readonly cardContextCache = new Map<string, { context: LarkFetchedMessageContext; expiresAt: number }>();

  constructor(opts: {
    sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
    rawClient?: Lark.Client;
  }) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.rawClient;
  }

  async fetchMessageText(messageId: string): Promise<string | null> {
    const context = await this.fetchMessageContext(messageId);
    return context?.text ?? null;
  }

  async fetchMessageContext(messageId: string): Promise<LarkFetchedMessageContext | null> {
    const cached = this.getCachedMessageContext(messageId);
    if (cached) return cached;

    const sdkContext = await this.fetchMessageContextViaSdk(messageId);
    if (sdkContext?.text && !isPlaceholderCardText(sdkContext.text, sdkContext.msgType)) {
      this.setCachedMessageContext(messageId, sdkContext);
      return sdkContext;
    }

    const rawGetContext = sdkContext ? null : await this.fetchMessageContextViaRawGet(messageId);
    if (rawGetContext?.text && !isPlaceholderCardText(rawGetContext.text, rawGetContext.msgType)) {
      this.setCachedMessageContext(messageId, rawGetContext);
      return rawGetContext;
    }

    const fallback = await this.fetchCardContextViaMget(messageId);
    if (fallback?.text && !isPlaceholderCardText(fallback.text, fallback.msgType)) {
      const merged = mergeContexts(messageId, sdkContext ?? rawGetContext, fallback);
      this.setCachedMessageContext(messageId, merged);
      return merged;
    }

    const placeholderContext = sdkContext ?? rawGetContext ?? fallback;
    if (!placeholderContext) return null;
    return {
      ...placeholderContext,
      text: placeholderContext.text && !isPlaceholderCardText(placeholderContext.text, placeholderContext.msgType)
        ? placeholderContext.text
        : null,
    };
  }

  private getCachedMessageContext(messageId: string): LarkFetchedMessageContext | null {
    const cached = this.cardContextCache.get(messageId);
    if (!cached) return null;
    if (cached.expiresAt > Date.now()) return cached.context;
    this.cardContextCache.delete(messageId);
    return null;
  }

  private setCachedMessageContext(messageId: string, context: LarkFetchedMessageContext): void {
    if (appConfig.cardContextCacheSize <= 0) return;
    this.cardContextCache.set(messageId, {
      context,
      expiresAt: Date.now() + appConfig.cardContextCacheTtlMs,
    });
    while (this.cardContextCache.size > appConfig.cardContextCacheSize) {
      const oldest = this.cardContextCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cardContextCache.delete(oldest);
    }
  }

  private async fetchMessageContextViaSdk(messageId: string): Promise<LarkFetchedMessageContext | null> {
    if (!this.sdkChannel?.fetchMessage) return null;
    try {
      const message = await this.sdkChannel.fetchMessage(messageId);
      if (!message) return null;
      return sdkMessageContext(messageId, message);
    } catch {
      return null;
    }
  }

  private async fetchMessageContextViaRawGet(messageId: string): Promise<LarkFetchedMessageContext | null> {
    const raw = this.rawClient;
    if (!raw) return null;
    try {
      const resp = await feishuApiCall('lark_transport.message.get', () =>
        raw.im.v1.message.get({
          path: { message_id: messageId },
        }),
      );
      const item = (resp as any)?.data?.items?.[0];
      return messageItemContext(messageId, item);
    } catch {
      return null;
    }
  }

  private async fetchCardContextViaMget(messageId: string): Promise<LarkFetchedMessageContext | null> {
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
      return messageItemContext(messageId, item);
    } catch {
      return null;
    }
  }
}

function sdkMessageContext(messageId: string, message: any): LarkFetchedMessageContext {
  const msgType = message.rawContentType ?? message.messageType ?? message.msg_type ?? message.message_type ?? 'text';
  const text = message.content ? fetchedMessageContentText(message.content, msgType) : null;
  return normalizeContext({
    messageId: message.messageId ?? message.message_id ?? messageId,
    text,
    msgType,
    parentId: message.parentId ?? message.parent_id,
    rootMessageId: message.rootMessageId ?? message.root_id,
    threadId: message.threadId ?? message.thread_id,
  });
}

function messageItemContext(messageId: string, item: any): LarkFetchedMessageContext | null {
  if (!item) return null;
  const text = messageItemText(item);
  const msgType = text?.messageType ?? item.msg_type ?? item.message_type ?? 'text';
  return normalizeContext({
    messageId: item.message_id ?? item.messageId ?? messageId,
    text: text?.text ?? null,
    msgType,
    parentId: item.parent_id ?? item.parentId,
    rootMessageId: item.root_id ?? item.rootMessageId,
    threadId: item.thread_id ?? item.threadId,
  });
}

function mergeContexts(
  requestedMessageId: string,
  base: LarkFetchedMessageContext | null | undefined,
  content: LarkFetchedMessageContext,
): LarkFetchedMessageContext {
  return normalizeContext({
    messageId: content.messageId || base?.messageId || requestedMessageId,
    text: content.text,
    msgType: content.msgType || base?.msgType || 'unknown',
    parentId: content.parentId ?? base?.parentId,
    rootMessageId: content.rootMessageId ?? base?.rootMessageId,
    threadId: content.threadId ?? base?.threadId,
  });
}

function normalizeContext(context: LarkFetchedMessageContext): LarkFetchedMessageContext {
  const normalized: LarkFetchedMessageContext = {
    messageId: context.messageId,
    text: context.text,
    msgType: context.msgType,
  };
  if (context.parentId) normalized.parentId = context.parentId;
  if (context.rootMessageId) normalized.rootMessageId = context.rootMessageId;
  if (context.threadId) normalized.threadId = context.threadId;
  return normalized;
}
