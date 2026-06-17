import * as Lark from '@larksuiteoapi/node-sdk';
import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuite/channel';
import { appConfig } from './config.js';
import { enrichmentPrompt } from './prompts.js';
import { MessageQueue } from './queue.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { IdentitySession } from './identity-session.js';
import { DOC_CHAT_ID_PREFIX, TERMINAL_CHAT_ID } from './identity-session.js';
import { debugLog } from './debug-log.js';
import { feishuApiCall } from './feishu-retry.js';
import { BoundedCache } from './resource-governance.js';
import { AckReactionTracker, deleteAckReactionWithTransport } from './ack-reactions.js';
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
  type MemoryContextBlock,
} from './memory-context-dedup.js';
import {
  legacyReactionRouteEvent,
  routeReactionEvent,
  sdkReactionRouteEvent,
} from './reaction-router.js';
import { addQuotedContext } from './quoted-context-loader.js';
import {
  addLegacyImageDownloads,
  addSdkImageDownloads,
} from './inbound-attachment-downloader.js';
import { DisplayNameResolver } from './display-name-resolver.js';
import { normalizeLegacyMessageEvent } from './inbound-message-normalizer.js';

export { resolveMentionPlaceholders } from './message-content.js';

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

export function passesDocCommentWhitelist(senderId: string): boolean {
  if (appConfig.allowedUserIds.length === 0) return true;
  return appConfig.allowedUserIds.includes(senderId);
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

const DOC_COMMENT_BODY_CAP_BYTES = 8 * 1024;

export interface CommentEventDeps {
  botOpenId: string;
  seenEventIds: BoundedCache<string, true>;
  identitySession: IdentitySession;
  queue: MessageQueue;
  messageHandler: MessageHandler | null;
  processMessage?: (message: LarkMessage) => Promise<void>;
  resolveUserName: (openId: string) => Promise<string>;
  client: {
    request?: (req: {
      method: 'POST';
      url: string;
      params: { file_type: string };
      data: { action: 'add'; reply_id: string; reaction_type: string };
    }) => Promise<any>;
    drive: {
      fileComment: { list: (req: any) => Promise<any> };
      fileCommentReply: { list: (req: any) => Promise<any> };
      meta: { batchQuery: (req: any) => Promise<any> };
    };
  };
}

function capUtf8(s: string | undefined, maxBytes: number): string | undefined {
  if (s === undefined) return undefined;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}

function extractCommentText(content: any): string | undefined {
  if (!content) return undefined;
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content.elements)) {
    const text = content.elements
      .map((el: any) => el?.text_run?.text ?? el?.docs_link?.url ?? '')
      .join('');
    return text || undefined;
  }
  return undefined;
}

