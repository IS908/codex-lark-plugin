import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(process.cwd(), 'docs/sdk-channel-rollout.md'), 'utf-8');

for (const pattern of [
  /npm run smoke:sdk/,
  /npm start -- --dry-run/,
  /LARK_CHANNEL_RUNTIME=sdk/,
  /Rollback/i,
  /workspace/i,
  /marketplace clone/i,
  /runtime cache/i,
  /make the SDK path the default/i,
  /remove the legacy path/i,
]) {
  assert.match(doc, pattern);
}

console.log('sdk-rollout-doc smoke: PASS');
