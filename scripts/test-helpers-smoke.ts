import assert from 'node:assert/strict';

import {
  createMockLarkClient,
  createMockTransport,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} from './test-helpers/tool-fixtures.js';

const { server, handlers, getTool } = createToolServerHarness();
server.registerTool('sample_tool', {}, async (args: { value: string }) => ({
  content: [{ type: 'text' as const, text: args.value }],
}));

assert.equal(handlers.has('sample_tool'), true);
assert.equal((await getTool('sample_tool')({ value: 'ok' })).content[0].text, 'ok');
assert.throws(() => getTool('missing_tool'), /missing_tool/);

const memory = createNoopMemoryStore({
  searchSkills: async () => ['custom skill'],
});
assert.deepEqual(await memory.searchSkills('custom'), ['custom skill']);
assert.equal(await memory.healthCheck(), true);

const client = createMockLarkClient({
  im: {
    v1: {
      message: {
        create: async () => ({ data: { message_id: 'om_custom' } }),
      },
    },
  },
});
assert.equal((await client.im.v1.message.create({})).data.message_id, 'om_custom');
assert.equal((await client.im.v1.image.create({})).data.image_key, 'img');

const transport = createMockTransport({
  addReaction: async () => 'reaction_custom',
});
assert.equal(await transport.addReaction('om_1', 'MeMeMe'), 'reaction_custom');
assert.deepEqual(await transport.sendMessage({ chatId: 'oc_1', input: { text: 'hello' } }), {
  messageId: 'om_sent',
});

const channel = createPrivateChatChannel((chatId) => chatId === 'oc_private');
assert.equal(channel.isPrivateChat('oc_private'), true);
assert.equal(channel.isPrivateChat('oc_group'), false);

console.log('test-helpers smoke: PASS');
