import type * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { feishuApiCall } from './feishu-retry.js';
import {
  fetchedMessageContentText,
  interactiveCardTextMetadata,
  isPlaceholderCardText,
  messageItemRawContent,
  messageItemText,
} from './message-content.js';
import type { SdkLarkTransportChannel } from './lark-transport.js';
import type {
  LarkCachedMessageContext,
  LarkMessageContext,
  LarkMessageFetchResult,
  LarkMessageFetchStage,
} from './lark-message-context.js';

export type LarkFetchedMessageContext = LarkMessageContext;
export type LarkCachedQuotedMessageContext = LarkCachedMessageContext;
export type {
  LarkMessageContext,
  LarkMessageFetchIdentity,
  LarkMessageFetchResult,
  LarkMessageFetchStage,
  LarkMessageHydrationReason,
} from './lark-message-context.js';

export interface LarkOutboundMessageContextCache {
  get(messageId: string): { quotedContext?: LarkCachedQuotedMessageContext } | undefined;
}

export interface LarkUserMessageFetchResult {
  item?: unknown;
  diagnostic?: string;
  fetchResult?: LarkMessageFetchResult;
}

export interface LarkUserMessageFetcher {
  fetchMessage(messageId: string): Promise<LarkUserMessageFetchResult | null>;
}

export class LarkTransportCardContext {
  private readonly sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
  private readonly rawClient?: Lark.Client;
  private readonly outboundMessageContextCache?: LarkOutboundMessageContextCache;
  private readonly userMessageFetcher?: LarkUserMessageFetcher;
  private readonly cardContextCache = new Map<string, { context: LarkFetchedMessageContext; expiresAt: number }>();

