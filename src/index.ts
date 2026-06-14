import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { LarkChannel } from './channel.js';
import { registerTools } from './tools.js';
import { ConversationBuffer } from './memory/buffer.js';
import { buildFlushPrompt } from './memory/distiller.js';
import { MemoryStore } from './memory/file.js';
import { IdentitySession, SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { JobScheduler } from './scheduler.js';
import { mcpServerInstructions } from './prompts.js';
import { debugLog } from './debug-log.js';
import { deliverMessageViaCodexExec } from './codex-exec-delivery.js';
import { sendFeishuReply } from './reply-sender.js';
import { TurnObligationTracker } from './turn-obligation.js';
import { postDocCommentReply, splitDocCommentText } from './doc-comment-api.js';
import { buildChannelNotificationMeta } from './channel-notification.js';
import { shouldSendCodexExecFailureReply } from './codex-exec-error.js';
import { logSafeError, redactErrorForLog } from './safe-log.js';
import { packageName, packageVersion } from './package-metadata.js';
import {
  buildSessionHealthNudgeText,
  sendSessionHealthOwnerDm,
  SessionHealthMonitor,
} from './session-health.js';
import {
  acquireSingleInstanceLock,
  registerLockCleanup,
  sweepInbox,
} from './resource-governance.js';

const LOCK_FILE = path.join(os.tmpdir(), `codex-lark-${appConfig.appId}.lock`);

function runStartupResourceCleanup(memoryStore: MemoryStore): void {
  void sweepInbox(appConfig.inboxDir, {
    maxAgeMs: appConfig.inboxMaxAgeHours * 60 * 60 * 1000,
    maxBytes: appConfig.inboxMaxBytes,
  })
    .then((result) => {
      if (result.removedOld || result.removedForSize) {
        debugLog(
          `[governance] Inbox cleanup removed ${result.removedOld} old and ${result.removedForSize} LRU files`,
        );
      }
    })
    .catch((err) => debugLog(`[governance] Inbox cleanup failed: ${err}`));

  void memoryStore
    .pruneEpisodes()
    .then((result) => {
      if (result.removedFiles) debugLog(`[governance] Episode pruning removed ${result.removedFiles} files`);
    })
    .catch((err) => debugLog(`[governance] Episode pruning failed: ${err}`));
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  // 1. Create memory store
  const memoryStore = new MemoryStore();
  console.error(`[memory] Using ${appConfig.memoriesDir}`);

  // 1b. Create identity session (server-side caller tracking for sensitive tools)
  const identitySession = new IdentitySession(
    () => appConfig.ownerOpenId,
    appConfig.identitySessionTtlMs,
    appConfig.identitySessionMaxEntries,
  );
  if (appConfig.ownerOpenId) {
    console.error(`[identity] owner fallback: ${appConfig.ownerOpenId}`);
  } else {
    console.error('[identity] no LARK_OWNER_OPEN_ID set — terminal skill invocations will be denied');
  }

  // 2. Create MCP server
  const server = new McpServer(
    { name: packageName, version: packageVersion },
    {
      capabilities: {
        logging: {},
        experimental: {
          'Codex/channel': {},
        },
      },
      instructions: mcpServerInstructions,
    }
  );

  // 3. Create Lark channel
  const channel = new LarkChannel();
  channel.setMemoryStore(memoryStore);
  channel.setIdentitySession(identitySession);
  const turnObligations = new TurnObligationTracker();
  const sessionHealthMonitor =
    appConfig.sessionHealthEnabled && appConfig.ownerOpenId
      ? new SessionHealthMonitor({
          enabled: appConfig.codexExecUseSessions,
          ownerOpenId: appConfig.ownerOpenId,
          turnThreshold: appConfig.sessionHealthTurnThreshold,
          promptBytesThreshold: appConfig.sessionHealthPromptBytesThreshold,
          quietDelayMs: appConfig.sessionHealthIdleDelayMs,
          baseCooldownMs: appConfig.sessionHealthCooldownMs,
          maxCooldownMs: appConfig.sessionHealthMaxCooldownMs,
          maxNudges: appConfig.sessionHealthMaxNudges,
          quiet: () => ({
            queueIdle: channel.isIdle(),
            ackQuiet:
              channel.getAckReactions().activeCount === 0 &&
              channel.getAckReactions().pendingCount === 0,
            turnQuiet: turnObligations.pendingCount() === 0,
          }),
          notifyOwner: async (nudge) => {
            await sendSessionHealthOwnerDm(
              channel.getClient(),
              appConfig.ownerOpenId!,
              buildSessionHealthNudgeText(nudge),
            );
          },
        })
      : null;
  if (appConfig.sessionHealthEnabled && !appConfig.ownerOpenId) {
    console.error('[session-health] disabled: LARK_OWNER_OPEN_ID is required');
  } else if (appConfig.sessionHealthEnabled && !appConfig.codexExecUseSessions) {
    console.error('[session-health] disabled: LARK_CODEX_EXEC_USE_SESSIONS=false');
  }

  // 4. Create conversation buffer + wire flush handler
  const buffer = new ConversationBuffer();
  buffer.setFlushHandler(async (chatId, messages) => {
    const flushPrompt = buildFlushPrompt(chatId, messages);
    // In auto-flush, we inject the prompt as if it were a message
    // The channel's message handler will forward it to Codex
    console.error(`[distiller] Auto-flush for chat ${chatId}: ${messages.length} messages`);

    // Bind a system-flush caller BEFORE notifying Codex (#66). Without
    // this, save_memory(type=chat) inside the flush turn fails caller
    // resolution because:
    //   - User entries are stored by IdentitySession under (chatId, threadId).
    //   - The flush notification carries chatId only (no threadId, since the
    //     buffer is chat-scoped, not thread-scoped).
    //   - getCaller(chatId, undefined) falls back to a chat-level entry,
    //     which is only present in non-threaded chats. Threaded chats miss.
    //
    // Chat episodes are stored by (chatId, threadId?), NOT by caller, so a
    // sentinel caller doesn't change WHERE the data goes — only WHAT the
    // audit log records. Mirrors scheduler.executePromptJob's pattern of
    // binding job.meta.created_by before the cronjob notification.
    identitySession.setCaller(chatId, undefined, SYSTEM_FLUSH_CALLER);

    // Forward flush prompt through the normal message handler
    if (channel['messageHandler']) {
      await channel['messageHandler']({
        messageId: `flush-${Date.now()}`,
        chatId,
        chatType: 'system',
        senderId: 'system',
        text: flushPrompt,
        messageType: 'text',
        rawContent: flushPrompt,
      });
    }
  });
  channel.setConversationBuffer(buffer);

  // 5. Register MCP tools (pass buffer so reply records assistant messages)
  registerTools(
    server,
    channel.getClient(),
    memoryStore,
    identitySession,
    channel,
    buffer,
    channel.getAckReactions(),
    channel.getBotMessageTracker(),
    channel.getLatestMessageTracker(),
    turnObligations
  );

  // 6. Set message handler — forwards Feishu messages to Codex via MCP
  channel.setMessageHandler(async (message) => {
    // Build friendly display: user_xxx or user_xxx · chat_xxx · thread_xxx
    const displayUser = message.senderName || message.senderId;
    const displayParts = [displayUser];
    if (message.chatName) displayParts.push(message.chatName);
    if (message.threadId) displayParts.push(`thread_${message.threadId.slice(-7)}`);
    const displayLabel = displayParts.join(' · ');

    debugLog(
      `[channel] Handler received message ${message.messageId} chat=${message.chatId} thread=${message.threadId ?? '(none)'} from=${displayLabel}: ${message.text.slice(0, 100)}...`
    );
    const hasReplyObligation = message.chatType === 'p2p' || message.chatType === 'group';
    identitySession.beginChannelTurn(message.chatId, message.threadId, appConfig.replyObligationTimeoutMs);
    if (hasReplyObligation) {
      turnObligations.begin({
        messageId: message.messageId,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        caller: message.senderId,
        mode: appConfig.codexDeliveryMode,
      });
      turnObligations.setActive(message.chatId, message.threadId, message.messageId);
    }

    try {
      if (appConfig.codexDeliveryMode === 'exec') {
        debugLog(
          `[channel] Delivering message ${message.messageId} via codex exec`
        );
        await deliverMessageViaCodexExec({
          message,
          displayLabel,
          sendReply: (request) => sendFeishuReply(
            {
              client: channel.getClient(),
              conversationBuffer: buffer,
              ackReactions: channel.getAckReactions(),
              botMessageTracker: channel.getBotMessageTracker(),
              latestMessageTracker: channel.getLatestMessageTracker(),
              turnObligations,
            },
            request,
          ),
          sendDocCommentReply: async (request) => {
            const resp = await postDocCommentReply(channel.getClient(), {
              docToken: request.doc_token,
              commentId: request.comment_id,
              fileType: request.file_type,
              content: request.content,
            });
            return { replyId: resp?.data?.reply_id };
          },
          recordAssistantMessage: ({ chatId, text }) => {
            buffer.record(chatId, {
              role: 'assistant',
              senderId: 'bot',
              text: text.slice(0, 500),
              timestamp: new Date().toISOString(),
            });
          },
          sessionHealth: sessionHealthMonitor ?? undefined,
          turnObligations,
        });
        if (hasReplyObligation) {
          turnObligations.requireSatisfiedOrDeferred(message.messageId);
        }
        debugLog(
          `[channel] codex exec delivery completed for message ${message.messageId}`
        );
        return;
      }

      debugLog(
        `[channel] Sending notifications/Codex/channel for message ${message.messageId}`
      );
      await server.server.notification({
        method: 'notifications/Codex/channel',
        params: {
          content: message.text,
          meta: buildChannelNotificationMeta(message, displayLabel),
        },
      });
      debugLog(
        `[channel] notifications/Codex/channel returned for message ${message.messageId}`
      );
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      channel.invalidateMemoryDedupScope(message.chatId, message.threadId, `delivery catch for message ${message.messageId}`);
      debugLog(
        `[channel] Failed to deliver inbound to Codex for message ${message.messageId}: ${errText}`
      );
      console.error('[channel] Failed to deliver inbound to Codex:', redactErrorForLog(err));
      if (appConfig.codexDeliveryMode === 'exec') {
        const errorText = `Codex exec failed: ${errText.slice(0, 1500)}`;
        if (message.chatType === 'doc_comment' && message.docComment) {
          for (const chunk of splitDocCommentText(errorText)) {
            await postDocCommentReply(channel.getClient(), {
              docToken: message.docComment.fileToken,
              commentId: message.docComment.commentId,
              fileType: message.docComment.fileType,
              content: chunk,
            }).catch((replyErr) => {
              logSafeError('[channel] Failed to send codex exec doc-comment error reply:', replyErr);
            });
          }
        } else if (shouldSendCodexExecFailureReply(message)) {
          await sendFeishuReply(
            {
              client: channel.getClient(),
              conversationBuffer: buffer,
              ackReactions: channel.getAckReactions(),
              botMessageTracker: channel.getBotMessageTracker(),
              latestMessageTracker: channel.getLatestMessageTracker(),
              turnObligations,
            },
            {
              chat_id: message.chatId,
              text: errorText,
              reply_to: message.messageId,
              thread_id: message.threadId,
            },
          ).catch((replyErr) => {
            console.error('[channel] Failed to send codex exec error reply:', redactErrorForLog(replyErr));
          });
        } else {
          console.error(
            `[channel] Suppressed codex exec error reply for non-user-visible or synthetic message ${message.messageId} (${message.chatType}): ${errorText}`,
          );
        }
      }
    } finally {
      if (appConfig.codexDeliveryMode === 'exec') {
        identitySession.endChannelTurn(message.chatId, message.threadId);
      }
      if (hasReplyObligation) {
        turnObligations.clearActive(message.chatId, message.threadId, message.messageId);
      }
    }
  });

  if (isDryRun) {
    console.error('[dry-run] All modules loaded successfully.');
    console.error('[dry-run] Tools registered. Exiting.');
    process.exit(0);
  }

  // 7. Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[index] MCP server connected via stdio');

  // 8. Acquire single-instance lock and start Lark WebSocket
  const lock = await acquireSingleInstanceLock(LOCK_FILE);
  registerLockCleanup(lock);
  await channel.start();

  // 9. Re-arm flush timers from persisted episodes
  await buffer.rearmFromDisk();

  // 10. Start cronjob scheduler
  const scheduler = new JobScheduler({
    server: server.server,
    client: channel.getClient(),
    identitySession,
    botMessageTracker: channel.getBotMessageTracker(),
  });
  await scheduler.start();

  runStartupResourceCleanup(memoryStore);

  console.error('[index] codex-lark-plugin started successfully');
}

main().catch((err) => {
  logSafeError('[index] Fatal error:', err);
  process.exit(1);
});
