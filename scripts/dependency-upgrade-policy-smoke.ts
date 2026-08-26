import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface PackageManifest {
  devDependencies?: Record<string, string>;
}

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
const pluginPackage = JSON.parse(readFileSync('plugins/lark/package.json', 'utf8')) as PackageManifest;
const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
const policy = readFileSync('docs/dependency-upgrades.md', 'utf8');

assert.match(dependabot, /^version:\s*2$/m);
assert.match(dependabot, /package-ecosystem:\s*"npm"/);
assert.match(dependabot, /directories:[\s\S]*-\s*"\/"[\s\S]*-\s*"\/plugins\/lark"/);
assert.match(dependabot, /interval:\s*"weekly"/);
assert.match(dependabot, /lark-sdk-stack:[\s\S]*@larksuite\/channel[\s\S]*@larksuiteoapi\/node-sdk/);
assert.match(dependabot, /schema-runtime:[\s\S]*zod/);
assert.match(dependabot, /development-tooling:[\s\S]*dependency-type:\s*"development"/);
assert.match(dependabot, /update-types:[\s\S]*"major"[\s\S]*"minor"[\s\S]*"patch"/);

assert.match(policy, /latest stable release/i);
assert.match(policy, /major release/i);
assert.match(policy, /supported Node\.js major/i);
assert.match(policy, /npm ci/);
assert.match(policy, /npm test/);
assert.match(policy, /npm run smoke:sdk/);
assert.match(policy, /npm run audit:deps/);

assert.deepEqual(
  pluginPackage.devDependencies,
  rootPackage.devDependencies,
  'root and packaged-plugin development dependencies must stay synchronized',
);
assert.match(
  rootPackage.devDependencies?.['@types/node'] ?? '',
  /^\^24\./,
  '@types/node must follow the supported Node.js 24 runtime line',
);

console.log('dependency-upgrade-policy smoke: PASS');
