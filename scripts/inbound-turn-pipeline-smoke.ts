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

const persistedOrigin = {
  messageId: 'om_persisted_cron_report',
  chatId: 'oc_group_pipeline',
  jobId: 'daily-report',
  runId: 'cron_run_daily_001',
  jobName: 'Daily report',
  jobCreatedAt: '2026-11-01T00:00:00.000Z',
  recordedAt: '2026-11-15T01:00:00.000Z',
};
const persistedQuotedMessage: LarkMessage = {
  ...quotedCronMessage,
  messageId: 'om_quote_persisted_report',
  parentId: persistedOrigin.messageId,
};
await prepareInboundTurn(persistedQuotedMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: new AckReactionTracker(),
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
  cronMessageOrigins: { get: async () => persistedOrigin },
}, { resources: [] });
assert.equal(persistedQuotedMessage.quotedCronJobId, 'daily-report');
assert.deepEqual(persistedQuotedMessage.quotedCronJobOrigin, persistedOrigin);

const topicReplyMessage: LarkMessage = {
  ...quotedCronMessage,
  messageId: 'om_topic_reply',
  parentId: 'om_unmapped_topic_reply',
  rootMessageId: persistedOrigin.messageId,
};
const topicLookups: string[] = [];
await prepareInboundTurn(topicReplyMessage, {
  latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
  ackReactions: new AckReactionTracker(),
  larkTransport: transport,
  chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
  cronMessageOrigins: {
    get: async (messageId) => {
      topicLookups.push(messageId);
      return messageId === persistedOrigin.messageId ? persistedOrigin : null;
    },
  },
}, { resources: [] });
assert.deepEqual(topicLookups, ['om_unmapped_topic_reply', persistedOrigin.messageId]);
assert.equal(topicReplyMessage.quotedCronJobId, 'daily-report');
assert.deepEqual(topicReplyMessage.quotedCronJobOrigin, persistedOrigin);

for (const [lookupIndex, lookup] of [
  { get: async () => null },
  { get: async () => { throw new Error('origin store unavailable'); } },
  { get: async () => ({ ...persistedOrigin, chatId: 'oc_other_chat' }) },
].entries()) {
  const unmappedMessage: LarkMessage = {
    ...quotedCronMessage,
    messageId: `om_unmapped_${lookupIndex}`,
    quotedCronJobId: undefined,
    quotedCronJobOrigin: undefined,
  };
  await prepareInboundTurn(unmappedMessage, {
    latestMessageTracker: { record: (chatId, msg) => latestRecords.push({ chatId, ...msg }) },
    ackReactions: new AckReactionTracker(),
    larkTransport: transport,
    chatTypeCache: { set: (chatId, chatType) => chatTypes.set(chatId, chatType) },
    cronMessageOrigins: lookup,
    botMessageTracker: {
      get: () => ({
        messageId: 'om_cron_report',
        chatId: 'oc_group_pipeline',
        threadId: 'job-covered-call-abc123def456-1760000000000',
        timestamp: Date.now(),
      }),
    },
  }, { resources: [] });
  assert.equal(
    unmappedMessage.quotedCronJobId,
    undefined,
    'configured persistent lookup must fail closed instead of falling back to thread metadata',
  );
}

console.log('inbound-turn-pipeline smoke: PASS');
