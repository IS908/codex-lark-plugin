import assert from 'node:assert/strict';
import { buildRecentThreadContext } from '../src/recent-thread-context.js';
import { enrichmentPrompt } from '../src/prompts.js';
import type { BufferedMessage } from '../src/memory/buffer.js';

const messages: BufferedMessage[] = [
  {
    role: 'user',
    senderId: 'ou_user',
    text: 'oldest turn',
    timestamp: '2026-06-18T01:00:00.000Z',
    timestampMs: 1781744400000,
    messageId: 'om_oldest',
    threadId: 'omt_thread',
    messageType: 'text',
  },
  {
    role: 'assistant',
    senderId: 'bot',
    text: 'oldest reply',
    timestamp: '2026-06-18T01:00:10.000Z',
    timestampMs: 1781744410000,
    messageId: 'om_oldest_bot',
    threadId: 'omt_thread',
    messageType: 'text',
  },
  {
    role: 'assistant',
    senderId: 'bot',
    text: 'second reply sorted by position',
    timestamp: '2026-06-18T01:01:10.000Z',
    timestampMs: 1781744470000,
    messagePosition: '30',
    messageId: 'om_second_bot',
    threadId: 'omt_thread',
    messageType: 'text',
  },
  {
    role: 'user',
    senderId: 'ou_user',
    text: 'second user turn',
    timestamp: '2026-06-18T01:01:10.000Z',
    timestampMs: 1781744470000,
    messagePosition: '20',
    messageId: 'om_second_user',
    threadId: 'omt_thread',
    messageType: 'text',
  },
  {
    role: 'user',
    senderId: 'ou_user',
    text: 'other thread should not leak',
    timestamp: '2026-06-18T01:01:20.000Z',
    timestampMs: 1781744480000,
    messageId: 'om_other_thread',
    threadId: 'omt_other',
    messageType: 'text',
  },
  {
    role: 'user',
    senderId: 'ou_user',
    text: 'What changed?',
    timestamp: '2026-06-18T01:02:00.000Z',
    timestampMs: 1781744520000,
    messageId: 'om_current',
    threadId: 'omt_thread',
    messageType: 'text',
  },
];

const context = buildRecentThreadContext({
  chatId: 'oc_chat',
  threadId: 'omt_thread',
  currentMessageId: 'om_current',
  messages,
});
assert(context);
assert.doesNotMatch(context!, /om_oldest/);
assert.doesNotMatch(context!, /other thread should not leak/);
assert.match(context!, /message_id: om_second_user/);
assert.match(context!, /message_id: om_second_bot/);
assert.match(context!, /message_id: om_current/);
assert(context!.indexOf('message_id: om_second_user') < context!.indexOf('message_id: om_second_bot'));
assert(context!.trim().endsWith('What changed?'));
assert.match(context!, /current: true/);

const quotedContext = buildRecentThreadContext({
  chatId: 'oc_chat',
  threadId: 'omt_thread',
  currentMessageId: 'om_current',
  messages: [
    {
      role: 'user',
      senderId: 'ou_user',
      text: 'Quoted body text',
      timestamp: '2026-06-18T01:01:00.000Z',
      timestampMs: 1781744460000,
      messageId: 'om_quoted',
      threadId: 'omt_thread',
      messageType: 'text',
    },
    messages.at(-1)!,
  ],
  quotedContent: ['message_id: om_quoted', 'content:', 'Quoted body text'].join('\n'),
});
assert.match(quotedContext ?? '', /message_id: om_quoted/);
assert.match(quotedContext ?? '', /\[body duplicated in Quoted Message section\]/);
assert.doesNotMatch(quotedContext ?? '', /content:\nQuoted body text/);

const truncatedContext = buildRecentThreadContext({
  chatId: 'oc_chat',
  threadId: 'omt_thread',
  currentMessageId: 'om_current_long',
  messages: [
    {
      role: 'user',
      senderId: 'ou_user',
      text: `first paragraph\n\n${'tail '.repeat(200)}`,
      timestamp: '2026-06-18T01:02:00.000Z',
      timestampMs: 1781744520000,
      messageId: 'om_current_long',
      threadId: 'omt_thread',
      messageType: 'text',
    },
  ],
  options: { maxBytes: 360, bodyMaxBytes: 80 },
});
assert.match(truncatedContext ?? '', /message_id: om_current_long/);
assert.match(truncatedContext ?? '', /timestamp_ms: 1781744520000/);
assert.match(truncatedContext ?? '', /first paragraph/);
assert.match(truncatedContext ?? '', /\.\.\.\[truncated\]/);

assert.equal(buildRecentThreadContext({
  chatId: 'oc_chat',
  threadId: 'omt_thread',
  currentMessageId: 'om_current',
  messages: [],
}), undefined);

const prompt = enrichmentPrompt('', undefined, 'ou_user', 'oc_chat', 'What changed?', context);
assert.match(prompt, /\[Recent Thread Context\]/);
assert(prompt.indexOf('[Recent Thread Context]') < prompt.indexOf('[Current Message]'));

console.log('recent-thread-context smoke: PASS');
