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
import type { LarkMessage } from '../src/lark-message.js';
import type { ReplyRequest } from '../src/reply-sender.js';

const store = new FileCodexExecSessionStore(join(root, 'sessions'));
await accessControlStore.load(join(root, 'access-control.json'));
const identitySession = new IdentitySession(() => 'ou_sender');
const replies: ReplyRequest[] = [];
const assistantRecords: Array<{ chatId: string; threadId?: string; text: string }> = [];
const validatedChats: string[] = [];
const flushRequests: Array<{ chatId: string; threadId?: string; reason: string }> = [];
const sessionHealthResets: string[] = [];

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

async function runCommand(
  message: LarkMessage,
  useCodexSessions = true,
  overrides: {
    flushConversation?: Parameters<typeof handleCodexModelCommand>[0]['flushConversation'];
    sessionStore?: Parameters<typeof handleCodexModelCommand>[0]['sessionStore'];
  } = {},
): Promise<boolean> {
  identitySession.setCaller(message.chatId, message.threadId, message.senderId);
  return handleCodexModelCommand({
    message,
    sessionStore: overrides.sessionStore ?? store,
    identitySession,
    useCodexSessions,
    flushConversation: overrides.flushConversation ?? (async (request) => {
      flushRequests.push({
        chatId: request.chatId,
        ...(request.threadId ? { threadId: request.threadId } : {}),
        reason: request.reason,
      });
      const result = { status: 'flushed' as const, messageCount: 2, summary: 'Short distilled summary.' };
      await request.commitBeforeRemove?.({ summary: result.summary });
      return result;
    }),
    resetSessionHealth: (sessionKey) => {
      sessionHealthResets.push(sessionKey);
    },
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

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_help',
  text: '/help',
  rawContent: '{"text":"/help"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /User commands:/);
for (const command of ['/help', '/model', '/flush', '/new', '/task']) {
  assert.match(replies.at(-1)?.text ?? '', new RegExp(command.replace('/', '\\/')));
}
assert.match(replies.at(-1)?.text ?? '', /Owner-only commands:/);
assert.match(replies.at(-1)?.text ?? '', /\/access/);

assert.equal(await runCommand(baseMessage), true);
assert.equal(replies.at(-1)?.reply_to, 'om_model_001');
assert.match(replies.at(-1)?.text ?? '', /override set to gpt-5\.6-sol/);
assert.equal(assistantRecords.at(-1)?.chatId, baseMessage.chatId);
assert.match(assistantRecords.at(-1)?.text ?? '', /override set to gpt-5\.6-sol/);
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

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-flush',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_flush',
  text: '/flush',
  rawContent: '{"text":"/flush"}',
}), true);
assert.deepEqual(flushRequests.at(-1), {
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  reason: 'manual',
});
assert.match(replies.at(-1)?.text ?? '', /Conversation context flushed \(2 messages\)/);
assert.match(replies.at(-1)?.text ?? '', /Current Codex session is unchanged/);
assert.match(replies.at(-1)?.text ?? '', /Short distilled summary/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-before-flush');
assert.equal(record?.model, 'gpt-4');

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_flush_p2p',
  chatId: 'oc_p2p_flush',
  chatType: 'p2p',
  threadId: undefined,
  text: '/flush',
  rawContent: '{"text":"/flush"}',
}), true);
assert.deepEqual(flushRequests.at(-1), {
  chatId: 'oc_p2p_flush',
  reason: 'manual',
});

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_flush_invalid',
  text: '/flush now',
  rawContent: '{"text":"/flush now"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Invalid \/flush command/);

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-new',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new',
  timestampMs: 1781744460000,
  text: '/new',
  rawContent: '{"text":"/new"}',
}), true);
assert.deepEqual(flushRequests.at(-1), {
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  reason: 'new_session',
});
assert.match(replies.at(-1)?.text ?? '', /Conversation context archived \(2 messages\)/);
assert.match(replies.at(-1)?.text ?? '', /New Codex session will start on the next turn/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, '');
assert.equal(record?.model, 'gpt-4');
assert.equal(record?.generation, 1);
assert.equal(record?.cutoffMessageId, 'om_new');
assert.equal(record?.cutoffTimestampMs, 1781744460000);
assert.equal(record?.handoffSummary, 'Short distilled summary.');
assert.equal(record?.handoffConsumedAt, undefined);
assert.equal(sessionHealthResets.at(-1), sessionKey);

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-new-failure',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new_failure',
  text: '/new',
  rawContent: '{"text":"/new"}',
}, true, {
  flushConversation: async () => {
    throw new Error('distillation failed');
  },
}), true);
assert.match(replies.at(-1)?.text ?? '', /New session was not started/);
assert.match(replies.at(-1)?.text ?? '', /buffered context were preserved/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-before-new-failure');
assert.equal(record?.generation, undefined);

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-new-busy',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new_busy',
  text: '/new',
  rawContent: '{"text":"/new"}',
}, true, {
  flushConversation: async () => ({ status: 'busy', messageCount: 2 }),
}), true);
assert.match(replies.at(-1)?.text ?? '', /already running/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-before-new-busy');
assert.equal(record?.generation, undefined);

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-new-empty',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
  generation: 2,
  cutoffMessageId: 'om_previous_new',
  cutoffTimestampMs: 1781744000000,
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new_empty',
  timestampMs: 1781744520000,
  text: '/new',
  rawContent: '{"text":"/new"}',
}, true, {
  flushConversation: async () => ({ status: 'empty', messageCount: 0 }),
}), true);
assert.match(replies.at(-1)?.text ?? '', /No buffered context needed archiving/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, '');
assert.equal(record?.model, 'gpt-4');
assert.equal(record?.generation, 3);
assert.equal(record?.cutoffMessageId, 'om_new_empty');
assert.equal(record?.cutoffTimestampMs, 1781744520000);
assert.equal(record?.handoffSummary, undefined);

