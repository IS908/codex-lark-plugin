import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
  RejectEvent,
} from '@larksuite/channel';
import type { LarkChannel } from './channel.js';
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

export async function startSdkChannelRuntime(
  channel: LarkChannel,
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
