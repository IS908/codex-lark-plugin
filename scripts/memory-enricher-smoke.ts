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

// Keep the public channel path wired through the same enricher boundary.
const channel = new LarkChannel();
channel.setMemoryStore({
  getProfile: async () => '- channel profile',
  searchEpisodes: async () => [],
  searchSkills: async () => [],
} as any);
const handled: any[] = [];
channel.setMessageHandler(async (message) => handled.push(message));
await (channel as any).processEnqueuedMessage({
  messageId: 'om_channel_enrich',
  chatId: 'oc_channel_enrich',
  chatType: 'p2p',
  senderId: 'ou_owner',
  text: 'hello',
  messageType: 'text',
  rawContent: '{}',
});
assert.match(handled[0].text, /channel profile/);

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
