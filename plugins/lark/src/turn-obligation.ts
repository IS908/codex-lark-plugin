import { appConfig } from './config.js';
import { audit } from './audit-log.js';

export type TurnObligationMode = 'exec' | 'notification';
export type TurnObligationStatus = 'pending' | 'satisfied' | 'deferred' | 'unanswered';
export type TurnSatisfactionSource =
  | 'reply'
  | 'react'
  | 'edit_message'
  | 'recall_message'
  | 'download_attachment'
  | 'defer_tool'
  | 'delivery_skip'
  | 'exec_assistant_text';

export interface TurnObligation {
  messageId: string;
  chatId: string;
  threadId?: string;
  caller: string;
  mode: TurnObligationMode;
  status: TurnObligationStatus;
  createdAt: number;
  updatedAt: number;
  source?: TurnSatisfactionSource | 'watchdog';
  marker?: 'LARK_DEFER' | 'LARK_NO_REPLY';
  reason?: string;
  timer?: NodeJS.Timeout;
}

export interface TurnObligationTrackerOptions {
  timeoutMs?: number;
  maxEntries?: number;
}

export interface DeferSentinel {
  marker: 'LARK_DEFER' | 'LARK_NO_REPLY';
  reason?: string;
  line: number;
}

export type TurnFallbackResolution =
  | { status: 'active' | 'single-pending'; messageId: string }
  | { status: 'ambiguous'; count: number }
  | { status: 'none' };

const DEFER_LINE_RE = /^\[(LARK_DEFER|LARK_NO_REPLY)\](?:\s+(.+))?$/;

export function findLarkDeferSentinel(text: string): DeferSentinel | null {
  let inFence = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = trimmed.match(DEFER_LINE_RE);
    if (!match) continue;
    return {
      marker: match[1] as 'LARK_DEFER' | 'LARK_NO_REPLY',
      reason: match[2]?.trim() || undefined,
      line: i + 1,
    };
  }
  return null;
}

export class TurnObligationTracker {
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private records = new Map<string, TurnObligation>();
  private activeByScope = new Map<string, string>();

