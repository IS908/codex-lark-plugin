/**
 * Configuration surface sync smoke tests.
 *
 * Keeps runtime-facing examples, docs, and configure skill guidance from
 * drifting when new LARK_* settings are added.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function envKeys(envExample: string): string[] {
  return [...new Set([...envExample.matchAll(/\bLARK_[A-Z0-9_]+\b/g)].map((match) => match[0]))].sort();
}

const rootEnv = read('.env.example');
const pluginEnv = read('plugins/lark/.env.example');
const rootSkill = read('skills/configure/SKILL.md');
const pluginSkill = read('plugins/lark/skills/configure/SKILL.md');
const runtimeConfig = read('src/config.ts');
const directRuntimeConfig = read('src/privacy-rules.ts');
const readme = read('README.md');
const readmeCn = read('README_CN.md');

assert.equal(pluginEnv, rootEnv, 'root and plugin .env.example files must stay identical');
assert.equal(pluginSkill, rootSkill, 'root and plugin configure skills must stay identical');

assert.match(rootEnv, /LARK_QUEUE_HANDLER_TIMEOUT_MS=660000/);
assert.match(rootEnv, /LARK_CHANNEL_RUNTIME=sdk/);
assert.match(rootEnv, /LARK_CODEX_EXEC_CWD=.*codex-exec-workdir/);

const keys = envKeys(rootEnv);
const runtimeKeys = [...new Set([...envKeys(runtimeConfig), ...envKeys(directRuntimeConfig)])].sort();
assert.deepEqual(
  keys,
  runtimeKeys,
  'every runtime LARK_* config key must be documented in .env.example',
);
for (const key of keys) {
  assert.match(rootSkill, new RegExp(`\\b${key}\\b`), `configure skill is missing ${key}`);
  assert.match(readme, new RegExp(`\\b${key}\\b`), `README.md is missing ${key}`);
  assert.match(readmeCn, new RegExp(`\\b${key}\\b`), `README_CN.md is missing ${key}`);
}

console.log(`config-surface-sync smoke: ${keys.length} keys PASS`);