  constructor(opts: {
    sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
    rawClient?: Lark.Client;
    outboundMessageContextCache?: LarkOutboundMessageContextCache;
    userMessageFetcher?: LarkUserMessageFetcher;
  }) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.rawClient;
    this.outboundMessageContextCache = opts.outboundMessageContextCache;
    this.userMessageFetcher = opts.userMessageFetcher;
  }

  async fetchMessageText(messageId: string): Promise<string | null> {
    const context = await this.fetchMessageContext(messageId);
    return context?.text ?? null;
  }

  async fetchMessageContext(messageId: string): Promise<LarkFetchedMessageContext | null> {
    const cached = this.getCachedMessageContext(messageId);
    if (cached) return cached;

    const outboundCached = this.getOutboundCachedMessageContext(messageId);
    if (outboundCached) {
      this.setCachedMessageContext(messageId, outboundCached);
      return outboundCached;
    }

    const attempts: LarkFetchedMessageContext[] = [];

    const botMgetContext = await this.fetchCardContextViaMget(messageId);
    if (botMgetContext) attempts.push(botMgetContext);
    if (botMgetContext?.text && !isPlaceholderCardText(botMgetContext.text, botMgetContext.msgType)) {
      this.setCachedMessageContext(messageId, botMgetContext);
      return botMgetContext;
    }

    let triedSdkRawFallback = false;
    if (!botMgetContext) {
      triedSdkRawFallback = true;
      const sdkRawContext = await this.fetchSdkRawGetFallback(messageId, attempts);
      if (sdkRawContext) {
        this.setCachedMessageContext(messageId, sdkRawContext);
        return sdkRawContext;
      }
    }

    const userContext = await this.fetchCardContextViaUser(messageId);
    if (userContext) attempts.push(userContext);
    if (userContext?.text && !isPlaceholderCardText(userContext.text, userContext.msgType)) {
      const merged = mergeContexts(messageId, botMgetContext, userContext);
      this.setCachedMessageContext(messageId, merged);
      return merged;
    }

    if (userContext) {
      await this.addMetadataFallbackAttempts(messageId, attempts);
      return unresolvedContextFromAttempts(messageId, attempts);
    }

    if (!triedSdkRawFallback) {
      const sdkRawContext = await this.fetchSdkRawGetFallback(messageId, attempts);
      if (sdkRawContext) {
        this.setCachedMessageContext(messageId, sdkRawContext);
        return sdkRawContext;
      }
    }

    return unresolvedContextFromAttempts(messageId, attempts);
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
      return markUnresolvedIfNeeded(sdkMessageContext(messageId, message), 'sdk_fetch', undefined, {
        fetchIdentity: 'bot',
      });
    } catch (error) {
      return createUnresolvedContext(messageId, 'unknown', 'sdk_fetch', safeFetchDiagnostic(error), {
        fetchIdentity: 'bot',
        fetchResult: fetchResultFromError(error),
      });
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
      if (!item) return createUnresolvedContext(messageId, 'unknown', 'raw_get', 'empty_response', {
        fetchIdentity: 'bot',
        fetchResult: 'empty',
      });
      return messageItemContext(messageId, item, 'raw_get', { fetchIdentity: 'bot' });
    } catch (error) {
      return createUnresolvedContext(messageId, 'unknown', 'raw_get', safeFetchDiagnostic(error), {
        fetchIdentity: 'bot',
        fetchResult: fetchResultFromError(error),
      });
    }
  }

  private async fetchSdkRawGetFallback(
    messageId: string,
    attempts: LarkFetchedMessageContext[],
  ): Promise<LarkFetchedMessageContext | null> {
    const sdkContext = await this.fetchMessageContextViaSdk(messageId);
    if (sdkContext) attempts.push(sdkContext);
    if (sdkContext?.text && !isPlaceholderCardText(sdkContext.text, sdkContext.msgType)) {
      return sdkContext;
    }

    const rawGetContext = await this.fetchMessageContextViaRawGet(messageId);
    if (rawGetContext) attempts.push(rawGetContext);
    if (rawGetContext?.text && !isPlaceholderCardText(rawGetContext.text, rawGetContext.msgType)) {
      return rawGetContext;
    }

    return null;
  }

  private async addMetadataFallbackAttempts(
    messageId: string,
    attempts: LarkFetchedMessageContext[],
  ): Promise<void> {
    const hasTypedMetadata = attempts.some((attempt) => attempt.msgType !== 'unknown');
    if (hasTypedMetadata) return;

    const sdkContext = await this.fetchMessageContextViaSdk(messageId);
    if (sdkContext) attempts.push(sdkContext);
    if (sdkContext?.msgType && sdkContext.msgType !== 'unknown') return;

    const rawGetContext = await this.fetchMessageContextViaRawGet(messageId);
    if (rawGetContext) attempts.push(rawGetContext);
  }

  private async fetchCardContextViaMget(messageId: string): Promise<LarkFetchedMessageContext | null> {
    const raw = this.rawClient;
    if (!raw?.request) return null;
    try {
      const resp = await feishuApiCall('lark_transport.message.mget', () =>
        raw.request({
          method: 'GET',
          url: messageMgetUrl(messageId),
          params: {},
        }),
      );
      const items = (resp as any)?.data?.items ?? (resp as any)?.data?.messages ?? [];
      const item = Array.isArray(items)
        ? items.find((candidate: any) => !candidate?.message_id || candidate.message_id === messageId) ?? items[0]
        : null;
      if (!item) return createUnresolvedContext(messageId, 'unknown', 'bot_mget', 'empty_response', {
        fetchIdentity: 'bot',
        fetchResult: 'empty',
      });
      return messageItemContext(messageId, item, 'bot_mget', { fetchIdentity: 'bot' });
    } catch (error) {
      return createUnresolvedContext(messageId, 'unknown', 'bot_mget', safeFetchDiagnostic(error), {
        fetchIdentity: 'bot',
        fetchResult: fetchResultFromError(error),
      });
    }
  }

  private getOutboundCachedMessageContext(messageId: string): LarkFetchedMessageContext | null {
    const quotedContext = this.outboundMessageContextCache?.get(messageId)?.quotedContext;
    if (!quotedContext?.text) return null;
    const msgType = quotedContext.msgType ?? 'interactive';
    if (isPlaceholderCardText(quotedContext.text, msgType)) return null;
    return normalizeContext({
      messageId: quotedContext.messageId ?? messageId,
      text: quotedContext.text,
      msgType,
      chatId: quotedContext.chatId,
      parentId: quotedContext.parentId,
      replyTo: quotedContext.replyTo,
      rootMessageId: quotedContext.rootMessageId,
      threadId: quotedContext.threadId,
      timestampMs: quotedContext.timestampMs,
      timestamp: quotedContext.timestamp,
      createTime: quotedContext.createTime,
      updateTime: quotedContext.updateTime,
      messagePosition: quotedContext.messagePosition,
      sender: quotedContext.sender,
      interactiveCard: quotedContext.interactiveCard,
      fetchStage: 'outbound_cache',
      fetchIdentity: 'cache',
      fetchResult: 'success',
    });
  }

  private async fetchCardContextViaUser(messageId: string): Promise<LarkFetchedMessageContext | null> {
    const fetcher = this.userMessageFetcher;
    if (!fetcher) return null;
    try {
      const result = await fetcher.fetchMessage(messageId);
      if (!result) return null;
      if (!result.item) {
        return createUnresolvedContext(messageId, 'unknown', 'user_mget', result.diagnostic, {
          fetchIdentity: 'user',
          fetchResult: result.fetchResult ?? 'empty',
        });
      }
      return messageItemContext(messageId, result.item, 'user_mget', { fetchIdentity: 'user' });
    } catch (error) {
      return createUnresolvedContext(messageId, 'unknown', 'user_mget', safeFetchDiagnostic(error), {
        fetchIdentity: 'user',
        fetchResult: fetchResultFromError(error),
      });
    }
  }
}

