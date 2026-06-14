/**
 * Per-thread sequential message queue.
 * Messages in the same (chatId, threadId) pair are processed sequentially.
 * Messages in different chats or different threads in the same chat are
 * processed in parallel — this lets independent thread conversations proceed
 * without blocking each other.
 */
import { debugLog } from './debug-log.js';

export interface MessageQueueOptions {
  /**
   * Max time to wait for one queued handler before allowing the next message in
   * the same key to proceed. A stuck MCP notification should not permanently
   * wedge a chat/thread queue.
   */
  handlerTimeoutMs?: number;
}

export class MessageQueue {
  private chains = new Map<string, Promise<void>>();
  private handlerTimeoutMs: number | null;

  constructor(options: MessageQueueOptions = {}) {
    this.handlerTimeoutMs =
      Number.isFinite(options.handlerTimeoutMs) && (options.handlerTimeoutMs ?? 0) > 0
        ? options.handlerTimeoutMs!
        : null;
  }

  private key(chatId: string, threadId?: string): string {
    // Use || instead of ?? so empty strings also fall back to '_'
    return `${chatId}::${threadId || '_'}`;
  }

  private runWithTimeout(k: string, handler: () => Promise<void>): Promise<void> {
    if (!this.handlerTimeoutMs) return handler();

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handlerPromise = Promise.resolve().then(handler);

    handlerPromise.catch((err) => {
      if (timedOut) {
        debugLog(`[queue] Late error after timeout in ${k}: ${err}`);
      }
    });

    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Message handler timed out after ${this.handlerTimeoutMs}ms`));
      }, this.handlerTimeoutMs!);
    });

    return Promise.race([handlerPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  enqueue(
    chatId: string,
    threadId: string | undefined,
    handler: () => Promise<void>
  ): void {
    const k = this.key(chatId, threadId);
    const prev = this.chains.get(k) ?? Promise.resolve();
    const next = prev
      .then(() => this.runWithTimeout(k, handler))
      .catch((err) => {
        debugLog(`[queue] Error processing message in ${k}: ${err}`);
      })
      .finally(() => {
        // Clean up resolved chains to prevent unbounded Map growth
        if (this.chains.get(k) === next) {
          this.chains.delete(k);
        }
    });
    this.chains.set(k, next);
  }

  isIdle(): boolean {
    return this.chains.size === 0;
  }
}
