import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const errors = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf-8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function checkEqual(label, actual, expected) {
  try {
    assert.equal(actual, expected);
  } catch {
    errors.push(`${label}: expected ${expected}, got ${actual ?? '<missing>'}`);
  }
}

function checkReadmeBadge(file, version) {
  const text = read(file);
  const match = text.match(/badge\/version-([^-]+)-informational/);
  if (!match) {
    errors.push(`${file}: missing version badge`);
    return;
  }
  checkEqual(`${file} version badge`, match[1], version);
}

function checkIndexUsesPackageVersion(file) {
  const text = read(file);
  if (!text.includes('packageVersion')) {
    errors.push(`${file}: MCP server metadata must use packageVersion`);
  }
  if (/version:\s*['"]\d+\.\d+\.\d+['"]/.test(text)) {
    errors.push(`${file}: MCP server metadata must not hardcode a semver string`);
  }
}

const pkg = readJson('package.json');
const version = pkg.version;

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  errors.push(`package.json: invalid semver-like version ${version ?? '<missing>'}`);
}

checkEqual('package-lock root package version', readJson('package-lock.json').packages?.['']?.version, version);
checkEqual('.codex-plugin/plugin.json version', readJson('.codex-plugin/plugin.json').version, version);
checkEqual('plugins/lark/package.json version', readJson('plugins/lark/package.json').version, version);
checkEqual(
  'plugins/lark/package-lock root package version',
  readJson('plugins/lark/package-lock.json').packages?.['']?.version,
  version,
);
checkEqual(
  'plugins/lark/.codex-plugin/plugin.json version',
  readJson('plugins/lark/.codex-plugin/plugin.json').version,
  version,
);

checkReadmeBadge('README.md', version);
checkReadmeBadge('README_CN.md', version);
checkIndexUsesPackageVersion('src/index.ts');
checkIndexUsesPackageVersion('plugins/lark/src/index.ts');

if (!read('CHANGELOG.md').includes(`## [${version}]`)) {
  errors.push(`CHANGELOG.md: missing release heading for ${version}`);
}

if (errors.length) {
  console.error('Release version check failed:');
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.error(`release version check ok: ${version}`);
