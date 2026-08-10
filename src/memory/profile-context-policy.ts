import type { LarkMessage } from '../lark-message.js';

export type ProfileContextMode = 'sender-private' | 'public-only';

export interface ProfileContextPolicy {
  mode: ProfileContextMode;
  reason:
    | 'sender_private_chat'
    | 'sender_group_private_context'
    | 'group_introspection_public_only'
    | 'group_missing_source_public_only'
    | 'non_chat_public_only';
}

export const GROUP_SENDER_PRIVATE_MEMORY_POLICY = 'group-sender-private-v2';
export const GROUP_PUBLIC_MEMORY_POLICY = 'group-public-v2';

export interface ProfileSessionContext {
  memoryVisibilityPolicy?: string;
  memoryContextSenderId?: string;
}

export function isBroadProfileIntrospection(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (/\bwhat_do_you_know\b/i.test(normalized)) return true;

  const englishBulk = /\b(?:all|every|everything|entire|complete|private|what|which|anything)\b/i.test(normalized);
  const englishAboutSelf = /\b(?:about|of|on)\s+me\b/i.test(normalized);
  const englishPersonalProfile = /\bmy\s+(?:(?:private|personal|stored|saved|all|every|complete|entire)\s+){0,3}(?:profile(?!\s+(?:picture|photo|photograph|image|avatar)\b)|memories)\b/i.test(normalized);
  const englishProfileAboutMe = /\b(?:profile|memories|memory)\b.{0,48}\b(?:about|of|on)\s+me\b/i.test(normalized);
  const englishKnowledgeAboutMe = /\b(?:know|remember|recall|store(?:d)?|save(?:d)?|have|information|info|details|facts|data|knowledge|history)\b.{0,48}\b(?:about|of|on)\s+me\b/i.test(normalized)
    || /\b(?:about|of|on)\s+me\b.{0,48}\b(?:know|remember|recall|store(?:d)?|save(?:d)?|have|information|info|details|facts|data|knowledge|history)\b/i.test(normalized);
  const englishBulkObjectDisclosure = /\b(?:list|show|print|dump|export|enumerate|display|reveal|tell|share|give|send|recite|expose|disclose|publish|output)\b.{0,32}\b(?:(?:all|every|entire|complete|private|stored|saved)\s+){1,3}(?:profile|memories|memory)\b(?:\s+(?:you|the\s+bot|codex)\s+(?:have|stored|saved))?(?=\s*(?:$|[.?!]|please\b))/i.test(normalized);
  if (
    (englishAboutSelf && englishBulk)
    || englishPersonalProfile
    || englishProfileAboutMe
    || (englishKnowledgeAboutMe && englishBulk)
    || englishBulkObjectDisclosure
  ) {
    return true;
  }

  const chineseAboutSelfBulk = /(?:关于我|对我)/.test(normalized)
    && /(?:什么|哪些|啥|全部|所有|都|有多少|有什么)/.test(normalized);
  const chineseBulkObjectDisclosure = /(?:列出|展示|显示|导出|总结|枚举|打印|公开|透露|说出|说出来|告诉).{0,16}(?:(?:全部|所有|私人|私有|完整|已保存的)\s*){1,3}(?:记忆|资料(?!\s*(?:照片|图片|图像|头像))|画像|档案|profile)(?=\s*(?:$|[。！？?!]))/i.test(normalized);
  const chinesePersonalProfile = /(?:我的|关于我的)\s*(?:(?:全部|所有|私人|私有|完整|已保存的)\s*){0,3}(?:记忆|资料(?!\s*(?:照片|图片|图像|头像))|画像|档案|profile)/i.test(normalized);
  const chinesePrivateObject = /(?:私人|私有)\s*(?:记忆|资料|画像|档案|profile)/i.test(normalized);
  const chineseKnowledgeAboutMe = /(?:知道|了解|记得|记住|想得起|存了|保存了).{0,16}(?:关于我|对我|我(?!的)).{0,12}(?:(?:什么|哪些|啥|全部|所有|都)(?:事|事情|信息|资料|内容|偏好|习惯|记忆)|(?:什么|啥)(?=$|[？?。!！]))/.test(normalized)
    || /(?:关于我|对我).{0,16}(?:都|全部|所有)?.{0,8}(?:知道|了解|记得|记住|想得起|存了|保存了).{0,12}(?:(?:什么|哪些|啥|全部|所有|都)(?:事|事情|信息|资料|内容|偏好|习惯|记忆)|(?:什么|啥)(?=$|[？?。!！]))/.test(normalized);
  return chineseAboutSelfBulk
    || chineseBulkObjectDisclosure
    || chinesePersonalProfile
    || chinesePrivateObject
    || chineseKnowledgeAboutMe;
}

export function resolveProfileContextPolicy(
  message: Pick<LarkMessage, 'chatType' | 'currentUserText' | 'text'>,
): ProfileContextPolicy {
  if (message.chatType === 'p2p') {
    return { mode: 'sender-private', reason: 'sender_private_chat' };
  }
  if (message.chatType === 'group') {
    const currentUserText = message.currentUserText ?? '';
    if (!currentUserText.trim()) {
      return { mode: 'public-only', reason: 'group_missing_source_public_only' };
    }
    if (isBroadProfileIntrospection(currentUserText)) {
      return { mode: 'public-only', reason: 'group_introspection_public_only' };
    }
    return { mode: 'sender-private', reason: 'sender_group_private_context' };
  }
  return { mode: 'public-only', reason: 'non_chat_public_only' };
}

export function profileSessionBinding(
  message: Pick<LarkMessage, 'chatType' | 'senderId' | 'currentUserText' | 'text'>,
): ProfileSessionContext | null {
  if (message.chatType !== 'group') return null;
  const policy = resolveProfileContextPolicy(message);
  return {
    memoryVisibilityPolicy: policy.mode === 'sender-private'
      ? GROUP_SENDER_PRIVATE_MEMORY_POLICY
      : GROUP_PUBLIC_MEMORY_POLICY,
    memoryContextSenderId: message.senderId,
  };
}

export function isProfileSessionCompatible(
  message: Pick<LarkMessage, 'chatType' | 'senderId' | 'currentUserText' | 'text'>,
  context: ProfileSessionContext | null | undefined,
): boolean {
  const required = profileSessionBinding(message);
  if (!required) return true;
  return context?.memoryVisibilityPolicy === required.memoryVisibilityPolicy
    && context?.memoryContextSenderId === required.memoryContextSenderId;
}

export function profileContextPromptPolicy(
  message: Pick<LarkMessage, 'chatType'>,
  policy: ProfileContextPolicy,
): string | undefined {
  if (message.chatType !== 'group') return undefined;
  if (policy.mode === 'public-only') {
    return 'This group turn is a broad profile or memory introspection request. Use and display public profile context only. Do not enumerate, summarize, hint at, or infer private profile entries.';
  }
  return 'The current sender initiated this group turn, so their private profile may guide personalization. The response is visible to the whole group: do not enumerate, quote, summarize, or disclose private profile facts. Other users cannot authorize access to this sender-private context.';
}