await store.set({
  key: sessionKey,
  sessionId: 'codex-session-before-boundary-write-failure',
  chatId: baseMessage.chatId,
  threadId: baseMessage.threadId,
  updatedAt: new Date().toISOString(),
  model: 'gpt-4',
  generation: 9,
  cutoffMessageId: 'om_existing_boundary',
  cutoffTimestampMs: 1781744500000,
});
assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new_boundary_write_failure',
  timestampMs: 1781744580000,
  text: '/new',
  rawContent: '{"text":"/new"}',
}, true, {
  sessionStore: {
    async get() {
      return {
        key: sessionKey,
        sessionId: 'codex-session-before-boundary-write-failure',
        chatId: baseMessage.chatId,
        threadId: baseMessage.threadId,
        updatedAt: new Date().toISOString(),
        model: 'gpt-4',
        generation: 9,
        cutoffMessageId: 'om_existing_boundary',
        cutoffTimestampMs: 1781744500000,
      };
    },
    async set() {
      throw new Error('session boundary write failed');
    },
  },
}), true);
assert.match(replies.at(-1)?.text ?? '', /New session was not started/);
assert.match(replies.at(-1)?.text ?? '', /session boundary write failed/);
record = await store.get(sessionKey);
assert.equal(record?.sessionId, 'codex-session-before-boundary-write-failure');
assert.equal(record?.generation, 9);
assert.equal(record?.cutoffMessageId, 'om_existing_boundary');

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_new_disabled',
  text: '/new',
  rawContent: '{"text":"/new"}',
}, false), true);
assert.match(replies.at(-1)?.text ?? '', /LARK_CODEX_EXEC_USE_SESSIONS=true/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_status_initial',
  text: '/access',
  rawContent: '{"text":"/access"}',
}), true);
assert.equal(
  replies.at(-1)?.text,
  [
    'User access: allowed',
    'Chat access: allowed',
    'No-mention mode: disabled',
  ].join('\n'),
);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_add',
  text: '/access add user ou_new_allowed',
  rawContent: '{"text":"/access add user ou_new_allowed"}',
}), true);
assert.equal(accessControlStore.isAllowedUserId('ou_new_allowed'), true);
assert.equal(replies.at(-1)?.text, 'User access added.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /ou_new_allowed|allowed_user_ids|snapshot/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_status_after_user',
  text: '/access list',
  rawContent: '{"text":"/access list"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /User access: blocked/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /ou_new_allowed|allowed_user_ids/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_admin_list_users',
  text: '/access admin list users',
  rawContent: '{"text":"/access admin list users"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Configured users:\n- ou_new_allowed/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_remove_user',
  text: '/access remove user ou_new_allowed',
  rawContent: '{"text":"/access remove user ou_new_allowed"}',
}), true);
assert.equal(accessControlStore.isAllowedUserId('ou_new_allowed'), false);
assert.equal(replies.at(-1)?.text, 'User access removed.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /ou_new_allowed|allowed_user_ids|snapshot/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_add_current_chat',
  text: '/access add chat 当前群聊',
  rawContent: '{"text":"/access add chat 当前群聊"}',
}), true);
assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_model'), true);
assert.deepEqual(validatedChats.at(-1), 'oc_model');
assert.equal(replies.at(-1)?.text, 'Chat access added.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /oc_model|allowed_chat_ids|resolved_from_current_chat|snapshot/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_admin_list_chats',
  text: '/access admin list chats',
  rawContent: '{"text":"/access admin list chats"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Configured chats:\n- oc_model/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_remove_here',
  text: '/access remove chat here',
  rawContent: '{"text":"/access remove chat here"}',
}), true);
assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_model'), false);
assert.equal(replies.at(-1)?.text, 'Chat access removed.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /oc_model|allowed_chat_ids|snapshot/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_add_no_mention',
  text: '/access add no-mention current',
  rawContent: '{"text":"/access add no-mention current"}',
}), true);
assert.equal(accessControlStore.snapshot().group_no_mention_chat_ids.includes('oc_model'), true);
assert.equal(replies.at(-1)?.text, 'No-mention mode enabled.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /oc_model|group_no_mention_chat_ids|snapshot/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_admin_list_no_mention',
  text: '/access admin list no-mention',
  rawContent: '{"text":"/access admin list no-mention"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /Configured no-mention chats:\n- oc_model/);

assert.equal(await runCommand({
  ...baseMessage,
  messageId: 'om_access_remove_no_mention',
  text: '/access remove no-mention current',
  rawContent: '{"text":"/access remove no-mention current"}',
}), true);
assert.equal(accessControlStore.snapshot().group_no_mention_chat_ids.includes('oc_model'), false);
assert.equal(replies.at(-1)?.text, 'No-mention mode disabled.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /oc_model|group_no_mention_chat_ids|snapshot/);

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
  messageId: 'om_access_admin_list_empty',
  text: '/access',
  rawContent: '{"text":"/access"}',
}), true);
assert.equal(
  replies.at(-1)?.text,
  [
    'User access: allowed',
    'Chat access: allowed',
    'No-mention mode: disabled',
  ].join('\n'),
);

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
  messageId: 'om_access_admin_list_denied',
  senderId: 'ou_not_owner',
  text: '/access admin list users',
  rawContent: '{"text":"/access admin list users"}',
}), true);
assert.match(replies.at(-1)?.text ?? '', /owner-only/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Configured users|ou_/);

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
assert.match(auditText, /lark_flush_command\s+ok/);
assert.match(auditText, /lark_new_session_command\s+ok/);
assert.match(auditText, /lark_new_session_command\s+error/);

console.log('codex-model-command smoke: PASS');
