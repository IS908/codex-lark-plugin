/**
 * Card builder smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { needsCard, shouldUseCard, buildCards } from '../src/feishu-card.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. Short plain text should NOT trigger card
if (needsCard('hello')) fail('short text triggered card');
if (shouldUseCard('hello')) fail('shouldUseCard alias triggered short text');

// 2. Rich Markdown text SHOULD trigger card
if (!needsCard('# heading\nbody')) fail('heading did not trigger card');
if (!needsCard('a\n\n```ts\nconst ok = true;\n```')) fail('code block did not trigger card');
if (!needsCard('```ts\nconst ok = true;')) fail('unclosed code fence did not trigger card');
if (!needsCard('| a | b |\n|---|---|')) fail('table did not trigger card');
if (needsCard('- only one item')) fail('single bullet should not trigger card');
if (!needsCard('- item 1\n- item 2')) fail('multi bullet list did not trigger card');
if (!needsCard('1. first\n2. second')) fail('numbered list did not trigger card');

// 3. Long structured analysis SHOULD trigger card, plain long text should not
if (needsCard('a'.repeat(501))) fail('plain long text triggered card');
if (!needsCard('建议：先分批执行。\n\n风险：波动较大。\n\n操作：挂限价。\n\n触发条件：突破后复核。')) {
  fail('structured analysis did not trigger card');
}

// 4. buildCards returns at least one card for any input
const c1 = buildCards('# Hi\nbody');
if (!Array.isArray(c1) || c1.length < 1) fail('buildCards returned empty');

// 5. buildCards handles oversized text by splitting into multiple cards
const big = '# Big\n' + 'x'.repeat(60 * 1024);
const c2 = buildCards(big);
if (c2.length < 2) fail(`oversized text did not split (got ${c2.length} cards)`);

// 6. Footer is appended as a notation-size markdown element
const c3 = buildCards('# Hi\nbody', { footer: 'note' });
const firstCard: any = c3[0];
const last = firstCard.body.elements[firstCard.body.elements.length - 1];
if (last.text_size !== 'notation' || last.content !== 'note') {
  fail(`footer not appended correctly: ${JSON.stringify(last)}`);
}

// 7. Title extracted from first H1
const c4: any = buildCards('# My Title\nbody');
if (c4[0].header.title.content !== 'My Title') fail('title extraction failed');

// 8. Fallback title when no heading
const c5: any = buildCards('just a line of text, no heading here');
const t5 = c5[0].header.title.content;
if (!t5 || t5.length === 0) fail('fallback title missing');

// 9. Code-block-safe splitting: long text with fenced code block must produce
// elements where fences stay balanced (close+reopen when split mid-block).
const bigCode = '# Long\n\n```py\n' + 'x = 1\n'.repeat(3000) + '```';
const c6: any = buildCards(bigCode);
for (const card of c6) {
  for (const el of card.body.elements) {
    if (el.tag !== 'markdown' || typeof el.content !== 'string') continue;
    const fenceCount = (el.content.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      fail(`unbalanced fences in element: ${el.content.slice(0, 100)}...`);
    }
  }
}

// 10. Unclosed code block should not throw
try {
  buildCards('# x\n```js\nfoo');
} catch (e) {
  fail(`unclosed code block threw: ${e}`);
}

// 11. Empty text falls back to '...' placeholder
const c7: any = buildCards('');
if (!c7[0] || !c7[0].body || !Array.isArray(c7[0].body.elements)) {
  fail('empty text produced invalid card');
}

// 12. Generated cards use the configured pale-red Feishu header theme.
const c8: any = buildCards('# Theme\nbody');
if (c8.some((card: any) => card.header?.template !== 'red')) {
  fail(`cards should use red header template: ${JSON.stringify(c8.map((card: any) => card.header?.template))}`);
}

// 13. Markdown tables are rendered as v2 card table elements, not only markdown.
const c9: any = buildCards([
  '# MNTN / ZS report',
  '',
  'Summary before table.',
  '',
  '| Ticker | Action | Risk |',
  '| --- | --- | --- |',
  '| MNTN | Watch | High |',
  '| ZS | Buy | Medium |',
  '',
  'Next steps after table.',
].join('\n'));
const tableElements = c9.flatMap((card: any) => card.body.elements).filter((el: any) => el.tag === 'table');
if (tableElements.length !== 1) fail(`expected one table element, got ${tableElements.length}`);
if (!Array.isArray(tableElements[0].columns) || tableElements[0].columns.length !== 3) {
  fail(`table columns not rendered: ${JSON.stringify(tableElements[0])}`);
}
if (!Array.isArray(tableElements[0].rows) || tableElements[0].rows.length !== 2) {
  fail(`table rows not rendered: ${JSON.stringify(tableElements[0])}`);
}

console.log('PASS');
