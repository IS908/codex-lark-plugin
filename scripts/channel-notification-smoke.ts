import assert from 'node:assert/strict';
import { buildChannelNotificationMeta } from '../src/channel-notification.js';
import type { LarkMessage } from '../src/channel.js';

const docMessage: LarkMessage = {
  messageId: 'rpl_doc_001',
  chatId: 'doc:dox_doc_001',
  chatType: 'doc_comment',
  senderId: 'ou_owner',
  senderName: 'Kevin',
  text: '<doc_comment doc_token="dox_doc_001" comment_id="cmt_doc_001"><body>@Codex</body></doc_comment>',
  messageType: 'doc_comment',
  threadId: 'cmt_doc_001',
  rawContent: '{}',
  docComment: {
    fileToken: 'dox_doc_001',
    commentId: 'cmt_doc_001',
    fileType: 'docx',
    replyId: 'rpl_doc_001',
  },
};

const docMeta = buildChannelNotificationMeta(docMessage, 'Kevin · Design Doc');
assert.equal(docMeta.chat_id, 'doc:dox_doc_001');
assert.equal(docMeta.thread_id, 'cmt_doc_001');
assert.equal(docMeta.doc_token, 'dox_doc_001');
assert.equal(docMeta.comment_id, 'cmt_doc_001');
assert.equal(docMeta.file_type, 'docx');
assert.equal(docMeta.reply_id, 'rpl_doc_001');
assert.equal(docMeta.chat_type, 'doc_comment');

const imMeta = buildChannelNotificationMeta({
  messageId: 'om_001',
  chatId: 'oc_001',
  chatType: 'group',
  senderId: 'ou_001',
  text: 'hello',
  messageType: 'text',
  threadId: 'omt_001',
  rootMessageId: 'om_root_001',
  rawContent: '{}',
}, 'Kevin · Group');

assert.equal(imMeta.chat_id, 'oc_001');
assert.equal(imMeta.thread_id, 'omt_001');
assert.equal(imMeta.root_message_id, 'om_root_001');
assert.equal(imMeta.doc_token, undefined);
assert.equal(imMeta.comment_id, undefined);
assert.equal(imMeta.file_type, undefined);
assert.equal(imMeta.message_type, 'text');

const reactionMeta = buildChannelNotificationMeta({
  messageId: 'om_bot_reply',
  chatId: 'oc_001',
  chatType: 'group',
  senderId: 'ou_001',
  text: '[Reaction Event]\nUser reacted with DONE',
  messageType: 'reaction',
  threadId: 'omt_001',
  rawContent: '{}',
  reaction: {
    emojiType: 'DONE',
    operatorId: 'ou_001',
    targetMessageId: 'om_bot_reply',
    source: 'sdk',
    targetMessageType: 'text',
    targetText: 'original bot reply',
  },
}, 'Kevin · Group');

assert.equal(reactionMeta.message_type, 'reaction');
assert.equal(reactionMeta.reaction_emoji, 'DONE');
assert.equal(reactionMeta.reaction_operator_id, 'ou_001');
assert.equal(reactionMeta.reaction_target_message_id, 'om_bot_reply');
assert.equal(reactionMeta.reaction_source, 'sdk');
assert.equal(reactionMeta.reaction_target_message_type, 'text');

console.log('PASS');
