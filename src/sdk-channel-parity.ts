import type { CommentEvent, NormalizedMessage, ResourceDescriptor } from '@larksuite/channel';
import type { LarkMessage } from './channel.js';
import { DOC_CHAT_ID_PREFIX, type IdentitySession } from './identity-session.js';
import { bindSdkMessageIdentity } from './sdk-channel-identity.js';

export type SdkMessageDropReason = 'bot_self' | 'no_mention' | 'no_mention_trigger' | 'not_allowed';
export type SdkMessageResult =
  | { status: 'processed'; message: LarkMessage }
  | { status: 'dropped'; reason: SdkMessageDropReason };

export interface SdkMessageDeps {
  identitySession: IdentitySession;
  allowedUserIds: string[];
  allowedChatIds: string[];
  groupNoMentionChatIds?: string[];
  botOpenId?: string | null;
  handleMessage: (message: LarkMessage) => Promise<void>;
}

function passesSdkWhitelist(senderId: string, chatId: string, deps: SdkMessageDeps): boolean {
  const userConfigured = deps.allowedUserIds.length > 0;
  const chatConfigured = deps.allowedChatIds.length > 0;
  if (!userConfigured && !chatConfigured) return true;
  const userOk = userConfigured && deps.allowedUserIds.includes(senderId);
  const chatOk = chatConfigured && deps.allowedChatIds.includes(chatId);
  return userOk || chatOk;
}

function isThreadMessage(sdkMessage: NormalizedMessage): boolean {
  return !!(sdkMessage.threadId || sdkMessage.rootId || sdkMessage.replyToMessageId);
}

function isLikelyQuestionOrCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(?:\/|\$)\S+/.test(trimmed)) return true;
  if (/[?？]\s*$/.test(trimmed)) return true;
  if (/[吗么]\s*$/.test(trimmed)) return true;
  return /^(?:please\s+)?(?:can|could|would|should|do|does|did|is|are|was|were|what|why|how|when|where|which|who)\b/i.test(trimmed) ||
    /(?:帮我|帮忙|请(?:帮|看|检查|处理|修复)|能否|能不能|可以(?:帮|.*吗)|可否|是否|是不是|有没有|怎么|如何|为什么|为啥|要不要|看下|检查一下|review一下|修复一下|处理一下)/i.test(trimmed);
}

export function shouldProcessUnmentionedGroupMessage(sdkMessage: NormalizedMessage): boolean {
  const text = sdkMessage.content.trim();
  if (!text) return false;
  if (isLikelyQuestionOrCommand(text)) return true;
  return isThreadMessage(sdkMessage);
}

function mapSdkResources(
  resources: ResourceDescriptor[] | undefined,
): Array<{ fileKey: string; fileName: string; fileType: string }> | undefined {
  if (!resources || resources.length === 0) return undefined;
  const mapped = resources
    .map((resource) => ({
      fileKey: resource.fileKey,
      fileName: resource.fileName ?? resource.fileKey,
      fileType: resource.type,
    }))
    .filter((resource) => resource.fileKey);
  return mapped.length > 0 ? mapped : undefined;
}

export async function processSdkMessage(
  sdkMessage: NormalizedMessage,
  deps: SdkMessageDeps,
): Promise<SdkMessageResult> {
  if (deps.botOpenId && sdkMessage.senderId === deps.botOpenId) {
    return { status: 'dropped', reason: 'bot_self' };
  }
  if (sdkMessage.chatType === 'group' && !sdkMessage.mentionedBot) {
    if (!(deps.groupNoMentionChatIds ?? []).includes(sdkMessage.chatId)) {
      return { status: 'dropped', reason: 'no_mention' };
    }
    if (!shouldProcessUnmentionedGroupMessage(sdkMessage)) {
      return { status: 'dropped', reason: 'no_mention_trigger' };
    }
  }
  if (!passesSdkWhitelist(sdkMessage.senderId, sdkMessage.chatId, deps)) {
    return { status: 'dropped', reason: 'not_allowed' };
  }

  const larkMessage = bindSdkMessageIdentity(
    {
      messageId: sdkMessage.messageId,
      chatId: sdkMessage.chatId,
      chatType: sdkMessage.chatType,
      senderId: sdkMessage.senderId,
      senderName: sdkMessage.senderName,
      content: sdkMessage.content,
      rawContentType: sdkMessage.rawContentType,
      threadId: sdkMessage.threadId,
      rootId: sdkMessage.rootId,
      replyToMessageId: sdkMessage.replyToMessageId,
      mentionedBot: sdkMessage.mentionedBot,
      mentions: sdkMessage.mentions.map((mention) => ({
        id: mention.openId ?? mention.userId ?? mention.key,
        name: mention.name ?? mention.key,
      })),
    },
    deps.identitySession,
  );
  if (sdkMessage.chatType === 'group' && !sdkMessage.mentionedBot) {
    larkMessage.unmentionedGroupTrigger = true;
  }
  larkMessage.attachments = mapSdkResources(sdkMessage.resources);

  await deps.handleMessage(larkMessage);
  return { status: 'processed', message: larkMessage };
}

export function bindSdkCommentIdentity(
  comment: CommentEvent,
  identitySession: IdentitySession,
): LarkMessage {
  if (!comment.mentionedBot) throw new Error('SDK comment event did not mention the bot');
  if (!comment.operator.openId) throw new Error('SDK comment event missing operator.openId');

  const chatId = `${DOC_CHAT_ID_PREFIX}${comment.fileToken}`;
  const threadId = comment.commentId;
  identitySession.setCaller(chatId, threadId, comment.operator.openId);

  const text =
    `<doc_comment doc_token="${comment.fileToken}" comment_id="${comment.commentId}" ` +
    `file_type="${comment.fileType}" is_mentioned="true">SDK comment mention</doc_comment>`;

  return {
    messageId: comment.replyId ?? comment.commentId,
    chatId,
    chatType: 'doc_comment',
    senderId: comment.operator.openId,
    text,
    messageType: 'doc_comment',
    threadId,
    rawContent: text,
    docComment: {
      fileToken: comment.fileToken,
      commentId: comment.commentId,
      fileType: comment.fileType,
      replyId: comment.replyId,
    },
  };
}
