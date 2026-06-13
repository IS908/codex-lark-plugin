import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name?: unknown; version?: unknown };

if (typeof pkg.version !== 'string' || !pkg.version) {
  throw new Error('package.json version must be a non-empty string');
}

export const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : 'codex-lark-plugin';
export const packageVersion = pkg.version;
