import type {
  LarkChannel as SdkLarkChannel,
  ResourceDescriptor,
} from '@larksuite/channel';
import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import {
  AckReactionTracker,
  deleteAckReactionWithTransport,
} from './ack-reactions.js';
import {
  addLegacyImageDownloads,
  addSdkImageDownloads,
} from './inbound-attachment-downloader.js';
import type { LarkTransport } from './lark-transport.js';
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

export type InboundTurnSource =
  | {
      kind: 'sdk';
      resources?: ResourceDescriptor[];
      sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>;
    }
  | {
      kind: 'legacy';
      rawContent: string;
      messageType: string;
      resolveChatName?: (chatId: string) => Promise<string>;
    };

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

  addAckReaction(message, deps, source.kind);

  if (source.kind === 'sdk') {
    await addSdkImageDownloads(message, source.resources ?? [], source.sdkChannel);
  } else {
    await addLegacyImageDownloads(
      message,
      source.rawContent,
      source.messageType,
      deps.larkTransport,
    );
    if (message.chatType === 'group' && source.resolveChatName) {
      const chatName = await source.resolveChatName(message.chatId);
      message.chatName = chatName || undefined;
    }
  }

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
  sourceKind: InboundTurnSource['kind'],
): void {
  const ackEmoji = message.chatType === 'p2p' ? 'Typing' : appConfig.ackEmoji;
  if (!ackEmoji) return;

  deps.larkTransport.addReaction(message.messageId, ackEmoji).then((reactionId) => {
    if (!reactionId) return;
    const stored = deps.ackReactions.storeReaction(message.messageId, reactionId);
    if (stored.action === 'delete-now') {
      deleteAckReactionWithTransport(deps.larkTransport, stored.reaction, `${sourceKind}-channel.delete_late`);
    }
  }).catch(() => {});
}
