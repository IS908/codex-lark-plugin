import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appConfig } from '../config.js';
import { applyL1, loadL2Rules, extractL2PrivatePhrases } from '../privacy-rules.js';

export type Tier = 'public' | 'private';

/** Short, stable-per-text identifier for a profile line (used by forget_memory). */
export interface ProfileLine {
  index: number;
  hash: string;
  text: string;
}

function lineHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** Normalize a profile line for deduplication (not for storage). */
function normalizeProfileLine(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '').toLowerCase();
}

function isL2Private(line: string, l2PrivatePhrases: string[]): boolean {
  if (l2PrivatePhrases.length === 0) return false;
  const lower = line.toLowerCase();
  return l2PrivatePhrases.some((phrase) => lower.includes(phrase));
}

function isDeterministicPrivate(line: string, l2PrivatePhrases: string[]): boolean {
  return applyL1(line) === 'private' || isL2Private(line, l2PrivatePhrases);
}

function splitProfileContentByPrivacy(
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

function capUtf8Bytes(content: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return content;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= maxBytes) return content;

  const marker = `\n\n[truncated to ${maxBytes} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return marker.slice(0, maxBytes);

  const keepBytes = maxBytes - markerBytes;
  let used = 0;
  let prefix = '';
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (used + charBytes > keepBytes) break;
    prefix += char;
    used += charBytes;
  }
  return prefix + marker;
}

function capEpisodeContent(content: string): string {
  return capUtf8Bytes(content, appConfig.maxEpisodeBytes);
}

/**
 * Merge new profile lines into an existing tier file body.
 *
 * Dedup rules:
 * - Case-insensitive line match after trim + leading-bullet strip.
 * - Punctuation is **not** normalized — "prefers tea" and "prefers tea."
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
    if (existingKeys.has(key)) continue; // exact match → skip
    newLines.push(trimmed);
    existingKeys.add(key); // also dedupe within the incoming batch

    // Near-duplicate warning: prefix-containment either direction.
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

export interface Episode {
  id: string;
  content: string;
  timestamp: string;
  score?: number;
  chatId?: string;
  threadId?: string;
}

export interface EpisodeMeta {
  chatId: string;
  threadId?: string;
  userId?: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  score?: number;
}

/**
 * Local markdown memory store.
 * Stores memories as .md files under ~/.codex/channels/lark/memories/
 */
export class MemoryStore {
  private baseDir: string;
  private profileLocks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? appConfig.memoriesDir;
  }

  async healthCheck(): Promise<boolean> { return true; }

  // ── User Profile (tiered, v0.10.0+) ──

  private profileDir(userId: string): string {
    return path.join(this.baseDir, 'profiles', userId);
  }

  private profileTierPath(userId: string, tier: Tier): string {
    return path.join(this.profileDir(userId), `${tier}.md`);
  }

  private legacyProfilePath(userId: string): string {
    return path.join(this.baseDir, 'profiles', `${userId}.md`);
  }

  private async loadL2PrivatePhrases(): Promise<string[]> {
    return extractL2PrivatePhrases(await loadL2Rules()).map((p) => p.toLowerCase());
  }

  /**
   * Migrate a pre-v0.10 single-file profile to the tiered layout, applying
   * the L1 classifier line-by-line to split into public/private.
   *
   * Idempotent: runs at most once per user. Partial-failure safe: legacy file
   * is deleted only after both target files are successfully written.
   *
   *  legacy: profiles/{userId}.md
   *  target: profiles/{userId}/{public,private}.md
   *
   * See spec's "Migration" section for the trade-off discussion (approach B:
   * deterministic L1 filter, no LLM dependency).
   */
  private async withProfileLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.profileLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous
      .catch(() => {})
      .then(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
    this.profileLocks.set(userId, current);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.profileLocks.get(userId) === current) {
        this.profileLocks.delete(userId);
      }
    }
  }

  private async migrateIfNeededUnlocked(userId: string): Promise<void> {
    const legacy = this.legacyProfilePath(userId);
    const dir = this.profileDir(userId);

    if (!existsSync(legacy)) return; // fresh user or already migrated

    if (existsSync(dir)) {
      // Mid-failure from a previous migration — new layout already exists.
      // Safe to drop the legacy file; new layout is authoritative.
      try { await fs.unlink(legacy); } catch {}
      return;
    }

    const content = await fs.readFile(legacy, 'utf-8');
    const publicLines: string[] = [];
    const privateLines: string[] = [];

    // Pre-load L2 user rules so operators who configure privacy-rules.md
    // BEFORE upgrading can influence their own legacy-profile migration
    // (org codenames, people mentions, etc. that L1 doesn't cover).
    // Substring match is case-insensitive, deterministic, no LLM needed.
    const l2Phrases = await this.loadL2PrivatePhrases();

    for (const line of content.split('\n')) {
      if (!line.trim()) {
        // Preserve blank lines in public for readability; skip in private.
        publicLines.push(line);
        continue;
      }

      if (applyL1(line) === 'private') {
        privateLines.push(line);
        continue;
      }

      if (l2Phrases.length > 0) {
        const lower = line.toLowerCase();
        if (l2Phrases.some((p) => lower.includes(p))) {
          privateLines.push(line);
          continue;
        }
      }

      publicLines.push(line);
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.profileTierPath(userId, 'public'), publicLines.join('\n'), 'utf-8');
    if (privateLines.length > 0) {
      await fs.writeFile(this.profileTierPath(userId, 'private'), privateLines.join('\n'), 'utf-8');
    }
    // Wrap unlink in try/catch to tolerate concurrent migrations of the
    // same user (e.g. User A is mentioned in two chats handled in parallel
    // by different queues — both enter migrateIfNeeded before either
    // finishes). ENOENT on the second unlink is benign.
    try { await fs.unlink(legacy); } catch {}

    console.error(
      `[migrate] profile ${userId}: ${publicLines.filter(l => l.trim()).length} public, ${privateLines.length} private`,
    );
  }

  /**
   * Load a user's profile, filtered by rendering visibility.
   * - caller === ownerId → return public + private tiers joined
   * - caller !== ownerId → return public tier only
   *
   * Returns null if neither tier file has content.
   *
   * Output is the raw tier file bytes (bullets preserved). This is the
   * representation the channel-side memory enricher feeds to Codex as
   * conversational context. The display/edit representation in
   * {@link listProfileLines} strips bullets — the two return formats are
   * intentionally different, and their consumers are disjoint.
   */
  async getProfile(ownerId: string, caller: string): Promise<string | null> {
    return this.withProfileLock(ownerId, async () => {
      await this.migrateIfNeededUnlocked(ownerId);

      const readOpt = async (p: string): Promise<string> => {
        if (!existsSync(p)) return '';
        try { return await fs.readFile(p, 'utf-8'); } catch { return ''; }
      };

      const pub = (await readOpt(this.profileTierPath(ownerId, 'public'))).trim();
      if (caller === ownerId) {
        const priv = (await readOpt(this.profileTierPath(ownerId, 'private'))).trim();
        const joined = [pub, priv].filter(Boolean).join('\n\n');
        return joined || null;
      }
      return pub || null;
    });
  }

  /**
   * Persist a profile tier. Creates the user directory if missing.
   *
   * Runs {@link migrateIfNeeded} first so that a save on an unmigrated user
   * does not silently drop their legacy profile content. Without this call,
   * the order save → read would see dir-exists-early-return in migration and
   * throw away the legacy file without classifying it.
   *
   * Mode:
   * - `'append'` (default, safe): read the existing tier, merge new lines
   *   (exact-match deduped after `trim + strip-bullet + lowercase`), preserve
   *   all original content. Used by one-off save_memory calls where `content`
   *   is a single fact. Never destroys existing entries.
   * - `'replace'`: overwrite the entire tier file. Reserved for the distiller
   *   auto-flush path, which intentionally rewrites the full tier based on a
   *   fresh read of recent history.
   */
  async saveProfile(
    userId: string,
    content: string,
    tier: Tier,
    mode: 'append' | 'replace' = 'append',
  ): Promise<void> {
    await this.withProfileLock(userId, async () => {
      await this.migrateIfNeededUnlocked(userId);
      const dir = this.profileDir(userId);
      await fs.mkdir(dir, { recursive: true });

      if (tier === 'public') {
        const l2Phrases = await this.loadL2PrivatePhrases();
        const { publicContent, privateContent } = splitProfileContentByPrivacy(content, l2Phrases);
        await this.writeProfileTierUnlocked(userId, 'public', publicContent, mode, l2Phrases);
        if (privateContent.trim()) {
          await this.writeProfileTierUnlocked(userId, 'private', privateContent, 'append', l2Phrases);
        }
        return;
      }

      await this.writeProfileTierUnlocked(userId, tier, content, mode, await this.loadL2PrivatePhrases());
    });
  }

  private async writeProfileTierUnlocked(
    userId: string,
    tier: Tier,
    content: string,
    mode: 'append' | 'replace',
    l2PrivatePhrases: string[],
  ): Promise<void> {
    const filePath = this.profileTierPath(userId, tier);

    if (mode === 'replace') {
      if (tier !== 'private' || !existsSync(filePath)) {
        await fs.writeFile(filePath, content, 'utf-8');
        return;
      }

      const existing = await fs.readFile(filePath, 'utf-8');
      const deterministicExisting = existing
        .split('\n')
        .filter((line) => line.trim() && isDeterministicPrivate(line, l2PrivatePhrases))
        .join('\n');
      const next = deterministicExisting
        ? mergeProfileLines(content, deterministicExisting, { userId, tier })
        : content;
      await fs.writeFile(filePath, next, 'utf-8');
      return;
    }

    const existing = existsSync(filePath) ? await fs.readFile(filePath, 'utf-8') : '';
    const merged = mergeProfileLines(existing, content, { userId, tier });
    if (merged === existing) return;
    await fs.writeFile(filePath, merged, 'utf-8');
  }

  /**
   * Return the lines of a profile tier as addressable items. Each line carries
   * a short sha1-based hash that is stable per content — callers (e.g. the
   * forget_memory tool) use the hash to identify a line without the file
   * needing a durable row id.
   *
   * Blank lines are skipped. Leading/trailing whitespace is trimmed. A leading
   * `-`/`*` bullet marker is also stripped so `text` (and the derived hash) is
   * storage-format-independent — a fact saved as "foo" by the distiller and
   * later merged via append as "- foo" shares one hash and renders identically
   * in `what_do_you_know`.
   */
  async listProfileLines(ownerId: string, tier: Tier): Promise<ProfileLine[]> {
    return this.withProfileLock(ownerId, async () => {
      await this.migrateIfNeededUnlocked(ownerId);
      return this.listProfileLinesUnlocked(ownerId, tier);
    });
  }

  private async listProfileLinesUnlocked(ownerId: string, tier: Tier): Promise<ProfileLine[]> {
    const p = this.profileTierPath(ownerId, tier);
    if (!existsSync(p)) return [];
    const content = await fs.readFile(p, 'utf-8');
    return content
      .split('\n')
      .map((raw) => raw.trim().replace(/^[-*]\s+/, ''))
      .filter(Boolean)
      .map((text, index) => ({ index, hash: lineHash(text), text }));
  }

  /**
   * Remove a single line (identified by its hash from {@link listProfileLines})
   * from the given tier file. Returns true if a line was removed, false if
   * nothing matched. Idempotent — removing the same hash twice returns false
   * on the second call.
   *
   * The rewritten file is bullet-normalized: every remaining line is written
   * back with a `- ` prefix so the tier stays visually consistent with the
   * append-mode storage convention.
   */
  async removeProfileLine(ownerId: string, tier: Tier, hash: string): Promise<boolean> {
    return this.withProfileLock(ownerId, async () => {
      await this.migrateIfNeededUnlocked(ownerId);
      const lines = await this.listProfileLinesUnlocked(ownerId, tier);
      const kept = lines.filter((l) => l.hash !== hash);
      if (kept.length === lines.length) return false;

      const next = kept.map((l) => `- ${l.text}`).join('\n') + (kept.length > 0 ? '\n' : '');
      await fs.writeFile(this.profileTierPath(ownerId, tier), next, 'utf-8');
      return true;
    });
  }

  // ── Episodes ──

  async searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]> {
    if (!scope?.chatId) return [];

    const dir = scope.threadId
      ? path.join(this.baseDir, 'episodes', scope.chatId, 'threads', scope.threadId)
      : path.join(this.baseDir, 'episodes', scope.chatId);

    try {
      const files = await fs.readdir(dir);
      const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('archive-'));

      // Read all episodes and score by keyword overlap + recency
      const keywords = this.extractKeywords(query);
      const scored: Array<{ episode: Episode; score: number }> = [];

      for (const file of mdFiles) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);

        // Score: keyword match on first two lines + filename
        const firstLines = content.split('\n').slice(0, 3).join(' ').toLowerCase();
        const filenameLower = file.toLowerCase();
        let keywordScore = 0;
        for (const kw of keywords) {
          if (firstLines.includes(kw) || filenameLower.includes(kw)) {
            keywordScore++;
          }
        }

        // Recency boost: newer files score higher (0-1 scale, decays over 30 days)
        const ageMs = Date.now() - stat.mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyScore = Math.max(0, 1 - ageDays / 30);

        const totalScore = keywordScore + recencyScore;

        scored.push({
          episode: {
            id: file,
            content,
            timestamp: stat.mtime.toISOString(),
            chatId: scope.chatId,
            threadId: scope.threadId,
          },
          score: totalScore,
        });
      }

      // Sort by score descending, return top N
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, appConfig.maxSearchResults).map(s => ({
        ...s.episode,
        score: s.score,
      }));
    } catch {
      return [];
    }
  }

  async saveEpisode(
    type: 'chat' | 'thread',
    content: string,
    meta: EpisodeMeta
  ): Promise<void> {
    const dir =
      type === 'thread' && meta.threadId
        ? path.join(this.baseDir, 'episodes', meta.chatId, 'threads', meta.threadId)
        : path.join(this.baseDir, 'episodes', meta.chatId);

    await fs.mkdir(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${timestamp}.md`;
    await fs.writeFile(path.join(dir, fileName), capEpisodeContent(content), 'utf-8');
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    const dir = path.join(this.baseDir, 'episodes', chatId);
    try {
      const files = await fs.readdir(dir);
      const episodes: Episode[] = [];

      for (const file of files.filter(f => f.endsWith('.md'))) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);
        episodes.push({
          id: file,
          content,
          timestamp: stat.mtime.toISOString(),
          chatId,
        });
      }

      episodes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return episodes;
    } catch {
      return [];
    }
  }

  async deleteEpisodes(chatId: string, ids: string[]): Promise<void> {
    const dir = path.join(this.baseDir, 'episodes', chatId);
    for (const id of ids) {
      try {
        await fs.unlink(path.join(dir, id));
      } catch {
        // ignore missing files
      }
    }
  }

  // ── Skills ──

  async searchSkills(query: string): Promise<Skill[]> {
    const dir = path.join(this.baseDir, 'skills');
    try {
      const files = await fs.readdir(dir);
      const keywords = this.extractKeywords(query);
      const results: Array<{ skill: Skill; score: number }> = [];

      for (const file of files.filter(f => f.endsWith('.md'))) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        // Parse skill file: first line = name, second line = description
        const lines = content.split('\n');
        const name = (lines[0] ?? '').replace(/^#\s*/, '').trim();
        const description = (lines[1] ?? '').trim();

        let score = 0;
        const searchText = `${name} ${description} ${file}`.toLowerCase();
        for (const kw of keywords) {
          if (searchText.includes(kw)) score++;
        }

        if (score > 0) {
          results.push({ skill: { name, description, content }, score });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, appConfig.maxSearchResults).map(r => ({
        ...r.skill,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  async saveSkill(name: string, description: string, content: string): Promise<void> {
    const dir = path.join(this.baseDir, 'skills');
    await fs.mkdir(dir, { recursive: true });

    const fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md';
    const fileContent = `# ${name}\n${description}\n\n${content}`;
    await fs.writeFile(path.join(dir, fileName), fileContent, 'utf-8');
  }

  // ── Helpers ──

  private extractKeywords(query: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'its',
      'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'she', 'they', 'them', 'and', 'or', 'but', 'not', 'no',
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
      '上', '也', '他', '她', '们', '这', '那', '你', '吗', '什么', '怎么',
    ]);

    return query
      .toLowerCase()
      .split(/[\s,;.!?，。！？、；：]+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
  }
}
