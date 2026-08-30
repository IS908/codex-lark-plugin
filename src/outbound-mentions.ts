import type { LarkChatMember, LarkTransport } from './lark-transport-contracts.js';
import { logSafeError } from './safe-log.js';

export interface RenderedOutboundMentions {
  text: string;
  cardMarkdown: string;
  resolvedCount: number;
}

interface ResolvableMember {
  id: string;
  name: string;
}

interface ProtectedRange {
  start: number;
  end: number;
}

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const MENTION_START_BOUNDARIES = '([{"\'`“‘，。！？；：、';
const MENTION_END_BOUNDARIES = ')]}"\'`”’,.!?;:，。！？；：、';

export async function resolveOutboundMentions(
  transport: LarkTransport,
  chatId: string,
  source: string,
): Promise<RenderedOutboundMentions> {
  const unchanged = unchangedResult(source);
  if (!hasMentionCandidate(source)) return unchanged;

  try {
    const members = await transport.getChatMembers(chatId);
    return renderOutboundMentions(source, members);
  } catch (error) {
    logSafeError('[outbound-mentions] Chat roster lookup failed; preserving visible text:', error);
    return unchanged;
  }
}

export function renderOutboundMentions(
  source: string,
  members: readonly LarkChatMember[],
): RenderedOutboundMentions {
  if (!hasMentionCandidate(source)) return unchangedResult(source);

  const candidates = uniqueMembersByName(members);
  if (candidates.size === 0) return unchangedResult(source);
  const protectedRanges = markdownCodeRanges(source);
  let rangeIndex = 0;
  let text = '';
  let cardMarkdown = '';
  let cursor = 0;
  let resolvedCount = 0;

  for (let at = source.indexOf('@'); at >= 0; at = source.indexOf('@', at + 1)) {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].end <= at) {
      rangeIndex++;
    }
    if (
      isProtected(at, protectedRanges[rangeIndex])
      || !isMentionStart(source, at)
    ) {
      continue;
    }

    const match = findMemberMatch(source, at + 1, candidates);
    if (!match) continue;

    const prefix = source.slice(cursor, at);
    text += prefix + textMention(match);
    cardMarkdown += prefix + cardMention(match);
    cursor = at + 1 + match.name.length;
    at = cursor - 1;
    resolvedCount++;
  }

  if (resolvedCount === 0) return unchangedResult(source);
  const suffix = source.slice(cursor);
  return {
    text: text + suffix,
    cardMarkdown: cardMarkdown + suffix,
    resolvedCount,
  };
}

function unchangedResult(source: string): RenderedOutboundMentions {
  return { text: source, cardMarkdown: source, resolvedCount: 0 };
}

function hasMentionCandidate(source: string): boolean {
  const protectedRanges = markdownCodeRanges(source);
  let rangeIndex = 0;
  for (let at = source.indexOf('@'); at >= 0; at = source.indexOf('@', at + 1)) {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex].end <= at) {
      rangeIndex++;
    }
    if (!isProtected(at, protectedRanges[rangeIndex]) && isMentionStart(source, at)) return true;
  }
  return false;
}

function isMentionStart(source: string, at: number): boolean {
  return at === 0 || /\s/u.test(source[at - 1]) || MENTION_START_BOUNDARIES.includes(source[at - 1]);
}

function isMentionEnd(source: string, end: number): boolean {
  return end >= source.length || /\s/u.test(source[end]) || MENTION_END_BOUNDARIES.includes(source[end]);
}

function uniqueMembersByName(members: readonly LarkChatMember[]): Map<string, ResolvableMember | null> {
  const byName = new Map<string, ResolvableMember | null>();
  for (const member of members) {
    const name = member.name?.trim();
    if (!name) continue;
    const candidate = OPEN_ID_PATTERN.test(member.id) && (!member.idType || member.idType === 'open_id')
      ? { id: member.id, name }
      : null;

    const existing = byName.get(name);
    if (!byName.has(name)) {
      byName.set(name, candidate);
    } else if (!existing || !candidate || existing.id !== candidate.id) {
      byName.set(name, null);
    }
  }
  return byName;
}

function findMemberMatch(
  source: string,
  start: number,
  candidates: ReadonlyMap<string, ResolvableMember | null>,
): ResolvableMember | undefined {
  let best: ResolvableMember | undefined;
  for (const [name, member] of candidates) {
    if (!member || (best && name.length <= best.name.length)) continue;
    if (!source.startsWith(name, start)) continue;
    if (!isMentionEnd(source, start + name.length)) continue;
    best = member;
  }
  return best;
}

function textMention(member: ResolvableMember): string {
  return `<at user_id="${member.id}">${escapeAtName(member.name)}</at>`;
}

function cardMention(member: ResolvableMember): string {
  return `<at id=${member.id}></at>`;
}

function escapeAtName(name: string): string {
  return name.replace(/[<>\"]/g, '');
}

function isProtected(index: number, range: ProtectedRange | undefined): boolean {
  return range !== undefined && range.start <= index && index < range.end;
}

function markdownCodeRanges(source: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number; start: number } | undefined;

  for (const line of source.split(/(?<=\n)/)) {
    const lineEnd = offset + line.length;
    const withoutNewline = line.replace(/\r?\n$/, '');
    const marker = withoutNewline.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      const closing = withoutNewline.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        ranges.push({ start: fence.start, end: lineEnd });
        fence = undefined;
      }
      offset = lineEnd;
      continue;
    }

    if (marker) {
      fence = {
        marker: marker[1][0] as '`' | '~',
        length: marker[1].length,
        start: offset,
      };
      offset = lineEnd;
      continue;
    }

    if (/^(?: {4}|\t)/.test(withoutNewline)) {
      ranges.push({ start: offset, end: lineEnd });
    } else {
      appendInlineCodeRanges(withoutNewline, offset, ranges);
    }
    offset = lineEnd;
  }

  if (fence) ranges.push({ start: fence.start, end: source.length });
  return ranges;
}

function appendInlineCodeRanges(line: string, offset: number, ranges: ProtectedRange[]): void {
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf('`', cursor);
    if (start < 0) return;
    let runLength = 1;
    while (line[start + runLength] === '`') runLength++;
    const marker = '`'.repeat(runLength);
    const end = line.indexOf(marker, start + runLength);
    if (end < 0) {
      ranges.push({ start: offset + start, end: offset + line.length });
      return;
    }
    ranges.push({ start: offset + start, end: offset + end + runLength });
    cursor = end + runLength;
  }
}
