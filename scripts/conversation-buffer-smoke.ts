import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { ConversationBuffer } = await import('../src/memory/buffer.js');

const buffer = new ConversationBuffer();
const requests: any[] = [];
buffer.setFlushHandler(async (request) => {
  requests.push(request);
  return { summary: `summary for ${request.messages.length}` };
});

buffer.record('oc_buffer', {
  role: 'user',
  senderId: 'ou_a',
  text: 'thread one message',
  timestamp: '2026-07-13T00:00:00.000Z',
  threadId: 'omt_one',
});
buffer.record('oc_buffer', {
  role: 'user',
  senderId: 'ou_b',
  text: 'thread two message',
  timestamp: '2026-07-13T00:01:00.000Z',
  threadId: 'omt_two',
});

let result = await buffer.flushNow('oc_buffer', { threadId: 'omt_one', reason: 'manual' });
assert.equal(result.status, 'flushed');
assert.equal(result.messageCount, 1);
assert.equal(result.summary, 'summary for 1');
assert.equal(requests.at(-1).threadId, 'omt_one');
assert.equal(requests.at(-1).reason, 'manual');
assert.deepEqual(buffer.getMessages('oc_buffer').map((message) => message.text), ['thread two message']);

buffer.setFlushHandler(async () => {
  throw new Error('distillation failed');
});
await assert.rejects(
  () => buffer.flushNow('oc_buffer', { threadId: 'omt_two', reason: 'new_session' }),
  /distillation failed/,
);
assert.deepEqual(buffer.getMessages('oc_buffer').map((message) => message.text), ['thread two message']);

buffer.setFlushHandler(async (request) => {
  requests.push(request);
  return { summary: 'commit gate summary' };
});
await assert.rejects(
  () => buffer.flushNow('oc_buffer', {
    threadId: 'omt_two',
    reason: 'new_session',
    commitBeforeRemove: async () => {
      throw new Error('boundary commit failed');
    },
  }),
  /boundary commit failed/,
);
assert.deepEqual(buffer.getMessages('oc_buffer').map((message) => message.text), ['thread two message']);

let releaseFlush!: () => void;
buffer.setFlushHandler(async () => {
  await new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  return { summary: 'done' };
});
const firstFlush = buffer.flushNow('oc_buffer', { reason: 'manual' });
result = await buffer.flushNow('oc_buffer', { reason: 'manual' });
assert.equal(result.status, 'busy');
assert.equal(result.messageCount, 1);
releaseFlush();
result = await firstFlush;
assert.equal(result.status, 'flushed');
assert.deepEqual(buffer.getMessages('oc_buffer'), []);

result = await buffer.flushNow('oc_buffer', { reason: 'manual' });
assert.equal(result.status, 'empty');
assert.equal(result.messageCount, 0);

console.log('conversation-buffer smoke: PASS');
