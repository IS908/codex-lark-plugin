import type {
  LarkChannel as SdkLarkChannel,
  ResourceDescriptor,
} from '@larksuite/channel';
import { appConfig } from './config.js';
import type { LarkMessage } from './lark-message.js';
import {
  AckReactionTracker,
  deleteAckReactionWithTransport,
} from './ack-reactions.js';
import { addSdkImageDownloads } from './inbound-attachment-downloader.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import { addQuotedContext } from './quoted-context-loader.js';

export interface LatestInboundMessageTracker {
  record(chatId: string, msg: { messageId: string; threadId?: string; timestamp: number }): void;
}

export interface ChatTypeWriter {
  set(chatId: string, chatType: 'p2p' | 'group'): void;
}

export interface PrepareInboundTurnDeps {
  latestMessageTracker: LatestInboundMessageTracker;
  ackReactions: AckReactionTracker;
  larkTransport: LarkTransport;
  chatTypeCache: ChatTypeWriter;
}

export interface InboundTurnSource {
  resources?: ResourceDescriptor[];
  sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>;
}

export async function prepareInboundTurn(
  message: LarkMessage,
  deps: PrepareInboundTurnDeps,
  source: InboundTurnSource,
): Promise<void> {
  deps.latestMessageTracker.record(message.chatId, {
    messageId: message.messageId,
    threadId: message.threadId,
    timestamp: Date.now(),
  });
  deps.ackReactions.recordInbound(message.messageId);

  addAckReaction(message, deps);

  await addSdkImageDownloads(message, source.resources ?? [], source.sdkChannel);

  await addQuotedContext(message, deps.larkTransport, {
    maxDepth: appConfig.quotedContextMaxDepth,
    maxBytes: appConfig.quotedContextMaxBytes,
  });

  if (message.chatType === 'p2p' || message.chatType === 'group') {
    deps.chatTypeCache.set(message.chatId, message.chatType);
  }
}

function addAckReaction(
  message: LarkMessage,
  deps: Pick<PrepareInboundTurnDeps, 'ackReactions' | 'larkTransport'>,
): void {
  const ackEmoji = message.chatType === 'p2p' ? 'Typing' : appConfig.ackEmoji;
  if (!ackEmoji) return;

  deps.larkTransport.addReaction(message.messageId, ackEmoji).then((reactionId) => {
    if (!reactionId) return;
    const stored = deps.ackReactions.storeReaction(message.messageId, reactionId);
    if (stored.action === 'delete-now') {
      deleteAckReactionWithTransport(deps.larkTransport, stored.reaction, 'sdk-channel.delete_late');
    }
  }).catch(() => {});
}
