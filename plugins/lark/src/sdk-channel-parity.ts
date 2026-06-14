import type { CommentEvent, NormalizedMessage, ResourceDescriptor } from '@larksuite/channel';
import type { LarkMessage } from './channel.js';
import { DOC_CHAT_ID_PREFIX, type IdentitySession } from './identity-session.js';
import { bindSdkMessageIdentity } from './sdk-channel-identity.js';

export type SdkMessageDropReason = 'no_mention' | 'not_allowed';
export type SdkMessageResult =
  | { status: 'processed'; message: LarkMessage }
  | { status: 'dropped'; reason: SdkMessageDropReason };

export interface SdkMessageDeps {
  identitySession: IdentitySession;
  allowedUserIds: string[];
  allowedChatIds: string[];
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
  if (sdkMessage.chatType === 'group' && !sdkMessage.mentionedBot) {
    return { status: 'dropped', reason: 'no_mention' };
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
