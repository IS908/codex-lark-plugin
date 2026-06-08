import type { LarkMessage } from './channel.js';

export function isFeishuOpenMessageId(messageId: string | undefined | null): boolean {
  return typeof messageId === 'string' && messageId.startsWith('om_');
}

export function isSyntheticSystemMessageId(messageId: string | undefined | null): boolean {
  return typeof messageId === 'string' && messageId.startsWith('flush-');
}

export function shouldSendFeishuReplyForMessage(
  message: Pick<LarkMessage, 'chatType' | 'messageId'>,
): boolean {
  return (message.chatType === 'p2p' || message.chatType === 'group') && isFeishuOpenMessageId(message.messageId);
}

export const shouldSendCodexExecFailureReply = shouldSendFeishuReplyForMessage;