function messageMgetUrl(messageId: string): string {
  const query = new URLSearchParams();
  query.set('card_msg_content_type', 'raw_card_content');
  query.append('message_ids', messageId);
  return `/open-apis/im/v1/messages/mget?${query.toString()}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return text.length <= 10 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSender(sender: any): LarkFetchedMessageContext['sender'] | undefined {
  if (!sender || typeof sender !== 'object') return undefined;
  const id =
    normalizeOptionalString(sender.id?.open_id) ??
    normalizeOptionalString(sender.id?.app_id) ??
    normalizeOptionalString(sender.id);
  const idType = normalizeOptionalString(sender.id_type ?? sender.idType);
  const senderType = normalizeOptionalString(sender.sender_type ?? sender.senderType);
  if (!id && !idType && !senderType) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(idType ? { idType } : {}),
    ...(senderType ? { senderType } : {}),
  };
}

function sdkMessageContext(messageId: string, message: any): LarkFetchedMessageContext {
  const msgType = message.rawContentType ?? message.messageType ?? message.msg_type ?? message.message_type ?? 'text';
  const text = message.content ? fetchedMessageContentText(message.content, msgType) : null;
  return normalizeContext({
    messageId: message.messageId ?? message.message_id ?? messageId,
    text,
    msgType,
    chatId: message.chatId ?? message.chat_id,
    parentId: message.parentId ?? message.parent_id,
    replyTo: message.replyTo ?? message.reply_to ?? message.parentId ?? message.parent_id,
    rootMessageId: message.rootMessageId ?? message.root_id,
    threadId: message.threadId ?? message.thread_id,
    timestampMs: normalizeTimestampMs(message.timestampMs ?? message.createTime ?? message.create_time ?? message.timestamp),
    timestamp: message.timestamp,
    createTime: message.createTime ?? message.create_time,
    updateTime: message.updateTime ?? message.update_time,
    messagePosition: message.messagePosition ?? message.message_position,
    sender: normalizeSender(message.sender),
    interactiveCard: message.content && text
      ? interactiveCardTextMetadata(message.content, msgType, text)
      : undefined,
  });
}

function messageItemContext(
  messageId: string,
  item: any,
  fetchStage: LarkMessageFetchStage,
  details: Pick<LarkFetchedMessageContext, 'fetchIdentity'> = {},
): LarkFetchedMessageContext | null {
  if (!item) return null;
  const text = messageItemText(item);
  const rawContent = messageItemRawContent(item);
  const msgType = text?.messageType ?? item.msg_type ?? item.message_type ?? 'text';
  return markUnresolvedIfNeeded(normalizeContext({
    messageId: item.message_id ?? item.messageId ?? messageId,
    text: text?.text ?? null,
    msgType,
    chatId: item.chat_id ?? item.chatId,
    parentId: item.parent_id ?? item.parentId,
    replyTo: item.reply_to ?? item.replyTo ?? item.parent_id ?? item.parentId,
    rootMessageId: item.root_id ?? item.rootMessageId,
    threadId: item.thread_id ?? item.threadId,
    timestampMs: normalizeTimestampMs(item.timestamp_ms ?? item.timestampMs ?? item.create_time ?? item.createTime ?? item.timestamp),
    timestamp: item.timestamp,
    createTime: item.create_time ?? item.createTime,
    updateTime: item.update_time ?? item.updateTime,
    messagePosition: normalizeOptionalString(item.message_position ?? item.messagePosition),
    sender: normalizeSender(item.sender),
    interactiveCard: rawContent && text?.text
      ? interactiveCardTextMetadata(rawContent, msgType, text.text)
      : undefined,
  }), fetchStage, text ? undefined : 'missing_message_content', {
    ...details,
    fetchResult: text ? undefined : 'missing_content',
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
    chatId: content.chatId ?? base?.chatId,
    parentId: content.parentId ?? base?.parentId,
    replyTo: content.replyTo ?? base?.replyTo,
    rootMessageId: content.rootMessageId ?? base?.rootMessageId,
    threadId: content.threadId ?? base?.threadId,
    timestampMs: content.timestampMs ?? base?.timestampMs,
    timestamp: content.timestamp ?? base?.timestamp,
    createTime: content.createTime ?? base?.createTime,
    updateTime: content.updateTime ?? base?.updateTime,
    messagePosition: content.messagePosition ?? base?.messagePosition,
    sender: content.sender ?? base?.sender,
    interactiveCard: content.interactiveCard ?? base?.interactiveCard,
    fetchStage: content.fetchStage ?? base?.fetchStage,
    fetchIdentity: content.fetchIdentity ?? base?.fetchIdentity,
    fetchResult: content.fetchResult ?? base?.fetchResult,
  });
}

function normalizeContext(context: LarkFetchedMessageContext): LarkFetchedMessageContext {
  const normalized: LarkFetchedMessageContext = {
    messageId: context.messageId,
    text: context.text,
    msgType: context.msgType,
  };
  if (context.chatId) normalized.chatId = context.chatId;
  if (context.parentId) normalized.parentId = context.parentId;
  if (context.replyTo) normalized.replyTo = context.replyTo;
  if (context.rootMessageId) normalized.rootMessageId = context.rootMessageId;
  if (context.threadId) normalized.threadId = context.threadId;
  if (context.timestampMs !== undefined) normalized.timestampMs = context.timestampMs;
  if (context.timestamp) normalized.timestamp = context.timestamp;
  if (context.createTime) normalized.createTime = context.createTime;
  if (context.updateTime) normalized.updateTime = context.updateTime;
  if (context.messagePosition) normalized.messagePosition = context.messagePosition;
  if (context.sender) normalized.sender = context.sender;
  if (context.interactiveCard) normalized.interactiveCard = context.interactiveCard;
  if (context.fetchStage) normalized.fetchStage = context.fetchStage;
  if (context.fetchIdentity) normalized.fetchIdentity = context.fetchIdentity;
  if (context.fetchResult) normalized.fetchResult = context.fetchResult;
  if (context.diagnostic) normalized.diagnostic = context.diagnostic;
  if (context.hydrationErrorReason) normalized.hydrationErrorReason = context.hydrationErrorReason;
  return normalized;
}

function markUnresolvedIfNeeded(
  context: LarkFetchedMessageContext,
  fetchStage: LarkMessageFetchStage,
  diagnostic?: string,
  details: Pick<LarkFetchedMessageContext, 'fetchIdentity' | 'fetchResult'> = {},
): LarkFetchedMessageContext {
  if (context.text && !isPlaceholderCardText(context.text, context.msgType)) {
    return normalizeContext({
      ...context,
      fetchStage,
      fetchIdentity: details.fetchIdentity,
      fetchResult: details.fetchResult ?? 'success',
    });
  }
  return normalizeContext({
    ...context,
    fetchStage,
    diagnostic: diagnostic ?? (context.text ? 'placeholder_content' : undefined),
    fetchIdentity: details.fetchIdentity,
    fetchResult: details.fetchResult ?? (context.text ? 'placeholder' : 'missing_content'),
    hydrationErrorReason: 'fetch_failed',
  });
}

function createUnresolvedContext(
  messageId: string,
  msgType: string,
  fetchStage: LarkMessageFetchStage,
  diagnostic?: string,
  details: Pick<LarkFetchedMessageContext, 'fetchIdentity' | 'fetchResult'> = {},
): LarkFetchedMessageContext {
  return normalizeContext({
    messageId,
    text: null,
    msgType,
    fetchStage,
    fetchIdentity: details.fetchIdentity,
    fetchResult: details.fetchResult,
    diagnostic,
    hydrationErrorReason: 'fetch_failed',
  });
}

function unresolvedContextFromAttempts(
  requestedMessageId: string,
  attempts: LarkFetchedMessageContext[],
): LarkFetchedMessageContext | null {
  if (attempts.length === 0) return null;
  const metadata = attempts.find((attempt) => attempt.msgType !== 'unknown') ?? attempts[0];
  const failedAttempt =
    [...attempts].reverse().find((attempt) => attempt.fetchStage === 'user_mget') ??
    [...attempts].reverse().find((attempt) => attempt.fetchStage === 'bot_mget' || attempt.fetchStage === 'raw_mget') ??
    [...attempts].reverse().find((attempt) => attempt.fetchStage) ??
    metadata;
  return normalizeContext({
    messageId: metadata.messageId || requestedMessageId,
    text: null,
    msgType: metadata.msgType || failedAttempt.msgType || 'unknown',
    parentId: metadata.parentId ?? failedAttempt.parentId,
    rootMessageId: metadata.rootMessageId ?? failedAttempt.rootMessageId,
    threadId: metadata.threadId ?? failedAttempt.threadId,
    fetchStage: failedAttempt.fetchStage,
    fetchIdentity: failedAttempt.fetchIdentity,
    fetchResult: failedAttempt.fetchResult,
    diagnostic: failedAttempt.diagnostic,
    hydrationErrorReason: failedAttempt.hydrationErrorReason ?? 'fetch_failed',
  });
}

function fetchResultFromError(error: unknown): LarkMessageFetchResult {
  const candidate = error as any;
  const status = candidate?.response?.status ?? candidate?.status ?? candidate?.cause?.response?.status;
  return String(status) === '404' ? '404' : 'error';
}

function safeFetchDiagnostic(error: unknown): string | undefined {
  const candidate = error as any;
  const responseData = candidate?.response?.data ?? candidate?.data ?? candidate?.cause?.response?.data;
  const code = responseData?.code ?? candidate?.code;
  const status = candidate?.response?.status ?? candidate?.status ?? candidate?.cause?.response?.status;
  const logId = responseData?.error?.log_id ?? responseData?.log_id ?? responseData?.LogId ?? candidate?.logId;
  const message = responseData?.msg ?? responseData?.message ?? (error instanceof Error ? error.message : undefined);
  const parts: string[] = [];
  if (code !== undefined && code !== null) parts.push(`code=${code}`);
  if (status !== undefined && status !== null) parts.push(`status=${status}`);
  if (logId) parts.push(`log_id=${logId}`);
  if (message) parts.push(`message=${message}`);
  return sanitizeDiagnostic(parts.join(' '));
}

function sanitizeDiagnostic(value: string | undefined): string | undefined {
  const sanitized = value
    ?.replace(/\s+/g, ' ')
    .replace(/((?:app|tenant)_access_token|authorization|secret|token)=\S+/gi, '$1=[redacted]')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized;
}
