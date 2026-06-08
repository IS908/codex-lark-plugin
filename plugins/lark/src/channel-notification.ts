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
    ...(message.chatName ? { chat_name: message.chatName } : {}),
    ...(message.threadId ? { thread_id: message.threadId } : {}),
    ...(message.botMentioned ? { bot_mentioned: 'true' } : {}),
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
