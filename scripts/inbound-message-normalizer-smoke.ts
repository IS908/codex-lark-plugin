import assert from 'node:assert/strict';
import { normalizeLegacyMessageEvent } from '../src/inbound-message-normalizer.js';

function makeEvent(overrides: any = {}) {
  const message = {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    content: JSON.stringify({ text: 'hello' }),
    message_type: 'text',
    parent_id: undefined,
    root_id: undefined,
    thread_id: undefined,
    mentions: [],
    ...overrides.message,
  };
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    ...overrides,
    message,
  };
}

function makeDeps(overrides: any = {}) {
  const logs: string[] = [];
  const resolvedUsers: string[] = [];
  return {
    logs,
    resolvedUsers,
    deps: {
      botOpenId: 'ou_bot',
      passesWhitelist: () => true,
      resolveUserName: async (openId: string) => {
        resolvedUsers.push(openId);
        return `name:${openId}`;
      },
      log: (line: string) => logs.push(line),
      ...overrides,
    },
  };
}

{
  const { deps, logs, resolvedUsers } = makeDeps();
  const result = await normalizeLegacyMessageEvent(makeEvent({
    message: { chat_type: 'group', mentions: [] },
  }), deps);

  assert.deepEqual(result, { status: 'dropped', reason: 'group_no_mentions' });
  assert.deepEqual(resolvedUsers, ['ou_sender']);
  assert.deepEqual(logs, ['[channel] Ignoring group message: no mentions']);
}

{
  const { deps, logs } = makeDeps();
  const result = await normalizeLegacyMessageEvent(makeEvent({
    message: {
      chat_type: 'group',
      mentions: [{ id: { open_id: 'ou_someone_else' }, name: 'Else' }],
    },
  }), deps);

  assert.deepEqual(result, { status: 'dropped', reason: 'group_bot_not_mentioned' });
  assert.deepEqual(logs, ['[channel] Ignoring group message: bot not @mentioned']);
}

{
  const { deps, logs } = makeDeps({
    passesWhitelist: () => false,
  });
  const result = await normalizeLegacyMessageEvent(makeEvent(), deps);

  assert.deepEqual(result, { status: 'dropped', reason: 'whitelist' });
  assert.deepEqual(logs, ['[channel] Message from ou_sender in oc_1 rejected by whitelist']);
}

{
  const { deps } = makeDeps();
  const result = await normalizeLegacyMessageEvent(makeEvent({
    message: {
      content: JSON.stringify({ text: 'hi @_user_1' }),
      root_id: 'om_root',
      mentions: [{ id: { open_id: 'ou_target' }, name: 'Target' }],
    },
  }), deps);

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('expected ok');
  assert.equal(result.threadId, 'om_root');
  assert.deepEqual(result.message, {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_sender',
    senderName: 'name:ou_sender',
    chatName: undefined,
    text: 'hi @Target',
    messageType: 'text',
    parentId: undefined,
    threadId: 'om_root',
    rootMessageId: 'om_root',
    mentions: [{ id: 'ou_target', name: 'Target' }],
    botMentioned: false,
    attachments: [],
    rawContent: JSON.stringify({ text: 'hi @_user_1' }),
  });
}

{
  const { deps, logs } = makeDeps();
  const result = await normalizeLegacyMessageEvent(makeEvent({
    message: {
      chat_type: 'group',
      chat_id: 'oc_group',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_1', file_name: 'report.pdf' }),
      thread_id: 'om_thread',
      mentions: [{ id: { open_id: 'ou_bot' }, name: 'Codex' }],
    },
  }), deps);

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('expected ok');
  assert.deepEqual(logs, ['[channel] Group message with @mention, processing']);
  assert.equal(result.threadId, 'om_thread');
  assert.equal(result.message.chatName, undefined);
  assert.equal(result.message.botMentioned, true);
  assert.deepEqual(result.message.attachments, [
    { fileKey: 'file_1', fileName: 'report.pdf', fileType: 'file' },
  ]);
}

console.log('inbound-message-normalizer smoke: PASS');
