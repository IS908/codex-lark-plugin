import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuite/channel';
import { appConfig } from './config.js';
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
  type LarkTransport,
  type SdkLarkTransportChannel,
} from './lark-transport.js';
import { logSafeError, redactErrorForLog } from './safe-log.js';
import { bindSdkCommentIdentity, processSdkMessage } from './sdk-channel-parity.js';
import {
  createMemoryDedupScopeKey,
  MemoryContextDeduper,
} from './memory-context-dedup.js';
import {
  legacyReactionRouteEvent,
  routeReactionEvent,
  sdkReactionRouteEvent,
} from './reaction-router.js';
import { DisplayNameResolver } from './display-name-resolver.js';
import { normalizeLegacyMessageEvent } from './inbound-message-normalizer.js';
import type { LarkCachedMessageContext } from './lark-message-context.js';
import { enrichLarkMessageWithMemory } from './memory-enricher.js';
import { handleCommentEvent } from './doc-comment-inbound.js';
import { prepareInboundTurn } from './inbound-turn-pipeline.js';

export { resolveMentionPlaceholders } from './message-content.js';
export { handleCommentEvent, passesDocCommentWhitelist } from './doc-comment-inbound.js';

/**
 * Build a Lark SDK logger that routes every level to stderr. The SDK's default
 * logger writes to stdout via `console.log`, which would corrupt MCP JSON-RPC
 * framing on the stdio transport. Every `new Lark.<Client|EventDispatcher|WSClient>(...)`
 * MUST be constructed with this logger — enforced statically by
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
  const userConfigured = appConfig.allowedUserIds.length > 0;
  const chatConfigured = appConfig.allowedChatIds.length > 0;
  if (!userConfigured && !chatConfigured) return true;
  const userOk = userConfigured && appConfig.allowedUserIds.includes(senderId);
  const chatOk = chatConfigured && appConfig.allowedChatIds.includes(chatId);
  return userOk || chatOk;
}

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group'
  senderId: string;
  senderName?: string;
  chatName?: string;
  text: string;
  messageType: string;
  parentId?: string;
  parentContent?: string;
  threadId?: string;
  rootMessageId?: string;
  mentions?: Array<{ id: string; name: string }>;
  /** True when this bot's open_id appears in mentions. Forwarded to Codex as meta.bot_mentioned. */
  botMentioned?: boolean;
  attachments?: Array<{ fileKey: string; fileName: string; fileType: string }>;
  rawContent: string;
  imagePath?: string;
  imagePaths?: string[];
  docComment?: {
    fileToken: string;
    commentId: string;
    fileType: string;
    replyId?: string;
  };
}

export type MessageHandler = (message: LarkMessage) => Promise<void>;

const SDK_COMMENT_CONTEXT_CAP_BYTES = 8 * 1024;

function capUtf8Text(s: string | undefined, maxBytes: number): string | undefined {
  if (s === undefined) return undefined;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}

export class BotMessageTracker {
  private ids: string[] = [];
  private map = new Map<string, TrackedBotMessage>();
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }

  add(messageId: string, meta: Omit<TrackedBotMessage, 'messageId' | 'timestamp'> = {}): void {
    if (this.maxSize <= 0 || !messageId) return;
    if (this.map.has(messageId)) return;
    this.map.set(messageId, {
      messageId,
      chatId: meta.chatId,
      threadId: meta.threadId,
      quotedContext: meta.quotedContext,
      timestamp: Date.now(),
    });
    this.ids.push(messageId);
    while (this.ids.length > this.maxSize) {
      const oldest = this.ids.shift()!;
      this.map.delete(oldest);
    }
  }

  has(messageId: string): boolean {
    return this.map.has(messageId);
  }

  get(messageId: string): TrackedBotMessage | undefined {
    return this.map.get(messageId);
  }
}

export interface TrackedBotMessage {
  messageId: string;
  chatId?: string;
  threadId?: string;
  quotedContext?: TrackedBotMessageQuotedContext;
  timestamp: number;
}

