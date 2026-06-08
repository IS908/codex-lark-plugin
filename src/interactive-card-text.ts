const MAX_CARD_TEXT_CHARS = 4000;

const CONTAINER_KEYS = new Set([
  'actions',
  'body',
  'columns',
  'elements',
  'extra',
  'fields',
  'header',
  'i18n_elements',
  'i18n_header',
  'items',
  'option',
  'options',
]);

const TEXT_KEYS = new Set([
  'alt',
  'label',
  'placeholder',
  'subtitle',
  'text',
  'title',
]);

const UNSAFE_KEYS = new Set([
  'android_url',
  'behaviors',
  'callback',
  'callback_id',
  'card_link',
  'confirm',
  'data',
  'default_url',
  'fallback_url',
  'form_value',
  'href',
  'ios_url',
  'multi_url',
  'open_url',
  'params',
  'pc_url',
  'request_option',
  'token',
  'url',
  'value',
  'values',
]);

const TEXT_TAGS = new Set([
  'lark_md',
  'markdown',
  'mrkdwn',
  'plain_text',
  'text',
]);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocaleMap(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((key) => /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(key));
}

function preferredLocaleValue(record: Record<string, unknown>): unknown[] {
  if (!isLocaleMap(record)) return [];
  const preferred = record.en_us ?? record.zh_cn ?? Object.values(record)[0];
  return preferred === undefined ? [] : [preferred];
}

function stripLarkMarkdownTags(text: string): string {
  return text
    .replace(/<link\b[^>]*>([\s\S]*?)<\/link>/gi, '$1')
    .replace(/<person\b[^>]*>([\s\S]*?)<\/person>/gi, '$1')
    .replace(/<person\b[^>]*\/?>/gi, '')
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_match, label: string) => {
      const trimmed = String(label).trim().replace(/^@+/, '');
      return trimmed ? `@${trimmed}` : '';
    })
    .replace(/<at\b[^>]*\/?>/gi, '')
    .replace(/<([a-z_][\w-]*)\b[^>]*>([\s\S]*?)<\/\1>/gi, '$2')
    .replace(/<[^>]+>/g, '');
}

function normalizeText(text: string): string {
  return stripLarkMarkdownTags(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|lark:\/\/|mailto:|file:\/\/)[^)]+\)/g, '$1')
    .replace(/\b(?:https?:\/\/|lark:\/\/|mailto:|file:\/\/)\S+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function collectTextNode(value: unknown, add: (text: string) => void): void {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === 'string') {
    add(parsed);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectTextNode(item, add);
    return;
  }
  if (!isRecord(parsed)) return;

  if (isLocaleMap(parsed)) {
    for (const child of preferredLocaleValue(parsed)) collectTextNode(child, add);
    return;
  }

  const tag = typeof parsed.tag === 'string' ? parsed.tag : '';
  if (TEXT_TAGS.has(tag)) {
    if (typeof parsed.content === 'string') add(parsed.content);
    if (typeof parsed.text === 'string') add(parsed.text);
  }

  const i18n = parsed.i18n;
  if (isRecord(i18n)) {
    for (const child of preferredLocaleValue(i18n)) collectTextNode(child, add);
  }

  const i18nContent = parsed.i18n_content;
  const hasPreferredI18nContent =
    isRecord(i18nContent) && preferredLocaleValue(i18nContent).length > 0;
  if (isRecord(i18nContent)) {
    for (const child of preferredLocaleValue(i18nContent)) collectTextNode(child, add);
  }

  if (!hasPreferredI18nContent && typeof parsed.content === 'string' && !parsed.content.trim().startsWith('{')) {
    add(parsed.content);
  }
  if (typeof parsed.text === 'string') add(parsed.text);
}

function visitCardNode(value: unknown, add: (text: string) => void): void {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) visitCardNode(item, add);
    return;
  }
  if (!isRecord(parsed)) return;

  if (isLocaleMap(parsed)) {
    for (const child of Object.values(parsed)) visitCardNode(child, add);
    return;
  }

  const tag = typeof parsed.tag === 'string' ? parsed.tag : '';
  if (TEXT_TAGS.has(tag) || tag === 'button') {
    collectTextNode(parsed, add);
  }

  for (const [rawKey, child] of Object.entries(parsed)) {
    const key = rawKey.toLowerCase();
    if (UNSAFE_KEYS.has(key)) continue;
    if (key === 'config') {
      if (isRecord(child) && 'summary' in child) collectTextNode(child.summary, add);
      continue;
    }
    if (TEXT_KEYS.has(key)) {
      collectTextNode(child, add);
      continue;
    }
    if (key === 'content' && typeof child === 'string') {
      const nested = parseMaybeJson(child);
      if (nested !== child) visitCardNode(nested, add);
      continue;
    }
    if (CONTAINER_KEYS.has(key)) {
      visitCardNode(child, add);
    }
  }
}

/**
 * Extract user-visible text from common Feishu/Lark interactive-card schemas.
 * Action values, callback payloads, URLs, and other machine-only fields are
 * intentionally skipped so quoted-card context does not leak private payloads.
 */
export function extractInteractiveCardText(rawContent: string): string | null {
  const parsed = parseMaybeJson(rawContent);
  if (!isRecord(parsed)) return null;

  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const text = normalizeText(raw);
    if (!text || seen.has(text)) return;
    seen.add(text);
    lines.push(text);
  };

  visitCardNode(parsed, add);

  const joined = lines.join('\n');
  if (!joined) return null;
  if (joined.length <= MAX_CARD_TEXT_CHARS) return joined;
  return `${joined.slice(0, MAX_CARD_TEXT_CHARS - 4).trimEnd()}\n...`;
}