function escapeAttr(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeBody(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface DocCommentEnvelopeArgs {
  fileToken: string;
  commentId: string;
  replyId?: string;
  fileType: string;
  operator: string;
  isMentioned: boolean;
  docTitle?: string;
  quote?: string;
  parentBody?: string;
  body?: string;
  fetchError?: string;
}

function buildDocCommentEnvelope(args: DocCommentEnvelopeArgs): string {
  const kind = args.replyId ? 'reply' : 'comment';
  const attrs = [
    `doc_token="${escapeAttr(args.fileToken)}"`,
    `comment_id="${escapeAttr(args.commentId)}"`,
    args.replyId ? `reply_id="${escapeAttr(args.replyId)}"` : '',
    `kind="${kind}"`,
    `operator="${escapeAttr(args.operator)}"`,
    args.docTitle ? `doc_title="${escapeAttr(args.docTitle)}"` : '',
    `file_type="${escapeAttr(args.fileType)}"`,
    `is_mentioned="${args.isMentioned}"`,
  ].filter(Boolean).join(' ');

  const inner: string[] = [];
  if (args.fetchError) inner.push(`  <fetch_error>${escapeBody(args.fetchError)}</fetch_error>`);
  if (args.quote) inner.push(`  <selected_text>${escapeBody(args.quote)}</selected_text>`);
  if (args.parentBody) inner.push(`  <parent>${escapeBody(args.parentBody)}</parent>`);
  if (args.body !== undefined) {
    inner.push(`  <body>${escapeBody(args.body)}</body>`);
  } else {
    inner.push(`  <body unknown="true"></body>`);
  }
  return `<doc_comment ${attrs}>\n${inner.join('\n')}\n</doc_comment>`;
}

function addDocCommentAckReaction(
  deps: CommentEventDeps,
  args: { fileToken: string; fileType: string; replyId: string; eventId?: string },
): void {
  const reactionType = appConfig.docCommentAckEmoji;
  if (!reactionType) return;

  if (!deps.client.request) {
    debugLog(`[channel] Doc comment ack skipped: client.request unavailable (event_id=${args.eventId ?? '<none>'})`);
    return;
  }

  void feishuApiCall(
    'doc_comment_ack_reaction.update',
    () => deps.client.request!({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v2/files/${encodeURIComponent(args.fileToken)}/comments/reaction`,
      params: { file_type: args.fileType },
      data: {
        action: 'add',
        reply_id: args.replyId,
        reaction_type: reactionType,
      },
    }),
    { retryTimeout: false },
  ).catch((err) => {
    debugLog(
      `[channel] Failed to add doc-comment ack ${reactionType} on reply ${args.replyId} (event_id=${args.eventId ?? '<none>'}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

export async function handleCommentEvent(data: any, deps: CommentEventDeps): Promise<void> {
  const eventId = data?.event_id;
  if (eventId && deps.seenEventIds.has(eventId)) return;
  if (eventId) deps.seenEventIds.set(eventId, true);

  const meta = data?.notice_meta;
  if (!meta) {
    debugLog(`[channel] Doc comment event missing notice_meta — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (data?.is_mentioned !== true) {
    debugLog(`[channel] Doc comment event is_mentioned=false — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (meta.to_user_id?.open_id !== deps.botOpenId) {
    debugLog(
      `[channel] Doc comment to_user_id=${meta.to_user_id?.open_id ?? '<none>'} != bot=${deps.botOpenId} — dropped (event_id=${eventId ?? '<none>'})`,
    );
    return;
  }
  if (meta.from_user_id?.open_id === deps.botOpenId) {
    debugLog(`[channel] Doc comment from bot itself — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }

  const fileToken = String(meta.file_token ?? '');
  const commentId = String(data?.comment_id ?? '');
  const replyId = typeof data?.reply_id === 'string' && data.reply_id ? data.reply_id : undefined;
  const fileType = String(meta.file_type ?? '');
  const fromOpenId = String(meta.from_user_id?.open_id ?? '');
  if (!fileToken || !commentId || !fileType || !fromOpenId) {
    debugLog(`[channel] Doc comment event missing required fields — dropped (event_id=${eventId ?? '<none>'})`);
    return;
  }
  if (!passesDocCommentWhitelist(fromOpenId)) {
    debugLog(`[channel] Doc comment from ${fromOpenId} on doc ${fileToken} rejected by whitelist`);
    return;
  }

  let parentBody: string | undefined;
  let body: string | undefined;
  let quote: string | undefined;
  let fetchError: string | undefined;

  if (replyId) {
    addDocCommentAckReaction(deps, { fileToken, fileType, replyId, eventId });
  }

  const [repliesResult, commentsResult] = await Promise.allSettled([
    deps.client.drive.fileCommentReply.list({
      path: { file_token: fileToken, comment_id: commentId },
      params: { file_type: fileType, page_size: 100 },
    }),
    deps.client.drive.fileComment.list({
      path: { file_token: fileToken },
      params: { file_type: fileType, page_size: 100 },
    }),
  ]);

  const replies: any[] =
    repliesResult.status === 'fulfilled' ? (repliesResult.value?.data?.items ?? []) : [];
  const comments: any[] =
    commentsResult.status === 'fulfilled' ? (commentsResult.value?.data?.items ?? []) : [];

  if (!replyId) {
    const originalReplyId = replies.find((reply: any) => typeof reply?.reply_id === 'string' && reply.reply_id)?.reply_id;
    if (originalReplyId) {
      addDocCommentAckReaction(deps, { fileToken, fileType, replyId: originalReplyId, eventId });
    } else {
      debugLog(`[channel] Doc comment ack skipped: original reply_id unavailable (event_id=${eventId ?? '<none>'})`);
    }
  }

  if (repliesResult.status === 'rejected' && commentsResult.status === 'rejected') {
    const err: any = repliesResult.reason;
    fetchError = err?.message ?? String(err);
    debugLog(`[channel] Doc comment pre-fetch failed (event_id=${eventId ?? '<none>'}): ${fetchError}`);
  } else if (repliesResult.status === 'rejected') {
    const err: any = repliesResult.reason;
    fetchError = err?.message ?? String(err);
    debugLog(`[channel] Doc comment replies list failed (event_id=${eventId ?? '<none>'}): ${fetchError}`);
  } else if (commentsResult.status === 'rejected') {
    const err: any = commentsResult.reason;
    debugLog(
      `[channel] Doc comment list failed; selected text omitted (event_id=${eventId ?? '<none>'}): ${err?.message ?? String(err)}`,
    );
  }

  const targetComment = comments.find((comment: any) => comment?.comment_id === commentId);
  quote = typeof targetComment?.quote === 'string' && targetComment.quote ? targetComment.quote : undefined;

  if (replyId) {
    parentBody = extractCommentText(replies[0]?.content);
    const targetReply = replies.find((reply: any) => reply?.reply_id === replyId);
    body = targetReply ? extractCommentText(targetReply.content) : undefined;
  } else {
    body = extractCommentText(replies[0]?.content);
  }

  body = capUtf8(body, DOC_COMMENT_BODY_CAP_BYTES);
  parentBody = capUtf8(parentBody, DOC_COMMENT_BODY_CAP_BYTES);

  let docTitle: string | undefined;
  try {
    const metaResp = await deps.client.drive.meta.batchQuery({
      data: { request_docs: [{ doc_token: fileToken, doc_type: fileType }] },
    });
    docTitle = metaResp?.data?.metas?.[0]?.title;
  } catch {
    docTitle = undefined;
  }

  const senderName = await deps.resolveUserName(fromOpenId);
  const envelope = buildDocCommentEnvelope({
    fileToken,
    commentId,
    replyId,
    fileType,
    operator: senderName,
    isMentioned: true,
    docTitle,
    quote,
    parentBody,
    body,
    fetchError,
  });

  const chatId = `${DOC_CHAT_ID_PREFIX}${fileToken}`;
  const syntheticMessage: LarkMessage = {
    messageId: replyId ?? commentId,
    chatId,
    chatType: 'doc_comment',
    senderId: fromOpenId,
    senderName,
    text: envelope,
    messageType: 'doc_comment',
    threadId: commentId,
    rawContent: JSON.stringify(data),
    docComment: {
      fileToken,
      commentId,
      fileType,
      ...(replyId ? { replyId } : {}),
    },
  };

  deps.queue.enqueue(chatId, commentId, async () => {
    if (deps.processMessage) {
      await deps.processMessage(syntheticMessage);
      return;
    }
    deps.identitySession.setCaller(chatId, commentId, fromOpenId);
    if (deps.messageHandler) await deps.messageHandler(syntheticMessage);
  });
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

export interface TrackedBotMessageQuotedContext {
  text: string;
  msgType: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
}

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
    this.latestMessageTracker.record(message.chatId, {
      messageId: message.messageId,
      threadId: message.threadId,
      timestamp: Date.now(),
    });
    this.ackReactions.recordInbound(message.messageId);

    await this.addSdkAckReaction(message, sdkChannel);
    await addSdkImageDownloads(message, sdkMessage.resources, sdkChannel);
    await addQuotedContext(message, this.larkTransport, {
      maxDepth: appConfig.quotedContextMaxDepth,
      maxBytes: appConfig.quotedContextMaxBytes,
    });

    if (message.chatType === 'p2p' || message.chatType === 'group') {
      this.chatTypeCache.set(message.chatId, message.chatType);
    }
  }

  private enqueueMessage(message: LarkMessage): void {
    debugLog(
      `[channel] Enqueue message ${message.messageId} chat=${message.chatId} thread=${message.threadId ?? '(none)'}`
    );

    this.queue.enqueue(message.chatId, message.threadId, async () => {
      await this.processEnqueuedMessage(message);
    });
  }

  private async addSdkAckReaction(
    message: LarkMessage,
    _sdkChannel?: Pick<SdkLarkChannel, 'addReaction'>,
  ): Promise<void> {
    const ackEmoji = message.chatType === 'p2p' ? 'Typing' : appConfig.ackEmoji;
    if (!ackEmoji) return;

    this.larkTransport.addReaction(message.messageId, ackEmoji).then((reactionId) => {
      if (!reactionId) return;
      const stored = this.ackReactions.storeReaction(message.messageId, reactionId);
      if (stored.action === 'delete-now') {
        deleteAckReactionWithTransport(this.larkTransport, stored.reaction, 'sdk-channel.delete_late');
      }
    }).catch(() => {});
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
        message.text = `${message.text}\n\n[Selected Text]\n${capUtf8(fetched.quote, DOC_COMMENT_BODY_CAP_BYTES)}`;
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
    const { messageId, chatId, threadId } = larkMessage;

    // Record latest inbound message for this (chat, thread) — used by reply tool
    // to auto-correct reply_to in concurrent thread scenarios.
    this.latestMessageTracker.record(chatId, {
      messageId,
      threadId,
      timestamp: Date.now(),
    });
    this.ackReactions.recordInbound(messageId);

    // Fire-and-forget ack reaction (Typing for P2P, MeMeMe for group @bot)
    const ackEmoji = larkMessage.chatType === 'p2p' ? 'Typing' : appConfig.ackEmoji;
    if (ackEmoji) {
      this.larkTransport.addReaction(messageId, ackEmoji).then((reactionId) => {
        if (!reactionId) return;
        const stored = this.ackReactions.storeReaction(messageId, reactionId);
        if (stored.action === 'delete-now') {
          deleteAckReactionWithTransport(this.larkTransport, stored.reaction, 'channel.delete_late');
        }
      }).catch(() => {});
    }

    await addLegacyImageDownloads(
      larkMessage,
      larkMessage.rawContent,
      larkMessage.messageType,
      this.larkTransport,
    );
    if (larkMessage.chatType === 'group') {
      const chatName = await this.displayNameResolver.resolveChatName(chatId);
      larkMessage.chatName = chatName || undefined;
    }
    await addQuotedContext(larkMessage, this.larkTransport, {
      maxDepth: appConfig.quotedContextMaxDepth,
      maxBytes: appConfig.quotedContextMaxBytes,
    });

    // Cache chat type for later lookups (e.g. list_jobs visibility filter).
    if (larkMessage.chatType === 'p2p' || larkMessage.chatType === 'group') {
      this.chatTypeCache.set(chatId, larkMessage.chatType);
    }

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
    });

    // Build memory-enriched context
    debugLog(`[channel] Enriching memory for message ${messageId}`);
    const enrichedText = await this.enrichWithMemory(larkMessage);
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

  private async enrichWithMemory(msg: LarkMessage): Promise<string> {
    if (!this.memoryStore) {
      return enrichmentPrompt('', msg.parentContent, msg.senderId, msg.chatId, msg.text);
    }

    this.memoryDeduper.setWindowMs(appConfig.memoryDedupWindowMs);
    const blocks: MemoryContextBlock[] = [];

    // Build search query — enhance short messages with recent buffer context
    let searchQuery = msg.text;
    if (msg.text.length < 15 && this.conversationBuffer) {
      const recent = this.conversationBuffer.getMessages(msg.chatId).slice(-3);
      const context = recent.map(m => m.text).join(' ');
      if (context.length > 0) {
        searchQuery = `${context} ${msg.text}`;
      }
    }

    // 1. User profile (hot injection — always loaded)
    // The caller is the sender themselves, so they see both public and private tiers.
    const profile = await this.memoryStore
      .getProfile(msg.senderId, msg.senderId)
      .catch(() => null);
    if (profile) {
      blocks.push({
        key: `profile:${msg.senderId}`,
        kind: 'profile',
        label: '[User Profile]',
        content: profile,
      });
    }

    // 2. Mentioned user profiles (hot injection)
    // Caller is the sender, not the mentioned user, so only the public tier is loaded.
    if (msg.mentions?.length) {
      for (const mention of msg.mentions) {
        if (mention.id && mention.id !== msg.senderId) {
          const mentionProfile = await this.memoryStore
            .getProfile(mention.id, msg.senderId)
            .catch(() => null);
          if (mentionProfile) {
            blocks.push({
              key: `mentioned_profile:${mention.id}`,
              kind: 'mentioned_profile',
              label: `[Mentioned User: ${mention.name}]`,
              content: mentionProfile,
            });
          }
        }
      }
    }

    // 3. Thread episodes (cold injection — semantic search with score filtering)
    if (msg.threadId) {
      const threadEps = await this.memoryStore
        .searchEpisodes(searchQuery, { chatId: msg.chatId, threadId: msg.threadId })
        .catch(() => []);
      const filtered = threadEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
      for (const [index, ep] of filtered.entries()) {
        const scoreTag = ep.score !== undefined ? ` · score:${ep.score.toFixed(2)}` : '';
        const dateTag = ep.timestamp.slice(0, 10);
        blocks.push({
          key: `thread_episode:${ep.id ?? `${ep.timestamp}:${index}`}`,
          kind: 'thread_episode',
          label: `[Thread Context${scoreTag} · ${dateTag}]`,
          content: ep.content,
        });
      }
    }

    // 4. Chat episodes (cold injection — semantic search with score filtering)
    const chatEps = await this.memoryStore
      .searchEpisodes(searchQuery, { chatId: msg.chatId })
      .catch(() => []);
    const filteredChat = chatEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
    for (const [index, ep] of filteredChat.entries()) {
      const scoreTag = ep.score !== undefined ? ` · score:${ep.score.toFixed(2)}` : '';
      const dateTag = ep.timestamp.slice(0, 10);
      blocks.push({
        key: `chat_episode:${ep.id ?? `${ep.timestamp}:${index}`}`,
        kind: 'chat_episode',
        label: `[Chat Context${scoreTag} · ${dateTag}]`,
        content: ep.content,
      });
    }

    // 5. Skills (cold injection — inject name + description + path only, not full content)
    const skills = await this.memoryStore.searchSkills(searchQuery).catch(() => []);
    const filteredSkills = skills.filter(s => s.score === undefined || s.score >= appConfig.minSearchScore);
    for (const skill of filteredSkills) {
      const scoreTag = skill.score !== undefined ? ` · score:${skill.score.toFixed(2)}` : '';
      const skillPath = `${appConfig.memoriesDir}/skills/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
      blocks.push({
        key: `skill:${skill.name.toLowerCase()}`,
        kind: 'skill',
        label: `[Skill: ${skill.name}${scoreTag}]`,
        content: `${skill.description}\n→ ${skillPath}`,
      });
    }

    // Assemble
    const scopeKey = createMemoryDedupScopeKey(msg.chatId, msg.threadId);
    const deduped = this.memoryDeduper.filter(scopeKey, blocks);
    if (blocks.length > 0) {
      debugLog(
        `[memory-dedup] scope=${scopeKey} injected=${deduped.injectedCount} suppressed=${deduped.suppressedCount} bytes_saved=${deduped.bytesSaved}`
      );
    }
    return enrichmentPrompt(
      deduped.memoryContext,
      msg.parentContent,
      msg.senderId,
      msg.chatId,
      msg.text
    );
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
