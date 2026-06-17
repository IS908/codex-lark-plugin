import type * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { feishuApiCall } from './feishu-retry.js';
import {
  fetchedMessageContentText,
  isPlaceholderCardText,
  messageItemText,
} from './message-content.js';
import type { SdkLarkTransportChannel } from './lark-transport.js';

export type LarkMessageFetchStage = 'outbound_cache' | 'sdk_fetch' | 'raw_get' | 'raw_mget';
export type LarkMessageFetchIdentity = 'cache' | 'bot' | 'user' | 'unknown';
export type LarkMessageFetchResult =
  | 'success'
  | 'empty'
  | '404'
  | 'error'
  | 'placeholder'
  | 'missing_content';
export type LarkMessageHydrationReason = 'fetch_failed';

export interface LarkFetchedMessageContext {
  messageId: string;
  text: string | null;
  msgType: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
  fetchStage?: LarkMessageFetchStage;
  fetchIdentity?: LarkMessageFetchIdentity;
  fetchResult?: LarkMessageFetchResult;
  diagnostic?: string;
  hydrationErrorReason?: LarkMessageHydrationReason;
}

export interface LarkCachedQuotedMessageContext {
  messageId?: string;
  text: string;
  msgType?: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
}

export interface LarkOutboundMessageContextCache {
  get(messageId: string): { quotedContext?: LarkCachedQuotedMessageContext } | undefined;
}

export class LarkTransportCardContext {
  private readonly sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
  private readonly rawClient?: Lark.Client;
  private readonly outboundMessageContextCache?: LarkOutboundMessageContextCache;
  private readonly cardContextCache = new Map<string, { context: LarkFetchedMessageContext; expiresAt: number }>();

  constructor(opts: {
    sdkChannel?: Pick<SdkLarkTransportChannel, 'fetchMessage'>;
    rawClient?: Lark.Client;
    outboundMessageContextCache?: LarkOutboundMessageContextCache;
  }) {
    this.sdkChannel = opts.sdkChannel;
    this.rawClient = opts.rawClient;
    this.outboundMessageContextCache = opts.outboundMessageContextCache;
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

    const sdkContext = await this.fetchMessageContextViaSdk(messageId);
    if (sdkContext) attempts.push(sdkContext);
    if (sdkContext?.text && !isPlaceholderCardText(sdkContext.text, sdkContext.msgType)) {
      this.setCachedMessageContext(messageId, sdkContext);
      return sdkContext;
    }

    const rawGetContext = await this.fetchMessageContextViaRawGet(messageId);
    if (rawGetContext) attempts.push(rawGetContext);
    if (rawGetContext?.text && !isPlaceholderCardText(rawGetContext.text, rawGetContext.msgType)) {
      this.setCachedMessageContext(messageId, rawGetContext);
      return rawGetContext;
    }

    const fallback = await this.fetchCardContextViaMget(messageId);
    if (fallback) attempts.push(fallback);
    if (fallback?.text && !isPlaceholderCardText(fallback.text, fallback.msgType)) {
      const merged = mergeContexts(messageId, sdkContext ?? rawGetContext, fallback);
      this.setCachedMessageContext(messageId, merged);
      return merged;
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
      if (!item) return createUnresolvedContext(messageId, 'unknown', 'raw_mget', 'empty_response', {
        fetchIdentity: 'bot',
        fetchResult: 'empty',
      });
      return messageItemContext(messageId, item, 'raw_mget', { fetchIdentity: 'bot' });
    } catch (error) {
      return createUnresolvedContext(messageId, 'unknown', 'raw_mget', safeFetchDiagnostic(error), {
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
      parentId: quotedContext.parentId,
      rootMessageId: quotedContext.rootMessageId,
      threadId: quotedContext.threadId,
      fetchStage: 'outbound_cache',
      fetchIdentity: 'cache',
      fetchResult: 'success',
    });
  }
}

function messageMgetUrl(messageId: string): string {
  const query = new URLSearchParams();
  query.set('card_msg_content_type', 'raw_card_content');
  query.append('message_ids', messageId);
  return `/open-apis/im/v1/messages/mget?${query.toString()}`;
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

function messageItemContext(
  messageId: string,
  item: any,
  fetchStage: LarkMessageFetchStage,
  details: Pick<LarkFetchedMessageContext, 'fetchIdentity'> = {},
): LarkFetchedMessageContext | null {
  if (!item) return null;
  const text = messageItemText(item);
  const msgType = text?.messageType ?? item.msg_type ?? item.message_type ?? 'text';
  return markUnresolvedIfNeeded(normalizeContext({
    messageId: item.message_id ?? item.messageId ?? messageId,
    text: text?.text ?? null,
    msgType,
    parentId: item.parent_id ?? item.parentId,
    rootMessageId: item.root_id ?? item.rootMessageId,
    threadId: item.thread_id ?? item.threadId,
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
  if (context.text && !isPlaceholderCardText(context.text, context.msgType)) return context;
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
  const failedAttempt = [...attempts].reverse().find((attempt) => attempt.fetchStage) ?? metadata;
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
