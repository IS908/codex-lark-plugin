import { deliverMessageViaCodexExec } from './codex-exec-delivery.js';
import type { CodexExecActionDispatcher } from './codex-exec-actions.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import type { IdentitySession } from './identity-session.js';
import type { ChatVisibilityProvider } from './lark-message.js';
import type { ConversationBuffer } from './memory/buffer.js';
import { buildFlushPrompt } from './memory/distiller.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';

export interface ConversationFlushServiceOptions {
  buffer: ConversationBuffer;
  identitySession: IdentitySession;
  profileDistiller: ProfileDistillationDispatcher;
  chatVisibility: ChatVisibilityProvider;
  getActionDispatcher: () => CodexExecActionDispatcher | null;
}

export function registerConversationFlushHandler(options: ConversationFlushServiceOptions): void {
  const {
    buffer,
    identitySession,
    profileDistiller,
    chatVisibility,
    getActionDispatcher,
  } = options;

  buffer.setFlushHandler(async ({ chatId, threadId, messages, reason }) => {
    const flushPrompt = buildFlushPrompt(chatId, messages, threadId);
    // Flushes run as synthetic system turns through Codex exec. Feishu does
    // not see the synthetic turn; manual /flush and /new commands receive a
    // separate confirmation after save_memory succeeds.
    console.error(
      `[distiller] ${reason} flush for chat ${chatId}`
      + `${threadId ? ` thread=${threadId}` : ''}: ${messages.length} messages`,
    );

    // Bind a system-flush caller BEFORE notifying Codex (#66). Without
    // this, save_memory(type=chat) inside the flush turn fails caller
    // resolution because:
    //   - User entries are stored by IdentitySession under (chatId, threadId).
    //   - Auto flush carries chatId only, while manual thread flushes carry
    //     both chatId and threadId.
    //   - getCaller must resolve the same scope used by save_memory.
    //
    // Chat episodes are stored by (chatId, threadId?), NOT by caller, so a
    // sentinel caller doesn't change WHERE the data goes — only WHAT the
    // audit log records. Mirrors scheduler.executePromptJob's pattern of
    // binding job.meta.created_by before cronjob execution.
    identitySession.setCaller(chatId, threadId, SYSTEM_FLUSH_CALLER);

    const actionDispatcher = getActionDispatcher();
    if (!actionDispatcher) {
      throw new Error('Codex exec action dispatcher is not configured for conversation flush.');
    }
    let summary = '';
    let saveMemoryOk = false;
    await deliverMessageViaCodexExec({
      message: {
        messageId: `flush-${Date.now()}`,
        chatId,
        ...(threadId ? { threadId } : {}),
        chatType: 'system',
        senderId: 'system',
        text: flushPrompt,
        messageType: 'text',
        rawContent: flushPrompt,
      },
      displayLabel: threadId ? `System flush · ${chatId} · ${threadId}` : `System flush · ${chatId}`,
      useCodexSessions: false,
      progressVisible: false,
      actionDispatcher,
      sendReply: async () => ({ sentCount: 0, statusText: 'Synthetic flush reply suppressed.' }),
      onFinalText: (text) => {
        summary = text.trim();
      },
      onActionResults: (results) => {
        saveMemoryOk = results.some((result) => result.ok && result.action === 'save_memory');
      },
    });
    if (!saveMemoryOk) {
      throw new Error('Conversation flush did not persist a memory summary.');
    }

    const activeUserIds = [...new Set(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => message.senderId)
        .filter((senderId) => senderId && senderId !== 'system'),
    )];
    for (const userId of activeUserIds) {
      void profileDistiller
        .maybeDispatch({
          userId,
          chatId,
          chatType: chatVisibility.isPrivateChat(chatId) ? 'p2p' : 'group',
        })
        .then((result) => {
          if (result.status === 'error') {
            console.error(`[profile-distill] dispatch failed for ${userId}: ${result.error ?? 'unknown error'}`);
          }
        })
        .catch((err) => logSafeError('[profile-distill] dispatch failed:', err));
    }
    return { summary };
  });
}
