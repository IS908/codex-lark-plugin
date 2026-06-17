import { extractInteractiveCardText } from './interactive-card-text.js';

const CARD_CLIENT_PLACEHOLDER = '请升级至最新版本客户端，以查看内容';

export interface MessageMention {
  id: string;
  name: string;
}

export interface MessageAttachment {
  fileKey: string;
  fileName: string;
  fileType: string;
}

/**
 * Resolve Feishu's @_user_N placeholders in a text body to `@<name>` using
 * the mentions array. mentions[N-1] corresponds to @_user_N (1-indexed).
 *
 * If the mention has no name (user privacy settings, masked) the placeholder
 * is kept verbatim. Out-of-range indices are also kept verbatim.
 */
export function resolveMentionPlaceholders(
  text: string,
  mentions: MessageMention[] | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) return text;
  return text.replace(/@_user_(\d+)/g, (match, n) => {
    const idx = Number(n) - 1;
    const mention = mentions[idx];
    return mention?.name ? `@${mention.name}` : match;
  });
}

export function extractMessageText(rawContent: string, messageType: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    switch (messageType) {
      case 'text':
        return parsed.text ?? rawContent;
      case 'post': {
        const lines: string[] = [];
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        for (const line of content) {
          const texts = (line as any[])
            .filter((node: any) => node.tag === 'text' || node.tag === 'a')
            .map((node: any) => node.text ?? node.href ?? '');
          lines.push(texts.join(''));
        }
        return lines.join('\n') || rawContent;
      }
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name ?? 'attachment'}]`;
      case 'audio':
        return '[Audio]';
      case 'video':
        return '[Video]';
      case 'interactive':
        return extractInteractiveCardText(rawContent) ?? '[Interactive Card]';
      default:
        return parsed.text ?? rawContent;
    }
  } catch {
    if (messageType === 'interactive') return '[Interactive Card]';
    return rawContent;
  }
}

function compactCardAttribute(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(re);
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim() || null;
}

function stripCompactCardTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCompactCardText(text: string): string | null {
  const match = text.match(/<card\b([^>]*)>([\s\S]*?)<\/card>/i);
  if (!match) return null;
  const title = compactCardAttribute(match[1] ?? '', 'title');
  const body = stripCompactCardTags(match[2] ?? '');
  const parts = [title, body].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

export function normalizeFetchedMessageText(text: string): string {
  return extractCompactCardText(text) ?? text;
}

export function fetchedMessageContentText(content: string, messageType: string): string {
  const compactText = normalizeFetchedMessageText(content);
  if (compactText !== content) return compactText;
  return normalizeFetchedMessageText(extractMessageText(content, messageType));
}

export function isPlaceholderCardText(text: string, messageType: string | undefined): boolean {
  const trimmed = text.trim();
  return (
    trimmed === '[Interactive Card]' ||
    trimmed.includes(CARD_CLIENT_PLACEHOLDER) ||
    /^<card\b/i.test(trimmed) ||
    (messageType === 'interactive' && !trimmed)
  );
}

export function normalizeMessageMentions(item: any): MessageMention[] {
  return (item?.mentions ?? []).map((mention: any) => ({
    id:
      mention.id?.open_id ??
      mention.id?.union_id ??
      (typeof mention.id === 'string' ? mention.id : ''),
    name: mention.name ?? '',
  }));
}

function normalizeRawContent(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function messageItemRawContent(item: any): string | null {
  const body = item?.body;
  if (body && typeof body === 'object' && 'content' in body) {
    return normalizeRawContent(body.content);
  }
  if (item && typeof item === 'object' && 'content' in item) {
    return normalizeRawContent(item.content);
  }
  return normalizeRawContent(body);
}

export function messageItemText(item: any): { text: string; messageType: string } | null {
  const content = messageItemRawContent(item);
  if (content === null) return null;
  const messageType = item.msg_type ?? item.message_type ?? 'text';
  const text = resolveMentionPlaceholders(
    fetchedMessageContentText(content, messageType),
    normalizeMessageMentions(item),
  );
  return { text, messageType };
}

export function extractMessageAttachments(message: any): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  try {
    const parsed = JSON.parse(message.content ?? '{}');
    const msgType = message.message_type ?? message.msg_type;

    if (msgType === 'image' && parsed.image_key) {
      attachments.push({ fileKey: parsed.image_key, fileName: 'image.png', fileType: 'image' });
    } else if (msgType === 'file' && parsed.file_key) {
      attachments.push({
        fileKey: parsed.file_key,
        fileName: parsed.file_name ?? 'file',
        fileType: 'file',
      });
    } else if (msgType === 'audio' && parsed.file_key) {
      attachments.push({ fileKey: parsed.file_key, fileName: 'audio', fileType: 'audio' });
    } else if (msgType === 'video' && parsed.file_key) {
      attachments.push({ fileKey: parsed.file_key, fileName: 'video', fileType: 'video' });
    }
  } catch {
    // Ignore malformed content; callers treat missing attachments as empty.
  }
  return attachments;
}
