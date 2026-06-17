export type LarkMessageFetchStage = 'outbound_cache' | 'sdk_fetch' | 'raw_get' | 'raw_mget' | 'user_mget';
export type LarkMessageFetchIdentity = 'cache' | 'bot' | 'user' | 'unknown';
export type LarkMessageFetchResult =
  | 'success'
  | 'empty'
  | '404'
  | 'error'
  | 'timeout'
  | 'unavailable'
  | 'placeholder'
  | 'missing_content';
export type LarkMessageHydrationReason = 'fetch_failed';
export type LarkMessageEnvelopeFailureReason = LarkMessageHydrationReason | 'token_budget_exceeded';

export interface LarkMessageSenderContext {
  id?: string;
  idType?: string;
  senderType?: string;
}

export interface LarkInteractiveCardContext {
  title?: string;
  text: string;
  rawContentShape: 'card_text' | 'feishu_card_json' | 'unknown';
}

export interface LarkMessageContext {
  messageId: string;
  text: string | null;
  msgType: string;
  chatId?: string;
  parentId?: string;
  replyTo?: string;
  rootMessageId?: string;
  threadId?: string;
  timestampMs?: number;
  timestamp?: string;
  createTime?: string;
  updateTime?: string;
  messagePosition?: string;
  sender?: LarkMessageSenderContext;
  interactiveCard?: LarkInteractiveCardContext;
  fetchStage?: LarkMessageFetchStage;
  fetchIdentity?: LarkMessageFetchIdentity;
  fetchResult?: LarkMessageFetchResult;
  diagnostic?: string;
  hydrationErrorReason?: LarkMessageHydrationReason;
}

export type LarkCachedMessageContext =
  & Partial<Omit<LarkMessageContext, 'messageId' | 'text' | 'msgType'>>
  & {
    messageId?: string;
    text: string;
    msgType?: string;
  };

export interface FormatLarkMessageContextOptions {
  hydrationStatus?: 'success' | 'failed';
  failureReason?: LarkMessageEnvelopeFailureReason;
  includeRecoveryHint?: boolean;
  current?: boolean;
}

export function normalizeLarkMessageType(value: string | undefined): string {
  return value === 'interactive' ? 'interactive_card' : (value || 'unknown');
}

export function larkMessageSource(fetchStage: string | undefined): string {
  switch (fetchStage) {
    case 'user_mget':
      return 'lark_cli';
    case 'sdk_fetch':
    case 'raw_get':
    case 'raw_mget':
      return 'feishu_api';
    case 'outbound_cache':
      return 'event';
    default:
      return 'unknown';
  }
}

export function larkMessageRole(
  sender: LarkMessageSenderContext | undefined,
  fetchIdentity: string | undefined,
): 'user' | 'assistant' | 'unknown' {
  const senderType = sender?.senderType?.toLowerCase();
  if (senderType === 'app' || senderType === 'bot') return 'assistant';
  if (senderType === 'user') return 'user';
  if (fetchIdentity === 'bot') return 'assistant';
  return 'unknown';
}

export function formatLarkMessageContextBlock(
  context: LarkMessageContext,
  options: FormatLarkMessageContextOptions = {},
): string {
  const hydrationStatus = options.hydrationStatus ?? (context.text === null || context.text === undefined ? 'failed' : 'success');
  return hydrationStatus === 'success'
    ? formatSuccessBlock(context, options)
    : formatFailureBlock(context, options);
}

