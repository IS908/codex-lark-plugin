import { isPlaceholderCardText } from './message-content.js';

export interface QuotedContextMessage {
  messageId: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
  parentContent?: string;
}

export interface FetchedQuotedMessage {
  messageId?: string;
  text?: string | null;
  msgType?: string;
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
  sender?: {
    id?: string;
    idType?: string;
    senderType?: string;
  };
  interactiveCard?: {
    title?: string;
    text: string;
    rawContentShape: 'card_text' | 'feishu_card_json' | 'unknown';
  };
  fetchStage?: string;
  fetchIdentity?: string;
  fetchResult?: string;
  diagnostic?: string;
  hydrationErrorReason?: 'fetch_failed';
}

export interface QuotedContextTransport {
  fetchMessageText(messageId: string): Promise<string | null>;
  fetchMessageContext?(messageId: string): Promise<FetchedQuotedMessage | null>;
}

export interface AddQuotedContextResult {
  quotedMessageId?: string;
  loaded: boolean;
}

export interface QuotedContextOptions {
  maxDepth?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = 12_000;

export function isOpenMessageId(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('om_');
}

export function selectQuotedMessageId(message: QuotedContextMessage): string | undefined {
  return (
    message.parentId ||
    (isOpenMessageId(message.rootMessageId) && message.rootMessageId !== message.messageId
      ? message.rootMessageId
      : undefined) ||
    (isOpenMessageId(message.threadId) && message.threadId !== message.messageId ? message.threadId : undefined)
  );
}

export async function addQuotedContext(
  message: QuotedContextMessage,
  transport: QuotedContextTransport,
  options: QuotedContextOptions = {},
): Promise<AddQuotedContextResult> {
  const quotedMessageId = selectQuotedMessageId(message);
  if (!quotedMessageId) return { loaded: false };

  const maxDepth = normalizePositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const visited = new Set<string>([message.messageId]);
  const blocks: string[] = [];
  let loaded = false;
  let currentMessageId: string | undefined = quotedMessageId;

  for (let depth = 0; currentMessageId && depth < maxDepth; depth += 1) {
    if (visited.has(currentMessageId)) break;
    visited.add(currentMessageId);

    const fetched = await fetchQuotedMessage(transport, currentMessageId);
    if (!fetched?.text || isPlaceholderCardText(fetched.text, fetched.msgType)) {
      blocks.push(formatFailureBlock({
        messageId: currentMessageId,
        msgType: fetched?.msgType,
        reason: fetched?.hydrationErrorReason ?? 'fetch_failed',
        fetchStage: fetched?.fetchStage,
        fetchIdentity: fetched?.fetchIdentity,
        fetchResult: fetched?.fetchResult,
        diagnostic: fetched?.diagnostic,
      }));
      break;
    }

    const resolvedMessageId = fetched.messageId || currentMessageId;
    const nextMessageId = selectQuotedMessageId({
      messageId: resolvedMessageId,
      parentId: fetched.parentId,
      rootMessageId: fetched.rootMessageId,
      threadId: fetched.threadId,
    });
    const block = formatSuccessBlock({
      messageId: resolvedMessageId,
      msgType: fetched.msgType,
      text: fetched.text,
      chatId: fetched.chatId,
      threadId: fetched.threadId,
      timestampMs: fetched.timestampMs,
      timestamp: fetched.timestamp,
      createTime: fetched.createTime,
      updateTime: fetched.updateTime,
      messagePosition: fetched.messagePosition,
      sender: fetched.sender,
      fetchStage: fetched.fetchStage,
      fetchIdentity: fetched.fetchIdentity,
      interactiveCard: fetched.interactiveCard,
      replyTo: nextMessageId && !visited.has(nextMessageId) ? nextMessageId : fetched.replyTo,
    });

    if (utf8Bytes(joinBlocks([...blocks, block])) > maxBytes) {
      blocks.push(formatFailureBlock({
        messageId: resolvedMessageId,
        msgType: fetched.msgType,
        reason: 'token_budget_exceeded',
      }));
      break;
    }

    blocks.push(block);
    loaded = true;
    currentMessageId = nextMessageId;
  }

  if (blocks.length > 0) {
    message.parentContent = joinBlocks(blocks);
  }

  return { quotedMessageId, loaded };
}

async function fetchQuotedMessage(
  transport: QuotedContextTransport,
  messageId: string,
): Promise<FetchedQuotedMessage | null> {
  try {
    if (transport.fetchMessageContext) {
      const fetched = await transport.fetchMessageContext(messageId);
      if (fetched) return fetched;
    }

    const text = await transport.fetchMessageText(messageId);
    return text ? { messageId, text, msgType: 'unknown' } : null;
  } catch {
    return null;
  }
}

function formatSuccessBlock(input: {
  messageId: string;
  msgType?: string;
  text: string;
  chatId?: string;
  threadId?: string;
  replyTo?: string;
  timestampMs?: number;
  timestamp?: string;
  createTime?: string;
  updateTime?: string;
  messagePosition?: string;
  sender?: FetchedQuotedMessage['sender'];
  fetchStage?: string;
  fetchIdentity?: string;
  interactiveCard?: FetchedQuotedMessage['interactiveCard'];
}): string {
  const normalizedMsgType = normalizeMsgType(input.msgType);
  const interactiveCard = input.interactiveCard ?? fallbackInteractiveCard(input.text, normalizedMsgType);
  const lines = [
    `kind: lark_message`,
    `role: ${messageRole(input.sender, input.fetchIdentity)}`,
    `source: ${messageSource(input.fetchStage)}`,
    ...(input.fetchIdentity ? [`identity: ${input.fetchIdentity}`] : []),
    `message_id: ${input.messageId}`,
    ...(input.chatId ? [`chat_id: ${input.chatId}`] : []),
    ...(input.threadId ? [`thread_id: ${input.threadId}`] : []),
    ...(input.replyTo ? [`reply_to: ${input.replyTo}`] : []),
    `msg_type: ${normalizedMsgType}`,
    ...(input.timestampMs !== undefined ? [`timestamp_ms: ${input.timestampMs}`] : []),
    ...(input.timestamp ? [`timestamp: ${input.timestamp}`] : []),
    ...(input.createTime ? [`create_time: ${input.createTime}`] : []),
    ...(input.updateTime ? [`update_time: ${input.updateTime}`] : []),
    ...(input.messagePosition ? [`message_position: ${input.messagePosition}`] : []),
    ...(input.sender?.senderType ? [`sender_type: ${input.sender.senderType}`] : []),
    ...(input.sender?.idType ? [`sender_id_type: ${input.sender.idType}`] : []),
    `hydration_status: success`,
    ...(interactiveCard ? [
      `interactive_card:`,
      ...(interactiveCard.title ? [`title: ${interactiveCard.title}`] : []),
      `raw_content_shape: ${interactiveCard.rawContentShape}`,
    ] : []),
    `content:`,
    input.text,
  ];
  return lines.join('\n');
}

function formatFailureBlock(input: {
  messageId: string;
  msgType: string | undefined;
  reason: 'fetch_failed' | 'token_budget_exceeded';
  fetchStage?: string;
  fetchIdentity?: string;
  fetchResult?: string;
  diagnostic?: string;
}): string {
  const normalizedMsgType = normalizeMsgType(input.msgType);
  const lines = [
    `kind: lark_message`,
    `role: ${input.fetchIdentity === 'bot' ? 'assistant' : 'unknown'}`,
    `source: ${messageSource(input.fetchStage)}`,
    ...(input.fetchIdentity ? [`identity: ${input.fetchIdentity}`] : []),
    `message_id: ${input.messageId}`,
    `msg_type: ${normalizedMsgType}`,
    `hydration_status: failed`,
    `reason: ${input.reason}`,
  ];
  const fetchStage = normalizeMetadataValue(input.fetchStage);
  const fetchIdentity = normalizeMetadataValue(input.fetchIdentity);
  const fetchResult = normalizeMetadataValue(input.fetchResult);
  const diagnostic = normalizeMetadataValue(input.diagnostic);
  if (fetchStage) lines.push(`fetch_stage: ${fetchStage}`);
  if (fetchIdentity) lines.push(`fetch_identity: ${fetchIdentity}`);
  if (fetchResult) lines.push(`fetch_result: ${fetchResult}`);
  if (diagnostic) lines.push(`diagnostic: ${diagnostic}`);
  if (shouldAddQuotedCardRecoveryHint(input.msgType, input.reason)) {
    lines.push(
      `codex_recovery_hint: quoted interactive card context is unavailable through ${fetchIdentity || 'current'} identity; ` +
      `if the answer depends on it, fetch message_id=${input.messageId} with Lark user-context tooling and parse the card content before answering.`
    );
  }
  return lines.join('\n');
}

function joinBlocks(blocks: string[]): string {
  return blocks.join('\n---\n');
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeMetadataValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function normalizeMsgType(value: string | undefined): string {
  return value === 'interactive' ? 'interactive_card' : (value || 'unknown');
}

function messageSource(fetchStage: string | undefined): string {
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

function messageRole(
  sender: FetchedQuotedMessage['sender'],
  fetchIdentity: string | undefined,
): 'user' | 'assistant' | 'unknown' {
  const senderType = sender?.senderType?.toLowerCase();
  if (senderType === 'app' || senderType === 'bot') return 'assistant';
  if (senderType === 'user') return 'user';
  if (fetchIdentity === 'bot') return 'assistant';
  return 'unknown';
}

function fallbackInteractiveCard(
  text: string,
  msgType: string,
): FetchedQuotedMessage['interactiveCard'] | undefined {
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
  reason: 'fetch_failed' | 'token_budget_exceeded',
): boolean {
  const normalized = normalizeMsgType(msgType);
  return reason === 'fetch_failed' && normalized === 'interactive_card';
}
