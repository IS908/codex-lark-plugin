import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities,
  readWorkspaceMountTable, workspaceBackingAliases, workspaceMountLayoutSupported } from './managed-workspace-ancestry.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { workspacePathContains } from './workspace-projects.js';

const systemPath = '/usr/bin:/bin';

export function nativeCodexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || path.join(env.HOME || os.homedir(), '.codex');
}

export async function assertCompatibleCodexLayers(env: NodeJS.ProcessEnv, workspaces: string[]): Promise<void> {
  const unsupported = () => new ManagedWorkspaceStorageError('git_sandbox_layers_unsupported');
  const exists = async (target: string) => fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw unsupported();
  });
  const rejectRules = async (root: string) => {
    const folder = path.join(root, 'rules');
    if (!await exists(folder)) return;
    try {
      for await (const entry of await fs.opendir(folder)) if (entry.name.endsWith('.rules')) throw unsupported();
    } catch { throw unsupported(); }
  };
  const home = nativeCodexHome(env);
  if (!path.isAbsolute(home)) throw unsupported();
  await rejectRules(home);
  if (await exists(path.join(home, 'hooks.json'))) throw unsupported();
  for (const name of ['config.toml', 'managed_config.toml', 'requirements.toml', 'hooks.json']) {
    if (await exists(path.join('/etc/codex', name))) throw unsupported();
  }
  await rejectRules('/etc/codex');
  const inspected = new Set<string>();
  for (const workspace of workspaces) {
    for (let directory = workspace; !inspected.has(directory); directory = path.dirname(directory)) {
      inspected.add(directory);
      const local = path.join(directory, '.codex');
      if (await exists(path.join(local, 'config.toml')) || await exists(path.join(local, 'hooks.json'))) throw unsupported();
      await rejectRules(local);
    }
  }
}

async function assertSystemDirectory(directory: string): Promise<void> {
  const parent = await fs.lstat(directory, { bigint: true });
  if (parent.uid !== 0n) throw new ManagedWorkspaceStorageError('git_launcher_untrusted');
  await assertProtectedWorkspacePath({ directory, device: String(parent.dev), inode: String(parent.ino) });
}

export async function resolveSystemGit(): Promise<string> {
  const file = await fs.realpath('/usr/bin/git');
  const directory = path.dirname(file);
  const stat = await fs.lstat(file, { bigint: true });
  if (stat.uid !== 0n || !stat.isFile() || (stat.mode & 0o6022n) !== 0n
    || !workspaceMountLayoutSupported([file], readWorkspaceMountTable())) {
    throw new ManagedWorkspaceStorageError('git_launcher_untrusted');
  }
  await assertSystemDirectory(directory);
  await fs.access(file, fs.constants.X_OK);
  await assertDenyOnlyWorkspaceAcls([file]);
  return file;
}