export type TrackedBotMessageQuotedContext = LarkCachedMessageContext;

/**
 * Records the latest inbound user message per (chatId, threadId) pair.
 * Used by the reply tool to auto-correct reply_to when Codex omits it in
 * concurrent thread scenarios.
 */
export interface TrackedMessage {
  messageId: string;
  threadId?: string;
  timestamp: number;
}

export class LatestMessageTracker {
  private map = new Map<string, TrackedMessage>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = 10 * 60 * 1000, maxSize = 1000) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 10 * 60 * 1000;
    this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
  }

  private key(chatId: string, threadId?: string): string {
    // Use || instead of ?? so empty strings also fall back to '_'
    return `${chatId}::${threadId || '_'}`;
  }

  record(chatId: string, msg: TrackedMessage): void {
    const key = this.key(chatId, msg.threadId);
    this.map.delete(key);
    this.map.set(key, msg);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  getLatest(chatId: string, threadId?: string): TrackedMessage | undefined {
    const key = this.key(chatId, threadId);
    const m = this.map.get(key);
    if (!m) return undefined;
    if (Date.now() - m.timestamp > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, m);
    return m;
  }
}

export class LarkChannel {
  private client: Lark.Client;
  private nameCache = new BoundedCache<string, string>(appConfig.nameCacheSize); // open_id/chat_id → display name
  private displayNameResolver: DisplayNameResolver;
  private chatTypeCache = new BoundedCache<string, 'p2p' | 'group'>(appConfig.chatTypeCacheSize); // chatId → type (populated from inbound events)
  private botOpenId: string = '';
  private wsClient: Lark.WSClient | null = null;
  private queue = new MessageQueue({ handlerTimeoutMs: appConfig.queueHandlerTimeoutMs });
  private messageHandler: MessageHandler | null = null;
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

