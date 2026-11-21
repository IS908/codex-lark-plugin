import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SqliteDurableRunRepository } from '../../src/durable-run/sqlite-repository.js';
import { prepareWorkspacePipLock } from '../../src/workspace-dependency-input.js';
import type { probeWorkspaceDependencyToolchain } from '../../src/workspace-dependency-toolchain.js';
import { readWorkspaceGitCacheIdentity } from '../../src/workspace-git-snapshot.js';
import { pinWorkspacePath } from '../../src/workspace-projects.js';
import { pipFixture } from '../workspace-dependency-install-fixture.js';
import { checkManagedGitEntrypoints } from './managed-git-entrypoints.js';

export async function checkManagedDependencyEntrypoints(fixture: string, command: string,
  tool: Awaited<ReturnType<typeof probeWorkspaceDependencyToolchain>>): Promise<void> {
  const parent = path.join(fixture, 'dependency-entrypoints');
  const base = path.join(parent, 'workspace');
  const source = path.join(base, 'source');
  const bare = path.join(base, 'git-cache');
  const pack = path.join(bare, 'objects', 'pack');
  const wheelhouse = path.join(base, 'wheelhouse');
  const scratch = path.join(base, 'scratch');
  const artifacts = path.join(base, 'artifacts');
  const codexHome = path.join(parent, 'codex-home');
  for (const directory of [pack, path.join(bare, 'refs'), scratch, artifacts, codexHome]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const [input, manifest] = await pipFixture(base, wheelhouse, tool.toolchain);
  const { identity, artifactManifestSha256 } = prepareWorkspacePipLock(input, manifest);
  const gitCommand = (args: string[], stdin?: string) => execFileSync('git', args, { input: stdin, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  gitCommand(['init', '-q', '--object-format=sha1', source]);
  await fs.writeFile(path.join(source, 'requirements.lock'), input.lock);
  gitCommand(['-C', source, 'add', 'requirements.lock']);
  gitCommand(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = gitCommand(['-C', source, 'rev-parse', 'HEAD']);
  await fs.writeFile(path.join(bare, 'HEAD'), `${commit}\n`);
  await fs.writeFile(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  gitCommand(['-C', source, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(pack, 'pack')], `${commit}\n`);
  const authorizedRoots = [base] as const;
  const cache = await pinWorkspacePath(base, bare);
  const repositoryId = 'e'.repeat(64);
  const git = { cache, ...await readWorkspaceGitCacheIdentity({ gitDirectory: cache, authorizedRoots, commit, repositoryId, scope: input.scope }) };
  const project = await pinWorkspacePath(base, source);
  const roots = { scratch: await pinWorkspacePath(base, scratch), artifacts: await pinWorkspacePath(base, artifacts) };
  const artifactsCache = await pinWorkspacePath(base, wheelhouse);
  const repository = await SqliteDurableRunRepository.open({ databasePath: path.join(base, 'foreground-state', 'entrypoints.sqlite') });
  try {
    await checkManagedGitEntrypoints({ base, project, roots, git, codexHome, store: repository.getManagedWorkspaceStore(),
      dependency: { command, repository, key: identity.key, provision: async (operator) => {
        const manifests = path.join(operator, 'workspace-dependency-manifests');
        await fs.mkdir(manifests, { mode: 0o700 });
        await fs.writeFile(path.join(manifests, `${identity.key}.json`), JSON.stringify(manifest), { mode: 0o600 });
        const registry = path.join(operator, 'workspace-dependencies.json');
        const projects = [{ source: project, repositoryId, policies: [{ ecosystem: 'pip' }] }];
        const write = (enabled: boolean) => fs.writeFile(registry, JSON.stringify({ version: 1, projects: enabled ? projects : [],
          caches: [{ ecosystem: 'pip', scope: input.scope, key: identity.key, cache: artifactsCache, artifactManifestSha256 }],
          toolchains: [tool.configured] }), { mode: 0o600 });
        await write(true);
        return write;
      }, verify: (directory, cwd) => {
        const env: NodeJS.ProcessEnv = { PYTHONPATH: directory };
        if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(tool.configured.runtime.directory, 'lib');
        assert.equal(execFileSync(tool.configured.executable, ['-SB', '-c', 'import lark_fixture; print(lark_fixture.VALUE)'],
          { cwd, env, encoding: 'utf8' }).trim(), 'lark fixture');
      } },
    });
  } finally { repository.close(); }
  console.log('workspace dependency entrypoints: foreground, prompt Cron and Async Task loaded verified per-run outputs');
}
