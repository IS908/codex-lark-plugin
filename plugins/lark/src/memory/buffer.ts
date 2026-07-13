import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';
import { logSafeError } from '../safe-log.js';

export interface BufferedMessage {
  role: 'user' | 'assistant';
  senderId: string;
  text: string;
  timestamp: string;
  messageId?: string;
  threadId?: string;
  messageType?: string;
  timestampMs?: number;
  messagePosition?: string;
}

export type ConversationFlushReason = 'auto' | 'manual' | 'new_session';

export interface ConversationFlushRequest {
  chatId: string;
  threadId?: string;
  messages: BufferedMessage[];
  reason: ConversationFlushReason;
}

export interface ConversationFlushHandlerResult {
  summary?: string;
}

export interface ConversationFlushResult {
  status: 'flushed' | 'empty' | 'busy';
  messageCount: number;
  summary?: string;
}

type FlushHandler = (request: ConversationFlushRequest) => Promise<ConversationFlushHandlerResult | void>;

/**
 * Per-chat conversation buffer (Layer 1 — short-term/working memory).
 * Tracks raw messages and manages auto-flush timers.
 */
export class ConversationBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private flushing = new Set<string>(); // guard against re-entry during flush
  private flushHandler: FlushHandler | null = null;

  setFlushHandler(handler: FlushHandler): void {
    this.flushHandler = handler;
  }

  record(chatId: string, message: BufferedMessage): void {
    // Don't record or reset timer during an active flush (prevents re-entry loops)
    if (this.flushing.has(chatId)) return;

    if (!this.buffers.has(chatId)) {
      this.buffers.set(chatId, []);
    }
    this.buffers.get(chatId)!.push(message);
    this.resetTimer(chatId);
  }

  getMessages(chatId: string): BufferedMessage[] {
    return this.buffers.get(chatId) ?? [];
  }

  clear(chatId: string): void {
    this.buffers.delete(chatId);
    this.clearTimer(chatId);
  }

  async flushNow(
    chatId: string,
    options: {
      threadId?: string;
      reason?: ConversationFlushReason;
      commitBeforeRemove?: (result: ConversationFlushHandlerResult | void) => Promise<void>;
    } = {},
  ): Promise<ConversationFlushResult> {
    const messages = this.selectMessages(chatId, options.threadId);
    if (messages.length === 0) return { status: 'empty', messageCount: 0 };
    if (this.flushing.has(chatId)) return { status: 'busy', messageCount: messages.length };

    console.error(
      `[buffer] ${options.reason ?? 'manual'} flush triggered for chat ${chatId}`
      + `${options.threadId ? ` thread=${options.threadId}` : ''} (${messages.length} messages)`,
    );

    this.clearTimer(chatId);
    this.flushing.add(chatId);
    try {
      if (!this.flushHandler) {
        throw new Error('Conversation flush handler is not configured.');
      }
      const result = await this.flushHandler({
        chatId,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        messages: [...messages],
        reason: options.reason ?? 'manual',
      });
      await options.commitBeforeRemove?.(result);
      this.removeMessages(chatId, messages);
      return {
        status: 'flushed',
        messageCount: messages.length,
        ...(result?.summary ? { summary: result.summary } : {}),
      };
    } catch (err) {
      this.resetTimer(chatId);
      throw err;
    } finally {
      this.flushing.delete(chatId);
    }
  }

  /**
   * Re-arm flush timers on startup by scanning persisted episode directories.
   * If a chat's most recent episode is older than LARK_INACTIVITY_HOURS, trigger flush.
   */
  async rearmFromDisk(): Promise<void> {
    const episodesDir = path.join(appConfig.memoriesDir, 'episodes');
    try {
      const chatDirs = await fs.readdir(episodesDir);
      const thresholdMs = appConfig.inactivityHours * 60 * 60 * 1000;
      const now = Date.now();

      for (const chatId of chatDirs) {
        const chatDir = path.join(episodesDir, chatId);
        const stat = await fs.stat(chatDir);
        if (!stat.isDirectory()) continue;

        // Check the most recent episode file
        const files = await fs.readdir(chatDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        if (mdFiles.length === 0) continue;

        // Find latest mtime
        let latestMs = 0;
        for (const f of mdFiles) {
          const fStat = await fs.stat(path.join(chatDir, f));
          if (fStat.mtimeMs > latestMs) latestMs = fStat.mtimeMs;
        }

        // If last episode is older than threshold, the chat was active before restart
        // and may have unflushed context — arm a timer
        if (now - latestMs < thresholdMs * 2) {
          // Chat was recently active; set a timer in case new messages arrive
          this.resetTimer(chatId);
          console.error(`[buffer] Re-armed flush timer for chat ${chatId}`);
        }
      }
    } catch {
      // episodes dir may not exist yet — that's fine
    }
  }

  private resetTimer(chatId: string): void {
    this.clearTimer(chatId);

    const timeoutMs = appConfig.inactivityHours * 60 * 60 * 1000;
    const timer = setTimeout(async () => {
      await this.triggerFlush(chatId);
    }, timeoutMs);

    // Don't hold the process open for flush timers
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private clearTimer(chatId: string): void {
    const existing = this.timers.get(chatId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(chatId);
    }
  }

  private async triggerFlush(chatId: string): Promise<void> {
    try {
      await this.flushNow(chatId, { reason: 'auto' });
    } catch (err) {
      logSafeError(`[buffer] Flush failed for chat ${chatId}:`, err);
    }
  }

  private selectMessages(chatId: string, threadId?: string): BufferedMessage[] {
    const messages = this.buffers.get(chatId) ?? [];
    return threadId ? messages.filter((message) => message.threadId === threadId) : messages;
  }

  private removeMessages(chatId: string, flushed: BufferedMessage[]): void {
    const existing = this.buffers.get(chatId);
    if (!existing) return;
    const flushedSet = new Set(flushed);
    const remaining = existing.filter((message) => !flushedSet.has(message));
    if (remaining.length === 0) {
      this.buffers.delete(chatId);
      this.timers.delete(chatId);
      return;
    }
    this.buffers.set(chatId, remaining);
    this.resetTimer(chatId);
  }
}
