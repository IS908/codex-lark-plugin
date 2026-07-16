import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTINUATION_LIMITS } from '../domain/continuation.js';

export class ContinuationArtifactStore {
  readonly rootDir: string;

  constructor(
    rootDir: string,
    private readonly maxBytes = CONTINUATION_LIMITS.managedArtifactBytesPerJob,
  ) {
    this.rootDir = path.resolve(rootDir);
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertRealDirectory(this.rootDir);
    await fs.chmod(this.rootDir, 0o700);
  }

  async ensure(jobId: string): Promise<string> {
    await this.ensureRoot();
    const directory = this.jobDirectory(jobId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRealDirectory(directory);
    await fs.chmod(directory, 0o700);
    return directory;
  }

  resolve(jobId: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Continuation artifact path must be relative.');
    }
    const directory = this.jobDirectory(jobId);
    const resolved = path.resolve(directory, relativePath);
    if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) {
      throw new Error('Continuation artifact path resolves outside job directory.');
    }
    return resolved;
  }

  async assertWithinLimit(jobId: string): Promise<void> {
    const directory = this.jobDirectory(jobId);
    await assertRealDirectory(directory);
    let totalBytes = 0;

    const visit = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (err: any) {
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Continuation artifacts cannot contain symbolic links: ${entry.name}`);
        }
        if (entry.isDirectory()) {
          await visit(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        totalBytes += (await fs.stat(entryPath)).size;
        if (totalBytes > this.maxBytes) {
          throw new Error(
            `Continuation artifact byte limit exceeded for ${jobId}: ${totalBytes} > ${this.maxBytes}.`,
          );
        }
      }
    };

    await visit(directory);
  }

  async canonicalizeReferences(
    jobId: string,
    references: readonly string[],
  ): Promise<string[]> {
    const directory = this.jobDirectory(jobId);
    await assertRealDirectory(directory);
    const canonical: string[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const resolved = this.resolve(jobId, reference);
      const metadata = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          throw new Error(`Continuation artifact does not exist: ${reference}`);
        }
        throw error;
      });
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Continuation artifact is not a regular file: ${reference}`);
      }
      const normalized = path.relative(directory, resolved).split(path.sep).join('/');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        canonical.push(normalized);
      }
    }
    await this.assertWithinLimit(jobId);
    return canonical;
  }

  async remove(jobId: string): Promise<void> {
    await fs.rm(this.jobDirectory(jobId), { recursive: true, force: true });
  }

  async purge(jobIds: readonly string[]): Promise<void> {
    for (const jobId of jobIds) await this.remove(jobId);
  }

  private jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
      throw new Error(`Invalid continuation job id for artifact storage: ${jobId}`);
    }
    const resolved = path.resolve(this.rootDir, jobId);
    if (!resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Continuation artifact job directory escapes the artifact root.');
    }
    return resolved;
  }
}

async function assertRealDirectory(directory: string): Promise<void> {
  const metadata = await fs.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Continuation artifact path is not a real directory: ${directory}`);
  }
}
