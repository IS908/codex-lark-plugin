import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { IdentitySession, SYSTEM_FLUSH_CALLER } = await import('../src/identity-session.js');
const { createToolContext } = await import('../src/tools/tool-context.js');
const { registerTransparencyTools } = await import('../src/tools/transparency.js');
const {
  createMockTransport,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} = await import('./test-helpers/tool-fixtures.js');

const { server, handlers, getTool } = createToolServerHarness();

const identitySession = new IdentitySession(() => null);
identitySession.setCaller('oc_private', 'thread_a', 'ou_user');
identitySession.setCaller('oc_flush', undefined, SYSTEM_FLUSH_CALLER);

const privateLines = [{ hash: 'privhash', text: 'private preference' }];
const publicLines = [{ hash: 'pubhash1', text: 'public fact' }];
let removed: { userId: string; tier: string; hash: string } | null = null;

const memoryStore = createNoopMemoryStore({
  listProfileLines: async (_userId: string, tier: 'public' | 'private') =>
    tier === 'public' ? publicLines : privateLines,
  removeProfileLine: async (userId: string, tier: 'public' | 'private', hash: string) => {
    removed = { userId, tier, hash };
    return hash === 'privhash';
  },
});

const ctx = createToolContext({
  server: server as any,
  client: {} as any,
  memoryStore,
  identitySession,
  channel: createPrivateChatChannel((chatId) => chatId === 'oc_private') as any,
  larkTransport: createMockTransport(),
});

const resolved = ctx.resolveCaller('what_do_you_know', 'oc_private', 'thread_a', {});
assert.equal('caller' in resolved ? resolved.caller : undefined, 'ou_user');

const denied = ctx.resolveCaller('forget_memory', 'oc_flush', undefined, {});
assert.equal('error' in denied ? denied.error.isError : false, true);
assert.match('error' in denied ? denied.error.content[0].text : '', /system-flush caller/i);

registerTransparencyTools(ctx);
assert.ok(handlers.has('what_do_you_know'), 'what_do_you_know registered by transparency domain');
assert.ok(handlers.has('forget_memory'), 'forget_memory registered by transparency domain');

const what = await getTool('what_do_you_know')({
  chat_id: 'oc_private',
  thread_id: 'thread_a',
});
assert.equal(what?.isError, undefined);
assert.match(what.content[0].text, /\[pubhash1\] public fact/);
assert.match(what.content[0].text, /\[privhash\] private preference/);

const forget = await getTool('forget_memory')({
  chat_id: 'oc_private',
  thread_id: 'thread_a',
  hash: 'privhash',
  tier: 'private',
});
assert.equal(forget?.isError, undefined);
assert.deepEqual(removed, { userId: 'ou_user', tier: 'private', hash: 'privhash' });

console.log('PASS');
