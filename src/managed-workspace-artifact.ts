import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { workspacePathContains } from './workspace-projects.js';

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

export async function readManagedArtifact(options: {
  directory: string;
  relativePath: string;
  maxBytes: number;
  expectedSha256?: string;
  revalidate: () => Promise<string>;
}): Promise<{ content: Buffer; sha256: string }> {
  const { directory, relativePath, maxBytes, expectedSha256, revalidate } = options;
  const invalid = () => new ManagedWorkspaceStorageError('artifact_invalid');
  const candidate = path.resolve(directory, relativePath);
  if (!relativePath || path.isAbsolute(relativePath) || !workspacePathContains(directory, candidate)
    || path.relative(directory, candidate).split(path.sep).join('/') !== relativePath
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw invalid();
  let handle: fs.FileHandle | undefined;
  try {
    if (await revalidate() !== directory || await fs.realpath(candidate) !== candidate) throw invalid();
    const named = await fs.lstat(candidate, { bigint: true });
    if (!named.isFile() || named.nlink !== 1n || named.size > BigInt(maxBytes)) throw invalid();
    handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(named, await handle.stat({ bigint: true }))) throw invalid();
    // Return the bytes from the verified descriptor, never a path for a consumer to reopen later.
    const content = Buffer.alloc(Number(named.size));
    for (let offset = 0; offset < content.length;) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw invalid();
      offset += bytesRead;
    }
    if (!sameFile(named, await handle.stat({ bigint: true })) || await revalidate() !== directory
      || await fs.realpath(candidate) !== candidate || !sameFile(named, await fs.lstat(candidate, { bigint: true }))) throw invalid();
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) throw invalid();
    return { content, sha256 };
  } catch {
    throw invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}
