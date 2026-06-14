import assert from 'node:assert/strict';
import {
  addSdkReaction,
  deferSdkReply,
  editSdkMessage,
  removeSdkReactionByEmoji,
  sendSdkReply,
} from '../src/sdk-channel-outbound.js';

const calls: any[] = [];
const channel = {
  async send(to: string, input: any, opts?: any) {
    calls.push({ method: 'send', to, input, opts });
    return { messageId: 'om_sent' };
  },
  async editMessage(messageId: string, text: string) {
    calls.push({ method: 'editMessage', messageId, text });
  },
  async addReaction(messageId: string, emojiType: string) {
    calls.push({ method: 'addReaction', messageId, emojiType });
    return 'reaction_1';
  },
  async removeReactionByEmoji(messageId: string, emojiType: string) {
    calls.push({ method: 'removeReactionByEmoji', messageId, emojiType });
    return true;
  },
};

{
  const result = await sendSdkReply(channel, {
    chatId: 'oc_reply',
    text: 'hello',
    replyTo: 'om_user',
    threadId: 'omt_thread',
  });

  assert.deepEqual(result, { messageId: 'om_sent' });
  assert.deepEqual(calls.pop(), {
    method: 'send',
    to: 'oc_reply',
    input: { text: 'hello' },
    opts: { replyTo: 'om_user', replyInThread: true },
  });
}

{
  const result = await sendSdkReply(channel, {
    chatId: 'oc_reply',
    card: { type: 'template', data: { template_id: 'tpl_1' } },
  });

  assert.deepEqual(result, { messageId: 'om_sent' });
  assert.deepEqual(calls.pop(), {
    method: 'send',
    to: 'oc_reply',
    input: { card: { type: 'template', data: { template_id: 'tpl_1' } } },
    opts: undefined,
  });
}

await editSdkMessage(channel, { messageId: 'om_sent', text: 'edited' });
assert.deepEqual(calls.pop(), { method: 'editMessage', messageId: 'om_sent', text: 'edited' });

const reactionId = await addSdkReaction(channel, { messageId: 'om_user', emoji: 'THUMBSUP' });
assert.equal(reactionId, 'reaction_1');
assert.deepEqual(calls.pop(), { method: 'addReaction', messageId: 'om_user', emojiType: 'THUMBSUP' });

const removed = await removeSdkReactionByEmoji(channel, { messageId: 'om_user', emoji: 'MeMeMe' });
assert.equal(removed, true);
assert.deepEqual(calls.pop(), {
  method: 'removeReactionByEmoji',
  messageId: 'om_user',
  emojiType: 'MeMeMe',
});

assert.deepEqual(deferSdkReply({ messageId: 'om_user', reason: 'handled elsewhere' }), {
  deferred: true,
  messageId: 'om_user',
  reason: 'handled elsewhere',
});

assert.throws(
  () => sendSdkReply(channel, { chatId: 'oc_reply', text: '', card: undefined }),
  /text or card/i,
);

console.log('sdk-outbound-parity smoke: PASS');