  async start(): Promise<void> {
    // Fetch bot's own open_id for filtering group @mentions
    await this.fetchBotOpenId();

    debugLog('[channel] Registering event dispatcher...');
    // EventDispatcher's default logger writes to stdout, which would corrupt
    // MCP JSON-RPC framing the moment it logs "event-dispatch is ready".
    // Redirect to stderr like Client and WSClient.
    const eventDispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.info,
      logger: makeSdkLogger('lark-events'),
    }).register({
      'im.message.receive_v1': async (data: any) => {
        debugLog(`[channel] Event received: im.message.receive_v1`);
        try {
          await this.handleMessageEvent(data);
        } catch (err) {
          logSafeError('[channel] Error handling message event:', err);
        }
      },
    }).register({
      'im.message.reaction.created_v1': async (data: any) => {
        debugLog(`[channel] Event received: im.message.reaction.created_v1`);
        try {
          await this.handleReactionEvent(data);
        } catch (err) {
          logSafeError('[channel] Error handling reaction event:', err);
        }
      },
    }).register({
      'drive.notice.comment_add_v1': async (data: any) => {
        debugLog(`[channel] Event received: drive.notice.comment_add_v1`);
        try {
          await handleCommentEvent(data, {
            botOpenId: this.botOpenId,
            seenEventIds: this.commentEventIdSeen,
            identitySession: this.identitySession!,
            queue: this.queue,
            messageHandler: this.messageHandler,
            processMessage: this.processEnqueuedMessage.bind(this),
            resolveUserName: this.displayNameResolver.resolveUserName.bind(this.displayNameResolver),
            client: this.client as any,
          });
        } catch (err) {
          logSafeError('[channel] Error handling doc comment event:', err);
        }
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      logger: makeSdkLogger('lark-ws'),
    });

    this.wsClient.start({ eventDispatcher });
    debugLog('[channel] lark channel: connected to Feishu via WebSocket');
  }

  async handleSdkMessageEvent(
    sdkMessage: NormalizedMessage,
    sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>,
  ): Promise<void> {
    const result = await processSdkMessage(sdkMessage, {
      identitySession: this.identitySession!,
      allowedUserIds: appConfig.allowedUserIds,
      allowedChatIds: appConfig.allowedChatIds,
      handleMessage: async (message) => {
        await this.prepareSdkMessage(message, sdkMessage, sdkChannel);
        this.enqueueMessage(message);
      },
    });

    if (result.status === 'dropped') {
      debugLog(`[sdk-channel] Dropped message ${sdkMessage.messageId}: ${result.reason}`);
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
      await this.addSdkCommentContext(message, comment, sdkChannel);
      this.enqueueMessage(message);
    } catch (err) {
      logSafeError('[sdk-channel] Error handling SDK comment event:', err);
    }
  }

  async handleSdkReactionEvent(reaction: ReactionEvent): Promise<void> {
    if (reaction.action !== 'added') return;

    routeReactionEvent({
      event: sdkReactionRouteEvent(reaction),
      botMessageTracker: this.botMessageTracker,
      passesWhitelist,
      debugLog,
      logPrefix: '[sdk-channel]',
    });
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
      kind: 'sdk',
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

  private async handleMessageEvent(data: any): Promise<void> {
    this.ensureOpenApiTransportCurrent();
    const normalized = await normalizeLegacyMessageEvent(data, {
      botOpenId: this.botOpenId,
      passesWhitelist,
      resolveUserName: this.displayNameResolver.resolveUserName.bind(this.displayNameResolver),
      log: debugLog,
    });
    if (normalized.status === 'dropped') return;

    const larkMessage: LarkMessage = normalized.message;
    await prepareInboundTurn(larkMessage, this.inboundTurnDeps(), {
      kind: 'legacy',
      rawContent: larkMessage.rawContent,
      messageType: larkMessage.messageType,
      resolveChatName: this.displayNameResolver.resolveChatName.bind(this.displayNameResolver),
    });

    this.enqueueMessage(larkMessage);
  }

  private async processEnqueuedMessage(larkMessage: LarkMessage): Promise<void> {
    const { messageId, chatId, threadId, senderId } = larkMessage;
    debugLog(
      `[channel] Queue handler start message ${messageId} chat=${chatId} thread=${threadId ?? '(none)'}`
    );

    // Bind identity for this chat/thread so MCP tools can resolve the
    // true caller without trusting Codex-declared identity arguments.
    this.identitySession?.setCaller(chatId, threadId, senderId);

    // Record in conversation buffer
    this.conversationBuffer?.record(chatId, {
      role: 'user',
      senderId,
      text: larkMessage.text,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      messageId,
      threadId,
      messageType: larkMessage.messageType,
    });

    // Build memory-enriched context
    debugLog(`[channel] Enriching memory for message ${messageId}`);
    const enrichedText = await enrichLarkMessageWithMemory(larkMessage, {
      memoryStore: this.memoryStore,
      conversationBuffer: this.conversationBuffer,
      memoryDeduper: this.memoryDeduper,
      log: debugLog,
    });
    debugLog(`[channel] Memory enrichment complete for message ${messageId}`);

    // Forward to handler with enriched context
    const enrichedMessage = { ...larkMessage, text: enrichedText };

    if (this.messageHandler) {
      debugLog(`[channel] Calling message handler for message ${messageId}`);
      try {
        await this.messageHandler(enrichedMessage);
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

  /**
   * Handle reaction events on bot messages.
   *
   * Reactions are passive UI feedback. Forwarding them into Codex as ordinary
   * message turns makes the bot send confusing follow-up text even though the
   * user only clicked an emoji.
   */
  private async handleReactionEvent(data: any): Promise<void> {
    routeReactionEvent({
      event: legacyReactionRouteEvent(data),
      botMessageTracker: this.botMessageTracker,
      passesWhitelist,
      debugLog,
      logPrefix: '[channel]',
    });
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
