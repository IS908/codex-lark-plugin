/**
 * Reply tool thread-routing smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify that follow-up messages (multi-chunk
 * text, multi-card, attachments) correctly stay in the source message's
 * thread when `thread_id` is present, and fall through to `message.create`
 * otherwise.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';
import { sendFeishuReply } from '../src/reply-sender.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const apiCalls: { method: string; args: any }[] = [];

function mockClient(opts: { failReply?: unknown; failPost?: unknown } = {}) {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            apiCalls.push({ method: 'message.create', args });
            return { data: { message_id: `created_${apiCalls.length}` } };
          },
          reply: async (args: any) => {
            if (opts.failPost && args?.data?.msg_type === 'post') throw opts.failPost;
            if (opts.failReply) throw opts.failReply;
            apiCalls.push({ method: 'message.reply', args });
            return { data: { message_id: `replied_${apiCalls.length}` } };
          },
        },
        messageReaction: {
          create: async () => {},
          delete: async () => {},
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

function makeBuffer() {
  return {
    record() {},
    flush: async () => {},
    startAutoFlush: () => {},
    stopAutoFlush: () => {},
  };
}

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

async function setup(opts: { client?: ReturnType<typeof mockClient> } = {}) {
  apiCalls.length = 0;
  const client = opts.client ?? mockClient();
  const botTracker = {
    ids: new Set<string>(),
    add(id: string) { this.ids.add(id); },
    has(id: string) { return this.ids.has(id); },
  };
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('chat_grp', 'thread_abc', 'ou_caller');
  identitySession.setCaller('chat_p2p', undefined, 'ou_caller');
  const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;

  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    makeBuffer() as any,
    undefined,
    botTracker as any,
    undefined,
  );

  const reply = handlers.get('reply');
  if (!reply) fail('reply handler not registered');
  return { reply };
}

// A fixture image on disk for attachment tests
const fixDir = mkdtempSync(join(tmpdir(), 'reply-thread-fix-'));
const imgPath = join(fixDir, 'fake.png');
writeFileSync(imgPath, Buffer.from('fake-png-bytes'));

// ── 1. Thread + image: image must go via reply(..., reply_in_thread=true) ──
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'here is the image',
    reply_to: 'om_user1',
    thread_id: 'thread_abc',
    files: [{ path: imgPath, type: 'image' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`1: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  // 1 for text, 1 for image — both via reply
  if (replyCalls.length !== 2) {
    fail(`1: expected 2 message.reply, got ${replyCalls.length}`);
  }
  const imageCall = replyCalls[1];
  if (imageCall.args.path.message_id !== 'om_user1') {
    fail(`1: image reply path.message_id wrong: ${imageCall.args.path.message_id}`);
  }
  if (imageCall.args.data.reply_in_thread !== true) {
    fail(`1: image reply missing reply_in_thread=true, got ${JSON.stringify(imageCall.args.data)}`);
  }
  if (imageCall.args.data.msg_type !== 'image') {
    fail(`1: image reply msg_type wrong: ${imageCall.args.data.msg_type}`);
  }
  for (const call of replyCalls) {
    if (!call.args.data.uuid) fail(`1: message.reply missing uuid: ${JSON.stringify(call.args.data)}`);
  }
  passed++;
}

// ── 2. P2P + image: image must still use message.create (no reply_in_thread) ──
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_p2p',
    text: 'here is the image',
    reply_to: 'om_p2p1',
    // no thread_id — P2P
    files: [{ path: imgPath, type: 'image' }],
  });
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  // text chunk 0 → reply; image → create (no thread)
  if (replyCalls.length !== 1) fail(`2: expected 1 message.reply, got ${replyCalls.length}`);
  if (createCalls.length !== 1) fail(`2: expected 1 message.create (image), got ${createCalls.length}`);
  const imgCreate = createCalls[0];
  if (imgCreate.args.data.msg_type !== 'image') {
    fail(`2: image create msg_type wrong: ${imgCreate.args.data.msg_type}`);
  }
  if (!imgCreate.args.data.uuid) fail('2: image create missing uuid');
  if ('reply_in_thread' in imgCreate.args.data) {
    fail(`2: P2P image create must NOT carry reply_in_thread`);
  }
  passed++;
}

// ── 2b. P2P + image-only: must not send an empty text reply first ──
{
  apiCalls.length = 0;
  const imageOnlyResult = await sendFeishuReply({ client: mockClient() as any }, {
    chat_id: 'chat_p2p',
    text: '',
    reply_to: 'om_p2p_media_only',
    files: [{ path: imgPath, type: 'image' }],
  });
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  if (replyCalls.length !== 0) fail(`2b: expected 0 empty text replies, got ${replyCalls.length}`);
  if (createCalls.length !== 1) fail(`2b: expected 1 image create, got ${createCalls.length}`);
  if (createCalls[0].args.data.msg_type !== 'image') {
    fail(`2b: image create msg_type wrong: ${createCalls[0].args.data.msg_type}`);
  }
  if (imageOnlyResult.sentCount !== 1) fail(`2b: expected sentCount=1, got ${imageOnlyResult.sentCount}`);
  if (imageOnlyResult.fileSentCount !== 1) fail(`2b: expected fileSentCount=1, got ${imageOnlyResult.fileSentCount}`);
  passed++;
}

// ── 3. Thread + long text (multi-chunk): chunks 2..N use reply_in_thread ──
{
  const { reply } = await setup();
  // Force text path + multi-chunk (text > LARK_TEXT_CHUNK_LIMIT = 4000)
  const big = 'a'.repeat(9000);
  await reply({
    chat_id: 'chat_grp',
    text: big,
    reply_to: 'om_user2',
    thread_id: 'thread_abc',
    format: 'text',
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`3: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  if (replyCalls.length < 2) {
    fail(`3: expected multi-chunk replies (>=2), got ${replyCalls.length}`);
  }
  // First call is the bare quote-reply; subsequent must carry reply_in_thread
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`3: first chunk must not carry reply_in_thread`);
  }
  for (let i = 1; i < replyCalls.length; i++) {
    if (replyCalls[i].args.data.reply_in_thread !== true) {
      fail(`3: chunk ${i} missing reply_in_thread=true`);
    }
  }
  passed++;
}

// ── 3b. Thread + rich text/image: prefer a single post reply ──
{
  apiCalls.length = 0;
  const result = await sendFeishuReply({ client: mockClient() as any }, {
    chat_id: 'chat_grp',
    text: '',
    reply_to: 'om_rich_success',
    thread_id: 'thread_abc',
    richParts: [
      { type: 'text', text: 'Before\n' },
      { type: 'image', path: imgPath, alt: 'diagram' },
      { type: 'text', text: '\nAfter' },
    ],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) fail(`3b: expected 0 create calls, got ${createCalls.length}`);
  if (replyCalls.length !== 1) fail(`3b: expected 1 rich post reply, got ${replyCalls.length}`);
  if (replyCalls[0].args.data.msg_type !== 'post') {
    fail(`3b: expected post msg_type, got ${replyCalls[0].args.data.msg_type}`);
  }
  const content = JSON.parse(replyCalls[0].args.data.content);
  if (content.zh_cn.content[1][0].tag !== 'img') fail(`3b: expected second rich block to be image: ${replyCalls[0].args.data.content}`);
  if (result.richDeliveryMode !== 'rich_post') fail(`3b: expected rich_post mode, got ${result.richDeliveryMode}`);
  if (result.fileSentCount !== 1) fail(`3b: expected fileSentCount=1, got ${result.fileSentCount}`);
  passed++;
}

// ── 3c. Thread + rich post failure: fall back to ordered split messages ──
{
  apiCalls.length = 0;
  const result = await sendFeishuReply({ client: mockClient({ failPost: new Error('post unsupported') }) as any }, {
    chat_id: 'chat_grp',
    text: '',
    reply_to: 'om_rich_fallback',
    thread_id: 'thread_abc',
    richParts: [
      { type: 'text', text: 'Before' },
      { type: 'image', path: imgPath, alt: 'diagram' },
    ],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  if (replyCalls.length !== 2) fail(`3c: expected 2 split replies, got ${replyCalls.length}`);
  if (replyCalls[0].args.data.msg_type !== 'text') {
    fail(`3c: first split message should be text, got ${replyCalls[0].args.data.msg_type}`);
  }
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`3c: first split text should be the quote reply, got ${JSON.stringify(replyCalls[0].args.data)}`);
  }
  if (replyCalls[1].args.data.msg_type !== 'image') {
    fail(`3c: second split message should be image, got ${replyCalls[1].args.data.msg_type}`);
  }
  if (replyCalls[1].args.data.reply_in_thread !== true) {
    fail(`3c: split image should stay in thread, got ${JSON.stringify(replyCalls[1].args.data)}`);
  }
  if (result.richDeliveryMode !== 'split') fail(`3c: expected split mode, got ${result.richDeliveryMode}`);
  if (result.sentCount !== 2) fail(`3c: expected sentCount=2, got ${result.sentCount}`);
  if (result.fileSentCount !== 1) fail(`3c: expected fileSentCount=1, got ${result.fileSentCount}`);
  passed++;
}

// ── 4. No reply_to + thread_id (shouldStayInThread guard) ─────────────
// When effectiveReplyTo cannot be resolved (no reply_to, no tracker), the
// follow-up must NOT try to call message.reply with an empty path — it
// should fall through to message.create to avoid SDK errors.
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'one line',
    thread_id: 'thread_abc',
    // no reply_to, no tracker configured in setup
    files: [{ path: imgPath, type: 'image' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (replyCalls.length !== 0) {
    fail(`4: expected no reply calls without effectiveReplyTo, got ${replyCalls.length}`);
  }
  // 1 text + 1 image, both create
  if (createCalls.length !== 2) {
    fail(`4: expected 2 message.create, got ${createCalls.length}`);
  }
  passed++;
}

// ── 5. Thread + file attachment ──────────────────────────────────
{
  const { reply } = await setup();
  const filePath = join(fixDir, 'doc.txt');
  writeFileSync(filePath, 'hello');
  await reply({
    chat_id: 'chat_grp',
    text: 'here is the file',
    reply_to: 'om_user3',
    thread_id: 'thread_abc',
    files: [{ path: filePath, type: 'file' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const fileReply = replyCalls.find((c) => c.args.data.msg_type === 'file');
  if (!fileReply) fail('5: file attachment not sent via reply');
  if (fileReply.args.data.reply_in_thread !== true) {
    fail('5: file attachment missing reply_in_thread=true');
  }
  passed++;
}

// ── 6. Thread + multi-card (format=card): cards 2..N use reply_in_thread ──
{
  const { reply } = await setup();
  // Force cards path via format='card'; exceed CARD_SIZE_LIMIT (25KB) with
  // multiple markdown elements to actually trigger multi-card split.
  // Use repeated markdown blocks so each becomes a separate element.
  const block = '# heading\n\n' + 'x'.repeat(2000) + '\n\n';
  const multiCardText = block.repeat(20); // ~40KB, forces >=2 cards
  await reply({
    chat_id: 'chat_grp',
    text: multiCardText,
    reply_to: 'om_user4',
    thread_id: 'thread_abc',
    format: 'card',
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`6: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  // At least 2 card chunks expected
  if (replyCalls.length < 2) {
    fail(`6: expected multi-card replies (>=2), got ${replyCalls.length}`);
  }
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`6: first card must not carry reply_in_thread`);
  }
  for (let i = 1; i < replyCalls.length; i++) {
    if (replyCalls[i].args.data.reply_in_thread !== true) {
      fail(`6: card ${i} missing reply_in_thread=true`);
    }
    if (replyCalls[i].args.data.msg_type !== 'interactive') {
      fail(`6: card ${i} msg_type wrong: ${replyCalls[i].args.data.msg_type}`);
    }
  }
  passed++;
}


// ── 7. Explicit delivery UUID is forwarded through card rendering ────────
// Durable outbox retries must reuse the same Feishu idempotency key while
// preserving the existing card, bot tracking, and assistant buffer paths.
{
  const sends: any[] = [];
  const tracked: Array<{ id: string; meta: unknown }> = [];
  const buffered: Array<{ chatId: string; message: any }> = [];
  const request = {
    chat_id: 'chat_grp',
    text: '# Durable report\n\n- persisted before delivery',
    format: 'card',
    idempotencyKey: 'cron:run_123:terminal',
  } as const;
  const result = await sendFeishuReply(
    {
      client: {} as any,
      transport: {
        async sendMessage(request: any) {
          sends.push(request);
          return { messageId: 'om_durable_card' };
        },
      } as any,
      botMessageTracker: {
        add(id: string, meta: unknown) { tracked.push({ id, meta }); },
      } as any,
      conversationBuffer: {
        record(chatId: string, message: any) { buffered.push({ chatId, message }); },
      } as any,
    },
    request,
  );
  if (result.isError || result.sentCount !== 1) {
    fail(`7: explicit UUID card delivery failed: ${JSON.stringify(result)}`);
  }
  const firstUuid = sends[0]?.uuid;
  if (sends.length !== 1 || !firstUuid) {
    fail(`7: stable idempotency key did not derive a UUID: ${JSON.stringify(sends)}`);
  }
  if (!('card' in sends[0].input)) {
    fail(`7: expected existing card renderer, got ${JSON.stringify(sends[0].input)}`);
  }
  if (tracked[0]?.id !== 'om_durable_card' || (tracked[0]?.meta as any)?.chatId !== 'chat_grp') {
    fail(`7: durable card was not tracked: ${JSON.stringify(tracked)}`);
  }
  if (buffered[0]?.chatId !== 'chat_grp' || !buffered[0]?.message?.text?.includes('Durable report')) {
    fail(`7: durable card was not recorded in assistant buffer: ${JSON.stringify(buffered)}`);
  }
  sends.length = 0;
  await sendFeishuReply(
    {
      client: {} as any,
      transport: {
        async sendMessage(outbound: any) {
          sends.push(outbound);
          return { messageId: 'om_durable_card_retry' };
        },
      } as any,
    },
    request,
  );
  if (sends[0]?.uuid !== firstUuid) {
    fail(`7: retry derived a different UUID: ${JSON.stringify(sends)}`);
  }
  passed++;
}

rmSync(fixDir, { recursive: true, force: true });
console.log(`reply-thread smoke: ${passed}/10 PASS`);
