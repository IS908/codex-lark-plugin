import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(process.cwd(), 'docs/transition-compatibility.md'), 'utf-8');

for (const required of [
  '# Transition Compatibility Matrix',
  'Codex exec action marker protocol',
  'SDK runtime vs legacy runtime',
  'Exec delivery vs notification delivery',
  'Job JSON backfill',
  'Profile single-file migration',
  'MCP tools vs exec actions',
  'Removal Checklist',
  'Priority Order',
]) {
  assert.match(doc, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.match(doc, /LARK_CHANNEL_RUNTIME=legacy.*rejected/is);
assert.match(doc, /Rollback is package downgrade to v1\.12\.3 or earlier/);
assert.match(doc, /LARK_CODEX_DELIVERY_MODE=notification.*rejected/is);
assert.match(doc, /Rollback is package downgrade to v1\.12\.4 or earlier/);
assert.match(doc, /notifications\/Codex\/channel.*parallel delivery mode/is);
assert.match(doc, /createInitialJobRuntime\(\)/);
assert.match(doc, /job-service/);
assert.match(doc, /issue-proposal-service/);
assert.match(doc, /job-lifecycle-parity-smoke/);
assert.match(doc, /issue-proposal-lifecycle-parity-smoke/);
assert.match(doc, /job doctor/);
assert.match(doc, /profile doctor/);
assert.match(doc, /rollback path based on reinstalling a previous plugin release/);
assert.match(doc, /Already complete for job lifecycle and issue-proposal lifecycle parity/);

console.log('transition-compatibility-doc smoke: PASS');
