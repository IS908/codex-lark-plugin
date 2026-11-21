import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readWorkspaceProjectSelector,
  resolveWorkspaceProject,
  WorkspaceProjectError,
} from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-projects-'));
try {
  const authorizedRoot = path.join(fixture, 'authorized');
  const first = path.join(authorizedRoot, 'first');
  const second = path.join(authorizedRoot, 'second');
  const outside = path.join(fixture, 'authorized-other');
  const firstApp = path.join(first, 'app');
  const secondApp = path.join(second, 'app');
  for (const directory of [firstApp, secondApp, outside]) {
    await fs.mkdir(directory, { recursive: true });
  }
  const registryPath = path.join(fixture, 'projects.json');
  const opts = { authorizedRoot, registryPath };
  const registry = {
    version: 1,
    roots: [{ name: 'first', path: first }, { name: 'second', path: second }, { name: 'outside', path: outside }],
    projects: [
      { root: 'first', name: 'app', path: 'app' },
      { root: 'second', name: 'app', path: 'app' },
      { root: 'outside', name: 'foreign', path: '.' },
      { root: 'first', name: 'missing', path: 'missing' },
    ],
    default: 'second/app',
  };
  const configure = (value: unknown = registry) => fs.writeFile(registryPath, JSON.stringify(value));
  const rejects = (args: Parameters<typeof resolveWorkspaceProject>[0], code: string) =>
    assert.rejects(resolveWorkspaceProject(args), (err) =>
      err instanceof WorkspaceProjectError && err.code === code && !err.message.includes(fixture));

  assert.equal(await resolveWorkspaceProject({ ...opts, authorizedRoot: 'unused' }), undefined);
  await configure();
  const selected = await resolveWorkspaceProject({ ...opts, selector: 'first/app' });
  assert.ok(selected);
  assert.equal(selected.directory, await fs.realpath(firstApp));
  assert.equal((await resolveWorkspaceProject(opts))?.directory, await fs.realpath(secondApp));
  assert.deepEqual(await resolveWorkspaceProject({ ...opts, persisted: selected }), selected);
  assert.equal((await resolveWorkspaceProject({
    ...opts, persisted: selected, selector: 'path:second/app',
  }))?.directory, await fs.realpath(secondApp));
  await rejects({ ...opts, selector: 'app', persisted: selected }, 'ambiguous_project');
  await rejects({ ...opts, selector: 'unknown', persisted: selected }, 'unknown_project');
  await rejects({ ...opts, selector: '' }, 'invalid_selector');
  await rejects({ ...opts, selector: 'outside/foreign' }, 'outside_authorized_root');
  await rejects({ ...opts, selector: `path:${outside}` }, 'outside_authorized_root');
  await rejects({ ...opts, selector: 'first/missing' }, 'unavailable_directory');
  await rejects({ ...opts, persisted: null }, 'invalid_binding');
  await rejects({ ...opts, authorizedRoot: second, persisted: selected }, 'outside_authorized_root');

  await fs.symlink(secondApp, path.join(first, 'escape'), 'dir');
  await configure({ ...registry, projects: [...registry.projects, { root: 'first', name: 'escape', path: 'escape' }] });
  await rejects({ ...opts, selector: 'first/escape' }, 'outside_project_root');
  await configure({ ...registry, projects: [...registry.projects, registry.projects[0]] });
  await rejects(opts, 'invalid_registry');
  await configure({ ...registry, roots: [...registry.roots, registry.roots[0]] });
  await rejects(opts, 'invalid_registry');

  await configure({ ...registry, projects: [{ root: 'second', name: 'app', path: 'app' }] });
  assert.deepEqual(await resolveWorkspaceProject({ ...opts, persisted: JSON.parse(JSON.stringify(selected)) }), selected);
  await fs.rename(firstApp, path.join(first, 'original'));
  await fs.symlink(secondApp, firstApp, 'dir');
  await rejects({ ...opts, persisted: selected }, 'directory_changed');
  await fs.unlink(firstApp);
  await fs.mkdir(firstApp);
  await rejects({ ...opts, persisted: selected }, 'directory_changed');

  assert.equal(readWorkspaceProjectSelector('普通问题\n/project first/app'), undefined);
  assert.equal(readWorkspaceProjectSelector('> /project first/app'), undefined);
  assert.equal(readWorkspaceProjectSelector('/projectile'), undefined);
  assert.equal(readWorkspaceProjectSelector('@_user_1 /project first/app\nTask'), 'first/app');
  assert.equal(readWorkspaceProjectSelector('/project first/app\n继续处理'), 'first/app');
  assert.equal(readWorkspaceProjectSelector('/project path:dir with spaces\r\nTask'), 'path:dir with spaces');
  assert.throws(() => readWorkspaceProjectSelector('/project\nTask'), WorkspaceProjectError);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
