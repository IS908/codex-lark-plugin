import type { BufferedMessage } from './memory/buffer.js';
import {
  formatLarkMessageContextBlock,
  type LarkMessageContext,
} from './lark-message-context.js';

const DEFAULT_TURN_LIMIT = 2;
const DEFAULT_MESSAGE_LIMIT = 4;
const DEFAULT_MAX_BYTES = 8_000;
const DEFAULT_BODY_MAX_BYTES = 1_200;

export interface RecentThreadContextOptions {
  turnLimit?: number;
  messageLimit?: number;
  maxBytes?: number;
  bodyMaxBytes?: number;
}

export interface BuildRecentThreadContextArgs {
  chatId: string;
  threadId?: string;
  currentMessageId: string;
  messages: BufferedMessage[];
  quotedContent?: string;
  options?: RecentThreadContextOptions;
}

interface IndexedBufferedMessage {
  message: BufferedMessage;
  index: number;
}

export function buildRecentThreadContext(args: BuildRecentThreadContextArgs): string | undefined {
  const turnLimit = positiveInt(args.options?.turnLimit, DEFAULT_TURN_LIMIT);
  const messageLimit = positiveInt(args.options?.messageLimit, DEFAULT_MESSAGE_LIMIT);
  const maxBytes = positiveInt(args.options?.maxBytes, DEFAULT_MAX_BYTES);
  const bodyMaxBytes = positiveInt(args.options?.bodyMaxBytes, DEFAULT_BODY_MAX_BYTES);
  const sorted = args.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => sameThread(message.threadId, args.threadId))
    .sort(compareBufferedMessages);

  if (sorted.length === 0) return undefined;

  const selected = selectRecentMessages(sorted, args.currentMessageId, turnLimit, messageLimit);
  if (selected.length === 0) return undefined;

  const blocks = selected.map(({ message }) => formatRecentMessageBlock({
    chatId: args.chatId,
    threadId: args.threadId,
    message,
    current: message.messageId === args.currentMessageId,
    quotedContent: args.quotedContent,
    bodyMaxBytes,
  }));
  return fitBlocksToBudget(blocks, maxBytes);
}

function selectRecentMessages(
  sorted: IndexedBufferedMessage[],
  currentMessageId: string,
  turnLimit: number,
  messageLimit: number,
): IndexedBufferedMessage[] {
  const current = sorted.find(({ message }) => message.messageId === currentMessageId) ?? sorted.at(-1);
  if (!current) return [];

  const throughCurrent = sorted.filter((entry) => compareBufferedMessages(entry, current) <= 0);
  const userMessages = throughCurrent.filter(({ message }) => message.role === 'user');
  const firstUserInWindow = userMessages.slice(-turnLimit)[0];
  const fromIndex = firstUserInWindow ? throughCurrent.indexOf(firstUserInWindow) : Math.max(0, throughCurrent.length - messageLimit);
  const window = throughCurrent.slice(Math.max(0, fromIndex)).slice(-messageLimit);
  const withoutCurrent = window.filter((entry) => entry !== current);
  return [...withoutCurrent, current];
}

function formatRecentMessageBlock(args: {
  chatId: string;
  threadId?: string;
  message: BufferedMessage;
  current: boolean;
  quotedContent?: string;
  bodyMaxBytes: number;
}): string {
  const rawText = dedupeQuotedBody(args.message.text, args.quotedContent);
  const text = capUtf8PreservingHead(rawText, args.bodyMaxBytes);
  const context: LarkMessageContext = {
    messageId: args.message.messageId ?? syntheticRecentMessageId(args.message),
    text,
    msgType: args.message.messageType ?? 'text',
    chatId: args.chatId,
    ...(args.threadId ? { threadId: args.threadId } : {}),
    timestampMs: args.message.timestampMs ?? Date.parse(args.message.timestamp),
    timestamp: args.message.timestamp,
    messagePosition: args.message.messagePosition,
    sender: {
      id: args.message.senderId,
      idType: args.message.senderId === 'bot' ? 'app_id' : 'open_id',
      senderType: args.message.role === 'assistant' ? 'app' : 'user',
    },
    fetchStage: 'outbound_cache',
    fetchIdentity: args.message.role === 'assistant' ? 'cache' : 'user',
    fetchResult: 'success',
  };
  return formatLarkMessageContextBlock(context, { current: args.current });
}

function fitBlocksToBudget(blocks: string[], maxBytes: number): string | undefined {
  let remaining = [...blocks];
  while (remaining.length > 0 && Buffer.byteLength(joinBlocks(remaining), 'utf8') > maxBytes) {
    if (remaining.length === 1) {
      return capUtf8PreservingHead(remaining[0], maxBytes);
    }
    remaining = remaining.slice(1);
  }
  return remaining.length > 0 ? joinBlocks(remaining) : undefined;
}

function sameThread(messageThreadId: string | undefined, targetThreadId: string | undefined): boolean {
  return (messageThreadId || '') === (targetThreadId || '');
}

function compareBufferedMessages(a: IndexedBufferedMessage, b: IndexedBufferedMessage): number {
  const aTime = timestampSortValue(a.message);
  const bTime = timestampSortValue(b.message);
  if (aTime !== bTime) return aTime - bTime;
  const aPosition = numericSortValue(a.message.messagePosition);
  const bPosition = numericSortValue(b.message.messagePosition);
  if (aPosition !== bPosition) return aPosition - bPosition;
  return a.index - b.index;
}

function timestampSortValue(message: BufferedMessage): number {
  if (Number.isFinite(message.timestampMs)) return message.timestampMs!;
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function numericSortValue(value: string | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function dedupeQuotedBody(text: string, quotedContent: string | undefined): string {
  const normalized = text.trim();
  if (!normalized || !quotedContent) return text;
  if (!quotedContent.includes(normalized)) return text;
  return '[body duplicated in Quoted Message section]';
}

function capUtf8PreservingHead(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}

function syntheticRecentMessageId(message: BufferedMessage): string {
  const suffix = Buffer.from(`${message.senderId}:${message.timestamp}`).toString('base64url').slice(0, 16);
  return `recent_${suffix}`;
}

function joinBlocks(blocks: string[]): string {
  return blocks.join('\n---\n');
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}
