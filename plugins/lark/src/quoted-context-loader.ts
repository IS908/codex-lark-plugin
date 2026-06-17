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
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
  fetchStage?: string;
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
      replyTo: nextMessageId && !visited.has(nextMessageId) ? nextMessageId : undefined,
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
  replyTo?: string;
}): string {
  const lines = [
    `message_id: ${input.messageId}`,
    `msg_type: ${input.msgType || 'unknown'}`,
    `hydration_status: success`,
    `content:`,
    input.text,
  ];
  if (input.replyTo) lines.push(`reply_to: ${input.replyTo}`);
  return lines.join('\n');
}

function formatFailureBlock(input: {
  messageId: string;
  msgType: string | undefined;
  reason: 'fetch_failed' | 'token_budget_exceeded';
  fetchStage?: string;
  diagnostic?: string;
}): string {
  const lines = [
    `message_id: ${input.messageId}`,
    `msg_type: ${input.msgType || 'unknown'}`,
    `hydration_status: failed`,
    `reason: ${input.reason}`,
  ];
  const fetchStage = normalizeMetadataValue(input.fetchStage);
  const diagnostic = normalizeMetadataValue(input.diagnostic);
  if (fetchStage) lines.push(`fetch_stage: ${fetchStage}`);
  if (diagnostic) lines.push(`diagnostic: ${diagnostic}`);
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
