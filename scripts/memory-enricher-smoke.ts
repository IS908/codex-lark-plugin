import assert from 'node:assert/strict';
import { LarkChannel } from '../src/channel.js';
import { enrichLarkMessageWithMemory } from '../src/memory-enricher.js';
import { MemoryContextDeduper } from '../src/memory-context-dedup.js';
import { ConversationBuffer } from '../src/memory/buffer.js';

const buffer = new ConversationBuffer();
buffer.record('oc_enrich', {
  role: 'assistant',
  senderId: 'bot',
  text: 'Previous answer',
  timestamp: '2026-06-18T01:00:00.000Z',
  timestampMs: 1781744400000,
  messageId: 'om_prev_bot',
  threadId: 'omt_enrich',
  messageType: 'text',
});
buffer.record('oc_enrich', {
  role: 'user',
  senderId: 'ou_owner',
  text: 'ok',
  timestamp: '2026-06-18T01:01:00.000Z',
  timestampMs: 1781744460000,
  messageId: 'om_current',
  threadId: 'omt_enrich',
  messageType: 'text',
});

const prompt = await enrichLarkMessageWithMemory({
  messageId: 'om_current',
  chatId: 'oc_enrich',
  chatType: 'group',
  senderId: 'ou_owner',
  text: 'ok',
  messageType: 'text',
  threadId: 'omt_enrich',
  mentions: [{ id: 'ou_peer', name: 'Peer' }],
  rawContent: '{}',
}, {
  conversationBuffer: buffer,
  memoryDeduper: new MemoryContextDeduper({ windowMs: 30_000 }),
  memoryStore: {
    getProfile: async (ownerId: string) => ownerId === 'ou_owner' ? '- owner profile' : '- peer public profile',
    searchEpisodes: async (_query: string, scope: any) => [{
      id: scope.threadId ? 'thread_ep' : 'chat_ep',
      timestamp: '2026-06-18T00:00:00.000Z',
      content: scope.threadId ? 'thread memory' : 'chat memory',
      score: 0.91,
    }],
    searchSkills: async () => [{
      name: 'Review',
      description: 'Review carefully',
      score: 0.95,
    }],
  } as any,
});

assert.match(prompt, /\[Recent Thread Context\]/);
assert.match(prompt, /message_id: om_current/);
assert.match(prompt, /current: true/);
assert.match(prompt, /owner profile/);
assert.match(prompt, /peer public profile/);
assert.match(prompt, /thread memory/);
assert.match(prompt, /chat memory/);
assert.match(prompt, /Review carefully/);

const noStorePrompt = await enrichLarkMessageWithMemory({
  messageId: 'om_no_store',
  chatId: 'oc_no_store',
  chatType: 'p2p',
  senderId: 'ou_owner',
  text: 'hello',
  messageType: 'text',
  rawContent: '{}',
}, {
  conversationBuffer: null,
  memoryDeduper: new MemoryContextDeduper({ windowMs: 0 }),
  memoryStore: null,
});
assert.match(noStorePrompt, /\[Memory Context\]/);
assert.match(noStorePrompt, /\(empty\)/);

