import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifests = ['package.json', 'plugins/lark/package.json'];
const startupLifecycleScripts = ['prestart', 'start', 'poststart'];

for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  for (const scriptName of startupLifecycleScripts) {
    const command = scripts[scriptName];
    if (!command) continue;

    assert.doesNotMatch(
      command,
      /\bnpm\s+(?:i|install)\b/,
      `${manifestPath} ${scriptName} must not install dependencies during startup`,
    );
  }
}

console.log('startup-no-install smoke: PASS');
