import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface PackageManifest {
  overrides?: Record<string, unknown>;
}

interface PackageLock {
  packages?: Record<string, { version?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function isAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  if (
    actualParts.length !== 3 ||
    minimumParts.length !== 3 ||
    [...actualParts, ...minimumParts].some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return false;
  }
  for (let index = 0; index < 3; index++) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

const rootPackage = readJson<PackageManifest>('package.json');
const pluginPackage = readJson<PackageManifest>('plugins/lark/package.json');
const rootLock = readJson<PackageLock>('package-lock.json');
const pluginLock = readJson<PackageLock>('plugins/lark/package-lock.json');

assert.deepEqual(
  pluginPackage.overrides,
  rootPackage.overrides,
  'root and packaged-plugin dependency overrides must stay synchronized',
);
assert.equal(rootPackage.overrides?.['fast-uri'], undefined, 'fast-uri must use the SDK-compatible patched range');
assert.equal(rootPackage.overrides?.hono, undefined, 'hono must use the SDK-compatible patched range');
assert.equal(rootPackage.overrides?.['ip-address'], undefined, 'ip-address override must remain dependency-scoped');
const rateLimitOverride = rootPackage.overrides?.['express-rate-limit'];
assert.ok(rateLimitOverride && typeof rateLimitOverride === 'object');
const overriddenIpAddress = (rateLimitOverride as Record<string, unknown>)['ip-address'];
assert.equal(typeof overriddenIpAddress, 'string');
assert.ok(isAtLeast(overriddenIpAddress as string, '10.4.0'));

for (const [name, minimumVersion] of [
  ['fast-uri', '3.1.5'],
  ['hono', '4.12.34'],
  ['ip-address', '10.4.0'],
] as const) {
  const key = `node_modules/${name}`;
  const rootVersion = rootLock.packages?.[key]?.version;
  const pluginVersion = pluginLock.packages?.[key]?.version;
  assert.ok(rootVersion, `root lockfile is missing ${name}`);
  assert.equal(
    pluginVersion,
    rootVersion,
    `root and packaged-plugin lockfiles resolve different ${name} versions`,
  );
  assert.ok(isAtLeast(rootVersion, minimumVersion), `${name}@${rootVersion} is below ${minimumVersion}`);
}

console.log('dependency-security smoke: PASS');
