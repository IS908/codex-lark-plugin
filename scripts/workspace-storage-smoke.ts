import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventoryWorkspaceStorage } from '../src/workspace-storage.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'lark-workspace-storage-'));
try {
  const root = path.join(temp, 'workspace');
  const outside = path.join(temp, 'outside');
  const project = path.join(root, 'project');
  await mkdir(path.join(project, '.git'), { recursive: true });
  await mkdir(path.join(project, 'node_modules', 'example'), { recursive: true });
  await mkdir(path.join(root, '.lark-actions'));
  await mkdir(outside);
  await writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(project, 'node_modules', 'example', 'index.js'), 'x'.repeat(4096));
  await writeFile(path.join(root, 'report.txt'), 'retained');
  await link(path.join(root, 'report.txt'), path.join(root, 'report-copy.txt'));
  await writeFile(path.join(outside, 'outside-only.bin'), Buffer.alloc(128 * 1024));
  await symlink(outside, path.join(root, 'outside-link'), 'dir');

  const roots = [
    { role: 'exec', directory: root },
    { role: 'continuation', directory: path.join(root, '.') },
  ] as const;
  const [report] = await inventoryWorkspaceStorage(roots);
  assert.deepEqual(report.roles, ['exec', 'continuation']);
  assert.equal(report.status, 'complete');
  assert.ok(report.categories.dependencies.apparentBytes >= 4096);
  assert.ok(report.categories.gitMetadata.apparentBytes > 0);
  assert.ok(report.categories.runtimeControl.entries > 0);
  assert.equal(report.categories.links.entries, 1);
  assert.equal(report.categories.other.apparentBytes, 'retained'.length);
  assert.ok(report.total.apparentBytes < 128 * 1024, 'must not traverse the external link');
  assert.equal(report.duplicateHardLinks, 1);
  assert.equal(report.largestEntries[0]?.path, 'project');
  assert.match(await readFile(path.join(project, '.git', 'HEAD'), 'utf8'), /^ref:/);

  const [truncated] = await inventoryWorkspaceStorage(roots, { maxEntries: 3 });
  assert.equal(truncated.status, 'partial');
  assert.ok(truncated.issues.some(({ reason }) => reason === 'entry_limit'));
  const [missing] = await inventoryWorkspaceStorage([{ role: 'exec', directory: path.join(temp, 'missing') }]);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.total, null);
  const [tooDeep] = await inventoryWorkspaceStorage(roots, { maxDepth: 1 });
  assert.equal(tooDeep.status, 'partial');
  assert.ok(tooDeep.issues.some(({ reason }) => reason === 'depth_limit'));

  const configDir = path.join(temp, '.codex', 'channels', 'lark');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, '.env'), [
    `LARK_CODEX_EXEC_CWD=${root}`,
    `LARK_CONTINUATION_WORKING_ROOT=${root}`,
    'LARK_APP_ID=cli_do_not_print',
    'LARK_APP_SECRET=never_print_workspace_inventory_secret',
  ].join('\n'));
  const cli = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/configure-doctor-cli.ts', '--workspace-storage', '--json',
  ], { env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp }, encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  const decoded = JSON.parse(cli.stdout);
  assert.equal(decoded.readOnly, true);
  assert.equal(decoded.roots.length, 1);
  assert.deepEqual(decoded.roots[0].roles, ['exec', 'continuation']);
  assert.doesNotMatch(cli.stdout, /never_print_workspace_inventory_secret|cli_do_not_print/);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('workspace-storage smoke: PASS');
