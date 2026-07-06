/**
 * Reply tool thread-routing smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify that follow-up messages (multi-chunk
 * text, multi-card, attachments) correctly stay in the source message's
 * thread when `thread_id` is present, and fall through to `message.create`
 * otherwise.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';
import { appConfig } from '../src/config.js';
import { JOB_THREAD_PREFIX, jobCreatedAtHash } from '../src/scheduler.js';
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

// ── 7. Synthetic cronjob thread_id must NOT trigger reply_in_thread ──
// Regression guard: cronjob dispatches inject thread_id="job-<id>-<ts>"
// as an IdentitySession isolation key. That value does not correspond to
// a real Feishu thread. If the reply tool treated it like one and emitted
// reply_in_thread:true against a real reply_to, Feishu would fabricate a
// new thread around that earlier message — an unintended side effect.
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'cron output',
    reply_to: 'om_some_earlier_msg',
    thread_id: `${JOB_THREAD_PREFIX}example-1700000000000`,
    files: [{ path: imgPath, type: 'image' }],
  });
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  // text chunk 0 quote-replies (reply without flag); image falls through to create
  if (replyCalls.length !== 1) fail(`7: expected 1 reply (text chunk 0), got ${replyCalls.length}`);
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`7: first chunk must not carry reply_in_thread even for cronjob thread`);
  }
  if (createCalls.length !== 1) fail(`7: expected 1 create (image), got ${createCalls.length}`);
  if ('reply_in_thread' in createCalls[0].args.data) {
    fail(`7: create must not carry reply_in_thread`);
  }
  if (createCalls[0].args.data.msg_type !== 'image') {
    fail(`7: create msg_type wrong: ${createCalls[0].args.data.msg_type}`);
  }
  passed++;
}

// ── 8. Synthetic cronjob reply permanent target failures auto-pause job ──
{
  const originalJobsDir = appConfig.jobsDir;
  const jobsDir = mkdtempSync(join(tmpdir(), 'reply-cron-autopause-'));
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  try {
    const jobId = 'reply-autopause';
    const createdAt = '2026-06-07T00:00:00.000Z';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          meta: {
            id: jobId,
            name: 'Reply AutoPause',
            type: 'prompt',
            schedule: '* * * * *',
            schedule_human: 'every 1m',
            prompt: 'reply',
            target_chat_id: 'chat_grp',
            origin_chat_id: 'chat_grp',
            status: 'active',
            created_by: 'ou_caller',
            created_at: createdAt,
          },
          runtime: {
            last_run_at: null,
            next_run_at: '2099-01-01T00:00:00.000Z',
            run_count: 1,
            last_error: null,
          },
        },
        null,
        2,
      ),
    );

    const err = new Error('permission denied') as Error & {
      response?: { status: number; data: { code: number; msg: string } };
    };
    err.response = { status: 403, data: { code: 99991672, msg: 'permission denied' } };
    const { reply } = await setup({ client: mockClient({ failReply: err }) });
    const result = await reply({
      chat_id: 'chat_grp',
      text: 'cron reply',
      reply_to: 'om_source',
      thread_id: `${JOB_THREAD_PREFIX}${jobId}-${jobCreatedAtHash(createdAt)}-1760000000000`,
      format: 'text',
    });
    if (!result.isError) fail('8: expected reply tool to return isError for permanent Feishu failure');

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
    if (persisted.meta.status !== 'paused') {
      fail(`8: expected cronjob auto-paused, got ${persisted.meta.status}`);
    }
    if (!persisted.runtime.last_error?.includes('auto-paused')) {
      fail(`8: expected auto-pause reason in last_error, got ${persisted.runtime.last_error}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    rmSync(jobsDir, { recursive: true, force: true });
  }
  passed++;
}

// ── 9. Legacy cronjob thread ids without created_at hash do not auto-pause ──
{
  const originalJobsDir = appConfig.jobsDir;
  const jobsDir = mkdtempSync(join(tmpdir(), 'reply-cron-legacy-autopause-'));
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  try {
    const jobId = 'reply-legacy-autopause';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          meta: {
            id: jobId,
            name: 'Reply Legacy AutoPause',
            type: 'prompt',
            schedule: '* * * * *',
            schedule_human: 'every 1m',
            prompt: 'reply',
            target_chat_id: 'chat_grp',
            origin_chat_id: 'chat_grp',
            status: 'active',
            created_by: 'ou_caller',
            created_at: '2026-06-07T00:00:00.000Z',
          },
          runtime: {
            last_run_at: null,
            next_run_at: '2099-01-01T00:00:00.000Z',
            run_count: 0,
            last_error: null,
          },
        },
        null,
        2,
      ),
    );

    const err = new Error('permission denied') as Error & {
      response?: { status: number; data: { code: number; msg: string } };
    };
    err.response = { status: 403, data: { code: 99991672, msg: 'permission denied' } };
    const { reply } = await setup({ client: mockClient({ failReply: err }) });
    const result = await reply({
      chat_id: 'chat_grp',
      text: 'cron reply',
      reply_to: 'om_source',
      thread_id: `${JOB_THREAD_PREFIX}${jobId}-1760000000000`,
      format: 'text',
    });
    if (!result.isError) fail('9: expected reply tool to return isError for permanent Feishu failure');

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
    if (persisted.meta.status !== 'active') {
      fail(`9: legacy hashless cronjob turn should not auto-pause, got ${persisted.meta.status}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    rmSync(jobsDir, { recursive: true, force: true });
  }
  passed++;
}

// ── 10. Stale cronjob reply failures do not pause a recreated same-id job ──
{
  const originalJobsDir = appConfig.jobsDir;
  const jobsDir = mkdtempSync(join(tmpdir(), 'reply-cron-stale-autopause-'));
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  try {
    const jobId = 'reply-stale-autopause';
    const oldCreatedAt = '2026-06-07T00:00:00.000Z';
    const newCreatedAt = '2026-06-07T00:01:00.000Z';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          meta: {
            id: jobId,
            name: 'Reply Stale AutoPause',
            type: 'prompt',
            schedule: '* * * * *',
            schedule_human: 'every 1m',
            prompt: 'reply',
            target_chat_id: 'chat_grp',
            origin_chat_id: 'chat_grp',
            status: 'active',
            created_by: 'ou_caller',
            created_at: newCreatedAt,
          },
          runtime: {
            last_run_at: null,
            next_run_at: '2099-01-01T00:00:00.000Z',
            run_count: 0,
            last_error: null,
          },
        },
        null,
        2,
      ),
    );

    const err = new Error('permission denied') as Error & {
      response?: { status: number; data: { code: number; msg: string } };
    };
    err.response = { status: 403, data: { code: 99991672, msg: 'permission denied' } };
    const { reply } = await setup({ client: mockClient({ failReply: err }) });
    const result = await reply({
      chat_id: 'chat_grp',
      text: 'cron reply',
      reply_to: 'om_source',
      thread_id: `${JOB_THREAD_PREFIX}${jobId}-${jobCreatedAtHash(oldCreatedAt)}-1760000000000`,
      format: 'text',
    });
    if (!result.isError) fail('10: expected reply tool to return isError for permanent Feishu failure');

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
    if (persisted.meta.status !== 'active') {
      fail(`10: stale cronjob turn should not pause recreated job, got ${persisted.meta.status}`);
    }
    if (persisted.runtime.last_error !== null) {
      fail(`10: stale cronjob turn should not write last_error, got ${persisted.runtime.last_error}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    rmSync(jobsDir, { recursive: true, force: true });
  }
  passed++;
}

// ── 11. Successful cronjob replies send full report and persist delivery state ──
{
  const originalJobsDir = appConfig.jobsDir;
  const jobsDir = mkdtempSync(join(tmpdir(), 'reply-cron-delivery-state-'));
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  try {
    const jobId = 'reply-delivery-state';
    const createdAt = '2026-06-07T00:00:00.000Z';
    const runId = '1760000000000';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          meta: {
            id: jobId,
            name: 'Reply Delivery State',
            type: 'prompt',
            schedule: '* * * * *',
            schedule_human: 'every 1m',
            prompt: 'reply',
            target_chat_id: 'chat_grp',
            origin_chat_id: 'chat_grp',
            status: 'active',
            created_by: 'ou_caller',
            created_at: createdAt,
          },
          runtime: {
            last_run_at: '2026-06-07T00:01:00.000Z',
            next_run_at: '2099-01-01T00:00:00.000Z',
            run_count: 1,
            last_error: null,
            run_id: runId,
            run_status: 'started',
            output_status: 'empty',
            delivery_status: 'pending',
            report: null,
            report_type: null,
            delivery_error: null,
          },
        },
        null,
        2,
      ),
    );

    const { reply } = await setup();
    const report = '# Daily report\n\n- shipped\n- verified';
    const result = await reply({
      chat_id: 'chat_grp',
      text: report,
      thread_id: `${JOB_THREAD_PREFIX}${jobId}-${jobCreatedAtHash(createdAt)}-${runId}`,
      format: 'text',
    });
    if (result.isError) fail(`11: expected successful reply, got ${JSON.stringify(result)}`);

    const createCalls = apiCalls.filter((c) => c.method === 'message.create');
    if (createCalls.length !== 1) fail(`11: expected one message.create, got ${createCalls.length}`);
    const sentContent = JSON.parse(createCalls[0].args.data.content);
    if (sentContent.text !== report) {
      fail(`11: expected complete report sent through Feishu payload, got ${createCalls[0].args.data.content}`);
    }

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
    if (persisted.runtime.run_status !== 'success') {
      fail(`11: expected run_status=success, got ${persisted.runtime.run_status}`);
    }
    if (persisted.runtime.output_status !== 'generated') {
      fail(`11: expected output_status=generated, got ${persisted.runtime.output_status}`);
    }
    if (persisted.runtime.delivery_status !== 'sent') {
      fail(`11: expected delivery_status=sent, got ${persisted.runtime.delivery_status}`);
    }
    if (persisted.runtime.report !== report) {
      fail(`11: expected persisted report body, got ${persisted.runtime.report}`);
    }
    if (persisted.runtime.report_type !== 'job_result') {
      fail(`11: expected report_type=job_result, got ${persisted.runtime.report_type}`);
    }
    if (persisted.runtime.delivery_error !== null || persisted.runtime.last_error !== null) {
      fail(`11: expected no delivery errors, got ${JSON.stringify(persisted.runtime)}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    rmSync(jobsDir, { recursive: true, force: true });
  }
  passed++;
}

// ── 12. Empty cronjob replies send a visible failure report instead of blank output ──
{
  const originalJobsDir = appConfig.jobsDir;
  const jobsDir = mkdtempSync(join(tmpdir(), 'reply-cron-empty-report-'));
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  try {
    const jobId = 'reply-empty-report';
    const createdAt = '2026-06-07T00:00:00.000Z';
    const runId = '1760000000001';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          meta: {
            id: jobId,
            name: 'Reply Empty Report',
            type: 'prompt',
            schedule: '* * * * *',
            schedule_human: 'every 1m',
            prompt: 'reply',
            target_chat_id: 'chat_grp',
            origin_chat_id: 'chat_grp',
            status: 'active',
            created_by: 'ou_caller',
            created_at: createdAt,
          },
          runtime: {
            last_run_at: '2026-06-07T00:01:00.000Z',
            next_run_at: '2099-01-01T00:00:00.000Z',
            run_count: 1,
            last_error: null,
            run_id: runId,
            run_status: 'started',
            output_status: 'empty',
            delivery_status: 'pending',
            report: null,
            report_type: null,
            delivery_error: null,
          },
        },
        null,
        2,
      ),
    );

    const { reply } = await setup();
    const result = await reply({
      chat_id: 'chat_grp',
      text: '   ',
      thread_id: `${JOB_THREAD_PREFIX}${jobId}-${jobCreatedAtHash(createdAt)}-${runId}`,
      format: 'text',
    });
    if (result.isError) fail(`12: expected visible error report delivery, got ${JSON.stringify(result)}`);

    const createCalls = apiCalls.filter((c) => c.method === 'message.create');
    if (createCalls.length !== 1) fail(`12: expected one message.create, got ${createCalls.length}`);
    const sentContent = JSON.parse(createCalls[0].args.data.content);
    if (!sentContent.text?.includes('CronJob produced an empty report.')) {
      fail(`12: expected empty-output failure report sent through Feishu, got ${createCalls[0].args.data.content}`);
    }

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8'));
    if (persisted.runtime.run_status !== 'failed') {
      fail(`12: expected run_status=failed for empty report, got ${persisted.runtime.run_status}`);
    }
    if (persisted.runtime.output_status !== 'generated') {
      fail(`12: expected generated error report output, got ${persisted.runtime.output_status}`);
    }
    if (persisted.runtime.delivery_status !== 'sent') {
      fail(`12: expected delivered failure report, got ${persisted.runtime.delivery_status}`);
    }
    if (persisted.runtime.report_type !== 'error_report') {
      fail(`12: expected error_report, got ${persisted.runtime.report_type}`);
    }
    if (!persisted.runtime.last_error?.includes('empty report')) {
      fail(`12: expected empty report last_error, got ${persisted.runtime.last_error}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    rmSync(jobsDir, { recursive: true, force: true });
  }
  passed++;
}

console.log(`reply-thread smoke: ${passed}/15 PASS`);
