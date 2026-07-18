import type { CommentEvent, NormalizedMessage, ResourceDescriptor } from '@larksuite/channel';
import type { LarkMessage } from './lark-message.js';
import { DOC_CHAT_ID_PREFIX, type IdentitySession } from './identity-session.js';
import type { AccessControlReader } from './runtime-access-control.js';
import { bindSdkMessageIdentity } from './sdk-channel-identity.js';

export type SdkMessageDropReason = 'bot_self' | 'no_mention' | 'no_mention_trigger' | 'not_allowed';
export type NoMentionTriggerReason =
  | 'empty'
  | 'question_or_command'
  | 'actionable_url'
  | 'thread_continuation'
  | 'noise'
  | 'not_evaluated';

export interface SdkMessageDropDiagnostic {
  chatId: string;
  chatType: NormalizedMessage['chatType'];
  mentionedBot: boolean;
  noMentionAllowed: boolean;
  topLevel: boolean;
  threadMessage: boolean;
  triggerDecision: NoMentionTriggerReason;
}

export interface NoMentionTriggerDecision {
  shouldProcess: boolean;
  reason: NoMentionTriggerReason;
  topLevel: boolean;
  threadMessage: boolean;
}

export type SdkMessageResult =
  | { status: 'processed'; message: LarkMessage }
  | { status: 'dropped'; reason: SdkMessageDropReason; diagnostic?: SdkMessageDropDiagnostic };

export interface SdkMessageDeps {
  identitySession: IdentitySession;
  accessControl: AccessControlReader;
  botOpenId?: string | null;
  handleMessage: (message: LarkMessage) => Promise<void>;
}

function passesSdkWhitelist(senderId: string, chatId: string, deps: SdkMessageDeps): boolean {
  return deps.accessControl.allowsMessage(senderId, chatId);
}

function isThreadMessage(sdkMessage: NormalizedMessage): boolean {
  return !!(sdkMessage.threadId || sdkMessage.rootId || sdkMessage.replyToMessageId);
}

function isLikelyQuestionOrCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(?:\/|\$)\S+/.test(trimmed)) return true;
  if (/[?？]\s*$/.test(trimmed)) return true;
  if (/[吗么]\s*$/.test(trimmed)) return true;
  return /^(?:please\s+)?(?:can|could|would|should|do|does|did|is|are|was|were|what|why|how|when|where|which|who)\b/i.test(trimmed) ||
    /(?:帮我|帮忙|请(?:帮|看|检查|处理|修复|总结|整理|分析)|能否|能不能|可以(?:帮|.*吗)|可否|是否|是不是|有没有|怎么|如何|为什么|为啥|要不要|看下|看一下|检查一下|review一下|修复一下|处理一下)/i.test(trimmed) ||
    /(?:总结|整理|概括|归纳|分析|复盘|提取|生成|创建|写|改|修复|处理|推进|评审|核实|确认|检查|说明|解释)(?:一下|下|一遍|这个|这份|这条|这段|这篇)?/i.test(trimmed);
}

