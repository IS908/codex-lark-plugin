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
import { parseJobThreadId } from './job-thread.js';
import { addQuotedContext, selectQuotedMessageId } from './quoted-context-loader.js';

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
  botMessageTracker?: {
    get(messageId: string): { chatId?: string; threadId?: string } | undefined;
  };
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
  message.currentUserText ??= message.text;
  deps.latestMessageTracker.record(message.chatId, {
    messageId: message.messageId,
    threadId: message.threadId,
    timestamp: Date.now(),
  });
  deps.ackReactions.recordInbound(message.messageId);

  addAckReaction(message, deps);

  const quotedMessageId = selectQuotedMessageId(message);
  const trackedQuotedMessage = quotedMessageId
    ? deps.botMessageTracker?.get(quotedMessageId)
    : undefined;
  const quotedCronjob = trackedQuotedMessage?.chatId === message.chatId
    ? parseJobThreadId(trackedQuotedMessage.threadId)
    : null;
  if (quotedCronjob) message.quotedCronJobId = quotedCronjob.jobId;

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
