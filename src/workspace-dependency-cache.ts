import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceMountTable,
  workspaceMountLayoutSupported } from './managed-workspace-ancestry.js';
import { createWorkspaceDependencyExpansionBudget, WorkspaceDependencyArchiveError } from './workspace-dependency-archive.js';
import { prepareWorkspaceNpmLock, prepareWorkspacePipLock, type WorkspaceDependencyInput } from './workspace-dependency-input.js';
import { validateWorkspaceProject } from './workspace-projects.js';

const MAX_ARTIFACT_BYTES = 1024n ** 3n;
const MAX_CACHE_BYTES = 4n * MAX_ARTIFACT_BYTES;
const READ_BYTES = 256 * 1024;

export class WorkspaceDependencyCacheError extends Error {
  constructor(readonly code: 'dependency_cache_invalid' | 'dependency_artifact_missing' | 'dependency_artifact_conflict' | 'dependency_cache_changed') {
    super({ dependency_cache_invalid: 'Dependency cache layout or permissions are invalid.',
      dependency_artifact_missing: 'The cache does not contain a selected dependency artifact.',
      dependency_artifact_conflict: 'A dependency artifact does not match its selected hash.',
      dependency_cache_changed: 'The dependency cache changed since it was verified.' }[code]);
  }
}

type ExpectedFile = { algorithm: 'sha512' | 'sha256'; digest: string; copies: number };
type Tree = Map<string, Tree | ExpectedFile>;
type Entry = [relative: string, expected: Tree | ExpectedFile];