  constructor(opts: TurnObligationTrackerOptions = {}) {
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? appConfig.replyObligationTimeoutMs);
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? appConfig.latestMessageTrackerSize));
  }

  begin(input: {
    messageId: string;
    chatId: string;
    threadId?: string;
    caller: string;
    mode: TurnObligationMode;
  }): void {
    if (!input.messageId || !input.chatId) return;
    const now = Date.now();
    const existing = this.records.get(input.messageId);
    if (existing?.timer) clearTimeout(existing.timer);

    const record: TurnObligation = {
      messageId: input.messageId,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      caller: input.caller,
      mode: input.mode,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    record.timer = setTimeout(() => {
      this.markUnanswered(input.messageId, 'watchdog', 'reply obligation timed out');
    }, this.timeoutMs);
    record.timer.unref?.();

    this.records.set(input.messageId, record);
    this.trimCompleted();
  }

  markSatisfied(messageId: string | undefined, source: TurnSatisfactionSource): boolean {
    if (!messageId) return false;
    const record = this.records.get(messageId);
    if (!record) return false;
    if (record.status !== 'pending') return record.status === 'satisfied';
    this.finish(record, 'satisfied', source);
    return true;
  }

  markDeferred(
    messageId: string | undefined,
    source: TurnSatisfactionSource,
    marker: 'LARK_DEFER' | 'LARK_NO_REPLY',
    reason?: string,
  ): boolean {
    if (!messageId) return false;
    const record = this.records.get(messageId);
    if (!record) return false;
    if (record.status !== 'pending') return record.status === 'deferred';
    this.finish(record, 'deferred', source, marker, reason);
    void audit('reply_obligation', record.caller, this.auditArgs(record), 'ok');
    return true;
  }

  markDeferredFromText(
    messageId: string | undefined,
    source: TurnSatisfactionSource,
    text: string,
  ): DeferSentinel | null {
    const sentinel = findLarkDeferSentinel(text);
    if (!sentinel) return null;
    this.markDeferred(messageId, source, sentinel.marker, sentinel.reason);
    return sentinel;
  }

  requireSatisfiedOrDeferred(messageId: string): void {
    const status = this.getStatus(messageId);
    if (status === 'pending') {
      throw new Error(
        `Lark turn ${messageId} ended without reply, reaction, edit, download, or explicit defer/no-reply marker.`,
      );
    }
  }

  getStatus(messageId: string): TurnObligationStatus | null {
    return this.records.get(messageId)?.status ?? null;
  }

  get(messageId: string): Omit<TurnObligation, 'timer'> | null {
    const record = this.records.get(messageId);
    if (!record) return null;
    const { timer: _timer, ...safe } = record;
    return { ...safe };
  }

  setActive(chatId: string, threadId: string | undefined, messageId: string): void {
    if (!chatId || !messageId) return;
    this.activeByScope.set(this.scopeKey(chatId, threadId), messageId);
  }

  clearActive(chatId: string, threadId: string | undefined, messageId: string): void {
    const key = this.scopeKey(chatId, threadId);
    if (this.activeByScope.get(key) === messageId) {
      this.activeByScope.delete(key);
    }
  }

  getActive(chatId: string | undefined, threadId?: string): string | undefined {
    if (!chatId) return undefined;
    return this.activeByScope.get(this.scopeKey(chatId, threadId));
  }

  resolveFallback(chatId: string | undefined, threadId?: string): TurnFallbackResolution {
    if (!chatId) return { status: 'none' };
    const active = this.getActive(chatId, threadId);
    if (active) return { status: 'active', messageId: active };

    const key = this.scopeKey(chatId, threadId);
    const pending = Array.from(this.records.values()).filter(
      (record) => record.status === 'pending' && this.scopeKey(record.chatId, record.threadId) === key,
    );
    if (pending.length === 1) {
      return { status: 'single-pending', messageId: pending[0].messageId };
    }
    if (pending.length > 1) {
      return { status: 'ambiguous', count: pending.length };
    }
    return { status: 'none' };
  }

  pendingCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === 'pending') count++;
    }
    return count;
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    this.records.clear();
    this.activeByScope.clear();
  }

  private scopeKey(chatId: string, threadId?: string): string {
    return `${chatId}::${threadId || '_'}`;
  }

  private finish(
    record: TurnObligation,
    status: TurnObligationStatus,
    source: TurnObligation['source'],
    marker?: 'LARK_DEFER' | 'LARK_NO_REPLY',
    reason?: string,
  ): void {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    record.status = status;
    record.source = source;
    record.marker = marker;
    record.reason = reason;
    record.updatedAt = Date.now();
  }

  private markUnanswered(
    messageId: string,
    source: 'watchdog',
    reason: string,
  ): void {
    const record = this.records.get(messageId);
    if (!record || record.status !== 'pending') return;
    this.finish(record, 'unanswered', source, undefined, reason);
    console.error(
      `[reply-obligation] Lark turn ${messageId} in chat ${record.chatId} timed out without reply/defer`,
    );
    void audit('reply_obligation', record.caller, this.auditArgs(record), 'error');
  }

  private auditArgs(record: TurnObligation): Record<string, unknown> {
    return {
      message_id: record.messageId,
      chat_id: record.chatId,
      thread_id: record.threadId,
      mode: record.mode,
      status: record.status,
      source: record.source,
      marker: record.marker,
      reason: record.reason,
    };
  }

  private trimCompleted(): void {
    while (this.records.size > this.maxEntries) {
      const oldestKey = this.records.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const oldest = this.records.get(oldestKey);
      if (oldest?.status === 'pending') return;
      if (oldest?.timer) clearTimeout(oldest.timer);
      this.records.delete(oldestKey);
    }
  }
}
