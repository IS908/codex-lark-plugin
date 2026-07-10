import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CODEX_EXEC_MODEL = 'gpt-global';

const root = await mkdtemp(join(tmpdir(), 'codex-model-command-'));

const { appConfig } = await import('../src/config.js');
(appConfig as any).codexExecCwd = root;

const { handleCodexModelCommand } = await import('../src/codex-model-command.js');
const { deliverMessageViaCodexExec } = await import('../src/codex-exec-delivery.js');
const {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
} = await import('../src/codex-session-store.js');
import type { LarkMessage } from '../src/channel.js';
import type { ReplyRequest } from '../src/reply-sender.js';

const store = new FileCodexExecSessionStore(join(root, 'sessions'));
const replies: ReplyRequest[] = [];
const assistantRecords: Array<{ chatId: string; threadId?: string; text: string }> = [];

const baseMessage: LarkMessage = {
  messageId: 'om_model_001',
  chatId: 'oc_model',
  chatType: 'group',
  senderId: 'ou_sender',
  senderName: 'Kevin',
  text: '@ASH /model gpt-5.6-sol',
  messageType: 'text',
  rawContent: '{"text":"@_user_1 /model gpt-5.6-sol"}',
  threadId: 'omt_model_thread',
  botMentioned: true,
};

async function runCommand(message: LarkMessage, useCodexSessions = true): Promise<boolean> {
  return handleCodexModelCommand({
    message,
    sessionStore: store,
    useCodexSessions,
    sendReply: async (request) => {
      replies.push(request);
      return { sentCount: 1 };
    },
    recordAssistantMessage: (message) => {
      assistantRecords.push(message);
    },
  });
}

const sessionKey = buildCodexExecSessionKey(baseMessage.chatId, baseMessage.threadId);

assert.equal(await runCommand(baseMessage), true);
assert.equal(replies.length, 1);
assert.equal(replies[0].reply_to, 'om_model_001');
assert.match(replies[0].text, /override set to gpt-5\.6-sol/);
assert.equal(assistantRecords.length, 1);
let record = await store.get(sessionKey);
assert.equal(record?.sessionId, '');
assert.equal(record?.model, 'gpt-5.6-sol');

const execRequests: any[] = [];
await deliverMessageViaCodexExec({
  message: {
    ...baseMessage,
    messageId: 'om_after_model_001',
    text: 'Use the selected model now.',
    rawContent: '{"text":"Use the selected model now."}',
  },
  displayLabel: 'Kevin · thread_model',
  sessionStore: store,
  runCodexExec: async (request) => {
    execRequests.push(request);
    assert.equal(request.resumeSessionId, null);
    assert.equal(request.model, 'gpt-5.6-sol');
    return { text: 'done', sessionId: 'codex-session-1' };
  },
  sendReply: async (request) => {
    replies.push(request);
    return { sentCount: 1 };
  },
});
assert.equal(execRequests.length, 1);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-1');
assert.equal(record?.model, 'gpt-5.6-sol');

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_model_show',
  text: '/model',
  rawContent: '{"text":"/model"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Source: chat\/thread override/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_model_reset',
  text: '/model reset',
  rawContent: '{"text":"/model reset"}',
}), true);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-1');
assert.equal(record?.model, undefined);
assert.match(replies.at(-1)?.text ?? '', /falls back to LARK_CODEX_EXEC_MODEL: gpt-global/);

const afterResetRequests: any[] = [];
await deliverMessageViaCodexExec({
  message: {
    ...baseMessage,
    messageId: 'om_after_reset_001',
    text: 'Use the global model now.',
    rawContent: '{"text":"Use the global model now."}',
  },
  displayLabel: 'Kevin · thread_model',
  sessionStore: store,
  runCodexExec: async (request) => {
    afterResetRequests.push(request);
    assert.equal(request.resumeSessionId, 'codex-session-1');
    assert.equal(request.model, 'gpt-global');
    return { text: 'done again', sessionId: 'codex-session-1' };
  },
  sendReply: async (request) => {
    replies.push(request);
    return { sentCount: 1 };
  },
});
assert.equal(afterResetRequests.length, 1);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_model_invalid',
  text: '/model bad id',
  rawContent: '{"text":"/model bad id"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Invalid model id/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_model_disabled',
  text: '/model gpt-5',
  rawContent: '{"text":"/model gpt-5"}',
}, false), true);
assert.match(replies.at(-1)?.text ?? '', /LARK_CODEX_EXEC_USE_SESSIONS=true/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_not_model',
  text: 'ordinary message',
  rawContent: '{"text":"ordinary message"}',
}), false);

console.log('codex-model-command smoke: PASS');