const boundaryBuffer = new ConversationBuffer();
boundaryBuffer.record('oc_boundary', {
  role: 'user',
  senderId: 'ou_owner',
  text: 'OLD_RECENT_CANARY should not cross /new',
  timestamp: '2026-06-18T01:00:00.000Z',
  timestampMs: 1781744400000,
  messageId: 'om_old_recent',
  threadId: 'omt_boundary',
  messageType: 'text',
});
boundaryBuffer.record('oc_boundary', {
  role: 'user',
  senderId: 'ou_owner',
  text: 'fresh boundary turn',
  timestamp: '2026-06-18T01:02:00.000Z',
  timestampMs: 1781744520000,
  messageId: 'om_boundary_current',
  threadId: 'omt_boundary',
  messageType: 'text',
});
const boundaryPrompt = await enrichLarkMessageWithMemory({
  messageId: 'om_boundary_current',
  chatId: 'oc_boundary',
  chatType: 'group',
  senderId: 'ou_owner',
  text: 'fresh boundary turn',
  messageType: 'text',
  threadId: 'omt_boundary',
  parentContent: [
    'kind: lark_message',
    'message_id: om_old_quoted',
    'msg_type: text',
    'timestamp_ms: 1781744400000',
    'hydration_status: success',
    'content:',
    'OLD_QUOTED_CANARY should not cross /new',
  ].join('\n'),
  rawContent: '{}',
}, {
  conversationBuffer: boundaryBuffer,
  conversationBoundary: {
    generation: 2,
    cutoffMessageId: 'om_new_boundary',
    cutoffTimestampMs: 1781744460000,
    handoffSummary: 'HANDOFF_SUMMARY_CANARY',
  },
  memoryDeduper: new MemoryContextDeduper({ windowMs: 0 }),
  memoryStore: null,
});
assert.match(boundaryPrompt, /HANDOFF_SUMMARY_CANARY/);
assert.match(boundaryPrompt, /fresh boundary turn/);
assert.match(boundaryPrompt, /reason: before_conversation_boundary/);
assert.doesNotMatch(boundaryPrompt, /OLD_RECENT_CANARY/);
assert.doesNotMatch(boundaryPrompt, /OLD_QUOTED_CANARY/);

// Keep the public channel path wired through the same enricher boundary.
const channel = new LarkChannel();
channel.setMemoryStore({
  getProfile: async () => '- channel profile',
  searchEpisodes: async () => [],
  searchSkills: async () => [],
} as any);
let consumedHandoff: any = null;
channel.setConversationBoundaryProvider({
  get: async () => ({
    generation: 4,
    cutoffMessageId: 'om_channel_new',
    cutoffTimestampMs: 1,
    handoffSummary: 'CHANNEL_HANDOFF_SUMMARY',
  }),
  markHandoffConsumed: async (chatId, threadId, generation) => {
    consumedHandoff = { chatId, threadId, generation };
  },
});
const handled: any[] = [];
channel.setMessageHandler(async (message) => handled.push(message));
await (channel as any).processEnqueuedMessage({
  messageId: 'om_channel_enrich',
  chatId: 'oc_channel_enrich',
  chatType: 'p2p',
  senderId: 'ou_owner',
  text: 'hello',
  messageType: 'text',
  parentContent: [
    'kind: lark_message',
    'message_id: om_channel_old_parent',
    'msg_type: text',
    'timestamp_ms: 0',
    'hydration_status: success',
    'content:',
    'CHANNEL_PARENT_OLD_CANARY',
  ].join('\n'),
  rawContent: '{}',
});
assert.match(handled[0].text, /channel profile/);
assert.match(handled[0].text, /CHANNEL_HANDOFF_SUMMARY/);
assert.match(handled[0].parentContent, /reason: before_conversation_boundary/);
assert.doesNotMatch(handled[0].text, /CHANNEL_PARENT_OLD_CANARY/);
assert.doesNotMatch(handled[0].parentContent, /CHANNEL_PARENT_OLD_CANARY/);
assert.deepEqual(consumedHandoff, {
  chatId: 'oc_channel_enrich',
  threadId: undefined,
  generation: 4,
});

const controlChannel = new LarkChannel();
let controlHandled = 0;
controlChannel.setControlMessageHandler(async () => {
  controlHandled += 1;
  return true;
});
controlChannel.setMemoryStore({
  getProfile: async () => {
    throw new Error('control command should bypass memory enrichment');
  },
  searchEpisodes: async () => [],
  searchSkills: async () => [],
} as any);
controlChannel.setMessageHandler(async () => {
  throw new Error('control command should bypass message handler');
});
await (controlChannel as any).processEnqueuedMessage({
  messageId: 'om_channel_control',
  chatId: 'oc_channel_control',
  chatType: 'p2p',
  senderId: 'ou_owner',
  text: '/model gpt-5',
  messageType: 'text',
  rawContent: '{"text":"/model gpt-5"}',
});
assert.equal(controlHandled, 1);

console.log('memory-enricher smoke: PASS');
