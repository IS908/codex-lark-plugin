import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from './managed-workspace-ancestry.js';
import { validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const exec = promisify(execFile);
const bareGit = ['--bare', '--git-dir=.', '-c', 'core.warnAmbiguousRefs=false', '-c', 'core.multiPackIndex=false'];
const cacheGit = [...bareGit, '-c', 'core.deltaBaseCacheLimit=16m', '-c', 'core.packedGitLimit=64m'];
const maxCachePackBytes = 256n * 1024n * 1024n;
const maxCacheIndexBytes = 32n * 1024n * 1024n;
const maxCacheObjects = 250_000;
const repositoryIdentity = z.strictObject({
  // Digest of a trusted repository identity, not a credential-bearing remote URL.
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
type RepositoryIdentity = z.infer<typeof repositoryIdentity>;
type ObjectFormat = 'sha1' | 'sha256';
type SnapshotIdentity = RepositoryIdentity & { objectFormat: ObjectFormat };
type SnapshotRequest = RepositoryIdentity & {
  gitDirectory: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
};

export class WorkspaceGitSnapshotError extends Error {
  constructor(readonly code: 'invalid_snapshot' | 'git_directory_not_self_contained' | 'git_commit_unavailable' | 'git_unavailable' | 'git_cache_invalid') {
    const messages = {
      invalid_snapshot: 'A Git snapshot requires a full commit ID and a valid repository scope.',
      git_directory_not_self_contained: 'The pinned Git directory is not a supported self-contained object store.',
      git_commit_unavailable: 'The exact commit is unavailable in the pinned local Git directory.',
      git_unavailable: 'A trusted local Git executable is unavailable.',
      git_cache_invalid: 'The pinned Git cache is incomplete, contains unexpected objects or metadata, or changed during validation.',
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
export async function inspectWorkspaceGitSnapshot(input: SnapshotRequest): Promise<SnapshotIdentity & { key: string }> {
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

// The producer must authorize the cache separately and normalize it to one exact commit closure.
export async function verifyWorkspaceGitCache(input: SnapshotRequest): Promise<SnapshotIdentity & {
  key: string;
  storeFingerprint: string;
}> {
  if (!repositoryIdentity.safeParse({ repositoryId: input.repositoryId, scope: input.scope, commit: input.commit }).success) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  const binding = await validateWorkspaceProject(input.authorizedRoots, input.gitDirectory);
  const executable = await trustedGitExecutable(binding.directory);
  const objectFormat = input.commit.length === 40 ? 'sha1' : 'sha256';
  try {
    const { storeFingerprint, packPath } = await fingerprintCache(binding, input.commit, objectFormat);
    await verifyCacheGit(executable, binding.directory, ['index-pack', '--verify', '--threads=1', packPath]);
    const type = await verifyCacheGit(executable, binding.directory, ['cat-file', '-t', input.commit]);
    if (type.toString('ascii') !== 'commit\n') throw new WorkspaceGitSnapshotError('git_cache_invalid');
    const unreachable = await verifyCacheGit(executable, binding.directory, ['fsck', '--full', '--strict',
      '--no-reflogs', '--no-progress', '--unreachable', input.commit]);
    if (unreachable.length || storeFingerprint !== (await fingerprintCache(binding, input.commit, objectFormat)).storeFingerprint) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
    await validateWorkspaceProject(input.authorizedRoots, binding);
    const identity = { repositoryId: input.repositoryId, scope: input.scope, commit: input.commit, objectFormat } satisfies SnapshotIdentity;
    return { ...identity, key: gitSnapshotKey(identity), storeFingerprint };
  } catch {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
}

async function fingerprintCache(binding: WorkspaceProjectBinding, commit: string, format: ObjectFormat): Promise<{
  storeFingerprint: string;
  packPath: string;
}> {
  const { directory, device, inode } = binding;
  await assertProtectedWorkspacePath(binding);
  const stamp: string[][] = [];
  const uid = process.geteuid?.();
  if (uid === undefined) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const record = async (relative: string, isDirectory: boolean) => {
    const file = path.join(directory, relative);
    const info = await fs.lstat(file, { bigint: true });
    if ((isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
      || String(info.dev) !== device || (info.uid !== 0n && info.uid !== BigInt(uid)) || (info.mode & 0o022n) !== 0n) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
    await assertDenyOnlyWorkspaceAcls([file]);
    stamp.push([relative, ...[info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs].map(String)]);
    return info;
  };
  const names = async (relative: string, max: number) => {
    const entries: string[] = [];
    for await (const entry of await fs.opendir(path.join(directory, relative))) {
      if (entries.length >= max) throw new WorkspaceGitSnapshotError('git_cache_invalid');
      entries.push(entry.name);
    }
    return entries.sort().join('\n');
  };
  if (String((await record('.', true)).ino) !== inode || await names('.', 4) !== 'HEAD\nconfig\nobjects\nrefs') {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  await record('refs', true);
  await record('objects', true);
  await record('objects/pack', true);
  if (await names('refs', 0) !== '' || await names('objects', 1) !== 'pack') {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  const pack = new RegExp(`^pack-([a-f0-9]{${commit.length}})\\.idx\\npack-\\1\\.pack$`)
    .exec(await names('objects/pack', 2));
  if (!pack) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const packPath = `objects/pack/pack-${pack[1]}.pack`;
  const idx = await record(`objects/pack/pack-${pack[1]}.idx`, false);
  const packInfo = await record(packPath, false);
  if (idx.size > maxCacheIndexBytes || packInfo.size > maxCachePackBytes) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const header = await readPinnedCachePrefix(path.join(directory, packPath), packInfo, 12);
  if (header.subarray(0, 4).toString('ascii') !== 'PACK' || header.readUInt32BE(8) > maxCacheObjects) {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  const config = format === 'sha1' ? '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'
    : '[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n';
  for (const [file, expected] of [['HEAD', `${commit}\n`], ['config', config]]) {
    const info = await record(file, false);
    if (info.size !== BigInt(expected.length)
      || (await readPinnedCachePrefix(path.join(directory, file), info, expected.length)).toString('utf8') !== expected) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
  }
  return { storeFingerprint: createHash('sha256').update(JSON.stringify(['git-cache-footprint-v1', stamp])).digest('hex'), packPath };
}

async function readPinnedCachePrefix(file: string, expected: BigIntStats, length: number): Promise<Buffer> {
  const fd = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await fd.stat({ bigint: true });
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size
      || info.mtimeNs !== expected.mtimeNs || info.ctimeNs !== expected.ctimeNs) throw new WorkspaceGitSnapshotError('git_cache_invalid');
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await fd.read(bytes, 0, length, 0);
    if (bytesRead !== length) throw new WorkspaceGitSnapshotError('git_cache_invalid');
    return bytes;
  } finally {
    await fd.close();
  }
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

function verifyCacheGit(executable: string, cwd: string, args: string[]): Promise<Buffer> {
  // Darwin does not support this address-space limit; still bound input, allocations, and time there.
  const argv = [...cacheGit, ...args];
  if (process.platform === 'linux') {
    return git('/bin/sh', cwd, ['-c', 'ulimit -v 786432 || exit 125; exec "$@"', 'lark-git-verifier',
      executable, ...argv], undefined, 60_000);
  }
  return git(executable, cwd, argv, undefined, 60_000);
}

async function git(executable: string, cwd: string, args: string[], input?: string, timeout = 10_000): Promise<Buffer> {
  const running = exec(executable, args, {
    cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: 'buffer',
    env: {
      PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOC_LIMIT: '67108864',
    },
  });
  running.child.stdin?.on('error', () => {});
  running.child.stdin?.end(input);
  return (await running).stdout;
}
