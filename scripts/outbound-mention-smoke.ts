import assert from 'node:assert/strict';
import type {
  LarkChatMember,
  LarkTransportSendRequest,
} from '../src/lark-transport-contracts.js';
import { renderOutboundMentions } from '../src/outbound-mentions.js';
import { sendFeishuReply } from '../src/reply-sender.js';
import { buildCards } from '../src/feishu-card.js';

const members: LarkChatMember[] = [
  { id: 'ou_alice', idType: 'open_id', name: 'Alice' },
  { id: 'ou_zhangsan', idType: 'open_id', name: '张三' },
  { id: 'ou_alex_one', idType: 'open_id', name: 'Alex' },
  { id: 'ou_alex_two', idType: 'open_id', name: 'Alex' },
];

const source = [
  '@Alice please review with @张三.',
  '',
  'Email alice@example.com and leave @Unknown unchanged.',
  '',
  '`notify @Alice`',
  '',
  '```sh',
  'notify @Alice',
  '```',
  '',
  '    notify @Alice',
  '',
  '@Alex is ambiguous.',
].join('\n');

const rendered = renderOutboundMentions(source, members);
assert.equal(rendered.resolvedCount, 2);
assert.ok(rendered.text.includes('<at user_id="ou_alice">Alice</at> please review'));
assert.ok(rendered.text.includes('<at user_id="ou_zhangsan">张三</at>.'));
assert.ok(rendered.cardMarkdown.includes('<at id=ou_alice></at> please review'));
assert.ok(rendered.cardMarkdown.includes('<at id=ou_zhangsan></at>.'));
for (const expected of [
  'alice@example.com',
  '@Unknown',
  '`notify @Alice`',
  'notify @Alice\n```',
  '    notify @Alice',
  '@Alex is ambiguous',
]) {
  assert.ok(rendered.text.includes(expected), `text should preserve ${expected}`);
  assert.ok(rendered.cardMarkdown.includes(expected), `card should preserve ${expected}`);
}

const mixedIdentityDuplicate = renderOutboundMentions('@Alice stays ambiguous.', [
  { id: 'ou_alice', idType: 'open_id', name: 'Alice' },
  { id: 'user_alice', idType: 'user_id', name: 'Alice' },
]);
assert.equal(mixedIdentityDuplicate.resolvedCount, 0);
assert.equal(mixedIdentityDuplicate.text, '@Alice stays ambiguous.');

// Card chunking must never split a generated native mention tag.
for (let prefixLength = 3900; prefixLength <= 4050; prefixLength++) {
  const longSource = `# Report\n\n${'x'.repeat(prefixLength)} @Alice done`;
  const longRendered = renderOutboundMentions(longSource, members);
  const cardJson = JSON.stringify(buildCards(longRendered.cardMarkdown));
  assert.ok(
    cardJson.includes('<at id=ou_alice></at>'),
    `card mention was split at prefix length ${prefixLength}`,
  );
}

function transportHarness(options: { rosterError?: Error } = {}) {
  const sends: LarkTransportSendRequest[] = [];
  const tracked: Array<{ id: string; meta: any }> = [];
  let rosterReads = 0;
  const transport = {
    async getChatMembers() {
      rosterReads++;
      if (options.rosterError) throw options.rosterError;
      return members;
    },
    async sendMessage(request: LarkTransportSendRequest) {
      sends.push(request);
      return { messageId: `om_${sends.length}` };
    },
  };
  return {
    sends,
    tracked,
    get rosterReads() { return rosterReads; },
    deps: {
      client: {} as any,
      transport: transport as any,
      botMessageTracker: {
        add(id: string, meta: any) { tracked.push({ id, meta }); },
      } as any,
    },
  };
}

// Plain text replies use the native text-message mention syntax.
{
  const harness = transportHarness();
  const result = await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: '@Alice please review.',
    format: 'text',
    routing: 'standalone',
  });
  assert.equal(result.isError, undefined);
  assert.equal(harness.rosterReads, 1);
  assert.deepEqual(harness.sends[0].input, {
    text: '<at user_id="ou_alice">Alice</at> please review.',
  });
}

// Generated Schema 2.0 cards use CardKit markdown mention syntax.
{
  const harness = transportHarness();
  const result = await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: '# Review\n\n@Alice please review.',
    routing: 'standalone',
  });
  assert.equal(result.isError, undefined);
  assert.equal(harness.rosterReads, 1);
  assert.ok('card' in harness.sends[0].input);
  const cardJson = JSON.stringify('card' in harness.sends[0].input ? harness.sends[0].input.card : null);
  assert.ok(cardJson.includes('<at id=ou_alice></at> please review.'));
  assert.ok(!cardJson.includes('<at user_id='));
  assert.ok(harness.tracked[0].meta.quotedContext.text.includes('@Alice please review.'));
}

// Roster lookup failures are fail-open for delivery and preserve visible text.
{
  const harness = transportHarness({ rosterError: new Error('missing chat member permission') });
  const result = await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: '@Alice delivery must continue.',
    format: 'text',
    routing: 'standalone',
  });
  assert.equal(result.isError, undefined);
  assert.equal(harness.rosterReads, 1);
  assert.deepEqual(harness.sends[0].input, { text: '@Alice delivery must continue.' });
}

// Caller-supplied raw cards are authoritative and never trigger heuristic rewriting.
{
  const harness = transportHarness();
  const rawCard = JSON.stringify({
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content: '@Alice stays literal.' }] },
  });
  await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: '@Alice stays literal.',
    card: rawCard,
    routing: 'standalone',
  });
  assert.equal(harness.rosterReads, 0);
  assert.deepEqual(harness.sends[0].input, { card: JSON.parse(rawCard) });
}

// Text without a candidate never performs a roster lookup.
{
  const harness = transportHarness();
  await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: 'No mention here.',
    format: 'text',
    routing: 'standalone',
  });
  assert.equal(harness.rosterReads, 0);
}

// Mentions that appear only in Markdown code are not identity lookups.
{
  const harness = transportHarness();
  await sendFeishuReply(harness.deps, {
    chat_id: 'oc_mentions',
    text: '`@Alice`\n\n```sh\nnotify @Alice\n```',
    format: 'text',
    routing: 'standalone',
  });
  assert.equal(harness.rosterReads, 0);
  assert.deepEqual(harness.sends[0].input, {
    text: '`@Alice`\n\n```sh\nnotify @Alice\n```',
  });
}

console.log('outbound mention smoke: PASS');
