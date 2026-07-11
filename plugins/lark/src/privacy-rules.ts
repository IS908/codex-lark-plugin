/**
 * L1 hardcoded privacy rules — universal patterns applied at distillation
 * time regardless of source or explicit user override.
 *
 * Classification priority (higher wins):
 *   L1 (this file) > L2 (user's privacy-rules.md) > L3 (LLM judgment)
 *
 * L1 blacklist always wins — even if a fact appears in a public group,
 * matching content (email, phone, token, etc.) is forced into the private tier.
 * Rationale: the danger of these fields is bot-initiated re-broadcast, not
 * the one-time disclosure.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { appConfig } from './config.js';

/**
 * Regex patterns that force a fact into `private`.
 *
 * NOTE on email — positioning: this plugin targets **work-chat use cases**
 * (Feishu is a corporate IM; work emails are routinely shared via signatures
 * and company directories). Under that model, email is **not sensitive by
 * default** and is intentionally NOT in the L1 blacklist — it falls through
 * to L2/L3 classification with a source-based default (group → public,
 * p2p → private).
 *
 * If your deployment is primarily personal (gmail, etc.) or you otherwise
 * want stricter handling, add a rule to your L2 privacy-rules.md under
 * "## Always private" — e.g. "contains an email address" — and the
 * distiller will respect it.
 */
export const L1_BLACKLIST_REGEX: { name: string; regex: RegExp }[] = [
  { name: 'cn-mobile', regex: /\b1[3-9]\d{9}\b/ },
  { name: 'us-phone', regex: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: 'cn-id', regex: /\b\d{17}[\dXx]\b/ },
  { name: 'credit-card', regex: /\b(?:\d[ -]*?){13,16}\b/ },
  { name: 'token-like', regex: /\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{16,}\b/i },
  { name: 'money-amount', regex: /\b\d+\s*[wk万千]\s*(?:元|块|RMB|CNY|USD)?\b|\$\d{3,}/ },
];

/** Keywords that force a fact into `private` when present. */
export const L1_BLACKLIST_KEYWORDS: string[] = [
  // 财务
  '薪资', '工资', 'KPI', '绩效', '奖金', 'bonus',
  // 职业异动
  '跳槽', '离职', '面试', 'offer',
  // 健康/情绪
  '病', '医院', '焦虑', '抑郁', '情绪', '吐槽',
  // 家庭
  '家庭矛盾', '婚姻', '离婚',
  // 凭据
  '密码', 'password',
];

/** Keywords that allow a fact into `public` (whitelist — otherwise defaults via L2/L3). */
export const L1_WHITELIST_KEYWORDS: string[] = [
  // 职位
  '工程师', '产品经理', 'PM', 'TL', 'CEO', 'CTO', '架构师',
  // 组织
  '团队', '部门', '公司',
  // 技术栈
  'TypeScript', 'JavaScript', 'Rust', 'Go', 'Python', 'Java', 'C++',
];

export type TierDecision = 'private' | 'public' | 'gray';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiWordKeyword(s: string): boolean {
  return /^[a-z0-9_+-]+$/i.test(s);
}

const OVERBROAD_L2_RULES = new Set([
  // English stop words / acknowledgements
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'ok', 'on', 'or', 'that', 'the', 'to', 'with',
  // Common Chinese function words and pronouns
  '的', '了', '和', '与', '或', '在', '是', '我', '你', '他', '她', '它', '们',
]);

