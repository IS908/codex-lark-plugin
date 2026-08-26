import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  appConfig
} from "./chunk-Y2RDVDXE.js";

// src/privacy-rules.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
var L1_BLACKLIST_REGEX = [
  { name: "cn-mobile", regex: /\b1[3-9]\d{9}\b/ },
  { name: "us-phone", regex: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: "cn-id", regex: /\b\d{17}[\dXx]\b/ },
  { name: "credit-card", regex: /\b(?:\d[ -]*?){13,16}\b/ },
  { name: "token-like", regex: /\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{16,}\b/i },
  { name: "money-amount", regex: /\b\d+\s*[wk万千]\s*(?:元|块|RMB|CNY|USD)?\b|\$\d{3,}/ }
];
var CREDENTIAL_MATERIAL_REGEX = [
  {
    name: "private-key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i
  },
  {
    name: "authorization-header",
    regex: /\b(?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic)\s+[^\s"'`]{8,}/i
  },
  {
    name: "secret-assignment",
    regex: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|secret)\s*[:=]\s*["']?[^\s"'`]{8,}/i
  },
  {
    name: "provider-token",
    regex: /\b(?:sk|pk|api|token|secret)[-_][a-z0-9]{16,}\b|\bgh[pousr]_[a-z0-9]{20,}\b/i
  },
  {
    name: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/
  },
  {
    name: "account-identifier",
    regex: /\b(?:account[_ -]?(?:id|number|no)|(?:tenant|user|client|open|union|app)[_-]?id)\s*[:=]\s*["']?[a-z0-9][a-z0-9_-]{7,}/i
  }
];
function detectCredentialMaterial(content) {
  return CREDENTIAL_MATERIAL_REGEX.filter(({ regex }) => regex.test(content)).map(({ name }) => name);
}
function filterCredentialMaterial(content) {
  const blockedClasses = detectCredentialMaterial(content);
  if (blockedClasses.length === 0) return { content, blockedClasses };
  if (blockedClasses.includes("private-key")) return { content: "", blockedClasses };
  return {
    content: content.split("\n").filter((line) => detectCredentialMaterial(line).length === 0).join("\n"),
    blockedClasses
  };
}
var L1_BLACKLIST_KEYWORDS = [
  // 财务
  "\u85AA\u8D44",
  "\u5DE5\u8D44",
  "KPI",
  "\u7EE9\u6548",
  "\u5956\u91D1",
  "bonus",
  // 职业异动
  "\u8DF3\u69FD",
  "\u79BB\u804C",
  "\u9762\u8BD5",
  "offer",
  // 健康/情绪
  "\u75C5",
  "\u533B\u9662",
  "\u7126\u8651",
  "\u6291\u90C1",
  "\u60C5\u7EEA",
  "\u5410\u69FD",
  // 家庭
  "\u5BB6\u5EAD\u77DB\u76FE",
  "\u5A5A\u59FB",
  "\u79BB\u5A5A",
  // 凭据
  "\u5BC6\u7801",
  "password"
];
var L1_WHITELIST_KEYWORDS = [
  // 职位
  "\u5DE5\u7A0B\u5E08",
  "\u4EA7\u54C1\u7ECF\u7406",
  "PM",
  "TL",
  "CEO",
  "CTO",
  "\u67B6\u6784\u5E08",
  // 组织
  "\u56E2\u961F",
  "\u90E8\u95E8",
  "\u516C\u53F8",
  // 技术栈
  "TypeScript",
  "JavaScript",
  "Rust",
  "Go",
  "Python",
  "Java",
  "C++"
];
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isAsciiWordKeyword(s) {
  return /^[a-z0-9_+-]+$/i.test(s);
}
var OVERBROAD_L2_RULES = /* @__PURE__ */ new Set([
  // English stop words / acknowledgements
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "ok",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
  // Common Chinese function words and pronouns
  "\u7684",
  "\u4E86",
  "\u548C",
  "\u4E0E",
  "\u6216",
  "\u5728",
  "\u662F",
  "\u6211",
  "\u4F60",
  "\u4ED6",
  "\u5979",
  "\u5B83",
  "\u4EEC"
]);
function keywordMatches(haystackLower, keyword) {
  const kw = keyword.trim();
  if (!kw) return false;
  if (isAsciiWordKeyword(kw)) {
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(kw.toLowerCase())}($|[^a-z0-9_])`).test(
      haystackLower
    );
  }
  return haystackLower.includes(kw.toLowerCase());
}
function applyL1(fact) {
  for (const { regex } of L1_BLACKLIST_REGEX) {
    if (regex.test(fact)) return "private";
  }
  const lower = fact.toLowerCase();
  for (const kw of L1_BLACKLIST_KEYWORDS) {
    if (keywordMatches(lower, kw)) return "private";
  }
  for (const kw of L1_WHITELIST_KEYWORDS) {
    if (keywordMatches(lower, kw)) return "public";
  }
  return "gray";
}
function resolveL2Path(overridePath) {
  return overridePath || appConfig.privacyRulesPath;
}
async function loadL2Rules(overridePath) {
  const path = resolveL2Path(overridePath);
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
function extractL2PrivatePhrases(markdown) {
  if (!markdown) return [];
  const phrases = [];
  let inSection = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^##\s+always\s+private\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection && line.startsWith("- ")) {
      const phrase = line.slice(2).trim();
      if (phrase) {
        try {
          phrases.push(validateL2Rule(phrase));
        } catch (err) {
          console.error(
            `[privacy] Ignoring invalid L2 private rule during extraction: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }
  return phrases;
}
function validateL2Rule(rule) {
  const trimmed = rule.trim();
  if (!trimmed) throw new Error("Invalid privacy rule: rule cannot be empty.");
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Invalid privacy rule: rule must be a single line.");
  }
  if (/^#+\s/.test(trimmed)) {
    throw new Error("Invalid privacy rule: rule must be a bullet item, not a markdown heading.");
  }
  if ([...trimmed].length < 2) {
    throw new Error("Invalid privacy rule: rule is too short and would match too broadly.");
  }
  if (isAsciiWordKeyword(trimmed) && trimmed.length < 3) {
    throw new Error("Invalid privacy rule: short ASCII tokens are too broad.");
  }
  if (OVERBROAD_L2_RULES.has(trimmed.toLowerCase())) {
    throw new Error("Invalid privacy rule: common stop words are too broad.");
  }
  if (trimmed.length > 500) {
    throw new Error("Invalid privacy rule: rule is too long (max 500 chars).");
  }
  return trimmed;
}
async function addL2Rule(rule, section, overridePath) {
  const cleanRule = validateL2Rule(rule);
  const path = resolveL2Path(overridePath);
  await mkdir(dirname(path), { recursive: true });
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const header = `## ${section}`;
  let next = existing;
  if (!next.includes(header)) {
    next += (next && !next.endsWith("\n") ? "\n" : "") + (next ? "\n" : "") + `${header}
`;
  }
  const sectionIdx = next.indexOf(header);
  const newlineAfterHeader = next.indexOf("\n", sectionIdx);
  const insertAt = newlineAfterHeader + 1;
  next = `${next.slice(0, insertAt)}- ${cleanRule}
${next.slice(insertAt)}`;
  await writeFile(path, next, "utf8");
}

export {
  L1_BLACKLIST_REGEX,
  detectCredentialMaterial,
  filterCredentialMaterial,
  L1_BLACKLIST_KEYWORDS,
  L1_WHITELIST_KEYWORDS,
  applyL1,
  loadL2Rules,
  extractL2PrivatePhrases,
  validateL2Rule,
  addL2Rule
};