function hasActionableResourceUrl(text: string): boolean {
  return /\bhttps?:\/\/[^\s<>"']*(?:larksuite|larkoffice|feishu)\.[^\s<>"']*\/(?:minutes|docs|docx|wiki|base|sheets|mindnotes|slides|drive|file|folder)\b/i.test(text);
}

export function evaluateUnmentionedGroupMessage(sdkMessage: NormalizedMessage): NoMentionTriggerDecision {
  const text = sdkMessage.content.trim();
  const threadMessage = isThreadMessage(sdkMessage);
  const topLevel = !threadMessage;
  if (!text) return { shouldProcess: false, reason: 'empty', topLevel, threadMessage };
  if (isLikelyQuestionOrCommand(text)) {
    return { shouldProcess: true, reason: 'question_or_command', topLevel, threadMessage };
  }
  if (hasActionableResourceUrl(text)) {
    return { shouldProcess: true, reason: 'actionable_url', topLevel, threadMessage };
  }
  if (threadMessage) return { shouldProcess: true, reason: 'thread_continuation', topLevel, threadMessage };
  return { shouldProcess: false, reason: 'noise', topLevel, threadMessage };
}

export function shouldProcessUnmentionedGroupMessage(sdkMessage: NormalizedMessage): boolean {
  return evaluateUnmentionedGroupMessage(sdkMessage).shouldProcess;
}

function dropDiagnostic(
  sdkMessage: NormalizedMessage,
  input: { noMentionAllowed: boolean; triggerDecision?: NoMentionTriggerDecision },
): SdkMessageDropDiagnostic {
  const fallbackThreadMessage = isThreadMessage(sdkMessage);
  return {
    chatId: sdkMessage.chatId,
    chatType: sdkMessage.chatType,
    mentionedBot: sdkMessage.mentionedBot,
    noMentionAllowed: input.noMentionAllowed,
    topLevel: input.triggerDecision?.topLevel ?? !fallbackThreadMessage,
    threadMessage: input.triggerDecision?.threadMessage ?? fallbackThreadMessage,
    triggerDecision: input.triggerDecision?.reason ?? 'not_evaluated',
  };
}

function mapSdkResources(
  resources: ResourceDescriptor[] | undefined,
): Array<{ fileKey: string; fileName: string; fileType: string }> | undefined {
  if (!resources || resources.length === 0) return undefined;
  const mapped = resources
    .map((resource) => ({
      fileKey: resource.fileKey,
      fileName: resource.fileName ?? resource.fileKey,
      fileType: resource.type,
    }))
    .filter((resource) => resource.fileKey);
  return mapped.length > 0 ? mapped : undefined;
}

export async function processSdkMessage(
  sdkMessage: NormalizedMessage,
  deps: SdkMessageDeps,
): Promise<SdkMessageResult> {
  if (deps.botOpenId && sdkMessage.senderId === deps.botOpenId) {
    return { status: 'dropped', reason: 'bot_self' };
  }
  if (sdkMessage.chatType === 'group' && !sdkMessage.mentionedBot) {
    if (!deps.accessControl.allowsNoMentionChat(sdkMessage.chatId)) {
      return {
        status: 'dropped',
        reason: 'no_mention',
        diagnostic: dropDiagnostic(sdkMessage, { noMentionAllowed: false }),
      };
    }
    const triggerDecision = evaluateUnmentionedGroupMessage(sdkMessage);
    if (!triggerDecision.shouldProcess) {
      return {
        status: 'dropped',
        reason: 'no_mention_trigger',
        diagnostic: dropDiagnostic(sdkMessage, { noMentionAllowed: true, triggerDecision }),
      };
    }
  }
  if (!passesSdkWhitelist(sdkMessage.senderId, sdkMessage.chatId, deps)) {
    return { status: 'dropped', reason: 'not_allowed' };
  }

  const larkMessage = bindSdkMessageIdentity(
    {
      messageId: sdkMessage.messageId,
      chatId: sdkMessage.chatId,
      chatType: sdkMessage.chatType,
      senderId: sdkMessage.senderId,
      senderName: sdkMessage.senderName,
      content: sdkMessage.content,
      rawContentType: sdkMessage.rawContentType,
      threadId: sdkMessage.threadId,
      rootId: sdkMessage.rootId,
      replyToMessageId: sdkMessage.replyToMessageId,
      timestampMs: sdkMessage.createTime,
      mentionedBot: sdkMessage.mentionedBot,
      mentions: sdkMessage.mentions.map((mention) => ({
        id: mention.openId ?? mention.userId ?? mention.key,
        name: mention.name ?? mention.key,
      })),
    },
    deps.identitySession,
  );
  if (sdkMessage.chatType === 'group' && !sdkMessage.mentionedBot) {
    larkMessage.unmentionedGroupTrigger = true;
  }
  larkMessage.attachments = mapSdkResources(sdkMessage.resources);

  await deps.handleMessage(larkMessage);
  return { status: 'processed', message: larkMessage };
}

export function bindSdkCommentIdentity(
  comment: CommentEvent,
  identitySession: IdentitySession,
): LarkMessage {
  if (!comment.mentionedBot) throw new Error('SDK comment event did not mention the bot');
  if (!comment.operator.openId) throw new Error('SDK comment event missing operator.openId');

  const chatId = `${DOC_CHAT_ID_PREFIX}${comment.fileToken}`;
  const threadId = comment.commentId;
  identitySession.setCaller(chatId, threadId, comment.operator.openId);

  const text =
    `<doc_comment doc_token="${comment.fileToken}" comment_id="${comment.commentId}" ` +
    `file_type="${comment.fileType}" is_mentioned="true">SDK comment mention</doc_comment>`;

  return {
    messageId: comment.replyId ?? comment.commentId,
    chatId,
    chatType: 'doc_comment',
    senderId: comment.operator.openId,
    text,
    messageType: 'doc_comment',
    timestampMs: comment.timestamp,
    threadId,
    rawContent: text,
    docComment: {
      fileToken: comment.fileToken,
      commentId: comment.commentId,
      fileType: comment.fileType,
      replyId: comment.replyId,
    },
  };
}
