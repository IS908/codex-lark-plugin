import assert from 'node:assert/strict';
import { IdentitySession } from '../src/identity-session.js';
import {
  bindSdkCommentIdentity,
  evaluateUnmentionedGroupMessage,
  processSdkMessage,
} from '../src/sdk-channel-parity.js';
import type { AccessControlReader } from '../src/runtime-access-control.js';

function accessControl(options: {
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  groupNoMentionChatIds?: string[];
} = {}): AccessControlReader {
  const allowedUserIds = options.allowedUserIds ?? [];
  const allowedChatIds = options.allowedChatIds ?? [];
  const groupNoMentionChatIds = options.groupNoMentionChatIds ?? [];
  return {
    allowsMessage(senderId: string, chatId: string) {
      if (allowedUserIds.length === 0 && allowedChatIds.length === 0) return true;
      return allowedUserIds.includes(senderId) || allowedChatIds.includes(chatId);
    },
    allowsDocComment(senderId: string) {
      return allowedUserIds.length === 0 || allowedUserIds.includes(senderId);
    },
    allowsNoMentionChat(chatId: string) {
      return groupNoMentionChatIds.includes(chatId);
    },
    isAllowedUserId(userId: string) {
      return allowedUserIds.includes(userId);
    },
    snapshot() {
      return {
        version: 1,
        revision: 0,
        allowed_user_ids: [...allowedUserIds],
        allowed_chat_ids: [...allowedChatIds],
        group_no_mention_chat_ids: [...groupNoMentionChatIds],
      };
    },
  };
}

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const result = await processSdkMessage(
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
      accessControl: accessControl(),
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
  const result = await processSdkMessage(
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
      accessControl: accessControl(),
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.equal(result.status, 'dropped');
  assert.equal(result.reason, 'no_mention');
  assert.deepEqual(result.diagnostic, {
    chatId: 'oc_group',
    chatType: 'group',
    mentionedBot: false,
    noMentionAllowed: false,
    topLevel: true,
    threadMessage: false,
    triggerDecision: 'not_evaluated',
  });
  assert.equal(handled, false);
  assert.equal(identitySession.getCaller('oc_group'), null);
}

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_question',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: 'Can you summarize this thread?',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].unmentionedGroupTrigger, true);
  assert.equal(handled[0].botMentioned, false);
  assert.equal(identitySession.getCaller('oc_trusted_group'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_chinese_question',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: '原因定位了吗',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].unmentionedGroupTrigger, true);
  assert.equal(identitySession.getCaller('oc_trusted_group'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const content = [
    '总结一下这个会议记录，讲了几件事，每件都做一下完整总结',
    'https://bytedance.my.larkoffice.com/minutes/minu_abc123',
  ].join('\n');
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_minutes_summary',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content,
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].unmentionedGroupTrigger, true);
  assert.equal(handled[0].text, content);
  assert.equal(identitySession.getCaller('oc_trusted_group'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_minutes_non_allowlisted',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: '总结一下这个会议记录\nhttps://bytedance.my.larkoffice.com/minutes/minu_abc123',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_other_group'] }),
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.equal(result.status, 'dropped');
  assert.equal(result.reason, 'no_mention');
  assert.equal(result.diagnostic?.noMentionAllowed, false);
  assert.equal(result.diagnostic?.triggerDecision, 'not_evaluated');
  assert.equal(handled, false);
}

{
  const decision = evaluateUnmentionedGroupMessage({
    messageId: 'om_group_no_mention_actionable_url',
    chatId: 'oc_trusted_group',
    chatType: 'group',
    senderId: 'ou_sender',
    content: 'https://bytedance.my.larkoffice.com/minutes/minu_abc123',
    rawContentType: 'text',
    mentionedBot: false,
    mentionAll: false,
    mentions: [],
    resources: [],
    createTime: Date.now(),
  });

  assert.deepEqual(decision, {
    shouldProcess: true,
    reason: 'actionable_url',
    topLevel: true,
    threadMessage: false,
  });
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_chatter',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: 'sounds good',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.equal(result.status, 'dropped');
  assert.equal(result.reason, 'no_mention_trigger');
  assert.deepEqual(result.diagnostic, {
    chatId: 'oc_trusted_group',
    chatType: 'group',
    mentionedBot: false,
    noMentionAllowed: true,
    topLevel: true,
    threadMessage: false,
    triggerDecision: 'noise',
  });
  assert.equal(handled, false);
  assert.equal(identitySession.getCaller('oc_trusted_group'), null);
}

{
  const identitySession = new IdentitySession(() => null);
  const handled: any[] = [];
  const result = await processSdkMessage(
    {
      messageId: 'om_group_no_mention_thread',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: 'sounds good',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      threadId: 'omt_trusted_thread',
      rootId: 'om_trusted_root',
      replyToMessageId: 'om_parent',
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled.length, 1);
  assert.equal(handled[0].unmentionedGroupTrigger, true);
  assert.equal(handled[0].threadId, 'omt_trusted_thread');
  assert.equal(identitySession.getCaller('oc_trusted_group', 'omt_trusted_thread'), 'ou_sender');
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessage(
    {
      messageId: 'om_group_bot_self',
      chatId: 'oc_trusted_group',
      chatType: 'group',
      senderId: 'ou_bot',
      content: 'Can you summarize this thread?',
      rawContentType: 'text',
      mentionedBot: false,
      mentionAll: false,
      mentions: [],
      resources: [],
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl({ groupNoMentionChatIds: ['oc_trusted_group'] }),
      botOpenId: 'ou_bot',
      handleMessage: async () => {
        handled = true;
      },
    },
  );

  assert.deepEqual(result, { status: 'dropped', reason: 'bot_self' });
  assert.equal(handled, false);
}

{
  const identitySession = new IdentitySession(() => null);
  let handled = false;
  const result = await processSdkMessage(
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
      accessControl: accessControl({ allowedUserIds: ['ou_other'], allowedChatIds: ['oc_p2p'] }),
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
  const handled: any[] = [];
  const result = await processSdkMessage(
    {
      messageId: 'om_root_child',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_sender',
      content: 'reply with root only',
      rawContentType: 'text',
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      resources: [],
      rootId: 'om_root_parent',
      replyToMessageId: 'om_parent',
      createTime: Date.now(),
    },
    {
      identitySession,
      accessControl: accessControl(),
      handleMessage: async (message) => {
        handled.push(message);
      },
    },
  );

  assert.equal(result.status, 'processed');
  assert.equal(handled[0].threadId, 'om_root_parent');
  assert.equal(handled[0].rootMessageId, 'om_root_parent');
  assert.equal(handled[0].parentId, 'om_parent');
  assert.equal(identitySession.getCaller('oc_group', 'om_root_parent'), 'ou_sender');
  assert.equal(identitySession.getCaller('oc_group'), null);
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
