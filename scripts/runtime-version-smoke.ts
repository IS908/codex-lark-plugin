import assert from 'node:assert/strict';
import { assertSupportedNodeVersion } from '../src/runtime-version.js';

assert.doesNotThrow(() => assertSupportedNodeVersion('24.15.0'));
assert.doesNotThrow(() => assertSupportedNodeVersion('24.15.1'));
assert.doesNotThrow(() => assertSupportedNodeVersion('24.16.0'));
assert.doesNotThrow(() => assertSupportedNodeVersion('25.0.0'));
assert.doesNotThrow(() => assertSupportedNodeVersion('26.5.0'));

for (const version of ['24.14.1', '24.14.99', '23.99.99', '22.20.0', 'invalid']) {
  assert.throws(
    () => assertSupportedNodeVersion(version),
    /Node\.js >=24\.15\.0 is required/,
    `expected ${version} to be rejected`,
  );
}

console.log('runtime-version smoke: PASS');
