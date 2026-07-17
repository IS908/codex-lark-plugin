import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  ContinuationWorkingDirectoryError,
  resolveContinuationWorkingDirectory,
  validateContinuationWorkingDirectory,
} = await import('../src/continuation/working-directory.js');

const base = await mkdtemp(path.join(tmpdir(), 'continuation-working-directory-'));
const root = path.join(base, 'authorized');
const child = path.join(root, 'repo-a');
const nested = path.join(child, 'packages', 'api');
const sibling = path.join(root, 'repo-b');
const outside = path.join(base, 'outside');
await Promise.all([
  mkdir(nested, { recursive: true }),
  mkdir(sibling, { recursive: true }),
  mkdir(outside, { recursive: true }),
]);

const rootResolution = await resolveContinuationWorkingDirectory(root, '.');
assert.equal(rootResolution.root, await realpath(root));
assert.equal(rootResolution.workingDirectory, await realpath(root));

const childResolution = await resolveContinuationWorkingDirectory(root, 'repo-a/packages/api');
assert.equal(childResolution.root, await realpath(root));
assert.equal(childResolution.workingDirectory, await realpath(nested));
assert.equal(await validateContinuationWorkingDirectory([root], nested), await realpath(nested));
assert.equal(await validateContinuationWorkingDirectory([root, child], nested), await realpath(nested));

for (const value of [outside, '../outside', 'repo-a/../../outside', 'missing']) {
  await assert.rejects(
    resolveContinuationWorkingDirectory(root, value),
    ContinuationWorkingDirectoryError,
  );
}

const file = path.join(root, 'report.txt');
await writeFile(file, 'report', 'utf-8');
await assert.rejects(
  resolveContinuationWorkingDirectory(root, 'report.txt'),
  /existing directory/i,
);

await symlink(outside, path.join(root, 'outside-link'));
await assert.rejects(
  resolveContinuationWorkingDirectory(root, 'outside-link'),
  /outside the configured continuation working root/i,
);

await assert.rejects(
  validateContinuationWorkingDirectory([child], sibling),
  /outside the configured continuation working root/i,
);

const replaceable = path.join(root, 'replaceable');
await mkdir(replaceable);
const persisted = (await resolveContinuationWorkingDirectory(root, 'replaceable')).workingDirectory;
await rm(replaceable, { recursive: true });
await symlink(outside, replaceable);
await assert.rejects(
  validateContinuationWorkingDirectory([root], persisted),
  /outside the configured continuation working root/i,
);

console.log('continuation working-directory smoke: PASS');
