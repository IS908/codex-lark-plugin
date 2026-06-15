import type * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { feishuApiCall } from './feishu-retry.js';
import {
  fetchedMessageContentText,
  isPlaceholderCardText,
  messageItemText,
} from './message-content.js';
import type { SdkLarkTransportChannel } from './lark-transport.js';

export class LarkTransportCardContext {
  private readonly sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
  private readonly rawClient?: Lark.Client;
  private readonly cardContextCache = new Map<string, { text: string; expiresAt: number }>();

  constructor(opts: {
    sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
    rawClient?: Lark.Client;
  }) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.rawClient;
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
      return { text: fetchedMessageContentText(message.content, messageType), messageType };
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
}
