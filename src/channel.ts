import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuite/channel';
import { appConfig } from './config.js';
import { accessControlStore } from './runtime-access-control.js';
import { MessageQueue } from './queue.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { IdentitySession } from './identity-session.js';
import { TERMINAL_CHAT_ID } from './identity-session.js';
import { debugLog } from './debug-log.js';
import { feishuApiCall } from './feishu-retry.js';
import { BoundedCache } from './resource-governance.js';
import { AckReactionTracker } from './ack-reactions.js';
import {
  createOpenApiLarkTransport,
  createSdkLarkTransport,
} from './lark-transport.js';
import type { LarkTransport, SdkLarkTransportChannel } from './lark-transport-contracts.js';
import { logSafeError, redactErrorForLog } from './safe-log.js';
import { bindSdkCommentIdentity, processSdkMessage } from './sdk-channel-parity.js';
import {
  createMemoryDedupScopeKey,
  MemoryContextDeduper,
} from './memory-context-dedup.js';
import {
  type ReactionRouteDecision,
  routeReactionEvent,
  sdkReactionRouteEvent,
} from './reaction-router.js';
import { DisplayNameResolver, generateUserAlias } from './display-name-resolver.js';
import { enrichLarkMessageWithMemory } from './memory-enricher.js';
import { handleCommentEvent } from './doc-comment-inbound.js';
import { prepareInboundTurn } from './inbound-turn-pipeline.js';
import { filterParentContentAfterBoundary } from './conversation-boundary.js';
import type {
  ControlMessageHandler,
  ConversationBoundaryProvider,
  LarkMessage,
  MessageHandler,
} from './lark-message.js';
import { BotMessageTracker, LatestMessageTracker } from './message-trackers.js';

export { resolveMentionPlaceholders } from './message-content.js';
export { handleCommentEvent, passesDocCommentWhitelist } from './doc-comment-inbound.js';

/**
 * Build a Lark SDK logger that routes every level to stderr. The SDK's default
 * logger writes to stdout via `console.log`, which would corrupt MCP JSON-RPC
 * framing on the stdio transport. Every Lark Client construction MUST include
 * this logger — enforced statically by
 * `scripts/check-sdk-loggers.ts`.
 *
 * Levels implemented: info / warn / error / debug / trace — the canonical
 * Lark SDK set. If a future SDK version introduces a new level (e.g.
 * verbose, fatal), this factory will need to be extended; otherwise the
 * SDK would throw a TypeError on the missing method.
 */
function makeSdkLogger(prefix: string) {
  return {
    info: (...args: any[]) => console.error(`[${prefix}]`, ...args),
    warn: (...args: any[]) => console.error(`[${prefix}][warn]`, ...args),
    error: (...args: any[]) => console.error(`[${prefix}][error]`, ...args.map(redactErrorForLog)),
    debug: (...args: any[]) => console.error(`[${prefix}][debug]`, ...args),
    trace: (...args: any[]) => console.error(`[${prefix}][trace]`, ...args),
  };
}

/**
 * Whitelist check with OR semantics:
 * - Neither list configured → allow all
 * - Only user list → gate on user only
 * - Only chat list → gate on chat only
 * - Both lists → allow when user OR chat matches (either list whitelists the message)
 */
function passesWhitelist(senderId: string, chatId: string): boolean {
  return accessControlStore.allowsMessage(senderId, chatId);
}

const SDK_COMMENT_CONTEXT_CAP_BYTES = 8 * 1024;

function capUtf8Text(s: string | undefined, maxBytes: number): string | undefined {
  if (s === undefined) return undefined;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}

export class LarkChannel {
  private client: Lark.Client;
  private nameCache = new BoundedCache<string, string>(appConfig.nameCacheSize); // open_id/chat_id → display name
  private displayNameResolver: DisplayNameResolver;
  private chatTypeCache = new BoundedCache<string, 'p2p' | 'group'>(appConfig.chatTypeCacheSize); // chatId → type (populated from inbound events)
  private botOpenId: string = '';
  private queue = new MessageQueue({ handlerTimeoutMs: appConfig.queueHandlerTimeoutMs });
  private messageHandler: MessageHandler | null = null;
  private controlMessageHandler: ControlMessageHandler | null = null;
  private memoryStore: MemoryStore | null = null;
  private conversationBuffer: ConversationBuffer | null = null;
  private identitySession: IdentitySession | null = null;
  private ackReactions = new AckReactionTracker();
  private botMessageTracker = new BotMessageTracker(appConfig.botMessageTrackerSize);
  private latestMessageTracker = new LatestMessageTracker(10 * 60 * 1000, appConfig.latestMessageTrackerSize);
  private commentEventIdSeen = new BoundedCache<string, true>(1000);
  private memoryDeduper = new MemoryContextDeduper({ windowMs: appConfig.memoryDedupWindowMs });
  private larkTransport: LarkTransport;
  private larkTransportRawClient: Lark.Client;
  private larkTransportRuntime: 'openapi' | 'sdk' = 'openapi';
  private conversationBoundaryProvider: ConversationBoundaryProvider | null = null;

