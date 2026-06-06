/**
 * Codex exec delivery smoke test.
 *
 * Verifies the fallback path used when Codex no longer consumes
 * notifications/Codex/channel: an inbound Feishu message is converted into a
 * one-shot `codex exec` prompt, then the final answer is sent back through the
 * normal Feishu reply path.
 */
import assert from 'node:assert/strict';
import { deliverMessageViaCodexExec } from '../src/codex-exec-delivery.js';
import type { LarkMessage } from '../src/channel.js';
import type { ReplyRequest } from '../src/reply-sender.js';

const message: LarkMessage = {
  messageId: 'om_inbound_001',
  chatId: 'oc_group_001',
  chatType: 'group',
  senderId: 'ou_sender_001',
  senderName: 'Kevin',
  chatName: 'Codex Test Group',
  text: '[Memory Context]\n(none)\n\n[Current Message]\nFrom: ou_sender_001 in oc_group_001\n@Codex ping',
  messageType: 'text',
  rawContent: '{"text":"@_user_1 ping"}',
  threadId: 'omt_thread_001',
  botMentioned: true,
  imagePaths: ['/tmp/lark-img-1.png', '/tmp/lark-img-2.png'],
};

const execRequests: any[] = [];
const replyRequests: ReplyRequest[] = [];

await deliverMessageViaCodexExec({
  message,
  displayLabel: 'Kevin · Codex Test Group · thread_ad_001',
  runCodexExec: async (request) => {
    execRequests.push(request);
    return 'pong from codex';
  },
  sendReply: async (request) => {
    replyRequests.push(request);
    return { sentCount: 1 };
  },
});

assert.equal(execRequests.length, 1);
assert.match(execRequests[0].prompt, /Reply to this Feishu\/Lark message/);
assert.match(execRequests[0].prompt, /message_id: om_inbound_001/);
assert.match(execRequests[0].prompt, /chat_id: oc_group_001/);
assert.match(execRequests[0].prompt, /thread_id: omt_thread_001/);
assert.match(execRequests[0].prompt, /Kevin · Codex Test Group/);
assert.match(execRequests[0].prompt, /@Codex ping/);
assert.deepEqual(execRequests[0].imagePaths, ['/tmp/lark-img-1.png', '/tmp/lark-img-2.png']);

assert.deepEqual(replyRequests, [
  {
    chat_id: 'oc_group_001',
    text: 'pong from codex',
    reply_to: 'om_inbound_001',
    thread_id: 'omt_thread_001',
  },
]);

console.log('PASS');
