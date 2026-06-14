import assert from 'node:assert/strict';
import { IdentitySession } from '../src/identity-session.js';
import {
  bindSdkCommentIdentity,
  processSdkMessageDryRun,
} from '../src/sdk-channel-parity.js';

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const result = await processSdkMessageDryRun(
    {
      messageId: 'om_group_mentioned',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_sender',
      senderName: 'Sender',
      content: 'quoted card context\nplease inspect this file',
      rawContentType: 'interactive',
      mentionedBot: true,
      mentionAll: false,
      mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Codex Bot', isBot: true }],
      resources: [
        { type: 'image', fileKey: 'img_1', fileName: 'diagram.png' },
        { type: 'file', fileKey: 'file_1', fileName: 'report.pdf' },
      ],
      threadId: 'omt_thread',
      rootId: 'om_root',
      replyToMessageId: 'om_parent',
      createTime: Date.now(),
    },
    {
      identitySession,
      allowedUserIds: [],
      allowedChatIds: [],
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].messageId, 'om_group_mentioned');
  assert.equal(handled[0].chatType, 'group');
  assert.equal(handled[0].botMentioned, true);
  assert.equal(handled[0].messageType, 'interactive');
  assert.equal(handled[0].threadId, 'omt_thread');
  assert.equal(handled[0].rootMessageId, 'om_root');
  assert.equal(handled[0].parentId, 'om_parent');
  assert.deepEqual(handled[0].mentions, [{ id: 'ou_bot', name: 'Codex Bot' }]);
  assert.deepEqual(handled[0].attachments, [
    { fileKey: 'img_1', fileName: 'diagram.png', fileType: 'image' },
    { fileKey: 'file_1', fileName: 'report.pdf', fileType: 'file' },
  ]);
  assert.equal(identitySession.getCaller('oc_group', 'omt_thread'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessageDryRun(
    {
      messageId: 'om_group_unmentioned',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: 'no bot mention',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      allowedUserIds: [],
      allowedChatIds: [],
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.deepEqual(result, { status: 'dropped', reason: 'no_mention' });
  assert.equal(handled, false);
  assert.equal(identitySession.getCaller('oc_group'), null);
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessageDryRun(
    {
      messageId: 'om_p2p',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      senderId: 'ou_sender',
      content: 'p2p does not need a mention',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      allowedUserIds: ['ou_other'],
      allowedChatIds: ['oc_p2p'],
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled, true);
  assert.equal(identitySession.getCaller('oc_p2p'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  const docMessage = bindSdkCommentIdentity(
    {
      fileToken: 'dox_sdk',
      fileType: 'docx',
      commentId: 'cmt_sdk',
      replyId: 'rpl_sdk',
      operator: { openId: 'ou_commenter' },
      mentionedBot: true,
      timestamp: Date.now(),
    },
    identitySession,
  );

  assert.equal(docMessage.chatId, 'doc:dox_sdk');
  assert.equal(docMessage.threadId, 'cmt_sdk');
  assert.equal(docMessage.messageId, 'rpl_sdk');
  assert.equal(docMessage.chatType, 'doc_comment');
  assert.equal(docMessage.senderId, 'ou_commenter');
  assert.deepEqual(docMessage.docComment, {
    fileToken: 'dox_sdk',
    commentId: 'cmt_sdk',
    fileType: 'docx',
    replyId: 'rpl_sdk',
  });
  assert.equal(identitySession.getCaller('doc:dox_sdk', 'cmt_sdk'), 'ou_commenter');
}

console.log('sdk-message-parity smoke: PASS');
