import type { LarkCachedMessageContext } from './lark-message-context.js';

export class BotMessageTracker {
  private ids: string[] = [];
  private map = new Map<string, TrackedBotMessage>();
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }

  add(messageId: string, meta: Omit<TrackedBotMessage, 'messageId' | 'timestamp'> = {}): void {
    if (this.maxSize <= 0 || !messageId) return;
    if (this.map.has(messageId)) return;
    this.map.set(messageId, {
      messageId,
      chatId: meta.chatId,
      threadId: meta.threadId,
      quotedContext: meta.quotedContext,
      timestamp: Date.now(),
    });
    this.ids.push(messageId);
    while (this.ids.length > this.maxSize) {
      const oldest = this.ids.shift()!;
      this.map.delete(oldest);
    }
  }

  has(messageId: string): boolean {
    return this.map.has(messageId);
  }

  get(messageId: string): TrackedBotMessage | undefined {
    return this.map.get(messageId);
  }
}

export interface TrackedBotMessage {
  messageId: string;
  chatId?: string;
  threadId?: string;
  quotedContext?: TrackedBotMessageQuotedContext;
  timestamp: number;
}

export type TrackedBotMessageQuotedContext = LarkCachedMessageContext;

/**
 * Records the latest inbound user message per (chatId, threadId) pair.
 * Used by the reply tool to auto-correct reply_to when Codex omits it in
 * concurrent thread scenarios.
 */
export interface TrackedMessage {
  messageId: string;
  threadId?: string;
  timestamp: number;
}

export class LatestMessageTracker {
  private map = new Map<string, TrackedMessage>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = 10 * 60 * 1000, maxSize = 1000) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 10 * 60 * 1000;
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }

  private key(chatId: string, threadId?: string): string {
    // Use || instead of ?? so empty strings also fall back to '_'
    return `${chatId}::${threadId || '_'}`;
  }

  record(chatId: string, msg: TrackedMessage): void {
    const key = this.key(chatId, msg.threadId);
    this.map.delete(key);
    this.map.set(key, msg);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  getLatest(chatId: string, threadId?: string): TrackedMessage | undefined {
    const key = this.key(chatId, threadId);
    const m = this.map.get(key);
    if (!m) return undefined;
    if (Date.now() - m.timestamp > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, m);
    return m;
  }
}