function formatSuccessBlock(
  context: LarkMessageContext,
  options: FormatLarkMessageContextOptions,
): string {
  const normalizedMsgType = normalizeLarkMessageType(context.msgType);
  const interactiveCard = context.interactiveCard ?? fallbackInteractiveCard(context.text ?? '', normalizedMsgType);
  const lines = [
    `kind: lark_message`,
    ...(options.current ? ['current: true'] : []),
    `role: ${larkMessageRole(context.sender, context.fetchIdentity)}`,
    `source: ${larkMessageSource(context.fetchStage)}`,
    ...(context.fetchIdentity ? [`identity: ${context.fetchIdentity}`] : []),
    `message_id: ${context.messageId}`,
    ...(context.chatId ? [`chat_id: ${context.chatId}`] : []),
    ...(context.threadId ? [`thread_id: ${context.threadId}`] : []),
    ...(context.replyTo ? [`reply_to: ${context.replyTo}`] : []),
    `msg_type: ${normalizedMsgType}`,
    ...(context.timestampMs !== undefined ? [`timestamp_ms: ${context.timestampMs}`] : []),
    ...(context.timestamp ? [`timestamp: ${context.timestamp}`] : []),
    ...(context.createTime ? [`create_time: ${context.createTime}`] : []),
    ...(context.updateTime ? [`update_time: ${context.updateTime}`] : []),
    ...(context.messagePosition ? [`message_position: ${context.messagePosition}`] : []),
    ...(context.sender?.senderType ? [`sender_type: ${context.sender.senderType}`] : []),
    ...(context.sender?.idType ? [`sender_id_type: ${context.sender.idType}`] : []),
    `hydration_status: success`,
    ...(interactiveCard ? [
      `interactive_card:`,
      ...(interactiveCard.title ? [`title: ${interactiveCard.title}`] : []),
      `raw_content_shape: ${interactiveCard.rawContentShape}`,
    ] : []),
    `content:`,
    context.text ?? '',
  ];
  return lines.join('\n');
}

function formatFailureBlock(
  context: LarkMessageContext,
  options: FormatLarkMessageContextOptions,
): string {
  const normalizedMsgType = normalizeLarkMessageType(context.msgType);
  const reason = options.failureReason ?? context.hydrationErrorReason ?? 'fetch_failed';
  const lines = [
    `kind: lark_message`,
    `role: ${larkMessageRole(context.sender, context.fetchIdentity)}`,
    `source: ${larkMessageSource(context.fetchStage)}`,
    ...(context.fetchIdentity ? [`identity: ${context.fetchIdentity}`] : []),
    `message_id: ${context.messageId}`,
    `msg_type: ${normalizedMsgType}`,
    `hydration_status: failed`,
    `reason: ${reason}`,
  ];
  const fetchStage = normalizeMetadataValue(context.fetchStage);
  const fetchIdentity = normalizeMetadataValue(context.fetchIdentity);
  const fetchResult = normalizeMetadataValue(context.fetchResult);
  const diagnostic = normalizeMetadataValue(context.diagnostic);
  if (fetchStage) lines.push(`fetch_stage: ${fetchStage}`);
  if (fetchIdentity) lines.push(`fetch_identity: ${fetchIdentity}`);
  if (fetchResult) lines.push(`fetch_result: ${fetchResult}`);
  if (diagnostic) lines.push(`diagnostic: ${diagnostic}`);
  if (options.includeRecoveryHint && shouldAddQuotedCardRecoveryHint(context.msgType, reason)) {
    lines.push(
      `codex_recovery_hint: quoted interactive card context is unavailable through ${fetchIdentity || 'current'} identity; ` +
      `if the answer depends on it, fetch message_id=${context.messageId} with Lark user-context tooling and parse the card content before answering.`
    );
  }
  return lines.join('\n');
}

function normalizeMetadataValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function fallbackInteractiveCard(
  text: string,
  msgType: string,
): LarkInteractiveCardContext | undefined {
  if (msgType !== 'interactive_card') return undefined;
  const title = text.split('\n').map((line) => line.trim()).find(Boolean);
  return {
    ...(title ? { title } : {}),
    text,
    rawContentShape: 'unknown',
  };
}

function shouldAddQuotedCardRecoveryHint(
  msgType: string | undefined,
  reason: LarkMessageEnvelopeFailureReason,
): boolean {
  const normalized = normalizeLarkMessageType(msgType);
  return reason === 'fetch_failed' && normalized === 'interactive_card';
}
