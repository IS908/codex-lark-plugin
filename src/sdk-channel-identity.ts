import type { LarkMessage } from './channel.js';
import { IdentitySession, TERMINAL_CHAT_ID } from './identity-session.js';

export interface SdkIdentityMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  chatName?: string;
  content: string;
  rawContentType: string;
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
  mentionedBot?: boolean;
  mentions?: Array<{ id?: string; openId?: string; name?: string }>;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`SDK message missing ${field}`);
  return value;
}

function normalizeMentions(
  mentions: SdkIdentityMessage['mentions'],
): Array<{ id: string; name: string }> | undefined {
  if (!mentions || mentions.length === 0) return undefined;
  const normalized = mentions
    .map((mention) => ({
      id: (mention.id ?? mention.openId ?? '').trim(),
      name: mention.name ?? '',
    }))
    .filter((mention) => mention.id);
  return normalized.length > 0 ? normalized : undefined;
}

export function bindSdkMessageIdentity(
  sdkMessage: SdkIdentityMessage,
  identitySession: IdentitySession,
): LarkMessage {
  const messageId = requireNonEmpty(sdkMessage.messageId, 'messageId');
  const chatId = requireNonEmpty(sdkMessage.chatId, 'chatId');
  const senderId = requireNonEmpty(sdkMessage.senderId, 'senderId');
  const chatType = requireNonEmpty(sdkMessage.chatType, 'chatType');
  const rawContentType = requireNonEmpty(sdkMessage.rawContentType, 'rawContentType');

  if (chatId === TERMINAL_CHAT_ID) {
    throw new Error('SDK message used reserved terminal chat id');
  }

  const threadId = sdkMessage.threadId ?? sdkMessage.rootId;
  identitySession.setCaller(chatId, threadId, senderId);

  return {
    messageId,
    chatId,
    chatType,
    senderId,
    senderName: sdkMessage.senderName,
    chatName: sdkMessage.chatName,
    text: sdkMessage.content,
    messageType: rawContentType,
    parentId: sdkMessage.replyToMessageId,
    threadId,
    rootMessageId: sdkMessage.rootId,
    mentions: normalizeMentions(sdkMessage.mentions),
    botMentioned: sdkMessage.mentionedBot,
    rawContent: sdkMessage.content,
  };
}