function keywordMatches(haystackLower: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  if (isAsciiWordKeyword(kw)) {
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(kw.toLowerCase())}($|[^a-z0-9_])`).test(
      haystackLower,
    );
  }
  return haystackLower.includes(kw.toLowerCase());
}

/** Apply L1 only. Returns a decision or `gray` when L1 gives no signal. */
export function applyL1(fact: string): TierDecision {
  for (const { regex } of L1_BLACKLIST_REGEX) {
    if (regex.test(fact)) return 'private';
  }
  const lower = fact.toLowerCase();
  for (const kw of L1_BLACKLIST_KEYWORDS) {
    if (keywordMatches(lower, kw)) return 'private';
  }
  for (const kw of L1_WHITELIST_KEYWORDS) {
    if (keywordMatches(lower, kw)) return 'public';
  }
  return 'gray';
}

// ─── L2 user rules file ─────────────────────────────────────

function resolveL2Path(overridePath?: string): string {
  return overridePath || appConfig.privacyRulesPath;
}

/**
 * Load the L2 user rules file as raw markdown. Returns empty string if not
 * present. The distiller injects this as-is into the classification prompt;
 * we intentionally do not parse it into structured rules (LLM handles nuance).
 */
export async function loadL2Rules(overridePath?: string): Promise<string> {
  const path = resolveL2Path(overridePath);
  if (!existsSync(path)) return '';
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Extract the bullet items under `## Always private` from L2 markdown as
 * plain phrases. Used by legacy-profile migration to do a deterministic
 * substring check — the LLM is not available in that synchronous path.
 *
 * Only phrases under `## Always private` are returned; `## Always public`
 * (if any) is ignored because migration defaults gray content to public
 * anyway.
 *
 * Matching semantics at the call site are **case-insensitive substring**.
 * This works well for concrete nouns / identifiers (company names, project
 * codenames, people mentions) but does NOT interpret abstract descriptions
 * like "涉及人际冲突的内容" the way an LLM would. That's a deliberate
 * trade-off — deterministic and fast, at the cost of expressivity. Abstract
 * L2 rules still apply at L3 distillation time as before.
 *
 * Overbroad phrases (e.g. "a", "ok", "的") are skipped for this deterministic
 * migration path because substring matching would otherwise classify almost
 * everything as private.
 */
export function extractL2PrivatePhrases(markdown: string): string[] {
  if (!markdown) return [];
  const phrases: string[] = [];
  let inSection = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^##\s+always\s+private\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      // Entered a different section — stop collecting
      inSection = false;
      continue;
    }
    if (inSection && line.startsWith('- ')) {
      const phrase = line.slice(2).trim();
      if (phrase) {
        try {
          phrases.push(validateL2Rule(phrase));
        } catch (err) {
          console.error(
            `[privacy] Ignoring invalid L2 private rule during extraction: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }
  return phrases;
}

export function validateL2Rule(rule: string): string {
  const trimmed = rule.trim();
  if (!trimmed) throw new Error('Invalid privacy rule: rule cannot be empty.');
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new Error('Invalid privacy rule: rule must be a single line.');
  }
  if (/^#+\s/.test(trimmed)) {
    throw new Error('Invalid privacy rule: rule must be a bullet item, not a markdown heading.');
  }
  if ([...trimmed].length < 2) {
    throw new Error('Invalid privacy rule: rule is too short and would match too broadly.');
  }
  if (isAsciiWordKeyword(trimmed) && trimmed.length < 3) {
    throw new Error('Invalid privacy rule: short ASCII tokens are too broad.');
  }
  if (OVERBROAD_L2_RULES.has(trimmed.toLowerCase())) {
    throw new Error('Invalid privacy rule: common stop words are too broad.');
  }
  if (trimmed.length > 500) {
    throw new Error('Invalid privacy rule: rule is too long (max 500 chars).');
  }
  return trimmed;
}

/**
 * Add a rule line to the L2 file under the given section. Creates the file
 * if missing; creates the section header if missing. New rules are inserted
 * at the TOP of their section (newest-first, changelog-style) so users who
 * open the file see their recent additions immediately.
 */
export async function addL2Rule(
  rule: string,
  section: 'Always private' | 'Always public',
  overridePath?: string,
): Promise<void> {
  const cleanRule = validateL2Rule(rule);
  const path = resolveL2Path(overridePath);
  await mkdir(dirname(path), { recursive: true });
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const header = `## ${section}`;

  let next = existing;
  if (!next.includes(header)) {
    // Append new section at the end
    next += (next && !next.endsWith('\n') ? '\n' : '') + (next ? '\n' : '') + `${header}\n`;
  }

  // Insert rule line directly after the section header
  const sectionIdx = next.indexOf(header);
  const newlineAfterHeader = next.indexOf('\n', sectionIdx);
  const insertAt = newlineAfterHeader + 1;
  next = `${next.slice(0, insertAt)}- ${cleanRule}\n${next.slice(insertAt)}`;

  await writeFile(path, next, 'utf8');
}
