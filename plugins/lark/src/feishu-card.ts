/**
 * Feishu Reply Card builder.
 *
 * Converts plain markdown text into Feishu CardKit Schema 2.0 card JSON.
 * - Optimizes markdown for Feishu's card renderer
 * - Keeps generated cards body-only so they read like rich Markdown messages
 * - Splits long text safely around fenced code blocks
 * - Splits oversized cards into multiple cards
 *
 * Ported and simplified from happyclaw/src/feishu-streaming-card.ts.
 * Streaming / interrupt / auxiliary state features are intentionally excluded
 * because the MCP reply flow delivers complete text atomically.
 */

// Per-markdown-element character limit
const CARD_MD_LIMIT = 4000;
// Per-card total size safety limit (Feishu hard limit is ~30 KB)
const CARD_SIZE_LIMIT = 25 * 1024;
// Per-card element count safety limit
const CARD_ELEMENT_LIMIT = 45;
const TABLE_MAX_COLUMNS = 10;
const TABLE_MAX_ROWS = 30;
const TABLE_CELL_LIMIT = 160;
const TABLE_HEADER_LIMIT = 64;

const HEADING_RE = /^#{1,6}\s+\S/m;
const CODE_FENCE_RE = /^\s*```/m;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/m;
const STRUCTURED_SECTION_RE = /^\s*(?:#{1,6}\s+|\*\*)?(建议|推荐|风险|操作|触发条件|适用场景|下一步|结论|Action|Actions|Risk|Risks|Recommendation|Recommendations|Next steps?)(?:\*\*)?\s*(?:[:：]|$)/gim;

/**
 * Decide whether a reply text needs Feishu's richer v2 card renderer.
 *
 * Keep this bridge-layer policy conservative: short confirmations and normal
 * prose stay copyable text, while formatting that Feishu text messages cannot
 * render well is upgraded automatically unless the caller forces format="text".
 */
export function needsCard(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (HEADING_RE.test(trimmed)) return true;
  if (CODE_FENCE_RE.test(trimmed)) return true;
  if (hasMarkdownTable(trimmed)) return true;
  if (countListItems(trimmed) >= 2) return true;
  if (hasStructuredSections(trimmed)) return true;
  return false;
}

/** Backward-compatible alias for older call sites and smoke checks. */
export function shouldUseCard(text: string): boolean {
  return needsCard(text);
}

/**
 * Build one or more Schema 2.0 card JSON objects from raw markdown text.
 * Returns at least one card. Oversized content is split across multiple
 * cards bounded by CARD_ELEMENT_LIMIT and CARD_SIZE_LIMIT.
 */
export function buildCards(
  text: string,
  opts?: { footer?: string }
): object[] {
  const { elements } = buildCardContent(text);

  // Append footer element if provided
  if (opts?.footer) {
    elements.push({
      tag: 'markdown',
      content: opts.footer,
      text_size: 'notation',
    });
  }

  // Pack elements into one or more cards, bounded by count and total size
  const cards: object[] = [];
  let batch: Element[] = [];
  let batchSize = 0;

  const flush = () => {
    if (batch.length === 0) return;
    cards.push(buildSchema2Card(batch));
    batch = [];
    batchSize = 0;
  };

  for (const el of elements) {
    const elJson = JSON.stringify(el);
    if (
      batch.length > 0 &&
      (batch.length >= CARD_ELEMENT_LIMIT ||
        batchSize + elJson.length > CARD_SIZE_LIMIT)
    ) {
      flush();
    }
    // Hard-truncate a single oversized element to stay within size budget.
    if (elJson.length > CARD_SIZE_LIMIT) {
      if (typeof el.content === 'string') {
        const content = el.content.slice(0, CARD_SIZE_LIMIT - 200) + '\n...';
        batch.push({ ...el, content });
        batchSize += CARD_SIZE_LIMIT - 200;
      } else {
        batch.push({
          tag: 'markdown',
          content: '_Table omitted because it exceeded the Feishu card size limit._',
        });
        batchSize += 96;
      }
    } else {
      batch.push(el);
      batchSize += elJson.length;
    }
  }
  flush();

  if (cards.length === 0) {
    cards.push(buildSchema2Card([{ tag: 'markdown', content: '...' }]));
  }

  return cards;
}

// ─── Markdown Style Optimizer ─────────────────────────────────
// Ported from happyclaw/src/feishu-markdown-style.ts (MIT).

/** Strip `![alt](value)` where value is not a valid Feishu image key. */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return '';
  });
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // 1. Extract code blocks, protect with placeholders
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. Heading demotion (only if source has H1~H3)
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1');
    r = r.replace(/^# (.+)$/gm, '#### $1');
  }

  if (cardVersion >= 2) {
    // 3. Consecutive heading spacing
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');
    // 4. Table spacing
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');
    // 5. Restore code blocks with <br> wrapping
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 5. Restore code blocks without <br>
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // 6. Compress excessive blank lines (3+ → 2)
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

/**
 * Optimize markdown for Feishu card rendering (Schema 2.0 by default).
 * Wraps the internal implementation so a bad input silently returns the raw
 * text instead of crashing the reply pipeline.
 */
function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    const r = _optimizeMarkdownStyle(text, cardVersion);
    return stripInvalidImageKeys(r);
  } catch {
    return text;
  }
}

// ─── Card Upgrade Detection ──────────────────────────────────

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function countListItems(text: string): number {
  return stripFencedCodeBlocks(text)
    .split('\n')
    .filter((line) => LIST_ITEM_RE.test(line))
    .length;
}

function hasStructuredSections(text: string): boolean {
  const names = new Set<string>();
  for (const match of stripFencedCodeBlocks(text).matchAll(STRUCTURED_SECTION_RE)) {
    names.add(match[1].toLowerCase());
  }
  return names.size >= 2;
}

function hasMarkdownTable(text: string): boolean {
  const lines = stripFencedCodeBlocks(text).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (isMarkdownTableRow(lines[i]) && isMarkdownTableSeparator(lines[i + 1])) {
      return true;
    }
  }
  return false;
}

// ─── Code-Block-Safe Splitting ───────────────────────────────

interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

/** Scan text for fenced code block ranges (``` ... ```). */
function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block — treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

function findContainingBlock(
  pos: number,
  ranges: CodeBlockRange[]
): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Split text into chunks of at most `maxLen` characters, preferring
 * paragraph/line boundaries and never truncating a fenced code block
 * without properly closing/reopening it.
 */
function splitCodeBlockSafe(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const ranges = findCodeBlockRanges(remaining);

    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      if (block.open > 0 && block.open > maxLen * 0.3) {
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Card Content & Assembly ─────────────────────────────────

type Element = Record<string, unknown>;

interface CardContentResult {
  elements: Element[];
}

/**
 * Build content elements for a single card:
 * - Optimizes markdown
 * - Converts Markdown tables into v2 card table elements
 * - Splits markdown into ≤ CARD_MD_LIMIT chunks (code-block-safe)
 * - Returns at least one element
 */
function buildCardContent(text: string): CardContentResult {
  const rawContent = text.trim();
  const elements: Element[] = [];

  for (const segment of splitMarkdownAndTables(rawContent)) {
    if (segment.type === 'table') {
      elements.push(segment.element);
      continue;
    }
    appendMarkdownElements(elements, segment.content);
  }

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() || '...' });
  }

  return { elements };
}

type CardSegment =
  | { type: 'markdown'; content: string }
  | { type: 'table'; element: Element };

function splitMarkdownAndTables(text: string): CardSegment[] {
  const lines = text.split('\n');
  const segments: CardSegment[] = [];
  let markdownLines: string[] = [];
  let inFence = false;

  const flushMarkdown = () => {
    const content = markdownLines.join('\n').trim();
    if (content) segments.push({ type: 'markdown', content });
    markdownLines = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^\s*```/.test(line.trim())) {
      inFence = !inFence;
      markdownLines.push(line);
      i++;
      continue;
    }

    if (
      !inFence &&
      i < lines.length - 1 &&
      isMarkdownTableRow(lines[i]) &&
      isMarkdownTableSeparator(lines[i + 1])
    ) {
      const tableLines = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isMarkdownTableRow(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }

      const tableElement = markdownTableToElement(tableLines);
      if (tableElement) {
        flushMarkdown();
        segments.push({ type: 'table', element: tableElement });
      } else {
        markdownLines.push(...tableLines);
      }
      i = j;
      continue;
    }

    markdownLines.push(line);
    i++;
  }

  flushMarkdown();
  return segments;
}

