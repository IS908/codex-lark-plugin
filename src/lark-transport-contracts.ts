import type * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuRetryOptions } from './feishu-retry.js';
import type {
  LarkCachedMessageContext,
  LarkMessageContext,
  LarkMessageFetchResult,
} from './lark-message-context.js';

export type LarkFetchedMessageContext = LarkMessageContext;
export type LarkCachedQuotedMessageContext = LarkCachedMessageContext;

export interface LarkOutboundMessageContextCache {
  get(messageId: string): { quotedContext?: LarkCachedQuotedMessageContext } | undefined;
}

export interface LarkUserMessageFetchResult {
  item?: unknown;
  diagnostic?: string;
  fetchResult?: LarkMessageFetchResult;
}

export interface LarkUserMessageFetcher {
  fetchMessage(messageId: string): Promise<LarkUserMessageFetchResult | null>;
}

export type LarkTransportInput =
  | { text: string }
  | { card: object }
  | { imageKey: string }
  | { fileKey: string; fileName: string }
  | { raw: { msgType: string; content: string } };

export interface LarkTransportSendRequest {
  chatId: string;
  input: LarkTransportInput;
  replyTo?: string;
  replyInThread?: boolean;
  uuid?: string;
  receiveIdType?: 'chat_id' | 'open_id' | 'user_id';
  forceRaw?: boolean;
  retry?: FeishuRetryOptions;
}

export interface LarkTransportSendResult {
  messageId?: string;
  chunkIds?: string[];
}

export interface LarkDocCommentRequest {
  docToken: string;
  commentId?: string;
  content: string;
  fileType: string;
}

export interface LarkDocCommentReplyRequest
  extends Required<Pick<LarkDocCommentRequest, 'docToken' | 'commentId' | 'content' | 'fileType'>> {
  retry?: FeishuRetryOptions;
}

export interface LarkDocCommentReplyMarkerRequest {
  docToken: string;
  commentId: string;
  fileType: string;
  marker: string;
}

export interface LarkTransport {
  sendMessage(request: LarkTransportSendRequest): Promise<LarkTransportSendResult>;
  editMessage(request: { messageId: string; text: string }): Promise<void>;
  updateCard(request: { messageId: string; card: object | string }): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string | undefined>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>;
  downloadResource(messageId: string, fileKey: string, resourceType: 'image' | 'file'): Promise<unknown>;
  uploadImage(data: Buffer): Promise<string | undefined>;
  uploadFile(data: Buffer, fileName: string): Promise<string | undefined>;
  replyDocComment(request: LarkDocCommentReplyRequest): Promise<{ replyId?: string }>;
  findDocCommentReplyByMarker(request: LarkDocCommentReplyMarkerRequest): Promise<{ replyId?: string } | null>;
  createDocComment(request: Omit<LarkDocCommentRequest, 'commentId'>): Promise<{ commentId?: string }>;
  fetchMessageText(messageId: string): Promise<string | null>;
  fetchMessageContext(messageId: string): Promise<LarkFetchedMessageContext | null>;
}

export interface SdkLarkTransportChannel {
  rawClient?: Lark.Client;
  send?: (
    to: string,
    input: { text: string } | { card: object },
    opts?: { replyTo?: string; replyInThread?: boolean },
  ) => Promise<{ messageId?: string; chunkIds?: string[] }>;
  editMessage?: (messageId: string, text: string) => Promise<void>;
  updateCard?: (messageId: string, card: object) => Promise<void>;
  recallMessage?: (messageId: string) => Promise<void>;
  addReaction?: (messageId: string, emojiType: string) => Promise<string>;
  removeReaction?: (messageId: string, reactionId: string) => Promise<void>;
  removeReactionByEmoji?: (messageId: string, emojiType: string) => Promise<boolean>;
  downloadResource?: (messageId: string, fileKey: string, resourceType: 'image' | 'file') => Promise<unknown>;
  fetchMessage?: (messageId: string) => Promise<{
    messageId?: string;
    chatId?: string;
    chat_id?: string;
    parentId?: string;
    parent_id?: string;
    replyTo?: string;
    reply_to?: string;
    rootMessageId?: string;
    root_id?: string;
    threadId?: string;
    thread_id?: string;
    timestampMs?: number;
    timestamp?: string;
    createTime?: string;
    create_time?: string;
    updateTime?: string;
    update_time?: string;
    messagePosition?: string;
    message_position?: string;
    sender?: unknown;
    content?: string;
    rawContentType?: string;
    messageType?: string;
    msg_type?: string;
    message_type?: string;
  } | undefined>;
  comments?: {
    resolveTarget?: (fileToken: string, fileType: string) => Promise<unknown | null>;
    reply?: (target: unknown, commentId: string, text: string) => Promise<void>;
  };
}

export interface LarkTransportOptions {
  sdkChannel?: SdkLarkTransportChannel;
  rawClient?: Lark.Client;
  outboundMessageContextCache?: LarkOutboundMessageContextCache;
  userMessageFetcher?: LarkUserMessageFetcher;
}
