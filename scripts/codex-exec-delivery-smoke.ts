/**
 * Codex exec delivery smoke test.
 *
 * Verifies the exec path used when Codex no longer consumes
 * notifications/Codex/channel: inbound Feishu messages are converted into
 * `codex exec` prompts, one Codex session is resumed per Feishu chat/thread,
 * and the final answer is sent back through the normal Feishu reply path.
 */
import assert from 'node:assert/strict';
import { deliverMessageViaCodexExec } from '../src/codex-exec-delivery.js';
import { buildCodexExecArgs, extractCodexExecSessionId } from '../src/codex-exec.js';
import type { LarkMessage } from '../src/channel.js';
import type { ReplyRequest } from '../src/reply-sender.js';

const message: LarkMessage = {
  messageId: 'om_inbound_001',
  chatId: 'oc_group_001',
  chatType: 'group',
  senderId: 'ou_sender_001',
  senderName: 'Kevin',
  chatName: 'Codex Test Group',
  text: '[Memory Context]\n(none)\n\n[Current Message]\nFrom: ou_sender_001 in oc_group_001\n@Codex ping',
  messageType: 'text',
  rawContent: '{"text":"@_user_1 ping"}',
  threadId: 'omt_thread_001',
  botMentioned: true,
  imagePaths: ['/tmp/lark-img-1.png', '/tmp/lark-img-2.png'],
};

const execRequests: any[] = [];
const replyRequests: ReplyRequest[] = [];

assert.deepEqual(
  buildCodexExecArgs(
    {
      prompt: 'continue',
      imagePaths: ['/tmp/img.png'],
      sandbox: 'workspace-write',
      ignoreUserConfig: true,
      skipGitRepoCheck: true,
      resumeSessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    },
    '/tmp/last-message.txt',
  ),
  [
    'exec',
    '--json',
    '--color',
    'never',
    '--output-last-message',
    '/tmp/last-message.txt',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--image',
    '/tmp/img.png',
    'resume',
    '0199a213-81c0-7800-8aa1-bbab2a035a53',
    '-',
  ],
);

assert.equal(
  extractCodexExecSessionId(
    '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}\n',
  ),
  '0199a213-81c0-7800-8aa1-bbab2a035a53',
);

await deliverMessageViaCodexExec({
  message,
  displayLabel: 'Kevin · Codex Test Group · thread_ad_001',
  runCodexExec: async (request) => {
    execRequests.push(request);
    return 'pong from codex';
  },
  sendReply: async (request) => {
    replyRequests.push(request);
    return { sentCount: 1 };
  },
});

assert.equal(execRequests.length, 1);
assert.match(execRequests[0].prompt, /Reply to this Feishu\/Lark message/);
assert.match(execRequests[0].prompt, /message_id: om_inbound_001/);
assert.match(execRequests[0].prompt, /chat_id: oc_group_001/);
assert.match(execRequests[0].prompt, /thread_id: omt_thread_001/);
assert.match(execRequests[0].prompt, /Kevin · Codex Test Group/);
assert.match(execRequests[0].prompt, /@Codex ping/);
assert.deepEqual(execRequests[0].imagePaths, ['/tmp/lark-img-1.png', '/tmp/lark-img-2.png']);

assert.deepEqual(replyRequests, [
  {
    chat_id: 'oc_group_001',
    text: 'pong from codex',
    reply_to: 'om_inbound_001',
    thread_id: 'omt_thread_001',
  },
]);

const sessionRequests: any[] = [];
const sessionRecords = new Map<string, any>();
const sessionStore = {
  async get(key: string) {
    return sessionRecords.get(key) ?? null;
  },
  async set(record: any) {
    sessionRecords.set(record.key, record);
  },
};

await deliverMessageViaCodexExec({
  message,
  displayLabel: 'Kevin · Codex Test Group · thread_ad_001',
  sessionStore,
  runCodexExec: async (request) => {
    sessionRequests.push(request);
    return { text: 'first answer', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' };
  },
  sendReply: async () => ({ sentCount: 1 }),
});

await deliverMessageViaCodexExec({
  message: {
    ...message,
    messageId: 'om_inbound_002',
    text: '[Current Message]\ncontinue from before',
  },
  displayLabel: 'Kevin · Codex Test Group · thread_ad_001',
  sessionStore,
  runCodexExec: async (request) => {
    sessionRequests.push(request);
    return { text: 'second answer', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' };
  },
  sendReply: async () => ({ sentCount: 1 }),
});

assert.equal(sessionRequests.length, 2);
assert.equal(sessionRequests[0].resumeSessionId, null);
assert.equal(sessionRequests[1].resumeSessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');

sessionRecords.set('chat:oc_group_001:thread:omt_thread_001', {
  key: 'chat:oc_group_001:thread:omt_thread_001',
  sessionId: 'stale-session',
  chatId: 'oc_group_001',
  threadId: 'omt_thread_001',
  updatedAt: new Date(0).toISOString(),
});
const fallbackRequests: any[] = [];

await deliverMessageViaCodexExec({
  message: {
    ...message,
    messageId: 'om_inbound_003',
    text: '[Current Message]\nresume after stale session',
  },
  displayLabel: 'Kevin · Codex Test Group · thread_ad_001',
  sessionStore,
  runCodexExec: async (request) => {
    fallbackRequests.push(request);
    if (request.resumeSessionId === 'stale-session') {
      throw new Error('codex exec failed with exit 1: session not found');
    }
    return { text: 'fresh answer', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a54' };
  },
  sendReply: async () => ({ sentCount: 1 }),
});

assert.equal(fallbackRequests.length, 2);
assert.equal(fallbackRequests[0].resumeSessionId, 'stale-session');
assert.equal(fallbackRequests[1].resumeSessionId, null);
assert.equal(
  sessionRecords.get('chat:oc_group_001:thread:omt_thread_001')?.sessionId,
  '0199a213-81c0-7800-8aa1-bbab2a035a54',
);

console.log('PASS');
