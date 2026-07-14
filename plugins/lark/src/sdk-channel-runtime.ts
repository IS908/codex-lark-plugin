import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
  RejectEvent,
} from '@larksuite/channel';
import type { SdkChannelRuntimeTarget } from './lark-message.js';
import { createSdkChannelScaffold } from './sdk-channel-scaffold.js';
import { debugLog } from './debug-log.js';
import { logSafeError } from './safe-log.js';

type SdkRuntimeChannel = Pick<
  SdkLarkChannel,
  | 'addReaction'
  | 'botIdentity'
  | 'comments'
  | 'connect'
  | 'downloadResource'
  | 'fetchMessage'
  | 'on'
>;

export interface SdkRuntimeOptions {
  createChannel?: () => SdkRuntimeChannel;
}

export interface SdkRuntimeRetryOptions extends SdkRuntimeOptions {
  retryDelayMs?: number | ((attempt: number, err: unknown) => number);
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  onConnected?: (sdkChannel: SdkRuntimeChannel) => void | Promise<void>;
  onStopped?: (err: unknown) => void | Promise<void>;
}

export interface SdkRuntimeRetryController {
  stop(): void;
}

const DEFAULT_RETRY_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;

function retryDelay(options: SdkRuntimeRetryOptions, attempt: number, err: unknown): number {
  const configured = options.retryDelayMs;
  const raw = typeof configured === 'function'
    ? configured(attempt, err)
    : configured ?? Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 3), MAX_RETRY_DELAY_MS);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_RETRY_DELAY_MS;
}

export async function startSdkChannelRuntime(
  channel: SdkChannelRuntimeTarget,
  options: SdkRuntimeOptions = {},
): Promise<SdkRuntimeChannel> {
  const sdkChannel = options.createChannel?.() ?? createSdkChannelScaffold();
  channel.setSdkTransportChannel(sdkChannel as any);

  sdkChannel.on('message', async (message: NormalizedMessage) => {
    try {
      await channel.handleSdkMessageEvent(message, sdkChannel);
    } catch (err) {
      logSafeError('[sdk-channel] Error handling message event:', err);
    }
  });

  sdkChannel.on('comment', async (comment: CommentEvent) => {
    try {
      await channel.handleSdkCommentEvent(comment, sdkChannel);
    } catch (err) {
      logSafeError('[sdk-channel] Error handling doc comment event:', err);
    }
  });

  sdkChannel.on('reaction', async (reaction: ReactionEvent) => {
    try {
      await channel.handleSdkReactionEvent(reaction);
    } catch (err) {
      logSafeError('[sdk-channel] Error handling reaction event:', err);
    }
  });

  sdkChannel.on('reject', (event: RejectEvent) => {
    debugLog(
      `[sdk-channel] Rejected message ${event.messageId} chat=${event.chatId} sender=${event.senderId}: ${event.reason}`,
    );
  });

  sdkChannel.on('error', (err: unknown) => {
    logSafeError('[sdk-channel] Runtime error:', err);
  });

  await sdkChannel.connect();
  channel.setBotOpenId(sdkChannel.botIdentity?.openId);
  debugLog('[sdk-channel] SDK channel runtime connected');
  return sdkChannel;
}

export function startSdkChannelRuntimeWithRetry(
  channel: SdkChannelRuntimeTarget,
  options: SdkRuntimeRetryOptions = {},
): SdkRuntimeRetryController {
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let wakeRetry: (() => void) | null = null;

  const waitForRetry = (delayMs: number) => new Promise<void>((resolve) => {
    if (delayMs <= 0 || stopped) {
      resolve();
      return;
    }
    wakeRetry = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wakeRetry = null;
      resolve();
    }, delayMs);
  });

  const run = async () => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        const sdkChannel = await startSdkChannelRuntime(channel, options);
        if (!stopped) {
          try {
            await options.onConnected?.(sdkChannel);
          } catch (err) {
            logSafeError('[sdk-channel] Runtime post-connect startup failed:', err);
            await options.onStopped?.(err);
          }
        }
        return;
      } catch (err) {
        if (stopped) {
          await options.onStopped?.(err);
          return;
        }
        const delayMs = retryDelay(options, attempt, err);
        logSafeError(`[sdk-channel] Runtime startup attempt ${attempt} failed; retrying in ${delayMs}ms:`, err);
        options.onRetry?.(err, attempt, delayMs);
        await waitForRetry(delayMs);
      }
    }
  };

  void run().catch(async (err) => {
    if (!stopped) {
      logSafeError('[sdk-channel] Runtime retry loop stopped:', err);
      await options.onStopped?.(err);
    }
  });

  return {
    stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      wakeRetry?.();
      wakeRetry = null;
    },
  };
}
