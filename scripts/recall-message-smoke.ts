import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AckReactionTracker } from '../src/ack-reactions.js';
import { BotMessageTracker } from '../src/channel.js';
import type { LarkChannel } from '../src/channel.js';
import { appConfig } from '../src/config.js';
import { IdentitySession } from '../src/identity-session.js';
import type { MemoryStore } from '../src/memory/file.js';
import { TurnObligationTracker } from '../src/turn-obligation.js';
import { registerTools } from '../src/tools.js';

async function flushAsyncAudit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const tmpDir = mkdtempSync(join(tmpdir(), 'recall-message-'));
const originalAuditLog = appConfig.auditLogPath;
(appConfig as { auditLogPath: string }).auditLogPath = join(tmpDir, 'audit.log');

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

const noopClient = {
  im: {
    v1: {
      message: {},
      messageReaction: {
        delete: async () => {},
      },
    },
  },
};

try {
  const calls: Array<{ method: string; args: any }> = [];
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const fakeServer = {
    registerTool(name: string, _config: any, handler: any) {
      handlers.set(name, handler);
    },
  };
  const transport = {
    sendMessage: async () => ({ sentCount: 1, statusText: 'ok' }),
    editMessage: async (request: { messageId: string; text: string }) => {
      calls.push({ method: 'transport.editMessage', args: request });
    },
    updateCard: async (request: { messageId: string; card: object | string }) => {
      calls.push({ method: 'transport.updateCard', args: request });
    },
    addReaction: async () => 'reaction_1',
    removeReaction: async () => {},
    removeReactionByEmoji: async () => true,
    downloadResource: async () => Buffer.from(''),
    uploadImage: async () => 'img_1',
    uploadFile: async () => 'file_1',
    replyDocComment: async () => ({}),
    createDocComment: async () => ({}),
    fetchMessageText: async () => null,
    fetchMessageContext: async () => null,
    recallMessage: async (messageId: string) => {
      calls.push({ method: 'transport.recallMessage', args: { messageId } });
    },
  };
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('oc_recall', 'thread_1', 'ou_caller');
  const botTracker = new BotMessageTracker(10);
  botTracker.add('om_bot_recall', { chatId: 'oc_recall', threadId: 'thread_1' });
  botTracker.add('om_bot_edit', { chatId: 'oc_recall', threadId: 'thread_1' });
  botTracker.add('om_bot_edit_card', { chatId: 'oc_recall', threadId: 'thread_1' });
  botTracker.add('om_bot_other_chat', { chatId: 'oc_other', threadId: 'thread_1' });
  const turnObligations = new TurnObligationTracker({ timeoutMs: 60_000 });
  turnObligations.begin({
    messageId: 'om_current_turn',
    chatId: 'oc_recall',
    threadId: 'thread_1',
    caller: 'ou_caller',
    mode: 'notification',
  });
  turnObligations.begin({
    messageId: 'om_current_edit_turn',
    chatId: 'oc_recall',
    threadId: 'thread_1',
    caller: 'ou_caller',
    mode: 'notification',
  });
  turnObligations.begin({
    messageId: 'om_current_card_edit_turn',
    chatId: 'oc_recall',
    threadId: 'thread_1',
    caller: 'ou_caller',
    mode: 'notification',
  });
  const ackReactions = new AckReactionTracker({ maxTrackedMessages: 10 });
  ackReactions.recordInbound('om_current_turn');
  ackReactions.storeReaction('om_current_turn', 'reaction_current');
  ackReactions.recordInbound('om_current_edit_turn');
  ackReactions.storeReaction('om_current_edit_turn', 'reaction_edit');
  ackReactions.recordInbound('om_current_card_edit_turn');
  ackReactions.storeReaction('om_current_card_edit_turn', 'reaction_card_edit');

  registerTools(
    fakeServer as any,
    noopClient as any,
    noopMemory,
    identitySession,
    { isPrivateChat: () => false } as unknown as LarkChannel,
    undefined,
    ackReactions,
    botTracker,
    undefined,
    turnObligations,
    undefined,
    transport as any,
  );

  const recall = handlers.get('recall_message');
  assert.ok(recall, 'recall_message tool should be registered');
  const edit = handlers.get('edit_message');
  assert.ok(edit, 'edit_message tool should be registered');

  const ok = await recall({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    reply_to: 'om_current_turn',
    message_id: 'om_bot_recall',
  });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content[0].text, 'Recalled message om_bot_recall');
  assert.deepEqual(calls, [{ method: 'transport.recallMessage', args: { messageId: 'om_bot_recall' } }]);
  assert.equal(turnObligations.getStatus('om_current_turn'), 'satisfied');
  assert.equal(ackReactions.activeCount, 2);

  const unknown = await recall({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    message_id: 'om_user_message',
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /not a tracked bot message/i);

  const wrongScope = await recall({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    message_id: 'om_bot_other_chat',
  });
  assert.equal(wrongScope.isError, true);
  assert.match(wrongScope.content[0].text, /does not belong to chat=oc_recall thread=thread_1/i);
  assert.equal(calls.length, 1);

  const editUnknown = await edit({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    reply_to: 'om_current_edit_turn',
    message_id: 'om_user_message',
    text: 'edited',
    format: 'text',
  });
  assert.equal(editUnknown.isError, true);
  assert.match(editUnknown.content[0].text, /not a tracked bot message/i);
  assert.equal(calls.length, 1);

  const editWrongScope = await edit({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    reply_to: 'om_current_edit_turn',
    message_id: 'om_bot_other_chat',
    text: 'edited',
    format: 'text',
  });
  assert.equal(editWrongScope.isError, true);
  assert.match(editWrongScope.content[0].text, /does not belong to chat=oc_recall thread=thread_1/i);
  assert.equal(calls.length, 1);

  const editOk = await edit({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    reply_to: 'om_current_edit_turn',
    message_id: 'om_bot_edit',
    text: 'edited',
    format: 'text',
  });
  assert.equal(editOk.isError, undefined);
  assert.equal(editOk.content[0].text, 'Edited message om_bot_edit');
  assert.deepEqual(calls[1], {
    method: 'transport.editMessage',
    args: { messageId: 'om_bot_edit', text: 'edited' },
  });
  assert.equal(turnObligations.getStatus('om_current_edit_turn'), 'satisfied');

  const editCardOk = await edit({
    chat_id: 'oc_recall',
    thread_id: 'thread_1',
    reply_to: 'om_current_card_edit_turn',
    message_id: 'om_bot_edit_card',
    text: 'card body',
    format: 'card_markdown',
  });
  assert.equal(editCardOk.isError, undefined);
  assert.equal(editCardOk.content[0].text, 'Edited message om_bot_edit_card');
  assert.equal(calls[2].method, 'transport.updateCard');
  assert.equal(calls[2].args.messageId, 'om_bot_edit_card');
  assert.equal(turnObligations.getStatus('om_current_card_edit_turn'), 'satisfied');
  assert.equal(ackReactions.activeCount, 0);

  await flushAsyncAudit();
  const audit = readFileSync(appConfig.auditLogPath, 'utf-8');
  assert.match(audit, /recall_message/);
  assert.match(audit, /edit_message/);
  assert.match(audit, /ok/);
  assert.match(audit, /denied/);
} finally {
  (appConfig as { auditLogPath: string }).auditLogPath = originalAuditLog;
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log('recall-message smoke: PASS');
