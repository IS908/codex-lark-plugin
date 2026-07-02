/**
 * Reply tool raw-card path smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify the card param behavior without network.
 * Exits non-zero if any assertion fails.
 */
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';
import { AckReactionTracker } from '../src/ack-reactions.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ── Mock helpers ──

/** Capture calls to the mock Lark client */
const apiCalls: { method: string; args: any }[] = [];
let failInteractiveSends = false;

function mockLarkClient() {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            if (failInteractiveSends && args?.data?.msg_type === 'interactive') {
              throw new Error('mock interactive send failure');
            }
            apiCalls.push({ method: 'message.create', args });
            return { data: { message_id: 'mock_msg_001' } };
          },
          reply: async (args: any) => {
            if (failInteractiveSends && args?.data?.msg_type === 'interactive') {
              throw new Error('mock interactive reply failure');
            }
            apiCalls.push({ method: 'message.reply', args });
            return { data: { message_id: 'mock_msg_002' } };
          },
        },
        messageReaction: {
          create: async (args: any) => {
            apiCalls.push({ method: 'messageReaction.create', args });
          },
          delete: async (args: any) => {
            apiCalls.push({ method: 'messageReaction.delete', args });
          },
        },
        image: {
          create: async () => ({ data: { image_key: 'img_mock' } }),
          get: async () => Buffer.from('fake'),
        },
        file: {
          create: async () => ({ data: { file_key: 'file_mock' } }),
        },
        messageResource: {
          get: async () => Buffer.from('fake'),
        },
      },
    },
  };
}

/** Minimal no-op MemoryStore (matches the real class shape; methods reply-card doesn't use are still present as no-ops). */
const noopMemory = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async () => {},
} as unknown as MemoryStore;

/** ConversationBuffer that records calls */
function makeBuffer() {
  const recorded: any[] = [];
  return {
    recorded,
    record(chatId: string, entry: any) { recorded.push({ chatId, entry }); },
    flush: async () => {},
    startAutoFlush: () => {},
    stopAutoFlush: () => {},
  };
}

// ── Capture registered tool handlers via a fake McpServer ──

const handlers = new Map<string, (args: any) => Promise<any>>();

const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

// ── Tests ──

