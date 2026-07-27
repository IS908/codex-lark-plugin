/**
 * Configuration surface sync smoke tests.
 *
 * Keeps runtime-facing examples, docs, and configure skill guidance from
 * drifting when new LARK_* settings are added.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema, configSchemaKeys } from '../src/config-schema.js';

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function envKeys(envExample: string): string[] {
  return [...new Set([...envExample.matchAll(/\bLARK_[A-Z0-9_]+\b/g)].map((match) => match[0]))].sort();
}

function documentedDefaults(markdown: string): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\| `(?<key>LARK_[A-Z0-9_]+)` \| (?<value>[^|]+) \|/);
    if (!match?.groups) continue;
    const value = match.groups.value
      .trim()
      .replace(/^`|`$/g, '')
      .replace('（空）', '(empty)')
      .replace('系统时区', 'system timezone')
      .replaceAll('×', 'x');
    defaults.set(match.groups.key, value);
  }
  return defaults;
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

assert.match(
  rootEnv,
  /LARK_QUEUE_HANDLER_TIMEOUT_MS=.*Default: LARK_CODEX_EXEC_TIMEOUT_MS \+ 60000\./,
);
assert.match(
  rootEnv,
  /LARK_CODEX_EXEC_CWD=.*Default: ~\/\.codex\/channels\/lark\/codex-exec-workdir\./,
);

const keys = envKeys(rootEnv);
const runtimeKeys = [...new Set([...envKeys(runtimeConfig), ...envKeys(directRuntimeConfig)])].sort();
assert.deepEqual(
  configSchemaKeys,
  keys,
  'canonical config schema must represent every supported LARK_* key',
);
assert.equal(configSchema.LARK_APP_ID.required, true);
assert.equal(configSchema.LARK_APP_SECRET.required, true);
assert.equal(configSchema.LARK_APP_SECRET.sensitive, true);
assert.equal(configSchema.LARK_APP_ID.sensitive, false);
for (const key of configSchemaKeys) {
  const definition = configSchema[key];
  assert.ok(definition.description.en.trim(), `${key} is missing an English description`);
  assert.ok(definition.description.zh.trim(), `${key} is missing a Chinese description`);
  assert.ok(definition.features.length > 0, `${key} must identify at least one runtime feature`);
  if (definition.sensitive) {
    assert.ok(!('default' in definition), `${key} must not define an emit-able secret default`);
  }
  if (definition.type === 'number') {
    assert.ok(definition.number, `${key} is missing numeric validation metadata`);
  }
  if (definition.type === 'choice') {
    assert.ok(definition.choices.length > 0, `${key} is missing allowed values`);
  }
}
for (const [locale, markdown] of [['en', readme], ['zh', readmeCn]] as const) {
  const defaults = documentedDefaults(markdown);
  for (const key of configSchemaKeys) {
    const definition = configSchema[key];
    if (definition.required) continue;
    assert.equal(
      defaults.get(key),
      definition.defaultDisplay,
      `${locale} README default is stale for ${key}`,
    );
  }
}
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