// Proves layout and bytes, not runtime immutability. Launch policies must independently deny writes and replacement.
export async function verifyWorkspaceDependencyCache(request: {
  input: WorkspaceDependencyInput;
  artifactManifest: unknown;
  cache: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
  expectedFingerprint?: string;
  inspectExpansion?: boolean;
}) {
  const prepared = request.input.ecosystem === 'npm' ? prepareWorkspaceNpmLock(request.input, request.artifactManifest)
    : prepareWorkspacePipLock(request.input, request.artifactManifest);
  if (request.expectedFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(request.expectedFingerprint)) invalid();
  const budget = request.inspectExpansion ? createWorkspaceDependencyExpansionBudget() : undefined;
  const copiesByIntegrity = 'copiesByIntegrity' in prepared ? prepared.copiesByIntegrity : undefined;
  const tree: Tree = new Map();
  for (const artifact of prepared.artifacts) {
    if ('integrity' in artifact) {
      const digest = Buffer.from(artifact.integrity.slice(7), 'base64').toString('hex');
      const copies = copiesByIntegrity?.get(artifact.integrity);
      if (!copies) invalid();
      put(tree, ['_cacache', 'content-v2', 'sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4)], { algorithm: 'sha512', digest, copies });
    } else {
      put(tree, [artifact.filename], { algorithm: 'sha256', digest: artifact.sha256, copies: 1 });
    }
  }

  try {
    const cache = await validateWorkspaceProject(request.authorizedRoots, request.cache);
    await assertProtectedWorkspacePath(cache);
    if (!workspaceMountLayoutSupported([cache.directory], readWorkspaceMountTable()) || !process.geteuid) invalid();
    const uid = BigInt(process.geteuid());
    const measured = new Map<string, BigIntStats>();
    const scratch = Buffer.alloc(READ_BYTES);
    let bytes = 0n;
    for (let pending: Entry[] = [['', tree]]; pending.length;) {
      // Check ACLs one level at a time, before traversing child directories or opening files.
      await verifyAcls(cache.directory, pending.map(([relative]) => relative));
      const next: Entry[] = [];
      for (const [relative, expected] of pending) {
        if (expected instanceof Map) await inspectDirectory(relative, expected, next);
        else await verifyFile(relative, expected);
      }
      pending = next;
    }
    await validateWorkspaceProject(request.authorizedRoots, cache);
    const stamps: string[][] = [];
    for (const relative of [...measured.keys()].sort()) {
      const first = measured.get(relative)!;
      if (!sameIdentity(first, await fs.lstat(path.join(cache.directory, relative), { bigint: true }))) changed();
      stamps.push([relative, ...fingerprintParts(first)]);
    }
    const cacheFingerprint = createHash('sha256').update(JSON.stringify(['workspace-dependency-cache-v1',
      prepared.identity.key, prepared.artifactManifestSha256, stamps])).digest('hex');
    if (request.expectedFingerprint !== undefined && cacheFingerprint !== request.expectedFingerprint) changed();
    return { cache, identity: prepared.identity, stagedLock: prepared.lock, artifactManifestSha256: prepared.artifactManifestSha256,
      cacheFingerprint, bytes: Number(bytes) };

    async function inspectDirectory(relative: string, expected: Tree, next: Entry[]): Promise<void> {
      const directory = path.join(cache.directory, relative);
      const before = await fs.lstat(directory, { bigint: true });
      if (!before.isDirectory() || !trusted(before, uid, cache.device) || (!relative && String(before.ino) !== cache.inode)) invalid();
      measured.set(relative, before);
      const found = new Set<string>();
      for await (const entry of await fs.opendir(directory)) {
        const item = expected.get(entry.name);
        if (!item || found.has(entry.name)) invalid();
        found.add(entry.name);
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        next.push([child, item]);
      }
      if (found.size !== expected.size) throw new WorkspaceDependencyCacheError('dependency_artifact_missing');
    }

    async function verifyFile(relative: string, expected: ExpectedFile): Promise<void> {
      const filename = path.join(cache.directory, relative);
      const info = await fs.lstat(filename, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !trusted(info, uid, cache.device) || info.size < 1n || info.size > MAX_ARTIFACT_BYTES) invalid();
      bytes += info.size;
      if (bytes > MAX_CACHE_BYTES) invalid();
      const fd = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!sameIdentity(info, await fd.stat({ bigint: true }))) changed();
        const hash = createHash(expected.algorithm);
        let remaining = Number(info.size);
        while (remaining) {
          const { bytesRead } = await fd.read(scratch, 0, Math.min(remaining, scratch.length), null);
          if (!bytesRead) changed();
          hash.update(scratch.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
        if (!sameIdentity(info, await fd.stat({ bigint: true }))) changed();
        if (hash.digest('hex') !== expected.digest) throw new WorkspaceDependencyCacheError('dependency_artifact_conflict');
        await budget?.inspect(fd, Number(info.size), request.input.ecosystem, expected.copies);
        if (!sameIdentity(info, await fd.stat({ bigint: true }))) changed();
        measured.set(relative, info);
      } finally { await fd.close(); }
    }
  } catch (error) {
    if (error instanceof WorkspaceDependencyCacheError || error instanceof WorkspaceDependencyArchiveError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceDependencyCacheError('dependency_artifact_missing');
    return invalid();
  }
}

function put(tree: Tree, parts: string[], file: ExpectedFile): void {
  for (const part of parts.slice(0, -1)) {
    const existing = tree.get(part) ?? new Map<string, Tree | ExpectedFile>();
    if (!(existing instanceof Map)) invalid();
    tree.set(part, existing);
    tree = existing;
  }
  tree.set(parts.at(-1)!, file);
}

function trusted(info: BigIntStats, uid: bigint, device: string): boolean {
  return String(info.dev) === device && (info.uid === uid || info.uid === 0n) && (info.mode & 0o022n) === 0n;
}

function fingerprintParts(info: BigIntStats): string[] {
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.ctimeNs, info.mtimeNs].map(String);
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
    && a.nlink === b.nlink && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

async function verifyAcls(root: string, entries: Iterable<string>): Promise<void> {
  if (process.platform !== 'darwin') return;
  let batch: string[] = [];
  let size = 0;
  for (const relative of entries) {
    const filename = path.join(root, relative);
    const bytes = Buffer.byteLength(filename) + 1;
    if (size + bytes > 64 * 1024) {
      await assertDenyOnlyWorkspaceAcls(batch);
      batch = [];
      size = 0;
    }
    batch.push(filename);
    size += bytes;
  }
  await assertDenyOnlyWorkspaceAcls(batch);
}

function changed(): never { throw new WorkspaceDependencyCacheError('dependency_cache_changed'); }
function invalid(): never { throw new WorkspaceDependencyCacheError('dependency_cache_invalid'); }
