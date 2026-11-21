import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from './managed-workspace-ancestry.js';
import { validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const exec = promisify(execFile);
const bareGit = ['--bare', '--git-dir=.', '-c', 'core.warnAmbiguousRefs=false', '-c', 'core.multiPackIndex=false'];
const repositoryIdentity = z.strictObject({
  // Digest of a trusted repository identity, not a credential-bearing remote URL.
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
type RepositoryIdentity = z.infer<typeof repositoryIdentity>;
type ObjectFormat = 'sha1' | 'sha256';
type SnapshotIdentity = RepositoryIdentity & { objectFormat: ObjectFormat };

export class WorkspaceGitSnapshotError extends Error {
  constructor(readonly code: 'invalid_snapshot' | 'git_directory_not_self_contained' | 'git_commit_unavailable' | 'git_unavailable') {
    const messages = {
      invalid_snapshot: 'A Git snapshot requires a full commit ID and a valid repository scope.',
      git_directory_not_self_contained: 'The pinned Git directory is not a supported self-contained object store.',
      git_commit_unavailable: 'The exact commit is unavailable in the pinned local Git directory.',
      git_unavailable: 'A trusted local Git executable is unavailable.',
    };
    super(messages[code]);
    this.name = 'WorkspaceGitSnapshotError';
  }
}

export function gitSnapshotKey(identity: SnapshotIdentity): string {
  const { repositoryId, scope, commit, objectFormat } = identity;
  if (!repositoryIdentity.safeParse({ repositoryId, scope, commit }).success
    || (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    || commit.length !== (objectFormat === 'sha1' ? 40 : 64)) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  return createHash('sha256').update(JSON.stringify(['git-snapshot-v1', repositoryId, scope, objectFormat, commit])).digest('hex');
}

// Read-only preflight. Cache provenance and full reachable-object verification belong to the provider.
export async function inspectWorkspaceGitSnapshot(input: RepositoryIdentity & {
  gitDirectory: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
}): Promise<SnapshotIdentity & { key: string }> {
  const { repositoryId, scope, commit } = input;
  if (!repositoryIdentity.safeParse({ repositoryId, scope, commit }).success) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  const binding = await validateWorkspaceProject(input.authorizedRoots, input.gitDirectory);
  await assertProtectedWorkspacePath(binding);
  await requireSelfContainedObjectStore(binding.directory, commit);
  const executable = await trustedGitExecutable(binding.directory);

  let objectFormat: string;
  try {
    const config = (await git(executable, '/', ['--git-dir=/dev/null', 'config',
      '--file', path.join(binding.directory, 'config'), '--no-includes', '--null', '--list'])).toString('utf8');
    if (config.split('\0').some((entry) => /^(?:include(?:if)?\.|core\.worktree\b|extensions\.partialclone\b|remote\..+\.promisor\b)/i.test(entry))) {
      throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
    }
    objectFormat = (await git(executable, binding.directory, [...bareGit, 'rev-parse', '--show-object-format'])).toString('utf8').trim();
  } catch {
    throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
  }
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
  const identity = { repositoryId, scope, commit, objectFormat } satisfies SnapshotIdentity;
  const key = gitSnapshotKey(identity);
  try {
    const result = await git(executable, binding.directory,
      [...bareGit, 'cat-file', '--batch'], `${commit}\n`);
    const separator = result.indexOf(10);
    if (separator < 0) throw new WorkspaceGitSnapshotError('git_commit_unavailable');
    const [returnedId, kind, sizeText] = result.subarray(0, separator).toString('ascii').split(' ');
    const size = Number(sizeText);
    if (returnedId !== commit || kind !== 'commit' || !/^\d+$/.test(sizeText ?? '') || size !== result.length - separator - 2
      || result.at(-1) !== 10 || createHash(objectFormat).update(`commit ${size}\0`)
        .update(result.subarray(separator + 1, -1)).digest('hex') !== commit) throw new WorkspaceGitSnapshotError('git_commit_unavailable');
  } catch {
    throw new WorkspaceGitSnapshotError('git_commit_unavailable');
  }
  await validateWorkspaceProject(input.authorizedRoots, binding);
  await assertProtectedWorkspacePath(binding);
  return { ...identity, key };
}

async function requireSelfContainedObjectStore(directory: string, commit: string): Promise<void> {
  const objects = path.join(directory, 'objects');
  const info = path.join(objects, 'info');
  const pack = path.join(objects, 'pack');
  const loose = path.join(objects, commit.slice(0, 2));
  const exists = (file: string) => fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const requireStore = async () => {
    const uid = process.geteuid?.();
    if (uid === undefined) return false;
    const safeFiles: string[] = [];
    const trusted = (entry: NonNullable<Awaited<ReturnType<typeof exists>>>) =>
      (entry.uid === uid || entry.uid === 0) && (entry.mode & 0o022) === 0;
    const check = async (file: string, type: 'file' | 'directory', optional = false) => {
      const entry = await exists(file);
      if (!entry) return optional;
      if (!trusted(entry) || (type === 'file' ? !entry.isFile() : !entry.isDirectory())) return false;
      if (type === 'directory') await assertDenyOnlyWorkspaceAcls([file]);
      else safeFiles.push(file);
      return true;
    };
    for (const file of ['HEAD', 'config']) if (!await check(path.join(directory, file), 'file')) return false;
    if (!await check(path.join(directory, 'packed-refs'), 'file', true) || !await check(objects, 'directory')) return false;
    for (const child of [info, pack, loose]) {
      if (!await check(child, 'directory', true)) return false;
    }
    for (const redirected of [path.join(directory, 'commondir'), path.join(directory, 'config.worktree'),
      path.join(info, 'alternates'), path.join(info, 'http-alternates')]) {
      if (await exists(redirected)) return false;
    }
    if (!await check(path.join(loose, commit.slice(2)), 'file', true)) return false;
    if (await exists(pack)) {
      let count = 0;
      for await (const entry of await fs.opendir(pack)) {
        if (++count > 2048 || !await check(path.join(pack, entry.name), 'file')) return false;
      }
    }
    const refs = path.join(directory, 'refs');
    if (!await check(refs, 'directory', true)) return false;
    const pending = await exists(refs) ? [refs] : [];
    let refCount = 0;
    while (pending.length) {
      const root = pending.pop()!;
      for await (const entry of await fs.opendir(root)) {
        const child = path.join(root, entry.name);
        if (++refCount > 4096 || !await check(child, entry.isDirectory() ? 'directory' : 'file')) return false;
        if (entry.isDirectory()) pending.push(child);
      }
    }
    for (let index = 0; index < safeFiles.length; index += 64) {
      await assertDenyOnlyWorkspaceAcls(safeFiles.slice(index, index + 64));
    }
    return true;
  };
  if (!await requireStore().catch(() => false)) throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
}

async function trustedGitExecutable(gitDirectory: string): Promise<string> {
  const repository = path.basename(gitDirectory) === '.git' ? path.dirname(gitDirectory) : gitDirectory;
  const uid = process.geteuid?.();
  for (const directory of new Set([...(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute), '/usr/bin', '/bin'])) {
    try {
      const candidate = await fs.realpath(path.join(directory, 'git'));
      if (workspacePathContains(repository, candidate)) continue;
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) continue;
      const parent = path.dirname(candidate);
      const meta = await fs.lstat(parent, { bigint: true });
      await assertProtectedWorkspacePath({ directory: parent, device: String(meta.dev), inode: String(meta.ino) });
      await assertDenyOnlyWorkspaceAcls([candidate]);
      return candidate;
    } catch {
      // Relative entries and unprotected executables are not eligible.
    }
  }
  throw new WorkspaceGitSnapshotError('git_unavailable');
}

async function git(executable: string, cwd: string, args: string[], input?: string): Promise<Buffer> {
  const running = exec(executable, args, {
    cwd, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'buffer',
    env: {
      PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
    },
  });
  running.child.stdin?.on('error', () => {});
  running.child.stdin?.end(input);
  return (await running).stdout;
}
