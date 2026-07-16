import type * as Lark from '@larksuiteoapi/node-sdk';
import { validateFeishuChatAccess } from './access-control-validation.js';
import type { AckReactionTracker } from './ack-reactions.js';
import { appConfig } from './config.js';
import { deliverMessageViaCodexExec } from './codex-exec-delivery.js';
import type { CodexExecActionDispatcher } from './codex-exec-actions.js';
import { formatCodexExecFailureReply, shouldSendCodexExecFailureReply } from './codex-exec-error.js';
import { handleCodexModelCommand } from './codex-model-command.js';
import type { CodexExecSessionHealthRecorder } from './codex-exec-delivery.js';
import type { CodexExecSessionStore } from './codex-session-store.js';
import { handleContinuationCommand } from './continuation/command-handler.js';
import type { ContinuationService } from './continuation/service.js';
import { debugLog } from './debug-log.js';
import { splitDocCommentText } from './doc-comment-api.js';
import type { IdentitySession } from './identity-session.js';
import type {
  ControlMessageHandler,
  LarkMessage,
  MessageHandler,
} from './lark-message.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker } from './message-trackers.js';
import { sendFeishuReply } from './reply-sender.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';
import { logSafeError, redactErrorForLog } from './safe-log.js';
import type { TurnObligationTracker } from './turn-obligation.js';

export interface CodexDeliveryChannelPorts {
  getClient(): Lark.Client;
  getLarkTransport(): LarkTransport;
  getAckReactions(): AckReactionTracker;
  getBotMessageTracker(): BotMessageTracker;
  getLatestMessageTracker(): LatestMessageTracker;
  invalidateMemoryDedupScope(chatId: string, threadId?: string, reason?: string): void;
  setControlMessageHandler(handler: ControlMessageHandler): void;
  setMessageHandler(handler: MessageHandler): void;
}

export interface CodexDeliverySessionHealth extends CodexExecSessionHealthRecorder {
  reset(sessionKey: string, reason?: 'manual' | 'session_id_changed'): void;
}

export interface ReplySenderPorts {
  client: () => Lark.Client;
  transport: () => LarkTransport;
  conversationBuffer?: ConversationBuffer;
  ackReactions?: AckReactionTracker;
  botMessageTracker?: BotMessageTracker;
  latestMessageTracker?: LatestMessageTracker;
  turnObligations?: TurnObligationTracker;
}

export function createReplySender(ports: ReplySenderPorts): (request: ReplyRequest) => Promise<ReplySendResult> {
  return (request) => sendFeishuReply(
    {
      client: ports.client(),
      transport: ports.transport(),
      conversationBuffer: ports.conversationBuffer,
      ackReactions: ports.ackReactions,
      botMessageTracker: ports.botMessageTracker,
      latestMessageTracker: ports.latestMessageTracker,
      turnObligations: ports.turnObligations,
    },
    request,
  );
}

export interface RegisterCodexDeliveryHandlersOptions {
  channel: CodexDeliveryChannelPorts;
  buffer: ConversationBuffer;
  identitySession: IdentitySession;
  sessionStore: CodexExecSessionStore;
  sessionHealth: CodexDeliverySessionHealth | null;
  turnObligations: TurnObligationTracker;
  actionDispatcher: CodexExecActionDispatcher | null;
  continuationService?: ContinuationService | null;
}