export async function resolveManagedGitLauncher(command: string, env: NodeJS.ProcessEnv, excluded: WorkspaceProjectBinding[],
  executionRoots: readonly string[] = []) {
  const invalid = () => new ManagedWorkspaceStorageError('git_launcher_untrusted');
  if (!process.geteuid || process.getuid?.() !== process.geteuid() || (!path.isAbsolute(command) && command !== 'codex')) throw invalid();
  const uid = BigInt(process.geteuid());
  const identities = excluded.map(({ device, inode }) => `${device}:${inode}`);
  const mounts = readWorkspaceMountTable();
  const canonicalRoots = await Promise.all(executionRoots.map((root) => fs.realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path.resolve(root);
    throw invalid();
  })));
  const paths = [...excluded.map(({ directory }) => directory), ...canonicalRoots].flatMap((root) => workspaceBackingAliases(root, mounts));
  const trustedDirectory = async (directory: string) => {
    if (workspaceBackingAliases(directory, mounts).some((alias) => paths.some((blocked) => workspacePathContains(blocked, alias)))) return false;
    const stat = await fs.lstat(directory, { bigint: true });
    await assertProtectedWorkspacePath({ directory, device: String(stat.dev), inode: String(stat.ino) });
    const ancestors = await readWorkspaceAncestorIdentities(directory);
    return identities.every((identity) => !ancestors.has(identity));
  };
  const search: string[] = [];
  for (const entry of (env.PATH ?? '/usr/bin:/bin').split(path.delimiter).filter(path.isAbsolute)) {
    try {
      const directory = await fs.realpath(entry);
      if (!directory.includes(path.delimiter) && await trustedDirectory(directory) && !search.includes(directory)) search.push(directory);
    } catch { /* Unavailable or unprotected directory. */ }
  }
  const executable = async (candidate: string) => {
    const file = await fs.realpath(candidate);
    if (!await trustedDirectory(path.dirname(file)) || !workspaceMountLayoutSupported([file], mounts)) throw invalid();
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || ![0n, uid].includes(stat.uid) || (stat.uid !== 0n && stat.nlink !== 1n)
      || !(stat.mode & 0o111n) || (stat.mode & 0o6022n) !== 0n) throw invalid();
    await fs.access(file, fs.constants.X_OK);
    await assertDenyOnlyWorkspaceAcls([file]);
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const bytes = Buffer.alloc(4);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const magic = bytes.toString('hex');
      const native = process.platform === 'linux' ? magic === '7f454c46'
        : process.platform === 'darwin' && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'].includes(magic);
      if (bytesRead !== bytes.length || !native) throw invalid();
    } finally {
      await handle.close();
    }
    return file;
  };
  const find = async (name: string) => {
    for (const directory of search) {
      try { return await executable(path.join(directory, name)); } catch { /* Try the next protected path. */ }
    }
    throw invalid();
  };
  for (const directory of systemPath.split(':')) {
    await assertSystemDirectory(await fs.realpath(directory)).catch(() => { throw invalid(); });
  }
  await resolveSystemGit().catch(() => { throw invalid(); });
  const file = path.isAbsolute(command) ? await executable(command).catch(() => { throw invalid(); }) : await find(command);
  const bin = path.dirname(file);
  const packageDir = path.dirname(bin);
  const bundledPath = path.join(packageDir, 'codex-path');
  try {
    const present = await fs.lstat(bundledPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!present && process.platform === 'linux') throw invalid();
    if (present) {
      if (bundledPath.includes(path.delimiter) || !present.isDirectory()
        || await fs.realpath(bundledPath) !== bundledPath || !await trustedDirectory(bundledPath)) throw invalid();
      const rg = path.join(bundledPath, 'rg');
      const files = await fs.readdir(bundledPath);
      // Codex prepends its package's PATH directory. Only the shipped ripgrep is expected there.
      if (files.length !== 1 || files[0] !== 'rg' || await executable(rg) !== rg) throw invalid();
    }
  } catch { throw invalid(); }
  if (process.platform === 'linux') {
    try {
      const manifest = path.join(packageDir, 'codex-package.json');
      const meta = await fs.lstat(manifest, { bigint: true });
      if (path.basename(bin) !== 'bin' || path.basename(file) !== 'codex' || !await trustedDirectory(packageDir)
        || !meta.isFile() || ![0n, uid].includes(meta.uid) || meta.nlink !== 1n || (meta.mode & 0o022n) !== 0n
        || meta.size > 16_384n) throw invalid();
      const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
      if (metadata?.layoutVersion !== 1 || metadata.version !== '0.171.0' || metadata.variant !== 'codex'
        || metadata.entrypoint !== 'bin/codex' || metadata.resourcesDir !== 'codex-resources' || metadata.pathDir !== 'codex-path') throw invalid();
      // Require the preferred helper so Codex never needs to search legacy or build-tree locations.
      const resources = path.join(packageDir, 'codex-resources');
      const bundled = path.join(resources, 'bwrap');
      if (await executable(bundled) !== bundled) throw invalid();
      for (const candidate of systemPath.split(':').map((directory) => path.join(directory, 'bwrap'))) {
        const system = await fs.realpath(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!system) continue;
        const helper = await fs.lstat(system, { bigint: true });
        if (helper.uid !== 0n || !helper.isFile() || (helper.mode & 0o022n) !== 0n
          || !workspaceMountLayoutSupported([system], mounts)) throw invalid();
        await assertSystemDirectory(path.dirname(system));
      }
    } catch { throw invalid(); }
  }
  const subprocessEnv: NodeJS.ProcessEnv = { ...env, PATH: systemPath, SHELL: '/bin/sh' };
  for (const key of Object.keys(subprocessEnv)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|DYLD_.*|LD_.*|CODEX_BWRAP_.*|RUNFILES.*|TEST_SRCDIR)$/.test(key)) delete subprocessEnv[key];
  }
  return { command: file, prefix: [], env: subprocessEnv };
}
