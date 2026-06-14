export interface SdkOutboundChannel {
  send: (
    to: string,
    input: { text: string } | { card: object },
    opts?: { replyTo?: string; replyInThread?: boolean },
  ) => Promise<{ messageId: string; chunkIds?: string[] }>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  addReaction: (messageId: string, emojiType: string) => Promise<string>;
  removeReactionByEmoji: (messageId: string, emojiType: string) => Promise<boolean>;
}

export interface SdkReplyRequest {
  chatId: string;
  text?: string;
  card?: object;
  replyTo?: string;
  threadId?: string;
}

export function sendSdkReply(
  channel: SdkOutboundChannel,
  request: SdkReplyRequest,
): Promise<{ messageId: string; chunkIds?: string[] }> {
  if (!request.text && !request.card) {
    throw new Error('sendSdkReply requires text or card content');
  }
  const input = request.card ? { card: request.card } : { text: request.text! };
  const opts =
    request.replyTo || request.threadId
      ? {
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          ...(request.threadId ? { replyInThread: true } : {}),
        }
      : undefined;
  return channel.send(request.chatId, input, opts);
}

export function editSdkMessage(
  channel: SdkOutboundChannel,
  request: { messageId: string; text: string },
): Promise<void> {
  return channel.editMessage(request.messageId, request.text);
}

export function addSdkReaction(
  channel: SdkOutboundChannel,
  request: { messageId: string; emoji: string },
): Promise<string> {
  return channel.addReaction(request.messageId, request.emoji);
}

export function removeSdkReactionByEmoji(
  channel: SdkOutboundChannel,
  request: { messageId: string; emoji: string },
): Promise<boolean> {
  return channel.removeReactionByEmoji(request.messageId, request.emoji);
}

export function deferSdkReply(request: { messageId: string; reason?: string }): {
  deferred: true;
  messageId: string;
  reason?: string;
} {
  return {
    deferred: true,
    messageId: request.messageId,
    ...(request.reason ? { reason: request.reason } : {}),
  };
}
