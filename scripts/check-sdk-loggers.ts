/**
 * Static check: every Lark SDK object that can log to stdout must include a
 * `logger:` option in its argument block.
 *
 * Why this matters: the Lark SDK's default logger uses `console.log`, which
 * writes to stdout. The MCP server uses stdout for JSON-RPC framing, so any
 * non-JSON-RPC bytes on stdout corrupt the protocol and Codex kills
 * the plugin. Every SDK object that can log must redirect to stderr.
 *
 * Why static (not runtime): dry-run exercises the default startup path, but
 * it is easy to add a new SDK construction path later. This check keeps
 * every known SDK constructor/factory explicit about stderr logging.
 *
 * Scope limits (by design):
 *   - Only verifies the *presence* of `logger:` in the options block. A
 *     literal `logger: undefined`, `logger: null`, or `logger: somevar`
 *     (where the variable is later reassigned) all pass this check.
 *     Human review covers the "is the value actually stderr-routing?"
 *     question — the lint catches the far more common mistake of
 *     omitting the option entirely.
 *   - Scans `new Lark.<...>(` constructors and the SDK scaffold's
 *     `createLarkChannel(...)` factory. If new construction paths are added,
 *     extend this script before relying on dry-run stdout checks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const channelSrc = readFileSync(join(process.cwd(), 'src/channel.ts'), 'utf-8');
const sdkScaffoldSrc = readFileSync(join(process.cwd(), 'src/sdk-channel-scaffold.ts'), 'utf-8');

const ctors = ['Client'] as const;
const problems: string[] = [];
let totalMatches = 0;

/**
 * Given a source position at `(`, walk forward tracking paren depth and
 * return the substring spanning the constructor's argument list up to the
 * matching close-paren. This scopes the `logger:` search to THIS
 * constructor's options — not a later unrelated block.
 */
function extractArgBlock(source: string, openParenIdx: number): string | null {
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIdx, i + 1);
    }
  }
  return null; // unbalanced
}

function extractBraceBlock(source: string, openBraceIdx: number): string | null {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(openBraceIdx, i + 1);
    }
  }
  return null;
}

function lineNo(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function extractLocalFunctionBlock(source: string, functionName: string): string | null {
  const pattern = new RegExp(`\\bfunction\\s+${functionName}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, 'm');
  const found = pattern.exec(source);
  if (!found) return null;
  const braceIdx = found.index + found[0].length - 1;
  return extractBraceBlock(source, braceIdx);
}

function hasLoggerOption(source: string, argBlock: string): boolean {
  if (/\blogger:/.test(argBlock)) return true;

  const builderCall = /\b([A-Za-z_$][\w$]*)\s*\(\s*\)/.exec(argBlock);
  if (!builderCall) return false;

  const builderBlock = extractLocalFunctionBlock(source, builderCall[1]);
  return builderBlock !== null && /\blogger:/.test(builderBlock);
}

for (const ctor of ctors) {
  const pattern = new RegExp(`new Lark\\.${ctor}\\(`, 'g');
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(channelSrc)) !== null) {
    totalMatches++;
    const parenIdx = found.index + found[0].length - 1;
    const block = extractArgBlock(channelSrc, parenIdx);
    if (block === null) {
      problems.push(
        `src/channel.ts — new Lark.${ctor}( at char ${parenIdx} has unbalanced parens (cannot verify)`,
      );
      continue;
    }
    if (!hasLoggerOption(channelSrc, block)) {
      problems.push(
        `src/channel.ts:${lineNo(channelSrc, found.index)} — new Lark.${ctor}( has no 'logger:' option in its argument block (would corrupt MCP stdout)`,
      );
    }
  }
}

const sdkPattern = /\bcreateLarkChannel\(/g;
let sdkFound: RegExpExecArray | null;
while ((sdkFound = sdkPattern.exec(sdkScaffoldSrc)) !== null) {
  totalMatches++;
  const parenIdx = sdkFound.index + sdkFound[0].length - 1;
  const block = extractArgBlock(sdkScaffoldSrc, parenIdx);
  if (block === null) {
    problems.push(
      `src/sdk-channel-scaffold.ts — createLarkChannel( at char ${parenIdx} has unbalanced parens (cannot verify)`,
    );
    continue;
  }
  if (!hasLoggerOption(sdkScaffoldSrc, block)) {
    problems.push(
      `src/sdk-channel-scaffold.ts:${lineNo(sdkScaffoldSrc, sdkFound.index)} — createLarkChannel( has no 'logger:' option in its argument block (would corrupt MCP stdout)`,
    );
  }
}

if (totalMatches === 0) {
  // The plugin relies on channel.ts constructing at least one Lark SDK
  // object — if none are found, either the source moved (and this check
  // is stale) or the file really lacks them (which is a bug). Fail loudly
  // rather than silently pass.
  console.error('FAIL: no Lark SDK constructors found in src/channel.ts');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('FAIL: SDK constructor(s) missing stderr logger:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`check-sdk-loggers: ${totalMatches}/${totalMatches} SDK constructors have logger`);
