import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as installer from '../src/workspace-dependency-install.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-publication-')));
try {
  const nonce = 'a'.repeat(24);
  const scratch = await pinWorkspacePath(fixture, '.');
  const checkoutPath = path.join(fixture, 'git-checkout');
  const existing = path.join(checkoutPath, 'node_modules');
  await fs.mkdir(existing, { recursive: true, mode: 0o700 });
  const checkout = await pinWorkspacePath(fixture, checkoutPath);
  const staging = path.join(fixture, `lark-dependency-install-${nonce}`);
  const proposed = path.join(staging, 'node_modules');
  const leaf = path.join(proposed, 'lark-publish', 'index.js');
  await fs.mkdir(path.dirname(leaf), { recursive: true, mode: 0o700 });
  await fs.writeFile(leaf, 'module.exports = 42;');
  const output = await pinWorkspacePath(fixture, proposed);
  const receipt = { output, measurement: await installer.measureWorkspaceDependencyOutput(output, 'npm') };
  const request = { scratch, checkout, ecosystem: 'npm', nonce, receipt } as const;
  const unowned = await fs.stat(existing, { bigint: true });
  await assert.rejects(installer.publishWorkspaceDependencyOutput(request), { code: 'dependency_install_output_conflict' });
  assert.equal((await fs.stat(existing, { bigint: true })).ino, unowned.ino, 'even an empty unowned directory is not replaced');
  await fs.rmdir(existing);
  await installer.publishWorkspaceDependencyOutput(request);
  assert.equal(await fs.realpath(existing), output.directory);
  assert.equal(execFileSync(process.execPath, ['-p', "require('lark-publish')"], { cwd: checkoutPath, env: {}, encoding: 'utf8' }).trim(), '42');
  await installer.validatePublishedWorkspaceDependencyOutput(request);
  await assert.rejects(installer.publishWorkspaceDependencyOutput(request), { code: 'dependency_install_output_conflict' });
  await fs.writeFile(leaf, 'module.exports = 44;');
  await assert.rejects(installer.validatePublishedWorkspaceDependencyOutput(request), { code: 'dependency_installed_output_invalid' });
  await fs.writeFile(leaf, 'module.exports = 42;');
  await fs.unlink(existing);
  await fs.mkdir(existing, { mode: 0o700 });
  await assert.rejects(installer.validatePublishedWorkspaceDependencyOutput(request), { code: 'dependency_installed_output_invalid' });
  await fs.rmdir(existing);
  await fs.symlink(path.relative(checkoutPath, proposed), existing, 'dir');
  await fs.rename(staging, `${staging}-old`);
  await fs.cp(`${staging}-old`, staging, { recursive: true });
  await assert.rejects(installer.validatePublishedWorkspaceDependencyOutput(request), { code: 'dependency_installed_output_invalid' });

  const pipNonce = 'b'.repeat(24);
  const pipDir = path.join(fixture, `lark-dependency-install-${pipNonce}`, 'python-deps');
  await fs.mkdir(pipDir, { recursive: true, mode: 0o700 });
  const pipOutput = await pinWorkspacePath(fixture, pipDir);
  const pip = { scratch, checkout, ecosystem: 'pip', nonce: pipNonce, receipt: {
    output: pipOutput, measurement: await installer.measureWorkspaceDependencyOutput(pipOutput, 'pip'),
  } } as const;
  await installer.publishWorkspaceDependencyOutput(pip);
  await installer.validatePublishedWorkspaceDependencyOutput(pip);
  await assert.rejects(installer.publishWorkspaceDependencyOutput({ ...pip, nonce }), { code: 'dependency_installed_output_invalid' });
  console.log('workspace dependency output publication: PASS');
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