function appendMarkdownElements(elements: Element[], rawMarkdown: string): void {
  const contentToRender = optimizeMarkdownStyle(rawMarkdown, 2).trim();
  if (!contentToRender) return;
  if (contentToRender.length > CARD_MD_LIMIT) {
    for (const chunk of splitCodeBlockSafe(contentToRender, CARD_MD_LIMIT)) {
      elements.push({ tag: 'markdown', content: chunk });
    }
    return;
  }
  elements.push({ tag: 'markdown', content: contentToRender });
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && splitMarkdownTableRow(trimmed).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!isMarkdownTableRow(line)) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function truncateCell(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 3)) + '...';
}

function cleanTableCell(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownTableToElement(lines: string[]): Element | null {
  const headers = splitMarkdownTableRow(lines[0]).slice(0, TABLE_MAX_COLUMNS);
  if (headers.length < 2 || !isMarkdownTableSeparator(lines[1])) return null;

  const columns = headers.map((header, index) => ({
    name: `c${index}`,
    display_name: truncateCell(cleanTableCell(header) || `Column ${index + 1}`, TABLE_HEADER_LIMIT),
    data_type: 'text',
    horizontal_align: 'left',
    width: 'auto',
  }));

  const rows = lines
    .slice(2, TABLE_MAX_ROWS + 2)
    .map((line) => splitMarkdownTableRow(line))
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => {
      const row: Record<string, string> = {};
      columns.forEach((column, index) => {
        row[column.name] = truncateCell(cleanTableCell(cells[index] ?? ''), TABLE_CELL_LIMIT);
      });
      return row;
    });

  if (rows.length === 0) return null;

  return {
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal_v2',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

/**
 * Assemble an aitask-style body-only Schema 2.0 (CardKit) card JSON object.
 * No header/template is generated; rich text lives directly in body.elements.
 */
function buildSchema2Card(elements: Element[]): object {
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
    },
    body: { elements },
  };
}
