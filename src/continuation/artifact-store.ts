import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONTINUATION_LIMITS,
  type ContinuationCheckpointArtifact,
} from '../domain/continuation.js';
import {
  currentProcessStartedAt,
  isProcessAlive,
  isProcessInstanceAlive,
} from '../process-identity.js';

const REDACTION_QUARANTINE_PREFIX = '.redacting-';
const ACTIVE_REDACTION_QUARANTINES = new Set<string>();
const LEGACY_QUARANTINE_GRACE_MS = 30_000;

export class ContinuationArtifactStore {
  readonly rootDir: string;

  constructor(
    rootDir: string,
    private readonly maxBytes = CONTINUATION_LIMITS.managedArtifactBytesPerJob,
    private readonly maxEntries = CONTINUATION_LIMITS.managedArtifactEntriesPerJob,
    private readonly maxDepth = CONTINUATION_LIMITS.managedArtifactDirectoryDepth,
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
    let totalEntries = 0;

    const visit = async (current: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth) {
        throw new Error(
          `Continuation artifact directory depth limit exceeded for ${jobId}: ${depth} > ${this.maxDepth}.`,
        );
      }
      let handle;
      try {
        handle = await fs.opendir(current);
      } catch (err: any) {
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      for await (const entry of handle) {
        totalEntries += 1;
        if (totalEntries > this.maxEntries) {
          throw new Error(
            `Continuation artifact entry limit exceeded for ${jobId}: ${totalEntries} > ${this.maxEntries}.`,
          );
        }
        const entryPath = path.join(current, entry.name);
        const metadata = await fs.lstat(entryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!metadata) continue;
        if (metadata.isSymbolicLink()) {
          throw new Error(`Continuation artifacts cannot contain symbolic links: ${entry.name}`);
        }
        if (metadata.isDirectory()) {
          await visit(entryPath, depth + 1);
        } else if (metadata.isFile()) {
          totalBytes += metadata.size;
          if (totalBytes > this.maxBytes) {
            throw new Error(
              `Continuation artifact byte limit exceeded for ${jobId}: ${totalBytes} > ${this.maxBytes}.`,
            );
          }
        } else {
          throw new Error(`Continuation artifacts must be regular files or directories: ${entry.name}`);
        }
      }
    };

    await visit(directory, 0);
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

  async copyVerified(
    sourceJobId: string,
    targetJobId: string,
    artifacts: readonly ContinuationCheckpointArtifact[],
  ): Promise<boolean> {
    if (artifacts.length === 0) return false;
    const canonical = await this.canonicalizeReferences(
      sourceJobId,
      artifacts.map((artifact) => artifact.path),
    );
    if (canonical.length !== artifacts.length) {
      throw new Error('Continuation retry artifact references must be unique.');
    }
    await this.ensure(targetJobId);
    try {
      for (let index = 0; index < canonical.length; index += 1) {
        const reference = canonical[index];
        const target = this.resolve(targetJobId, reference);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(
          this.resolve(sourceJobId, reference),
          target,
          constants.COPYFILE_EXCL,
        );
        await fs.chmod(target, 0o600);
        const sha256 = createHash('sha256').update(await fs.readFile(target)).digest('hex');
        if (sha256 !== artifacts[index].sha256.toLowerCase()) {
          throw new Error(`Continuation retry artifact checksum mismatch: ${reference}`);
        }
      }
      await this.assertWithinLimit(targetJobId);
      return true;
    } catch (error) {
      await this.remove(targetJobId).catch(() => {});
      throw error;
    }
  }

  async remove(jobId: string): Promise<void> {
    await fs.rm(this.jobDirectory(jobId), { recursive: true, force: true });
  }

  async quarantine(jobId: string): Promise<string | null> {
    await this.ensureRoot();
    const source = this.jobDirectory(jobId);
    const token = `${process.pid}.${currentProcessStartedAt()}.${Date.now()}-${randomBytes(8).toString('hex')}`;
    const destination = this.quarantineDirectory(jobId, token);
    let sourceMetadata;
    try {
      sourceMetadata = await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
      throw new Error('Continuation artifact quarantine source is not a real directory.');
    }
    const quarantineName = path.basename(destination);
    ACTIVE_REDACTION_QUARANTINES.add(quarantineName);
    try {
      await fs.rename(source, destination);
      const moved = await fs.lstat(destination);
      if (moved.dev !== sourceMetadata.dev || moved.ino !== sourceMetadata.ino) {
        await fs.rename(destination, source).catch(() => {});
        throw new Error('Continuation artifact quarantine identity changed during rename.');
      }
      return token;
    } catch (error) {
      ACTIVE_REDACTION_QUARANTINES.delete(quarantineName);
      throw error;
    }
  }

  async restoreQuarantine(jobId: string, token: string): Promise<void> {
    const source = this.quarantineDirectory(jobId, token);
    try {
      await fs.rename(source, this.jobDirectory(jobId));
    } finally {
      ACTIVE_REDACTION_QUARANTINES.delete(path.basename(source));
    }
  }

  async discardQuarantine(jobId: string, token: string): Promise<void> {
    const source = this.quarantineDirectory(jobId, token);
    try {
      await removeArtifactTree(source);
    } finally {
      ACTIVE_REDACTION_QUARANTINES.delete(path.basename(source));
    }
  }

  async cleanupOrphans(
    jobIds: ReadonlySet<string>,
    nowMs = Date.now(),
    isJobKnown?: (jobId: string) => boolean | Promise<boolean>,
    withJobLock?: <T>(jobId: string, operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const quarantine = parseRedactionQuarantine(entry.name);
      if (!quarantine) continue;
      const candidate = path.join(this.rootDir, entry.name);
      const reconcile = async (): Promise<void> => {
        const shouldRestore = isJobKnown
          ? await isJobKnown(quarantine.jobId)
          : jobIds.has(quarantine.jobId);
        if (!shouldRestore) {
          await removeArtifactTree(candidate);
          return;
        }
        const candidateMetadata = await fs.lstat(candidate).catch((error) => {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
          throw error;
        });
        if (!candidateMetadata) return;
        const stateAgeMs = nowMs - (quarantine.createdAt ?? candidateMetadata.mtimeMs);
        const ownerIsActive = quarantine.ownerStartedAt === null
          ? isProcessAlive(quarantine.ownerPid)
            && stateAgeMs < LEGACY_QUARANTINE_GRACE_MS
          : await isProcessInstanceAlive(
            quarantine.ownerPid,
            quarantine.ownerStartedAt,
            stateAgeMs,
            LEGACY_QUARANTINE_GRACE_MS,
          );
        if (
          ownerIsActive
          && (quarantine.ownerPid !== process.pid
            || ACTIVE_REDACTION_QUARANTINES.has(entry.name))
        ) return;
        try {
          await fs.rename(candidate, this.jobDirectory(quarantine.jobId));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (
            !['EEXIST', 'ENOENT', 'EACCES'].includes(code ?? '')
            || await pathExists(candidate)
            || !(await isRestoredDirectory(this.jobDirectory(quarantine.jobId)))
          ) throw error;
        }
      };
      if (withJobLock) await withJobLock(quarantine.jobId, reconcile);
      else await reconcile();
    }
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

  private quarantineDirectory(jobId: string, token: string): string {
    this.jobDirectory(jobId);
    if (!/^[1-9]\d*\.[1-9]\d*(?:\.[1-9]\d*)?-[a-f0-9]{16}$/.test(token)) {
      throw new Error('Continuation artifact quarantine token is invalid.');
    }
    return path.join(this.rootDir, `${REDACTION_QUARANTINE_PREFIX}${jobId}-${token}`);
  }
}

function parseRedactionQuarantine(
  name: string,
): { jobId: string; ownerPid: number; ownerStartedAt: number | null; createdAt: number | null } | null {
  if (!name.startsWith(REDACTION_QUARANTINE_PREFIX)) return null;
  const match = /^\.redacting-(.+)-([1-9]\d*)(?:\.([1-9]\d*))?(?:\.([1-9]\d*))?-[a-f0-9]{16}$/.exec(name);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(match[1])) return null;
  const ownerPid = Number(match[2]);
  if (!Number.isSafeInteger(ownerPid)) return null;
  const ownerStartedAt = match[3] === undefined ? null : Number(match[3]);
  if (ownerStartedAt !== null && !Number.isSafeInteger(ownerStartedAt)) return null;
  const createdAt = match[4] === undefined ? null : Number(match[4]);
  if (createdAt !== null && !Number.isSafeInteger(createdAt)) return null;
  return { jobId: match[1], ownerPid, ownerStartedAt, createdAt };
}

async function removeArtifactTree(directory: string): Promise<void> {
  const metadata = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing to remove non-directory continuation artifact tree: ${directory}`);
  }
  await fs.rm(directory, { recursive: true });
}

async function assertRealDirectory(directory: string): Promise<void> {
  const metadata = await fs.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Continuation artifact path is not a real directory: ${directory}`);
  }
}

async function isRestoredDirectory(directory: string): Promise<boolean> {
  try {
    const metadata = await fs.lstat(directory);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}
