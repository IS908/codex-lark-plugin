import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(process.cwd(), 'docs/sdk-channel-rollout.md'), 'utf-8');
const migrationDoc = readFileSync(join(process.cwd(), 'docs/channel-sdk-node-migration.md'), 'utf-8');

for (const pattern of [
  /npm run smoke:sdk/,
  /npm start -- --dry-run/,
  /SDK-backed channel/i,
  /Rollback/i,
  /LARK_CHANNEL_RUNTIME=legacy.*fails startup/is,
  /LARK_CHANNEL_RUNTIME=sdk.*harmless/is,
  /v1\.12\.3.*earlier/,
  /workspace/i,
  /marketplace clone/i,
  /runtime cache/i,
  /message.*comment.*reaction/is,
  /package downgrade/i,
]) {
  assert.match(doc, pattern);
}

assert.doesNotMatch(migrationDoc, /does not currently run/i);
assert.doesNotMatch(migrationDoc, /tracked in #76/i);
assert.match(migrationDoc, /event\/cache.*bot-identity `messages\/mget`.*user-identity/is);
assert.match(migrationDoc, /LarkTransportCardContext\.fetchMessageText/);
assert.match(migrationDoc, /best-effort raw context/i);

console.log('sdk-rollout-doc smoke: PASS');
