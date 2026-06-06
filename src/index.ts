import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
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

const LOCK_FILE = path.join(os.tmpdir(), `codex-lark-${appConfig.appId}.lock`);

async function acquireLock(): Promise<void> {
  try {
    // Try to create lock file exclusively
    await fs.writeFile(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch {
    // Lock file exists — check if the process is still alive
    try {
      const pid = parseInt(await fs.readFile(LOCK_FILE, 'utf-8'), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        console.error(`[lock] Another instance is running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // Process is dead — stale lock, overwrite
        await fs.writeFile(LOCK_FILE, String(process.pid));
      }
    } catch {
      await fs.writeFile(LOCK_FILE, String(process.pid));
    }
  }
  // Clean up lock on exit
  const cleanup = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
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
  );
  if (appConfig.ownerOpenId) {
    console.error(`[identity] owner fallback: ${appConfig.ownerOpenId}`);
  } else {
    console.error('[identity] no LARK_OWNER_OPEN_ID set — terminal skill invocations will be denied');
  }

  // 2. Create MCP server
  const server = new McpServer(
    { name: 'codex-lark-plugin', version: '1.0.8' },
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
    channel.getLatestMessageTracker()
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
            },
            request,
          ),
        });
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
          meta: {
            chat_id: message.chatId,
            message_id: message.messageId,
            user: displayLabel,
            user_id: message.senderId,
            chat_type: message.chatType,
            ...(message.chatName ? { chat_name: message.chatName } : {}),
            ...(message.threadId ? { thread_id: message.threadId } : {}),
            ...(message.botMentioned ? { bot_mentioned: 'true' } : {}),
            ts: new Date().toISOString(),
            ...(message.parentContent ? { parent_content: message.parentContent } : {}),
            ...(message.imagePath ? { image_path: message.imagePath } : {}),
            ...(message.imagePaths?.length ? { image_paths: message.imagePaths.join(',') } : {}),
            ...(message.attachments?.length === 1
              ? {
                  attachment_kind: message.attachments[0].fileType,
                  attachment_file_id: message.attachments[0].fileKey,
                  attachment_name: message.attachments[0].fileName,
                }
              : message.attachments && message.attachments.length > 1
                ? { attachments: JSON.stringify(message.attachments) }
                : {}),
          },
        },
      });
      debugLog(
        `[channel] notifications/Codex/channel returned for message ${message.messageId}`
      );
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      debugLog(
        `[channel] Failed to deliver inbound to Codex for message ${message.messageId}: ${errText}`
      );
      console.error('[channel] Failed to deliver inbound to Codex:', err);
      if (appConfig.codexDeliveryMode === 'exec') {
        await sendFeishuReply(
          {
            client: channel.getClient(),
            conversationBuffer: buffer,
            ackReactions: channel.getAckReactions(),
            botMessageTracker: channel.getBotMessageTracker(),
            latestMessageTracker: channel.getLatestMessageTracker(),
          },
          {
            chat_id: message.chatId,
            text: `Codex exec failed: ${errText.slice(0, 1500)}`,
            reply_to: message.messageId,
            thread_id: message.threadId,
          },
        ).catch((replyErr) => {
          console.error('[channel] Failed to send codex exec error reply:', replyErr);
        });
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
  await acquireLock();
  await channel.start();

  // 9. Re-arm flush timers from persisted episodes
  await buffer.rearmFromDisk();

  // 10. Start cronjob scheduler
  const scheduler = new JobScheduler({
    server: server.server,
    client: channel.getClient(),
    identitySession,
  });
  await scheduler.start();

  console.error('[index] codex-lark-plugin started successfully');
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
