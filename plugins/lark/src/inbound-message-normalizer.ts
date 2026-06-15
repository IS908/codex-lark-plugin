import {
  extractMessageAttachments,
  extractMessageText,
  resolveMentionPlaceholders,
} from './message-content.js';

export interface LegacyInboundMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  chatName?: string;
  text: string;
  messageType: string;
  parentId?: string;
  parentContent?: string;
  threadId?: string;
  rootMessageId?: string;
  mentions?: Array<{ id: string; name: string }>;
  botMentioned?: boolean;
  attachments?: Array<{ fileKey: string; fileName: string; fileType: string }>;
  rawContent: string;
  imagePath?: string;
  imagePaths?: string[];
}

export type LegacyInboundDropReason =
  | 'whitelist'
  | 'group_no_mentions'
  | 'group_bot_not_mentioned';

export type LegacyInboundNormalizeResult =
  | { status: 'ok'; message: LegacyInboundMessage; threadId?: string }
  | { status: 'dropped'; reason: LegacyInboundDropReason };

export interface LegacyInboundNormalizerDeps {
  botOpenId?: string;
  passesWhitelist(senderId: string, chatId: string): boolean;
  resolveUserName(openId: string, sender?: any): Promise<string>;
  log?: (line: string) => void;
}

function normalizeMentions(mentions: any[] | undefined): Array<{ id: string; name: string }> {
  return (mentions ?? []).map((m: any) => ({
    id: m.id?.open_id ?? m.id?.union_id ?? '',
    name: m.name ?? '',
  }));
}

export async function normalizeLegacyMessageEvent(
  data: any,
  deps: LegacyInboundNormalizerDeps,
): Promise<LegacyInboundNormalizeResult> {
  const log = deps.log ?? (() => {});
  const { message, sender } = data;
  const {
    message_id: messageId,
    chat_id: chatId,
    chat_type: chatType,
    content: rawContent,
    message_type: messageType,
    parent_id: parentId,
    root_id: rootMessageId,
    thread_id: eventThreadId,
    mentions,
  } = message;
  const threadId = eventThreadId ?? rootMessageId;
  const senderId = sender?.sender_id?.open_id ?? '';
  const senderName = await deps.resolveUserName(senderId, sender);

  if (!deps.passesWhitelist(senderId, chatId)) {
    log(`[channel] Message from ${senderId} in ${chatId} rejected by whitelist`);
    return { status: 'dropped', reason: 'whitelist' };
  }

  if (chatType === 'group') {
    if (!mentions || mentions.length === 0) {
      log('[channel] Ignoring group message: no mentions');
      return { status: 'dropped', reason: 'group_no_mentions' };
    }
    if (deps.botOpenId) {
      const botMentioned = mentions.some(
        (m: any) => (m.id?.open_id ?? m.id?.union_id) === deps.botOpenId,
      );
      if (!botMentioned) {
        log('[channel] Ignoring group message: bot not @mentioned');
        return { status: 'dropped', reason: 'group_bot_not_mentioned' };
      }
    }
    log('[channel] Group message with @mention, processing');
  }

  const parsedMentions = normalizeMentions(mentions);
  const botMentioned = deps.botOpenId
    ? parsedMentions.some((m) => m.id === deps.botOpenId)
    : parsedMentions.length > 0;
  const text = resolveMentionPlaceholders(
    extractMessageText(rawContent, messageType),
    parsedMentions,
  );
  const attachments = extractMessageAttachments(message);

  return {
    status: 'ok',
    threadId,
    message: {
      messageId,
      chatId,
      chatType,
      senderId,
      senderName: senderName || undefined,
      chatName: undefined,
      text,
      messageType,
      parentId,
      threadId,
      rootMessageId,
      mentions: parsedMentions,
      botMentioned,
      attachments,
      rawContent,
    },
  };
}
