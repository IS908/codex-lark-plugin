import type * as Lark from '@larksuiteoapi/node-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AckReactionTracker } from '../ack-reactions.js';
import { audit } from '../audit-log.js';
import type { BotMessageTracker, LatestMessageTracker, LarkChannel } from '../channel.js';
import { SYSTEM_FLUSH_CALLER } from '../identity-session.js';
import type { IdentitySession } from '../identity-session.js';
import {
  createOpenApiLarkTransport,
  type LarkTransport,
} from '../lark-transport.js';
import type { ConversationBuffer } from '../memory/buffer.js';
import type { MemoryStore } from '../memory/file.js';
import type { ProfileDistillationDispatcher } from '../profile-distillation.js';
import { logSafeError } from '../safe-log.js';
import type { TurnObligationTracker, TurnSatisfactionSource } from '../turn-obligation.js';

export type LarkTransportProvider = LarkTransport | (() => LarkTransport);

export type ToolResult = {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
};

export type CallerResolution =
  | { caller: string }
  | { error: { isError: true; content: { type: 'text'; text: string }[] } };

export interface ToolContext {
  server: McpServer;
  client: Lark.Client;
  memoryStore: MemoryStore;
  identitySession: IdentitySession;
  channel: LarkChannel;
  transport: LarkTransport;
  conversationBuffer?: ConversationBuffer;
  ackReactions?: AckReactionTracker;
  botMessageTracker?: BotMessageTracker;
  latestMessageTracker?: LatestMessageTracker;
  turnObligations?: TurnObligationTracker;
  profileDistiller?: ProfileDistillationDispatcher;
  resolveCaller: (
    toolName: string,
    chatId: string | undefined,
    threadId: string | undefined,
    args: Record<string, unknown>,
  ) => CallerResolution;
  triggerProfileDistillation: (
    caller: string,
    chatId: string,
    threadId: string | undefined,
  ) => void;
  resolveTurnMessageId: (args: {
    reply_to?: string;
    chat_id?: string;
    thread_id?: string;
    fallback_message_id?: string;
  }) => string | undefined;
  satisfyTurn: (messageId: string | undefined, source: TurnSatisfactionSource) => void;
}

export interface CreateToolContextArgs {
  server: McpServer;
  client: Lark.Client;
  memoryStore: MemoryStore;
  identitySession: IdentitySession;
  channel: LarkChannel;
  conversationBuffer?: ConversationBuffer;
  ackReactions?: AckReactionTracker;
  botMessageTracker?: BotMessageTracker;
  latestMessageTracker?: LatestMessageTracker;
  turnObligations?: TurnObligationTracker;
  profileDistiller?: ProfileDistillationDispatcher;
  larkTransport?: LarkTransportProvider;
}

export function createTransportProxy(resolve: () => LarkTransport): LarkTransport {
  return {
    sendMessage: (request) => resolve().sendMessage(request),
    editMessage: (request) => resolve().editMessage(request),
    updateCard: (request) => resolve().updateCard(request),
    recallMessage: (messageId) => resolve().recallMessage(messageId),
    addReaction: (messageId, emojiType) => resolve().addReaction(messageId, emojiType),
    removeReaction: (messageId, reactionId) => resolve().removeReaction(messageId, reactionId),
    removeReactionByEmoji: (messageId, emojiType) => resolve().removeReactionByEmoji(messageId, emojiType),
    downloadResource: (messageId, fileKey, resourceType) =>
      resolve().downloadResource(messageId, fileKey, resourceType),
    uploadImage: (data) => resolve().uploadImage(data),
    uploadFile: (data, fileName) => resolve().uploadFile(data, fileName),
    replyDocComment: (request) => resolve().replyDocComment(request),
    createDocComment: (request) => resolve().createDocComment(request),
    fetchMessageText: (messageId) => resolve().fetchMessageText(messageId),
  };
}

