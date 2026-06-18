import type { LarkMessage } from './channel.js';

export function buildChannelNotificationMeta(
  message: LarkMessage,
  displayLabel: string,
): Record<string, string> {
  return {
    chat_id: message.chatId,
    message_id: message.messageId,
    user: displayLabel,
    user_id: message.senderId,
    chat_type: message.chatType,
    message_type: message.messageType,
    ...(message.chatName ? { chat_name: message.chatName } : {}),
    ...(message.threadId ? { thread_id: message.threadId } : {}),
    ...(message.rootMessageId ? { root_message_id: message.rootMessageId } : {}),
    ...(message.botMentioned ? { bot_mentioned: 'true' } : {}),
    ...(message.reaction
      ? {
          reaction_emoji: message.reaction.emojiType,
          reaction_operator_id: message.reaction.operatorId,
          reaction_target_message_id: message.reaction.targetMessageId,
          reaction_source: message.reaction.source,
          ...(message.reaction.targetMessageType ? { reaction_target_message_type: message.reaction.targetMessageType } : {}),
        }
      : {}),
    ...(message.docComment
      ? {
          doc_token: message.docComment.fileToken,
          comment_id: message.docComment.commentId,
          file_type: message.docComment.fileType,
          ...(message.docComment.replyId ? { reply_id: message.docComment.replyId } : {}),
        }
      : {}),
    ts: new Date().toISOString(),
    ...(message.parentContent ? { parent_content: message.parentContent } : {}),
    ...(message.imagePath ? { image_path: message.imagePath } : {}),
    ...(message.imagePaths?.length ? { image_paths: message.imagePaths.join(',') } : {}),
    ...(message.attachments?.length === 1
      ? {
          attachment_kind: message.attachments[0].fileType,
          attachment_file_id: message.attachments[0].fileKey,
          attachment_name: message.attachments[0].fileName,
        }
      : message.attachments && message.attachments.length > 1
        ? { attachments: JSON.stringify(message.attachments) }
        : {}),
  };
}
