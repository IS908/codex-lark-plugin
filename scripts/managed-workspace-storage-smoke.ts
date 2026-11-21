import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import {
  allocateManagedRunDirectories,
  readManagedWorkspaceRoots,
  validateManagedRunDirectory,
} from '../src/managed-workspace-storage.js';
import { mkdirInsidePinnedRoot } from '../src/managed-workspace-mkdir.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-managed-workspace-'));
try {
  const base = await fs.realpath(fixture);
  const allowed = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  const source = path.join(allowed, 'source');
  const scratch = path.join(allowed, 'runs');
  const artifacts = path.join(allowed, 'artifacts');
  for (const directory of [source, scratch, artifacts, outside]) {
    await fs.mkdir(directory, { recursive: true });
  }
  const configPath = path.join(base, 'workspace.json');
  const opts = { configPath, authorizedRoots: [allowed] as const, project: await pinWorkspacePath(allowed, source) };
  const configure = (scratchRoot: string, artifactRoot: string) => fs.writeFile(configPath,
    JSON.stringify({ version: 1, scratchRoot, artifactRoot }));
  assert.equal(await readManagedWorkspaceRoots(opts), undefined);
  await configure(scratch, outside);
  await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'outside_authorized_root' });
  await configure(scratch, scratch);
  await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'overlapping_roots' });
  await configure(scratch, source);
  await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'overlapping_roots' });
  await configure(artifacts, scratch);
  await fs.symlink(outside, path.join(allowed, 'escaped'), 'dir');
  await configure(scratch, path.join(allowed, 'escaped'));
  await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'outside_authorized_root' });
  await configure(scratch, artifacts);
  const roots = await readManagedWorkspaceRoots(opts);
  assert.ok(roots);

  await fs.chmod(scratch, 0o777);
  await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'unprotected_root' });
  await fs.chmod(scratch, 0o700);

  const aliasedSource = path.join(allowed, 'source-mount');
  const aliasedChild = path.join(aliasedSource, 'nested');
  await fs.mkdir(aliasedChild, { recursive: true });
  const stat = fs.stat.bind(fs);
  const sourceStat = await stat(source, { bigint: true });
  const alias = mock.method(fs, 'stat', (...args: Parameters<typeof stat>) =>
    args[0] === aliasedSource ? Promise.resolve(sourceStat) : stat(...args));
  try {
    await configure(aliasedChild, artifacts);
    await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'overlapping_roots' });
    await configure(aliasedSource, artifacts);
    await assert.rejects(readManagedWorkspaceRoots(opts), { code: 'overlapping_roots' });
  } finally {
    alias.mock.restore();
  }

  const heldParent = path.join(allowed, 'protected');
  await fs.mkdir(heldParent, { mode: 0o700 });
  const held = await pinWorkspacePath(allowed, heldParent);
  await fs.rename(heldParent, path.join(allowed, 'displaced'));
  await fs.mkdir(heldParent, { mode: 0o700 });
  await assert.rejects(mkdirInsidePinnedRoot(held, `cron_prompt-${'a'.repeat(64)}`), { code: 'directory_changed' });
  assert.deepEqual(await fs.readdir(heldParent), []);

  const allocate = (id: string) => allocateManagedRunDirectories({
    roots, authorizedRoots: opts.authorizedRoots,
    owner: { kind: 'cron_prompt', runId: id },
    project: opts.project, createdAt: '2026-11-21T12:00:00.000Z',
  });
  const [first, second] = await Promise.all([allocate('cron_run_1'), allocate('cron_run_2')]);
  assert.notEqual(first.scratch.directory, second.scratch.directory);
  assert.notEqual(first.artifacts.directory, first.scratch.directory);
  assert.deepEqual(first.project, opts.project);
  assert.equal(first.createdAt, '2026-11-21T12:00:00.000Z');
  await assert.rejects(allocate('cron_run_1'), { code: 'allocation_conflict' });

  const reopened = JSON.parse(JSON.stringify(first));
  await configure(artifacts, scratch);
  assert.equal(await validateManagedRunDirectory(reopened, 'scratch', opts.authorizedRoots), first.scratch.directory);
  await fs.writeFile(path.join(first.artifacts.directory, 'report.txt'), 'report');
  await fs.rename(first.scratch.directory, path.join(scratch, 'relocated'));
  await assert.rejects(validateManagedRunDirectory(reopened, 'scratch', opts.authorizedRoots), { code: 'unavailable_directory' });
  const formal = await validateManagedRunDirectory(reopened, 'artifacts', opts.authorizedRoots);
  assert.equal(await fs.readFile(path.join(formal, 'report.txt'), 'utf8'), 'report');
  await fs.symlink(second.scratch.directory, first.scratch.directory, 'dir');
  await assert.rejects(validateManagedRunDirectory(reopened, 'scratch', opts.authorizedRoots), { code: 'directory_changed' });
  await assert.rejects(validateManagedRunDirectory(reopened, 'artifacts', [source]), { code: 'outside_authorized_root' });
  await assert.rejects(validateManagedRunDirectory({ ...reopened, artifacts: second.artifacts }, 'artifacts', opts.authorizedRoots),
    { code: 'invalid_binding' });
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
