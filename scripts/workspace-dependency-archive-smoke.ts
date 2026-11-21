import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceDependencyExpansionBudget } from '../src/workspace-dependency-archive.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-archive-budget-'));
const limit = { bytes: 128 * 1024, entries: 20 };
try {
  const pkg = path.join(root, 'package');
  await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg, 'small'), Buffer.alloc(12 * 1024));
  await fs.writeFile(path.join(pkg, 'large'), Buffer.alloc(256 * 1024));
  const tar = path.join(root, 'small.tgz');
  const bigTar = path.join(root, 'big.tgz');
  const wheel = path.join(root, 'small.whl');
  const bigWheel = path.join(root, 'big.whl');
  const environment = { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' };
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', tar, '-C', root, 'package/small'], { env: environment });
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', bigTar, '-C', root, 'package/large'], { env: environment });
  execFileSync('/usr/bin/zip', ['-q', wheel, 'small'], { cwd: pkg, env: environment });
  execFileSync('/usr/bin/zip', ['-q', bigWheel, 'large'], { cwd: pkg, env: environment });
  const inspect = async (file: string, ecosystem: 'npm' | 'pip', copies = 1, budget = createWorkspaceDependencyExpansionBudget(limit)) => {
    const handle = await fs.open(file, 'r');
    try { await budget.inspect(handle, (await handle.stat()).size, ecosystem, copies); }
    finally { await handle.close(); }
  };
  for (const file of [tar, bigTar, wheel, bigWheel]) assert.ok((await fs.stat(file)).size < 4096);
  await inspect(tar, 'npm');
  await inspect(wheel, 'pip');
  await assert.rejects(inspect(bigTar, 'npm'), { code: 'dependency_archive_budget_exceeded' });
  await assert.rejects(inspect(bigWheel, 'pip'), { code: 'dependency_archive_budget_exceeded' });
  await assert.rejects(inspect(tar, 'npm', 20), { code: 'dependency_archive_budget_exceeded' });
  const budget = createWorkspaceDependencyExpansionBudget({ ...limit, entries: 2 });
  await inspect(wheel, 'pip', 1, budget);
  await assert.rejects(inspect(wheel, 'pip', 1, budget), { code: 'dependency_archive_budget_exceeded' });
  const linkTar = path.join(root, 'link.tgz');
  await fs.symlink('small', path.join(pkg, 'link'));
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', linkTar, '-C', root, 'package/link'], { env: environment });
  await assert.rejects(inspect(linkTar, 'npm'), { code: 'dependency_archive_invalid' });
  const malformed = path.join(root, 'malformed');
  await fs.writeFile(malformed, 'not an archive');
  await assert.rejects(inspect(malformed, 'npm'), { code: 'dependency_archive_invalid' });
  await assert.rejects(inspect(malformed, 'pip'), { code: 'dependency_archive_invalid' });
  console.log('workspace dependency archive smoke: PASS');
} finally { await fs.rm(root, { recursive: true, force: true }); }