async function run() {
  const client = mockLarkClient();
  const botTrackerAdded: Array<{ id: string; meta: any }> = [];
  const botTracker = {
    ids: new Set<string>(),
    maxSize: 500,
    set: new Set<string>(),
    add(id: string, meta: any = {}) { botTrackerAdded.push({ id, meta }); this.ids.add(id); },
    has(id: string) { return this.ids.has(id); },
  };
  const buffer = makeBuffer();
  const ackReactions = new AckReactionTracker({ maxTrackedMessages: 20 });

  // Register tools (captures handlers via fake server)
  const identitySession = new IdentitySession(() => null);
  // Bind a fake caller so resolveCaller-gated tools can be exercised.
  identitySession.setCaller('chat_001', undefined, 'ou_reply_smoke');
  const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;

  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    buffer as any,
    ackReactions,
    botTracker as any,
    undefined,
  );

  const replyHandler = handlers.get('reply');
  if (!replyHandler) fail('replyHandler not captured');

  const validCard = JSON.stringify({ type: 'template', data: { template_id: 't1' } });

  // ── Test 1: valid card JSON → message.create with msg_type=interactive ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;
  buffer.recorded.length = 0;

  const r1 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: validCard,
  });

  if (r1.isError) fail(`Test 1: unexpected error: ${r1.content[0].text}`);
  if (r1.content[0].text !== 'Sent 1 card message') fail(`Test 1: wrong result: ${r1.content[0].text}`);

  const createCall = apiCalls.find((c) => c.method === 'message.create');
  if (!createCall) fail('Test 1: message.create not called');
  if (createCall.args.data.msg_type !== 'interactive') fail('Test 1: msg_type should be interactive');
  if (!createCall.args.data.uuid) fail('Test 1: message.create missing uuid');

  const sentContent = JSON.parse(createCall.args.data.content);
  if (sentContent.type !== 'template') fail('Test 1: card content not passed through');

  if (botTrackerAdded.length !== 1 || botTrackerAdded[0].id !== 'mock_msg_001') {
    fail(`Test 1: botTracker not updated: ${JSON.stringify(botTrackerAdded)}`);
  }
  if (botTrackerAdded[0].meta.quotedContext?.msgType !== 'interactive') {
    fail(`Test 1: botTracker missing interactive quoted context: ${JSON.stringify(botTrackerAdded[0])}`);
  }
  if (!botTrackerAdded[0].meta.quotedContext?.text?.includes('"template_id":"t1"')) {
    fail(`Test 1: botTracker quoted context should preserve raw card JSON: ${JSON.stringify(botTrackerAdded[0])}`);
  }

  // ── Test 2: invalid card JSON → isError ──
  apiCalls.length = 0;
  const r2 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: 'not json{{{',
  });

  if (!r2.isError) fail('Test 2: should return isError for bad JSON');
  if (!r2.content[0].text.includes('Invalid card JSON')) fail('Test 2: wrong error text');
  if (apiCalls.length !== 0) fail('Test 2: should not call API on bad JSON');

  // ── Test 3: card with reply_to → message.reply ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;

  const r3 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: validCard,
    reply_to: 'om_reply_123',
  });

  if (r3.isError) fail('Test 3: unexpected error');
  const replyCall = apiCalls.find((c) => c.method === 'message.reply');
  if (!replyCall) fail('Test 3: message.reply not called');
  if (replyCall.args.path.message_id !== 'om_reply_123') fail('Test 3: wrong reply_to');
  if (!replyCall.args.data.uuid) fail('Test 3: message.reply missing uuid');

  // ── Test 4: card path records in conversationBuffer ──
  apiCalls.length = 0;
  buffer.recorded.length = 0;

  await replyHandler({
    chat_id: 'chat_buf',
    text: 'some text',
    card: validCard,
  });

  if (buffer.recorded.length !== 1) fail(`Test 4: buffer not recorded (got ${buffer.recorded.length})`);
  if (buffer.recorded[0].chatId !== 'chat_buf') fail('Test 4: wrong chatId in buffer');
  if (buffer.recorded[0].entry.role !== 'assistant') fail('Test 4: wrong role in buffer');

  // ── Test 5: card path revokes ack reactions (exact match) ──
  apiCalls.length = 0;
  ackReactions.clear();
  ackReactions.recordInbound('om_ack_msg');
  ackReactions.storeReaction('om_ack_msg', 'reaction_abc');

  await replyHandler({
    chat_id: 'chat_ack',
    text: '',
    card: validCard,
    reply_to: 'om_ack_msg',
  });
  await flushMicrotasks();

  if (ackReactions.activeCount !== 0) {
    fail(`Test 5: ack reactions not cleared (active=${ackReactions.activeCount})`);
  }
  const deleteCall = apiCalls.find((c) => c.method === 'messageReaction.delete');
  if (!deleteCall) fail('Test 5: messageReaction.delete not called');
  if (deleteCall.args.path.reaction_id !== 'reaction_abc') fail('Test 5: wrong reaction_id');

  // ── Test 6: card path revokes all acks when no exact match ──
  apiCalls.length = 0;
  ackReactions.recordInbound('om_other1');
  ackReactions.recordInbound('om_other2');
  ackReactions.storeReaction('om_other1', 'r1');
  ackReactions.storeReaction('om_other2', 'r2');

  await replyHandler({
    chat_id: 'chat_ack2',
    text: '',
    card: validCard,
    // no reply_to — should revoke all pending acks
  });
  await flushMicrotasks();

  if (ackReactions.activeCount !== 0) {
    fail(`Test 6: ack reactions not fully cleared (active=${ackReactions.activeCount})`);
  }
  const deleteCalls = apiCalls.filter((c) => c.method === 'messageReaction.delete');
  if (deleteCalls.length !== 2) fail(`Test 6: expected 2 reaction deletes, got ${deleteCalls.length}`);

  // ── Test 7: card with empty text uses '[card]' fallback in buffer ──
  buffer.recorded.length = 0;

  await replyHandler({
    chat_id: 'chat_no_text',
    text: '',
    card: validCard,
  });

  if (buffer.recorded[0].entry.text !== '[card]') {
    fail(`Test 7: expected '[card]' fallback, got '${buffer.recorded[0].entry.text}'`);
  }

  // ── Test 8: no card param → normal text path ──
  apiCalls.length = 0;
  buffer.recorded.length = 0;

  const r8 = await replyHandler({
    chat_id: 'chat_normal',
    text: 'hello plain text',
  });

  if (r8.isError) fail('Test 8: unexpected error');
  const normalCreate = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'text'
  );
  if (!normalCreate) fail('Test 8: plain text path should use msg_type=text');

  // ── Test 9: markdown-rich text defaults to generated v2 interactive cards ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;

  const markdownReport = [
    '# Weekly report',
    '',
    '- shipped the bridge fix',
    '- verified the release',
    '',
    '```ts',
    'const ok = true;',
    '```',
  ].join('\n');
  const r9 = await replyHandler({
    chat_id: 'chat_markdown_default',
    text: markdownReport,
  });

  if (r9.isError) fail(`Test 9: unexpected error: ${r9.content[0].text}`);
  const markdownCardCall = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'interactive'
  );
  if (!markdownCardCall) fail('Test 9: markdown-rich default reply should use msg_type=interactive');
  const markdownGeneratedCard = JSON.parse(markdownCardCall.args.data.content);
  if (markdownGeneratedCard.schema !== '2.0') fail('Test 9: generated card should use Schema 2.0');
  if (markdownGeneratedCard.config?.width_mode !== 'fill') {
    fail(`Test 9: generated card should use fill width_mode: ${JSON.stringify(markdownGeneratedCard.config)}`);
  }
  if (markdownGeneratedCard.header !== undefined) {
    fail(`Test 9: generated card should be body-only, got header: ${JSON.stringify(markdownGeneratedCard.header)}`);
  }
  if (!Array.isArray(markdownGeneratedCard.body?.elements)) {
    fail(`Test 9: generated card missing body.elements: ${JSON.stringify(markdownGeneratedCard)}`);
  }
  if (botTrackerAdded[0]?.meta?.quotedContext?.msgType !== 'interactive') {
    fail(`Test 9: generated card should track interactive quoted context: ${JSON.stringify(botTrackerAdded[0])}`);
  }

  // ── Test 10: explicit format=text forces rich Markdown through plain text ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;

  const r10 = await replyHandler({
    chat_id: 'chat_markdown_forced_text',
    text: markdownReport,
    format: 'text',
  });

  if (r10.isError) fail(`Test 10: unexpected error: ${r10.content[0].text}`);
  const forcedTextCall = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'text'
  );
  if (!forcedTextCall) fail('Test 10: format=text should use msg_type=text');
  const forcedCardCall = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'interactive'
  );
  if (forcedCardCall) fail('Test 10: format=text should not send interactive cards');
  if (botTrackerAdded[0]?.meta?.quotedContext) {
    fail(`Test 10: forced text reply should not track card quoted context: ${JSON.stringify(botTrackerAdded[0])}`);
  }

  // ── Test 11: explicit format=card uses generated body-only card ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;

  const r11 = await replyHandler({
    chat_id: 'chat_001',
    text: 'short but explicitly carded',
    format: 'card',
  });

  if (r11.isError) fail(`Test 11: unexpected error: ${r11.content[0].text}`);
  const formatCardCall = apiCalls.find((c) => c.method === 'message.create');
  if (!formatCardCall) fail('Test 11: message.create not called');
  const generatedCard = JSON.parse(formatCardCall.args.data.content);
  if (generatedCard.header !== undefined) {
    fail(`Test 11: generated card should not include header: ${JSON.stringify(generatedCard.header)}`);
  }
  if (generatedCard.config?.width_mode !== 'fill') {
    fail(`Test 11: generated card should use fill width_mode: ${JSON.stringify(generatedCard.config)}`);
  }
  if (!String(generatedCard.body?.elements?.[0]?.content ?? '').includes('short but explicitly carded')) {
    fail(`Test 11: generated card body missing original text: ${JSON.stringify(generatedCard.body?.elements)}`);
  }
  const formatCardTracked = botTrackerAdded.at(-1);
  if (formatCardTracked?.meta.quotedContext?.msgType !== 'interactive') {
    fail(`Test 11: generated card missing quoted context: ${JSON.stringify(formatCardTracked)}`);
  }
  if (!formatCardTracked?.meta.quotedContext?.text?.includes('short but explicitly carded')) {
    fail(`Test 11: generated card quoted context missing original text: ${JSON.stringify(formatCardTracked)}`);
  }

  // ── Test 12: generated-card send failures fall back to original text ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;
  failInteractiveSends = true;

  const r12 = await replyHandler({
    chat_id: 'chat_card_fallback',
    text: markdownReport,
  });
  failInteractiveSends = false;

  if (r12.isError) fail(`Test 12: unexpected error: ${r12.content[0].text}`);
  const fallbackInteractive = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'interactive'
  );
  if (fallbackInteractive) fail('Test 12: failed interactive send should not be recorded as delivered');
  const fallbackText = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'text'
  );
  if (!fallbackText) fail('Test 12: generated-card failure should fall back to text');
  const fallbackContent = JSON.parse(fallbackText.args.data.content);
  if (!fallbackContent.text.includes('# Weekly report')) {
    fail(`Test 12: fallback text should preserve original markdown: ${JSON.stringify(fallbackContent)}`);
  }
  if (botTrackerAdded[0]?.meta?.quotedContext) {
    fail(`Test 12: fallback text should not track card quoted context: ${JSON.stringify(botTrackerAdded[0])}`);
  }

  // ── Test 13: synthetic reply_to ids must not create any visible Feishu message ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;
  buffer.recorded.length = 0;

  const r13 = await replyHandler({
    chat_id: 'chat_001',
    text: 'synthetic id fallback',
    reply_to: 'flush-1780923345577',
  });

  if (r13.isError) fail(`Test 13: unexpected error: ${r13.content[0].text}`);
  if (!r13.content[0].text.includes('Skipped reply for synthetic system message')) {
    fail(`Test 13: wrong status text: ${r13.content[0].text}`);
  }
  if (apiCalls.length !== 0) fail(`Test 13: synthetic reply_to should not call Feishu APIs: ${JSON.stringify(apiCalls)}`);
  if (botTrackerAdded.length !== 0) fail('Test 13: synthetic reply should not track a bot message');
  if (buffer.recorded.length !== 0) fail('Test 13: synthetic reply should not record assistant text');

  console.log('PASS');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
