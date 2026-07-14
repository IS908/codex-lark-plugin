import { createHash } from 'node:crypto';
import { applyL1 } from '../privacy-rules.js';

export type Tier = 'public' | 'private';

/** Short, stable-per-text identifier for a profile line (used by forget_memory). */
export interface ProfileLine {
  index: number;
  hash: string;
  text: string;
}

export function lineHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** Normalize a profile line for deduplication (not for storage). */
export function normalizeProfileLine(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '').toLowerCase();
}

function isL2Private(line: string, l2PrivatePhrases: string[]): boolean {
  if (l2PrivatePhrases.length === 0) return false;
  const lower = line.toLowerCase();
  return l2PrivatePhrases.some((phrase) => lower.includes(phrase));
}

export function isDeterministicPrivate(line: string, l2PrivatePhrases: string[]): boolean {
  return applyL1(line) === 'private' || isL2Private(line, l2PrivatePhrases);
}

export function splitProfileContentByPrivacy(
  content: string,
  l2PrivatePhrases: string[],
): { publicContent: string; privateContent: string } {
  const publicLines: string[] = [];
  const privateLines: string[] = [];

  for (const raw of content.split('\n')) {
    if (!raw.trim()) {
      publicLines.push(raw);
      continue;
    }
    if (isDeterministicPrivate(raw, l2PrivatePhrases)) privateLines.push(raw);
    else publicLines.push(raw);
  }

  return {
    publicContent: publicLines.join('\n'),
    privateContent: privateLines.join('\n'),
  };
}

/**
 * Merge new profile lines into an existing tier file body.
 *
 * Dedup rules:
 * - Case-insensitive line match after trim + leading-bullet strip.
 * - Punctuation is not normalized; "prefers tea" and "prefers tea."
 *   are kept as distinct lines to avoid silent merges.
 *
 * Original capitalization and punctuation are preserved in the output.
 *
 * Incoming lines without a `-`/`*` bullet marker are normalized on write to
 * `- <line>` so the tier file remains a well-formed markdown bullet list.
 *
 * Near-duplicates (prefix containment after normalization) are logged to
 * stderr to help operators notice redundant writes, but are still preserved.
 */
export function mergeProfileLines(
  existing: string,
  incoming: string,
  ctx?: { userId?: string; tier?: Tier },
): string {
  const existingLinesRaw = existing.split('\n').filter((l) => l.trim());
  const existingKeys = new Set(existingLinesRaw.map(normalizeProfileLine));
  const existingNormalized = existingLinesRaw.map(normalizeProfileLine);

  const newLines: string[] = [];
  for (const raw of incoming.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeProfileLine(trimmed);
    if (existingKeys.has(key)) continue;
    newLines.push(trimmed);
    existingKeys.add(key);

    for (const other of existingNormalized) {
      if (key !== other && (key.startsWith(other) || other.startsWith(key))) {
        const where = ctx?.userId && ctx?.tier ? ` in ${ctx.userId}/${ctx.tier}.md` : '';
        console.error(
          `[memory] Possible near-duplicate${where}: incoming "${trimmed}" resembles existing entry "${existingLinesRaw[existingNormalized.indexOf(other)]}"`,
        );
        break;
      }
    }
  }

  if (newLines.length === 0) return existing;

  const appended = newLines
    .map((l) => (/^[-*]\s+/.test(l) ? l : `- ${l}`))
    .join('\n');
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return existing + sep + appended + '\n';
}
