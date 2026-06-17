import { isPlaceholderCardText } from './message-content.js';
import {
  formatLarkMessageContextBlock,
  type LarkMessageContext,
} from './lark-message-context.js';

export interface QuotedContextMessage {
  messageId: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
  parentContent?: string;
}

export type FetchedQuotedMessage = LarkMessageContext;

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
      const reason = fetched?.hydrationErrorReason ?? 'fetch_failed';
      blocks.push(formatLarkMessageContextBlock({
        messageId: currentMessageId,
        text: null,
        msgType: fetched?.msgType ?? 'unknown',
        fetchStage: fetched?.fetchStage,
        fetchIdentity: fetched?.fetchIdentity,
        fetchResult: fetched?.fetchResult,
        diagnostic: fetched?.diagnostic,
        hydrationErrorReason: reason,
      }, {
        hydrationStatus: 'failed',
        failureReason: reason,
        includeRecoveryHint: true,
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
    const block = formatLarkMessageContextBlock({
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
      blocks.push(formatLarkMessageContextBlock({
        messageId: resolvedMessageId,
        text: null,
        msgType: fetched.msgType,
      }, {
        hydrationStatus: 'failed',
        failureReason: 'token_budget_exceeded',
        includeRecoveryHint: true,
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
