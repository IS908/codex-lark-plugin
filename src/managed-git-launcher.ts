import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities,
  readWorkspaceMountTable, workspaceBackingAliases } from './managed-workspace-ancestry.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { workspacePathContains } from './workspace-projects.js';

export async function resolveManagedGitLauncher(command: string, env: NodeJS.ProcessEnv, excluded: WorkspaceProjectBinding[]) {
  const invalid = () => new ManagedWorkspaceStorageError('git_launcher_untrusted');
  if (!process.geteuid || process.getuid?.() !== process.geteuid() || (!path.isAbsolute(command) && command !== 'codex')) throw invalid();
  const uid = BigInt(process.geteuid());
  const identities = excluded.map(({ device, inode }) => `${device}:${inode}`);
  const mounts = readWorkspaceMountTable();
  const paths = excluded.flatMap(({ directory }) => workspaceBackingAliases(directory, mounts));
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
    if (!await trustedDirectory(path.dirname(file))) throw invalid();
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || ![0n, uid].includes(stat.uid) || (stat.uid !== 0n && stat.nlink !== 1n)
      || !(stat.mode & 0o111n) || (stat.mode & 0o6022n) !== 0n) throw invalid();
    await fs.access(file, fs.constants.X_OK);
    await assertDenyOnlyWorkspaceAcls([file]);
    return file;
  };
  const find = async (name: string) => {
    for (const directory of search) {
      try { return await executable(path.join(directory, name)); } catch { /* Try the next protected path. */ }
    }
    throw invalid();
  };
  // Codex also looks up Git by name. Exclude entries that could resolve that lookup to an unchecked target.
  for (let index = search.length - 1; index >= 0; index--) {
    const git = path.join(search[index], 'git');
    const exists = await fs.lstat(git).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw invalid();
    });
    if (exists) {
      try { await executable(git); } catch { search.splice(index, 1); }
    }
  }
  if (!search.length) throw invalid();
  await find('git');
  const file = path.isAbsolute(command) ? await executable(command).catch(() => { throw invalid(); }) : await find(command);
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let header: string;
  try {
    const bytes = Buffer.alloc(128);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
  } finally {
    await handle.close();
  }
  const subprocessEnv: NodeJS.ProcessEnv = { ...env, PATH: search.join(path.delimiter) };
  for (const key of Object.keys(subprocessEnv)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ZDOTDIR|DYLD_.*|LD_.*)$/.test(key)) delete subprocessEnv[key];
  }
  if (header === '#!/usr/bin/env node') return { command: await find('node'), prefix: [file], env: subprocessEnv };
  if (header.startsWith('#!')) throw invalid();
  return { command: file, prefix: [], env: subprocessEnv };
}