export function createToolContext(args: CreateToolContextArgs): ToolContext {
  const fallbackTransport = createOpenApiLarkTransport(args.client);
  const providedTransport = args.larkTransport;
  const resolveTransport: () => LarkTransport =
    typeof providedTransport === 'function'
      ? providedTransport
      : () => providedTransport ?? fallbackTransport;
  const transport = createTransportProxy(resolveTransport);

  function resolveCaller(
    toolName: string,
    chatId: string | undefined,
    threadId: string | undefined,
    auditArgs: Record<string, unknown>,
  ): CallerResolution {
    if (!chatId) {
      void audit(toolName, null, auditArgs, 'denied');
      return {
        error: {
          isError: true,
          content: [{ type: 'text' as const, text: 'chat_id is required for this tool' }],
        },
      };
    }
    const caller = args.identitySession.getCaller(chatId, threadId);
    if (!caller) {
      void audit(toolName, null, auditArgs, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No active identity session for chat ${chatId}. This tool requires an inbound Feishu message to establish caller identity, or a terminal invocation with LARK_OWNER_OPEN_ID set.`,
            },
          ],
        },
      };
    }
    if (caller === SYSTEM_FLUSH_CALLER && toolName !== 'save_memory') {
      void audit(toolName, caller, auditArgs, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${toolName} is not authorized for the system-flush caller. Only save_memory can authorize under this caller (and save_memory itself further restricts to type=chat|thread). The sentinel exists to let buffer flushes persist chat episodes without a real user — not to act on behalf of one.`,
            },
          ],
        },
      };
    }
    return { caller };
  }

  function triggerProfileDistillation(
    caller: string,
    chatId: string,
    threadId: string | undefined,
  ): void {
    if (!args.profileDistiller) return;
    void args.profileDistiller
      .maybeDispatch({
        userId: caller,
        chatId,
        ...(threadId ? { threadId } : {}),
        chatType: args.channel.isPrivateChat(chatId) ? 'p2p' : 'group',
      })
      .then((result) => {
        if (result.status === 'error') {
          console.error(`[profile-distill] dispatch failed for ${caller}: ${result.error ?? 'unknown error'}`);
        }
      })
      .catch((err) => logSafeError('[profile-distill] dispatch failed:', err));
  }

  function resolveTurnMessageId(toolArgs: {
    reply_to?: string;
    chat_id?: string;
    thread_id?: string;
    fallback_message_id?: string;
  }): string | undefined {
    if (toolArgs.reply_to) return toolArgs.reply_to;
    const fallback = args.turnObligations?.resolveFallback(toolArgs.chat_id, toolArgs.thread_id);
    if (fallback?.status === 'ambiguous') {
      throw new Error(
        `reply_to is required: ${fallback.count} pending Lark turns match chat=${toolArgs.chat_id} thread=${toolArgs.thread_id ?? '(none)'}.`,
      );
    }
    if (fallback?.status === 'active' || fallback?.status === 'single-pending') {
      return fallback.messageId;
    }
    if (toolArgs.chat_id && args.latestMessageTracker) {
      return args.latestMessageTracker.getLatest(toolArgs.chat_id, toolArgs.thread_id)?.messageId;
    }
    return toolArgs.fallback_message_id;
  }

  function satisfyTurn(messageId: string | undefined, source: TurnSatisfactionSource): void {
    args.turnObligations?.markSatisfied(messageId, source);
  }

  return {
    server: args.server,
    client: args.client,
    memoryStore: args.memoryStore,
    identitySession: args.identitySession,
    channel: args.channel,
    transport,
    conversationBuffer: args.conversationBuffer,
    ackReactions: args.ackReactions,
    botMessageTracker: args.botMessageTracker,
    latestMessageTracker: args.latestMessageTracker,
    turnObligations: args.turnObligations,
    profileDistiller: args.profileDistiller,
    resolveCaller,
    triggerProfileDistillation,
    resolveTurnMessageId,
    satisfyTurn,
  };
}
