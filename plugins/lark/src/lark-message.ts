import type {
  CommentEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuite/channel';
import type { ConversationBoundary } from './conversation-boundary.js';
import type { SdkLarkTransportChannel } from './lark-transport-contracts.js';

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group'
  senderId: string;
  senderName?: string;
  chatName?: string;
  text: string;
  /** Unenriched current-turn user text. Routing classifiers must not inspect stored memory or quoted content. */
  currentUserText?: string;
  messageType: string;
  parentId?: string;
  parentContent?: string;
  /** Trusted cronjob origin derived from locally tracked bot-message routing metadata. */
  quotedCronJobId?: string;
  threadId?: string;
  rootMessageId?: string;
  timestampMs?: number;
  messagePosition?: string;
  mentions?: Array<{ id: string; name: string }>;
  /** True when this bot's open_id appears in mentions. Forwarded to Codex as meta.bot_mentioned. */
  botMentioned?: boolean;
  /** True when a trusted group allowlist let a non-@mention message enter Codex. */
  unmentionedGroupTrigger?: boolean;
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
  reaction?: {
    emojiType: string;
    operatorId: string;
    targetMessageId: string;
    source: 'sdk';
    targetMessageType?: string;
    targetText?: string;
  };
}

export type MessageHandler = (message: LarkMessage) => Promise<void>;
export type ControlMessageHandler = (message: LarkMessage) => Promise<boolean>;

export interface ConversationBoundaryProvider {
  get(chatId: string, threadId?: string): Promise<ConversationBoundary | null>;
  markHandoffConsumed(chatId: string, threadId: string | undefined, generation: number): Promise<void>;
}

export interface ChatVisibilityProvider {
  isPrivateChat(chatId: string): boolean;
}

export interface SdkChannelRuntimeTarget {
  setSdkTransportChannel(sdkChannel: SdkLarkTransportChannel): void;
  handleSdkMessageEvent(
    sdkMessage: NormalizedMessage,
    sdkChannel?: Pick<SdkLarkChannel, 'downloadResource' | 'fetchMessage' | 'addReaction'>,
  ): Promise<void>;
  handleSdkCommentEvent(
    comment: CommentEvent,
    sdkChannel?: Pick<SdkLarkChannel, 'comments'>,
  ): Promise<void>;
  handleSdkReactionEvent(reaction: ReactionEvent): Promise<void>;
  setBotOpenId(openId: string | undefined): void;
}
