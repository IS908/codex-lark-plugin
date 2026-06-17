import assert from 'node:assert/strict';
import { AckReactionTracker } from '../src/ack-reactions.js';
import { prepareInboundTurn } from '../src/inbound-turn-pipeline.js';
import type { LarkMessage } from '../src/channel.js';

function waitTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const latestRecords: any[] = [];
const chatTypes = new Map<string, 'p2p' | 'group'>();
const reactionCalls: Array<{ messageId: string; emoji: string }> = [];
const transport = {
  addReaction: async (messageId: string, emoji: string) => {
    reactionCalls.push({ messageId, emoji });
    return `reaction_${messageId}`;
  },
  removeReaction: async () => {},
  fetchMessageText: async () => null,
  fetchMessageContext: async () => null,
  downloadResource: async () => Buffer.from('unused'),
} as any;

const sdkMessage: LarkMessage = {
  messageId: 'om_sdk_pipeline',
  chatId: 'oc_sdk_pipeline',
  chatType: 'p2p',
  senderId: 'ou_sender',
  text: 'hello sdk',
  messageType: 'text',
  rawContent: '{}',
};
const sdkAck = new AckReactionTracker();
await prepareInboundTurn(sdkMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: sdkAck,
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
}, {
  kind: 'sdk',
  resources: [],
});
await waitTick();
assert.equal(latestRecords.at(-1)?.messageId, 'om_sdk_pipeline');
assert.equal(sdkAck.hasRecentInbound('om_sdk_pipeline'), true);
assert.equal(sdkAck.activeCount, 1);
assert.deepEqual(reactionCalls.at(-1), { messageId: 'om_sdk_pipeline', emoji: 'Typing' });
assert.equal(chatTypes.get('oc_sdk_pipeline'), 'p2p');

const legacyMessage: LarkMessage = {
  messageId: 'om_legacy_pipeline',
  chatId: 'oc_legacy_pipeline',
  chatType: 'group',
  senderId: 'ou_sender',
  text: 'hello legacy',
  messageType: 'text',
  threadId: 'omt_legacy',
  rawContent: JSON.stringify({ text: 'hello legacy' }),
};
const legacyAck = new AckReactionTracker();
await prepareInboundTurn(legacyMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: legacyAck,
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
}, {
  kind: 'legacy',
  rawContent: legacyMessage.rawContent,
  messageType: legacyMessage.messageType,
  resolveChatName: async () => 'Pipeline Group',
});
await waitTick();
assert.equal(legacyMessage.chatName, 'Pipeline Group');
assert.equal(latestRecords.at(-1)?.threadId, 'omt_legacy');
assert.equal(legacyAck.hasRecentInbound('om_legacy_pipeline'), true);
assert.equal(chatTypes.get('oc_legacy_pipeline'), 'group');

console.log('inbound-turn-pipeline smoke: PASS');
