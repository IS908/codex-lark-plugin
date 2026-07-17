import assert from 'node:assert/strict';
import { AckReactionTracker } from '../src/ack-reactions.js';
import { prepareInboundTurn } from '../src/inbound-turn-pipeline.js';
import type { LarkMessage } from '../src/lark-message.js';

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
  resources: [],
});
await waitTick();
assert.equal(latestRecords.at(-1)?.messageId, 'om_sdk_pipeline');
assert.equal(sdkAck.hasRecentInbound('om_sdk_pipeline'), true);
assert.equal(sdkAck.activeCount, 1);
assert.deepEqual(reactionCalls.at(-1), { messageId: 'om_sdk_pipeline', emoji: 'Typing' });
assert.equal(chatTypes.get('oc_sdk_pipeline'), 'p2p');

const groupMessage: LarkMessage = {
  messageId: 'om_group_pipeline',
  chatId: 'oc_group_pipeline',
  chatType: 'group',
  senderId: 'ou_sender',
  text: 'hello group',
  messageType: 'text',
  threadId: 'omt_group',
  rawContent: '{}',
};
const groupAck = new AckReactionTracker();
await prepareInboundTurn(groupMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: groupAck,
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
}, {
  resources: [],
});
await waitTick();
assert.equal(latestRecords.at(-1)?.threadId, 'omt_group');
assert.equal(groupAck.hasRecentInbound('om_group_pipeline'), true);
assert.equal(chatTypes.get('oc_group_pipeline'), 'group');

const quotedCronMessage: LarkMessage = {
  messageId: 'om_quote_cron_report',
  chatId: 'oc_group_pipeline',
  chatType: 'group',
  senderId: 'ou_sender',
  text: 'rerun this task',
  messageType: 'text',
  parentId: 'om_cron_report',
  rawContent: '{}',
};
await prepareInboundTurn(quotedCronMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: new AckReactionTracker(),
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
  botMessageTracker: {
    get: (messageId: string) => messageId === 'om_cron_report'
      ? {
          messageId,
          chatId: 'oc_group_pipeline',
          threadId: 'job-covered-call-abc123def456-1760000000000',
          timestamp: Date.now(),
        }
      : undefined,
  },
}, {
  resources: [],
});
assert.equal(quotedCronMessage.quotedCronJobId, 'covered-call');

console.log('inbound-turn-pipeline smoke: PASS');