export function registerCodexDeliveryHandlers(options: RegisterCodexDeliveryHandlersOptions): void {
  const {
    channel,
    buffer,
    identitySession,
    sessionStore,
    sessionHealth,
    turnObligations,
    actionDispatcher,
    continuationService,
  } = options;

  const sendReplyViaFeishu = createReplySender({
    client: () => channel.getClient(),
    transport: () => channel.getLarkTransport(),
    conversationBuffer: buffer,
    ackReactions: channel.getAckReactions(),
    botMessageTracker: channel.getBotMessageTracker(),
    latestMessageTracker: channel.getLatestMessageTracker(),
    turnObligations,
  });

  channel.setControlMessageHandler(async (message) => {
    const handledTask = await handleContinuationCommand({
      message,
      service: continuationService ?? null,
      ownerOpenId: appConfig.ownerOpenId,
      sendReply: sendReplyViaFeishu,
      sendDocCommentReply: async (request) => {
        const response = await channel.getLarkTransport().replyDocComment({
          docToken: request.doc_token,
          commentId: request.comment_id,
          fileType: request.file_type,
          content: request.content,
        });
        return { replyId: response.replyId };
      },
    });
    if (handledTask) return true;
    return handleCodexModelCommand({
      message,
      sessionStore,
      identitySession,
      useCodexSessions: appConfig.codexExecUseSessions,
      flushConversation: ({ chatId, threadId, reason, commitBeforeRemove }) =>
        buffer.flushNow(chatId, { threadId, reason, commitBeforeRemove }),
      resetSessionHealth: (sessionKey) => sessionHealth?.reset(sessionKey, 'manual'),
      validateChatAccess: (chatId) => validateFeishuChatAccess(channel.getClient(), chatId),
      sendReply: sendReplyViaFeishu,
    });
  });

  channel.setMessageHandler(async (message) => {
    const displayLabel = displayLabelForMessage(message);

    debugLog(
      `[channel] Handler received message ${message.messageId} chat=${message.chatId} thread=${message.threadId ?? '(none)'} from=${displayLabel} text_bytes=${Buffer.byteLength(message.text, 'utf8')}`,
    );
    const hasReplyObligation = message.chatType === 'p2p' || message.chatType === 'group';
    identitySession.beginChannelTurn(message.chatId, message.threadId, appConfig.replyObligationTimeoutMs);
    if (hasReplyObligation) {
      turnObligations.begin({
        messageId: message.messageId,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        caller: message.senderId,
        mode: 'exec',
      });
      turnObligations.setActive(message.chatId, message.threadId, message.messageId);
    }

    try {
      debugLog(`[channel] Delivering message ${message.messageId} via codex exec`);
      await deliverMessageViaCodexExec({
        message,
        displayLabel,
        sessionStore,
        sendReply: sendReplyViaFeishu,
        sendDocCommentReply: async (request) => {
          const resp = await channel.getLarkTransport().replyDocComment({
            docToken: request.doc_token,
            commentId: request.comment_id,
            fileType: request.file_type,
            content: request.content,
          });
          return { replyId: resp.replyId };
        },
        recordAssistantMessage: (message) => recordAssistantMessage(buffer, message),
        sessionHealth: sessionHealth ?? undefined,
        turnObligations,
        actionDispatcher: actionDispatcher ?? undefined,
      });
      if (hasReplyObligation) {
        turnObligations.requireSatisfiedOrDeferred(message.messageId);
      }
      debugLog(`[channel] codex exec delivery completed for message ${message.messageId}`);
    } catch (err) {
      await handleCodexExecDeliveryFailure({
        channel,
        message,
        err,
        sendReplyViaFeishu,
      });
    } finally {
      identitySession.endChannelTurn(message.chatId, message.threadId);
      if (hasReplyObligation) {
        turnObligations.clearActive(message.chatId, message.threadId, message.messageId);
      }
    }
  });
}

function displayLabelForMessage(message: LarkMessage): string {
  const displayUser = message.senderName || message.senderId;
  const displayParts = [displayUser];
  if (message.chatName) displayParts.push(message.chatName);
  if (message.threadId) displayParts.push(`thread_${message.threadId.slice(-7)}`);
  return displayParts.join(' · ');
}

export function recordAssistantMessage(
  buffer: ConversationBuffer,
  { chatId, threadId, text }: { chatId: string; threadId?: string; text: string },
): void {
  buffer.record(chatId, {
    role: 'assistant',
    senderId: 'bot',
    text: text.slice(0, 500),
    timestamp: new Date().toISOString(),
    timestampMs: Date.now(),
    ...(threadId ? { threadId } : {}),
    messageType: 'text',
  });
}

async function handleCodexExecDeliveryFailure(args: {
  channel: CodexDeliveryChannelPorts;
  message: LarkMessage;
  err: unknown;
  sendReplyViaFeishu: (request: ReplyRequest) => Promise<ReplySendResult>;
}): Promise<void> {
  const { channel, message, err, sendReplyViaFeishu } = args;
  const errText = err instanceof Error ? err.message : String(err);
  channel.invalidateMemoryDedupScope(message.chatId, message.threadId, `delivery catch for message ${message.messageId}`);
  debugLog(`[channel] Failed to deliver inbound to Codex for message ${message.messageId}: ${errText}`);
  console.error('[channel] Failed to deliver inbound to Codex:', redactErrorForLog(err));
  const errorText = formatCodexExecFailureReply(err);
  if (message.chatType === 'doc_comment' && message.docComment) {
    for (const chunk of splitDocCommentText(errorText)) {
      await channel.getLarkTransport().replyDocComment({
        docToken: message.docComment.fileToken,
        commentId: message.docComment.commentId,
        fileType: message.docComment.fileType,
        content: chunk,
      }).catch((replyErr) => {
        logSafeError('[channel] Failed to send codex exec doc-comment error reply:', replyErr);
      });
    }
  } else if (shouldSendCodexExecFailureReply(message)) {
    await sendReplyViaFeishu({
      chat_id: message.chatId,
      text: errorText,
      reply_to: message.messageId,
      thread_id: message.threadId,
    }).catch((replyErr) => {
      console.error('[channel] Failed to send codex exec error reply:', redactErrorForLog(replyErr));
    });
  } else {
    console.error(
      `[channel] Suppressed codex exec error reply for non-user-visible or synthetic message ${message.messageId} (${message.chatType}): ${errorText}`,
    );
  }
}