  constructor() {
    this.client = new Lark.Client({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      logger: makeSdkLogger('lark-sdk'),
    });
    this.displayNameResolver = new DisplayNameResolver({
      cache: this.nameCache,
      client: () => this.client as any,
    });
    this.larkTransport = createOpenApiLarkTransport(this.client, {
      outboundMessageContextCache: this.botMessageTracker,
    });
    this.larkTransportRawClient = this.client;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setControlMessageHandler(handler: ControlMessageHandler): void {
    this.controlMessageHandler = handler;
  }

  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  setIdentitySession(session: IdentitySession): void {
    this.identitySession = session;
  }

  /**
   * Returns true if the given chat_id should be treated as a private
   * (caller-only visible) chat for rendering-visibility purposes.
   *
   * - Real p2p chats: inferred from inbound event chat_type, cached.
   * - Terminal sentinel: treated as private (the operator is the sole viewer).
   * - Unknown chat_ids: default to false (treat as group) to bias the filter
   *   toward less exposure when we have no signal.
   */
  isPrivateChat(chatId: string): boolean {
    if (chatId === TERMINAL_CHAT_ID) return true;
    return this.chatTypeCache.get(chatId) === 'p2p';
  }

  setConversationBuffer(buffer: ConversationBuffer): void {
    this.conversationBuffer = buffer;
  }

  setConversationBoundaryProvider(provider: ConversationBoundaryProvider): void {
    this.conversationBoundaryProvider = provider;
  }

  getClient(): Lark.Client {
    return this.client;
  }

  getLarkTransport(): LarkTransport {
    this.ensureOpenApiTransportCurrent();
    return this.larkTransport;
  }

  setSdkTransportChannel(sdkChannel: SdkLarkTransportChannel): void {
    this.larkTransport = createSdkLarkTransport(sdkChannel, this.client, {
      outboundMessageContextCache: this.botMessageTracker,
    });
    this.larkTransportRawClient = this.client;
    this.larkTransportRuntime = 'sdk';
  }

  private ensureOpenApiTransportCurrent(): void {
    if (this.larkTransportRuntime !== 'openapi') return;
    if (this.larkTransportRawClient === this.client) return;
    this.larkTransport = createOpenApiLarkTransport(this.client, {
      outboundMessageContextCache: this.botMessageTracker,
    });
    this.larkTransportRawClient = this.client;
  }

  getAckReactions(): AckReactionTracker {
    return this.ackReactions;
  }

  getBotMessageTracker(): BotMessageTracker {
    return this.botMessageTracker;
  }

  getLatestMessageTracker(): LatestMessageTracker {
    return this.latestMessageTracker;
  }

  private inboundTurnDeps() {
    return {
      latestMessageTracker: this.latestMessageTracker,
      ackReactions: this.ackReactions,
      larkTransport: this.larkTransport,
      chatTypeCache: this.chatTypeCache,
      botMessageTracker: this.botMessageTracker,
    };
  }

  invalidateMemoryDedupScope(chatId: string, threadId?: string, reason = 'manual'): void {
    const scopeKey = createMemoryDedupScopeKey(chatId, threadId);
    this.memoryDeduper.invalidate(scopeKey);
    debugLog(`[memory-dedup] invalidated scope=${scopeKey} reason=${reason}`);
  }

  isIdle(): boolean {
    return this.queue.isIdle();
  }

  async handleSdkMessageEvent(
    sdkMessage: NormalizedMessage,
    sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>,
  ): Promise<void> {
    const result = await processSdkMessage(sdkMessage, {
      identitySession: this.identitySession!,
      accessControl: accessControlStore,
      botOpenId: this.botOpenId,
      handleMessage: async (message) => {
        await this.prepareSdkMessage(message, sdkMessage, sdkChannel);
        this.enqueueMessage(message);
      },
    });

    if (result.status === 'dropped') {
      const diagnostic = result.diagnostic
        ? ` chat=${result.diagnostic.chatId}` +
          ` top_level=${result.diagnostic.topLevel}` +
          ` thread=${result.diagnostic.threadMessage}` +
          ` no_mention_allowed=${result.diagnostic.noMentionAllowed}` +
          ` heuristic=${result.diagnostic.triggerDecision}`
        : '';
      debugLog(`[sdk-channel] Dropped message ${sdkMessage.messageId}: ${result.reason}${diagnostic}`);
    }
  }

  async handleSdkCommentEvent(
    comment: CommentEvent,
    sdkChannel?: Pick<SdkLarkChannel, 'comments'>,
  ): Promise<void> {
    if (comment.raw) {
      await handleCommentEvent(comment.raw, {
        botOpenId: this.botOpenId,
        seenEventIds: this.commentEventIdSeen,
        identitySession: this.identitySession!,
        queue: this.queue,
        messageHandler: this.messageHandler,
        processMessage: this.processEnqueuedMessage.bind(this),
        resolveUserName: this.displayNameResolver.resolveUserName.bind(this.displayNameResolver),
        client: this.client as any,
      });
      return;
    }

    try {
      const message = bindSdkCommentIdentity(comment, this.identitySession!);
      message.currentUserText = message.text;
      await this.addSdkCommentContext(message, comment, sdkChannel);
      this.enqueueMessage(message);
    } catch (err) {
      logSafeError('[sdk-channel] Error handling SDK comment event:', err);
    }
  }

  async handleSdkReactionEvent(reaction: ReactionEvent): Promise<void> {
    if (reaction.action !== 'added') return;

    const decision = routeReactionEvent({
      event: sdkReactionRouteEvent(reaction, this.botOpenId),
      botMessageTracker: this.botMessageTracker,
      passesWhitelist,
      debugLog,
      logPrefix: '[sdk-channel]',
    });
    if (decision.action === 'deliver') {
      await this.enqueueReactionMessage(decision);
    }
  }

  setBotOpenId(openId: string | undefined): void {
    if (openId) {
      this.botOpenId = openId;
      debugLog(`[sdk-channel] Bot open_id resolved: ${openId}`);
    }
  }

  private async prepareSdkMessage(
    message: LarkMessage,
    sdkMessage: NormalizedMessage,
    sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>,
  ): Promise<void> {
    await prepareInboundTurn(message, this.inboundTurnDeps(), {
      resources: sdkMessage.resources,
      sdkChannel,
    });
  }

  private enqueueMessage(message: LarkMessage): void {
    debugLog(
      `[channel] Enqueue message ${message.messageId} chat=${message.chatId} thread=${message.threadId ?? '(none)'}`
    );

    this.queue.enqueue(message.chatId, message.threadId, async () => {
      await this.processEnqueuedMessage(message);
    });
  }

  private async addSdkCommentContext(
    message: LarkMessage,
    comment: CommentEvent,
    sdkChannel?: Pick<SdkLarkChannel, 'comments'>,
  ): Promise<void> {
    if (!sdkChannel?.comments) return;
    try {
      const target = await sdkChannel.comments.resolveTarget(comment.fileToken, comment.fileType);
      if (!target) return;
      const fetched = await sdkChannel.comments.fetch(target, comment.commentId);
      if (fetched?.quote) {
        message.text = `${message.text}\n\n[Selected Text]\n${capUtf8Text(fetched.quote, SDK_COMMENT_CONTEXT_CAP_BYTES)}`;
      }
    } catch {
      // Comment context is best-effort; keep the turn deliverable without it.
    }
  }

  private async processEnqueuedMessage(larkMessage: LarkMessage): Promise<void> {
    const { messageId, chatId, threadId, senderId } = larkMessage;
    debugLog(
      `[channel] Queue handler start message ${messageId} chat=${chatId} thread=${threadId ?? '(none)'}`
    );

    // Bind identity for this chat/thread so MCP tools can resolve the
    // true caller without trusting Codex-declared identity arguments.
    this.identitySession?.setCaller(chatId, threadId, senderId);

    if (this.controlMessageHandler && await this.controlMessageHandler(larkMessage)) {
      debugLog(`[channel] Control message handled for message ${messageId}`);
      return;
    }

    // Record in conversation buffer
    this.conversationBuffer?.record(chatId, {
      role: 'user',
      senderId,
      text: larkMessage.text,
      timestamp: new Date().toISOString(),
      timestampMs: larkMessage.timestampMs ?? Date.now(),
      messageId,
      threadId,
      messageType: larkMessage.messageType,
      ...(larkMessage.messagePosition ? { messagePosition: larkMessage.messagePosition } : {}),
    });

    // Build memory-enriched context
    debugLog(`[channel] Enriching memory for message ${messageId}`);
    const conversationBoundary = this.conversationBoundaryProvider
      ? await this.conversationBoundaryProvider.get(chatId, threadId)
      : null;
    const boundaryFilteredMessage = {
      ...larkMessage,
      parentContent: filterParentContentAfterBoundary(larkMessage.parentContent, conversationBoundary),
    };
    const enrichedText = await enrichLarkMessageWithMemory(boundaryFilteredMessage, {
      memoryStore: this.memoryStore,
      conversationBuffer: this.conversationBuffer,
      memoryDeduper: this.memoryDeduper,
      conversationBoundary,
      log: debugLog,
    });
    debugLog(`[channel] Memory enrichment complete for message ${messageId}`);

    // Forward to handler with enriched context
    const enrichedMessage = {
      ...boundaryFilteredMessage,
      currentUserText: boundaryFilteredMessage.currentUserText ?? boundaryFilteredMessage.text,
      text: enrichedText,
    };

    if (this.messageHandler) {
      debugLog(`[channel] Calling message handler for message ${messageId}`);
      try {
        await this.messageHandler(enrichedMessage);
        if (conversationBoundary?.handoffSummary && !conversationBoundary.handoffConsumedAt) {
          await this.conversationBoundaryProvider?.markHandoffConsumed(
            chatId,
            threadId,
            conversationBoundary.generation,
          );
        }
        debugLog(`[channel] Message handler completed for message ${messageId}`);
      } catch (err) {
        this.invalidateMemoryDedupScope(chatId, threadId, `delivery failure for message ${messageId}`);
        throw err;
      }
    } else {
      this.invalidateMemoryDedupScope(chatId, threadId, `no handler for message ${messageId}`);
      debugLog(`[channel] No message handler registered for message ${messageId}`);
    }
  }

  private async enqueueReactionMessage(
    decision: Extract<ReactionRouteDecision, { action: 'deliver' }>,
  ): Promise<void> {
    const { event, trackedMessage } = decision;
    const source = 'sdk';
    const chatId = trackedMessage.chatId;
    if (!chatId) return;

    const operatorId = event.operatorId ?? '';
    const emojiType = event.emojiType || '(unknown)';
    const senderName = operatorId ? (this.nameCache.get(operatorId) ?? generateUserAlias(operatorId)) : '';
    const chatType = this.chatTypeCache.get(chatId) ?? 'group';
    const targetText = capUtf8Text(trackedMessage.quotedContext?.text, SDK_COMMENT_CONTEXT_CAP_BYTES);
    const targetMessageType = trackedMessage.quotedContext?.msgType;
    const lines = [
      '[Reaction Event]',
      `User ${senderName || operatorId || '(unknown user)'} (${operatorId || 'unknown_open_id'}) reacted to a previous bot reply with emoji ${emojiType}.`,
      `target_bot_message_id: ${event.messageId}`,
      `chat_id: ${chatId}`,
      ...(trackedMessage.threadId ? [`thread_id: ${trackedMessage.threadId}`] : []),
      '',
      'This emoji reaction is a normal user interaction turn carried by the target bot reply. Interpret the emoji together with the target bot reply and prior context, then decide whether to continue, retry an action, ask for clarification, send a visible reply, or return [LARK_NO_REPLY]. Do not classify OK, DONE, THUMBSUP, HEART, LIKE, or MeMeMe as passive by emoji type alone.',
      ...(targetText
        ? [
            '',
            '[Target Bot Reply]',
            ...(targetMessageType ? [`message_type: ${targetMessageType}`] : []),
            targetText,
          ]
        : []),
    ];

    const reactionMessage: LarkMessage = {
      messageId: event.messageId,
      chatId,
      chatType,
      senderId: operatorId,
      ...(senderName ? { senderName } : {}),
      text: lines.join('\n'),
      messageType: 'reaction',
      parentId: event.messageId,
      ...(trackedMessage.threadId ? { threadId: trackedMessage.threadId } : {}),
      rawContent: JSON.stringify({
        event_type: 'reaction',
        source,
        target_message_id: event.messageId,
        emoji_type: emojiType,
        operator_id: operatorId,
      }),
      reaction: {
        emojiType,
        operatorId,
        targetMessageId: event.messageId,
        source,
        ...(targetMessageType ? { targetMessageType } : {}),
        ...(targetText ? { targetText } : {}),
      },
    };

    this.enqueueMessage(reactionMessage);
  }

  /**
   * Fetch the bot's own open_id via the bot info API.
   * Used to filter group messages — only process those that @mention this bot.
   */
  private async fetchBotOpenId(): Promise<void> {
    try {
      const resp = await feishuApiCall('channel.botInfo.get', () =>
        this.client.request({
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/bot/v3/info',
        }),
      );
      const openId = (resp as any)?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        debugLog(`[channel] Bot open_id resolved: ${openId}`);
      } else {
        console.error('[channel] Warning: could not resolve bot open_id from /bot/v3/info');
      }
    } catch (err) {
      logSafeError('[channel] Warning: failed to fetch bot info:', err);
    }
  }
}
