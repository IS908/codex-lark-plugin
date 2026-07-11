import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CODEX_EXEC_MODEL = 'gpt-global';

const root = await mkdtemp(join(tmpdir(), 'codex-model-command-'));

const { appConfig } = await import('../src/config.js');
(appConfig as any).codexExecCwd = root;
(appConfig as { ownerOpenId: string | null }).ownerOpenId = 'ou_sender';
(appConfig as { auditLogPath: string }).auditLogPath = join(root, 'audit.log');

const { handleCodexModelCommand } = await import('../src/codex-model-command.js');
const { deliverMessageViaCodexExec } = await import('../src/codex-exec-delivery.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { accessControlStore } = await import('../src/runtime-access-control.js');
const {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
} = await import('../src/codex-session-store.js');
import type { LarkMessage } from '../src/channel.js';
import type { ReplyRequest } from '../src/reply-sender.js';

const store = new FileCodexExecSessionStore(join(root, 'sessions'));
await accessControlStore.load(join(root, 'access-control.json'));
const identitySession = new IdentitySession(() => 'ou_sender');
const replies: ReplyRequest[] = [];
const assistantRecords: Array<{ chatId: string; threadId?: string; text: string }> = [];
const validatedChats: string[] = [];

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
  identitySession.setCaller(message.chatId, message.threadId, message.senderId);
  return handleCodexModelCommand({
    message,
    sessionStore: store,
    identitySession,
    useCodexSessions,
    validateChatAccess: async (chatId) => {
      validatedChats.push(chatId);
      if (chatId === 'oc_missing') throw new Error('Chat oc_missing does not exist.');
    },
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
  messageId: 'om_model_non_owner',
  senderId: 'ou_not_owner',
  text: '/model gpt-4',
  rawContent: '{"text":"/model gpt-4"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Chat\/thread Codex model override set to gpt-4/);
record = await store.get(sessionKey);
assert.equal(record?.model, 'gpt-4');

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_add',
  text: '/access add user ou_new_allowed',
  rawContent: '{"text":"/access add user ou_new_allowed"}',
}), true);
assert.equal(accessControlStore.isAllowedUserId('ou_new_allowed'), true);
assert.match(replies.at(-1)?.text ?? '', /ou_new_allowed/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_add_current_chat',
  text: '/access add chat 当前群聊',
  rawContent: '{"text":"/access add chat 当前群聊"}',
}), true);
assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_model'), true);
assert.deepEqual(validatedChats.at(-1), 'oc_model');
assert.match(replies.at(-1)?.text ?? '', /resolved_from_current_chat/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_remove_here',
  text: '/access remove chat here',
  rawContent: '{"text":"/access remove chat here"}',
}), true);
assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_model'), false);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_invalid_chat',
  text: '/access add chat not-a-chat',
  rawContent: '{"text":"/access add chat not-a-chat"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /oc_\.\.\. format/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_missing_chat',
  text: '/access add chat oc_missing',
  rawContent: '{"text":"/access add chat oc_missing"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /does not exist/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_current_from_p2p',
  chatId: 'ou_p2p_chat',
  chatType: 'p2p',
  text: '/access add chat current',
  rawContent: '{"text":"/access add chat current"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /group chat/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_list',
  text: '/access',
  rawContent: '{"text":"/access"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /ou_new_allowed/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_denied',
  senderId: 'ou_not_owner',
  text: '/access add user ou_denied',
  rawContent: '{"text":"/access add user ou_denied"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /owner-only/);
assert.equal(accessControlStore.isAllowedUserId('ou_denied'), false);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_not_model',
  text: 'ordinary message',
  rawContent: '{"text":"ordinary message"}',
}), false);

const auditText = readFileSync(appConfig.auditLogPath, 'utf8');
assert.match(auditText, /lark_model_command\s+ok/);
assert.match(auditText, /lark_access_command\s+ok/);
assert.match(auditText, /lark_access_command\s+denied/);

console.log('codex-model-command smoke: PASS');
