import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(process.cwd(), 'docs/sdk-channel-rollout.md'), 'utf-8');

for (const pattern of [
  /npm run smoke:sdk/,
  /npm start -- --dry-run/,
  /default SDK runtime/i,
  /Rollback/i,
  /LARK_CHANNEL_RUNTIME=legacy/,
  /workspace/i,
  /marketplace clone/i,
  /runtime cache/i,
  /message.*comment.*reaction/is,
  /remove the legacy path/i,
]) {
  assert.match(doc, pattern);
}

console.log('sdk-rollout-doc smoke: PASS');
