import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CONTINUATION_CONTRACT_ID_PATTERN,
  CONTINUATION_LIMITS,
  type AsyncTaskInputArtifact,
  type AsyncTaskSourceInput,
} from '../domain/continuation.js';
import type {
  ContinuationInputInstallResult,
  ContinuationInputStorePort,
  ContinuationInputVerification,
} from '../ports/continuation.js';
import {
  currentProcessStartedAt,
  isProcessAlive,
  isProcessInstanceAlive,
} from '../process-identity.js';
import { continuationJobId } from './idempotency.js';

export { continuationJobId } from './idempotency.js';

interface ContinuationInputStoreOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  orphanAgeMs?: number;
}

interface InputManifest {
  version: 1;
  jobId: string;
  requestFingerprint: string;
  inputs: AsyncTaskInputArtifact[];
}

class InvalidManagedInputError extends Error {}

const MANIFEST_FILE = '.manifest.json';
const DEFAULT_ORPHAN_AGE_MS = 60 * 60 * 1_000;
const CREATION_LOCK_PREFIX = '.creating-';
const CREATION_RECLAIM_PREFIX = '.reclaim-';
const REDACTION_QUARANTINE_PREFIX = '.redacting-';
const CREATION_LOCK_WAIT_MS = 5 * 60 * 1_000;
const OWNERLESS_LOCK_GRACE_MS = 30_000;
const UNKNOWN_CREATION_OWNER_GRACE_MS = CREATION_LOCK_WAIT_MS + OWNERLESS_LOCK_GRACE_MS;
const ACTIVE_REDACTION_QUARANTINES = new Set<string>();

interface CreationLockOwner {
  pid: number;
  startedAt: number | null;
  nonce: string | null;
  createdAt: string;
}

export class ContinuationInputStore implements ContinuationInputStorePort {
  readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly orphanAgeMs: number;

  constructor(rootDir: string, options: ContinuationInputStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxFiles = options.maxFiles ?? CONTINUATION_LIMITS.inputFileCount;
    this.maxFileBytes = options.maxFileBytes ?? CONTINUATION_LIMITS.inputBytesPerFile;
    this.maxTotalBytes = options.maxTotalBytes ?? CONTINUATION_LIMITS.managedInputBytesPerJob;
    this.orphanAgeMs = options.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertDirectory(this.rootDir);
    await fs.chmod(this.rootDir, 0o700);
  }

  async withCreationLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    assertJobId(jobId);
    await this.ensureRoot();
    const lockDirectory = path.join(this.rootDir, `${CREATION_LOCK_PREFIX}${jobId}`);
    const deadline = Date.now() + CREATION_LOCK_WAIT_MS;
    let ownerNonce: string | undefined;
    while (true) {
      const nonce = randomBytes(16).toString('hex');
      const owner: CreationLockOwner = {
        pid: process.pid,
        startedAt: currentProcessStartedAt(),
        nonce,
        createdAt: new Date().toISOString(),
      };
      try {
        await fs.writeFile(lockDirectory, `${JSON.stringify(owner)}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
        ownerNonce = nonce;
        if (await hasCompetingCreationReclaim(this.rootDir, lockDirectory)) {
          await releaseCreationLock(lockDirectory, this.rootDir, ownerNonce);
          ownerNonce = undefined;
          if (Date.now() >= deadline) {
            throw new Error('Continuation creation-lock reclaim did not finish before the wait deadline.');
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        break;
      } catch (error) {
        if (ownerNonce) {
          const nonce = ownerNonce;
          ownerNonce = undefined;
          try {
            await releaseCreationLock(lockDirectory, this.rootDir, nonce);
          } catch (releaseError) {
            throw new AggregateError(
              [error, releaseError],
              'Continuation creation-lock setup and cleanup both failed.',
            );
          }
        }
        if (!isCreationLockContention(error)) throw error;
        if (await tryReclaimCreationLock(lockDirectory, this.rootDir)) continue;
        if (Date.now() >= deadline) {
          throw new Error('Continuation creation is already in progress for this idempotency key.');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (ownerNonce) {
        try {
          await releaseCreationLock(lockDirectory, this.rootDir, ownerNonce);
        } catch (releaseError) {
          if (operationError) {
            throw new AggregateError(
              [operationError, releaseError],
              'Continuation operation and creation-lock release both failed.',
            );
          }
          throw releaseError;
        }
      }
    }
  }

  async install(
    jobId: string,
    sources: readonly AsyncTaskSourceInput[],
    requestFingerprint = '',
  ): Promise<ContinuationInputInstallResult> {
    assertJobId(jobId);
    this.validateSources(sources);
    await this.ensureRoot();
    const finalDirectory = this.jobDirectory(jobId);
    const stagingDirectory = path.join(
      this.rootDir,
      `.staging-${jobId}-${process.pid}-${randomBytes(8).toString('hex')}`,
    );
    await fs.mkdir(stagingDirectory, { mode: 0o700 });
    let installed = false;
    try {
      const artifacts: AsyncTaskInputArtifact[] = [];
      let totalBytes = 0;
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const id = `input_${String(index + 1).padStart(3, '0')}`;
        const relativePath = neutralInputFileName(id, source.fileName);
        const copied = await copyRegularFile(
          source.sourcePath,
          path.join(stagingDirectory, relativePath),
          this.maxFileBytes,
        );
        if (
          source.expectedSizeBytes !== undefined
          && copied.sizeBytes !== source.expectedSizeBytes
        ) {
          throw new Error('Continuation input integrity check failed: copied size differs from the verified source.');
        }
        if (
          source.expectedSha256 !== undefined
          && copied.sha256 !== source.expectedSha256
        ) {
          throw new Error('Continuation input integrity check failed: copied checksum differs from the verified source.');
        }
        totalBytes += copied.sizeBytes;
        if (totalBytes > this.maxTotalBytes) {
          throw new Error(`Continuation input total byte limit exceeded: ${totalBytes} > ${this.maxTotalBytes}.`);
        }
        artifacts.push({
          id,
          kind: source.kind,
          fileName: relativePath,
          relativePath,
          sha256: copied.sha256,
          sizeBytes: copied.sizeBytes,
        });
      }
      const manifest: InputManifest = { version: 1, jobId, requestFingerprint, inputs: artifacts };
      const manifestPath = path.join(stagingDirectory, MANIFEST_FILE);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
      for (const artifact of artifacts) {
        await fs.chmod(path.join(stagingDirectory, artifact.relativePath), 0o400);
      }
      await fs.chmod(manifestPath, 0o400);
      await fs.chmod(stagingDirectory, 0o500);
      const existing = await this.readManifestIfPresent(finalDirectory, jobId);
      if (existing) {
        assertEquivalentManifest(existing, manifest);
        await this.assertReusableTree(jobId, existing);
        return { artifacts: existing.inputs, installed: false };
      }
      try {
        await fs.rename(stagingDirectory, finalDirectory);
        installed = true;
        return { artifacts, installed: true };
      } catch (error) {
        if (!isInstallRace(error)) throw error;
        const winner = await this.readManifestIfPresent(finalDirectory, jobId);
        if (!winner) throw error;
        assertEquivalentManifest(winner, manifest);
        await this.assertReusableTree(jobId, winner);
        return { artifacts: winner.inputs, installed: false };
      }
    } catch (error) {
      throw safeAdmissionError(error);
    } finally {
      if (!installed) await removeManagedTree(stagingDirectory).catch(() => {});
    }
  }

  async clone(
    sourceJobId: string,
    targetJobId: string,
    artifacts: readonly AsyncTaskInputArtifact[],
    requestFingerprint = '',
  ): Promise<ContinuationInputInstallResult> {
    const verification = await this.verify(sourceJobId, artifacts);
    if (!verification.ok) {
      throw new Error('Continuation input integrity check failed; retry input copy was not created.');
    }
    return this.install(targetJobId, artifacts.map((artifact) => ({
      sourcePath: this.resolve(sourceJobId, artifact.relativePath),
      fileName: artifact.fileName,
      kind: artifact.kind,
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
    })), requestFingerprint);
  }

  async verify(
    jobId: string,
    artifacts: readonly AsyncTaskInputArtifact[],
  ): Promise<ContinuationInputVerification> {
    if (artifacts.length === 0) return { ok: true };
    const directory = this.jobDirectory(jobId);
    const directoryMetadata = await lstatForVerification(directory);
    if (!directoryMetadata) return { ok: false, reason: 'missing' };
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      return { ok: false, reason: 'invalid' };
    }
    for (const artifact of artifacts) {
      try {
        validateArtifact(artifact);
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      const filePath = this.resolve(jobId, artifact.relativePath);
      const metadata = await lstatForVerification(filePath);
      if (!metadata) return { ok: false, reason: 'missing' };
      if (metadata.isSymbolicLink() || !metadata.isFile()) return { ok: false, reason: 'invalid' };
      if (metadata.size !== artifact.sizeBytes) return { ok: false, reason: 'modified' };
      let digest: string;
      try {
        digest = await sha256File(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return { ok: false, reason: 'missing' };
        }
        if (['ELOOP', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR'].includes(code ?? '')) {
          return { ok: false, reason: 'invalid' };
        }
        if (error instanceof InvalidManagedInputError) {
          return { ok: false, reason: 'invalid' };
        }
        throw error;
      }
      if (digest !== artifact.sha256) return { ok: false, reason: 'modified' };
    }
    return { ok: true };
  }

  resolve(jobId: string, relativePath: string): string {
    const directory = this.jobDirectory(jobId);
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error('Continuation input path must be relative.');
    }
    const resolved = path.resolve(directory, relativePath);
    if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) {
      throw new Error('Continuation input path resolves outside its managed directory.');
    }
    return resolved;
  }

  async remove(jobId: string): Promise<void> {
    await removeManagedTree(this.jobDirectory(jobId));
  }

  async quarantine(jobId: string): Promise<string | null> {
    const source = this.jobDirectory(jobId);
    const token = `${process.pid}.${currentProcessStartedAt()}.${Date.now()}-${randomBytes(8).toString('hex')}`;
    const destination = this.quarantineDirectory(jobId, token);
    let metadata;
    try {
      metadata = await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Continuation input path is not a real directory.');
    }
    const quarantineName = path.basename(destination);
    ACTIVE_REDACTION_QUARANTINES.add(quarantineName);
    try {
      await fs.rename(source, destination);
    } catch (error) {
      ACTIVE_REDACTION_QUARANTINES.delete(quarantineName);
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const moved = await fs.lstat(destination);
      if (moved.dev !== metadata.dev || moved.ino !== metadata.ino) {
        await fs.rename(destination, source).catch(() => {});
        throw new Error('Continuation input quarantine identity changed during rename.');
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
      await removeManagedTree(source);
    } finally {
      ACTIVE_REDACTION_QUARANTINES.delete(path.basename(source));
    }
  }

  async cleanupOrphans(
    jobIds: ReadonlySet<string>,
    nowMs = Date.now(),
    isJobKnown?: (jobId: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const liveCreationJobs = new Set<string>();
    for (const entry of entries) {
      if (!entry.name.startsWith(CREATION_LOCK_PREFIX)) continue;
      const lockDirectory = path.join(this.rootDir, entry.name);
      const jobId = entry.name.slice(CREATION_LOCK_PREFIX.length);
      if (!(await tryReclaimCreationLock(lockDirectory, this.rootDir))) {
        liveCreationJobs.add(jobId);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const redactionQuarantine = parseRedactionQuarantine(entry.name);
      if (redactionQuarantine) {
        const candidate = path.join(this.rootDir, entry.name);
        await this.withCreationLock(redactionQuarantine.jobId, async () => {
          const shouldRestore = isJobKnown
            ? await isJobKnown(redactionQuarantine.jobId)
            : jobIds.has(redactionQuarantine.jobId);
          if (!shouldRestore) {
            await removeManagedTree(candidate);
            return;
          }
          const candidateMetadata = await fs.lstat(candidate).catch((error) => {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
            throw error;
          });
          if (!candidateMetadata) return;
          const stateAgeMs = nowMs - (redactionQuarantine.createdAt ?? candidateMetadata.mtimeMs);
          const ownerIsActive = redactionQuarantine.ownerStartedAt === null
            ? isProcessAlive(redactionQuarantine.ownerPid)
              && stateAgeMs < OWNERLESS_LOCK_GRACE_MS
            : await isProcessInstanceAlive(
              redactionQuarantine.ownerPid,
              redactionQuarantine.ownerStartedAt,
              stateAgeMs,
              OWNERLESS_LOCK_GRACE_MS,
            );
          if (
            ownerIsActive
            && (redactionQuarantine.ownerPid !== process.pid
              || ACTIVE_REDACTION_QUARANTINES.has(entry.name))
          ) return;
          try {
            await fs.rename(candidate, this.jobDirectory(redactionQuarantine.jobId));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (
              !['EEXIST', 'ENOENT', 'EACCES'].includes(code ?? '')
              || await pathExists(candidate)
              || !(await isRestoredDirectory(this.jobDirectory(redactionQuarantine.jobId)))
            ) throw error;
          }
        });
        continue;
      }
      const isStaging = entry.name.startsWith('.staging-');
      if (entry.name.startsWith(CREATION_LOCK_PREFIX)) continue;
      if (!isStaging && jobIds.has(entry.name)) continue;
      if (!isStaging && liveCreationJobs.has(entry.name)) continue;
      if (isStaging && [...liveCreationJobs].some((jobId) =>
        entry.name.startsWith(`.staging-${jobId}-`))) continue;
      const candidate = path.join(this.rootDir, entry.name);
      if (!isStaging && isValidJobId(entry.name)) {
        await this.withCreationLock(entry.name, async () => {
          if (jobIds.has(entry.name) || await isJobKnown?.(entry.name)) return;
          await removeAgedOrphan(candidate, nowMs, this.orphanAgeMs);
        });
        continue;
      }
      await removeAgedOrphan(candidate, nowMs, this.orphanAgeMs);
    }
  }

  private validateSources(sources: readonly AsyncTaskSourceInput[]): void {
    if (sources.length > this.maxFiles) {
      throw new Error(`Continuation input file count exceeds ${this.maxFiles}.`);
    }
    for (const source of sources) {
      if (!['message_image', 'message_attachment'].includes(source.kind)) {
        throw new Error('Continuation input kind is invalid.');
      }
      validateFileName(source.fileName);
      if (!path.isAbsolute(source.sourcePath)) {
        throw new Error('Continuation input source path must be absolute and server-admitted.');
      }
      if (
        source.expectedSha256 !== undefined
        && !/^[a-f0-9]{64}$/.test(source.expectedSha256)
      ) {
        throw new Error('Continuation input expected checksum is invalid.');
      }
      if (
        source.expectedSizeBytes !== undefined
        && (!Number.isSafeInteger(source.expectedSizeBytes) || source.expectedSizeBytes < 0)
      ) {
        throw new Error('Continuation input expected size is invalid.');
      }
    }
  }

  private jobDirectory(jobId: string): string {
    assertJobId(jobId);
    const resolved = path.resolve(this.rootDir, jobId);
    if (!resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Continuation input job directory escapes the input root.');
    }
    return resolved;
  }

  private quarantineDirectory(jobId: string, token: string): string {
    assertJobId(jobId);
    if (!/^[1-9]\d*\.[1-9]\d*(?:\.[1-9]\d*)?-[a-f0-9]{16}$/.test(token)) {
      throw new Error('Continuation input quarantine token is invalid.');
    }
    return path.join(this.rootDir, `${REDACTION_QUARANTINE_PREFIX}${jobId}-${token}`);
  }

  private async readManifestIfPresent(
    directory: string,
    jobId: string,
  ): Promise<InputManifest | null> {
    try {
      await assertDirectory(directory);
      const parsed = JSON.parse(await fs.readFile(path.join(directory, MANIFEST_FILE), 'utf8')) as InputManifest;
      if (
        parsed.version !== 1
        || parsed.jobId !== jobId
        || typeof parsed.requestFingerprint !== 'string'
        || !Array.isArray(parsed.inputs)
      ) {
        throw new Error('Continuation input manifest is invalid.');
      }
      parsed.inputs.forEach(validateArtifact);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async assertReusableTree(jobId: string, manifest: InputManifest): Promise<void> {
    const verification = await this.verify(jobId, manifest.inputs);
    if (!verification.ok) {
      throw new InvalidManagedInputError(
        `Continuation managed input integrity check failed during recovery: ${verification.reason}.`,
      );
    }
  }
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  maxFileBytes: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  const pathMetadata = await fs.lstat(sourcePath);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error('Continuation input source must be a regular file.');
  }
  const source = await fs.open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error('Continuation input source must be a regular file.');
    if (before.size > maxFileBytes) {
      throw new Error(`Continuation input file byte limit exceeded: ${before.size} > ${maxFileBytes}.`);
    }
    const digest = createHash('sha256');
    let copiedBytes = 0;
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        copiedBytes += chunk.length;
        if (copiedBytes > maxFileBytes) {
          callback(new Error(`Continuation input file byte limit exceeded: ${copiedBytes} > ${maxFileBytes}.`));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      source.createReadStream({ autoClose: false }),
      hashing,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
    );
    const after = await source.stat();
    if (before.size !== after.size || copiedBytes !== after.size) {
      throw new Error('Continuation input source changed while it was being admitted.');
    }
    return { sha256: digest.digest('hex'), sizeBytes: copiedBytes };
  } finally {
    await source.close();
  }
}

async function lstatForVerification(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const file = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) {
      throw new InvalidManagedInputError('Continuation managed input is not a regular file.');
    }
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally {
    await file.close();
  }
}

function validateFileName(fileName: string): void {
  if (
    !fileName
    || fileName.length > 120
    || fileName === '.'
    || fileName === '..'
    || fileName === MANIFEST_FILE
    || fileName.includes('/')
    || fileName.includes('\\')
    || fileName.includes('\0')
    || path.basename(fileName) !== fileName
  ) {
    throw new Error('Continuation input file name is invalid.');
  }
}

function neutralInputFileName(id: string, originalFileName: string): string {
  const extension = path.extname(originalFileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? `${id}${extension}` : id;
}

function validateArtifact(artifact: AsyncTaskInputArtifact): void {
  if (!CONTINUATION_CONTRACT_ID_PATTERN.test(artifact.id)) {
    throw new Error('Continuation input artifact id is invalid.');
  }
  validateFileName(artifact.fileName);
  if (!artifact.relativePath || path.isAbsolute(artifact.relativePath)) {
    throw new Error('Continuation input artifact path is invalid.');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Continuation input artifact checksum is invalid.');
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
    throw new Error('Continuation input artifact size is invalid.');
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const metadata = await fs.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Continuation input path is not a real directory: ${directory}`);
  }
}

function assertJobId(jobId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
    throw new Error(`Invalid continuation job id for input storage: ${jobId}`);
  }
}

function isValidJobId(jobId: string): boolean {
  try {
    assertJobId(jobId);
    return true;
  } catch {
    return false;
  }
}

function isInstallRace(error: unknown): boolean {
  return ['EACCES', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

function isCreationLockContention(error: unknown): boolean {
  return ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

function safeAdmissionError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('Continuation idempotency conflict:')) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) {
    return new Error(`Continuation input admission failed: source is unavailable, unreadable, or not a regular file (${code}).`);
  }
  if (error instanceof SyntaxError || /not a real directory/.test(error instanceof Error ? error.message : '')) {
    return new Error('Continuation input admission failed: managed input state is invalid.');
  }
  return error instanceof Error ? error : new Error('Continuation input admission failed.');
}

async function readCreationOwner(lockDirectory: string): Promise<CreationLockOwner | null> {
  try {
    const metadata = await fs.lstat(lockDirectory);
    const ownerPath = metadata.isDirectory()
      ? path.join(lockDirectory, 'owner.json')
      : lockDirectory;
    const parsed = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as {
      pid?: unknown;
      nonce?: unknown;
      createdAt?: unknown;
      startedAt?: unknown;
    };
    if (
      !Number.isInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.createdAt !== 'string'
    ) return null;
    const nonce = typeof parsed.nonce === 'string' && /^[a-f0-9]{32}$/.test(parsed.nonce)
      ? parsed.nonce
      : null;
    const startedAt = Number(parsed.startedAt);
    return {
      pid: Number(parsed.pid),
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
      nonce,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

async function tryReclaimCreationLock(lockDirectory: string, rootDir: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await fs.lstat(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw error;
  }
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw new Error('Continuation creation lock state is invalid.');
  }
  const owner = await readCreationOwner(lockDirectory);
  if (owner === null) {
    if (Date.now() - metadata.mtimeMs < OWNERLESS_LOCK_GRACE_MS) return false;
  } else if (owner.startedAt === null) {
    if (isProcessAlive(owner.pid) && Date.now() - metadata.mtimeMs < OWNERLESS_LOCK_GRACE_MS) {
      return false;
    }
  } else if (await isProcessInstanceAlive(
    owner.pid,
    owner.startedAt,
    Date.now() - metadata.mtimeMs,
    UNKNOWN_CREATION_OWNER_GRACE_MS,
  )) return false;

  const quarantine = path.join(
    rootDir,
    `${CREATION_RECLAIM_PREFIX}${path.basename(lockDirectory)}-${process.pid}.${currentProcessStartedAt()}.${Date.now()}-${randomBytes(8).toString('hex')}`,
  );
  try {
    await fs.rename(lockDirectory, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw error;
  }
  const moved = await fs.lstat(quarantine);
  if (moved.dev !== metadata.dev || moved.ino !== metadata.ino) {
    try {
      await fs.rename(quarantine, lockDirectory);
    } catch (error) {
      throw new Error('Continuation creation lock changed during reclaim and could not be restored.', {
        cause: error,
      });
    }
    return false;
  }
  await removeManagedTree(quarantine);
  return true;
}

async function hasCompetingCreationReclaim(rootDir: string, lockDirectory: string): Promise<boolean> {
  const prefix = `${CREATION_RECLAIM_PREFIX}${path.basename(lockDirectory)}-`;
  for (const entry of await fs.readdir(rootDir)) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = path.join(rootDir, entry);
    const metadata = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) continue;
    const owner = parseCreationReclaimOwner(entry.slice(prefix.length));
    const stateAgeMs = Date.now() - (owner?.createdAt ?? metadata.mtimeMs);
    const ownerIsActive = owner?.startedAt
      ? stateAgeMs < OWNERLESS_LOCK_GRACE_MS && await isProcessInstanceAlive(
        owner.pid,
        owner.startedAt,
        stateAgeMs,
        OWNERLESS_LOCK_GRACE_MS,
      )
      : owner
        ? isProcessAlive(owner.pid) && stateAgeMs < OWNERLESS_LOCK_GRACE_MS
        : stateAgeMs < OWNERLESS_LOCK_GRACE_MS;
    if (ownerIsActive) return true;
    await removeManagedTree(candidate);
  }
  return false;
}

function parseCreationReclaimOwner(
  token: string,
): { pid: number; startedAt: number | null; createdAt: number | null } | null {
  const match = /^([1-9]\d*)(?:\.([1-9]\d*)\.([1-9]\d*))?-[a-f0-9]{16}$/.exec(token);
  if (!match) return null;
  const pid = Number(match[1]);
  const startedAt = match[2] === undefined ? null : Number(match[2]);
  const createdAt = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(pid)
    || (startedAt !== null && !Number.isSafeInteger(startedAt))
    || (createdAt !== null && !Number.isSafeInteger(createdAt))
  ) return null;
  return { pid, startedAt, createdAt };
}

async function releaseCreationLock(
  lockDirectory: string,
  rootDir: string,
  nonce: string,
): Promise<void> {
  const owner = await readCreationOwner(lockDirectory);
  if (owner?.nonce !== nonce) {
    throw new Error('Continuation creation lock ownership changed before release.');
  }
  const releaseDirectory = path.join(
    rootDir,
    `${CREATION_RECLAIM_PREFIX}release-${path.basename(lockDirectory)}-${process.pid}-${nonce}`,
  );
  try {
    await fs.rename(lockDirectory, releaseDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('Continuation creation lock disappeared before release.', { cause: error });
    }
    throw error;
  }
  const movedOwner = await readCreationOwner(releaseDirectory);
  if (movedOwner?.nonce !== nonce) {
    try {
      await fs.rename(releaseDirectory, lockDirectory);
    } catch (error) {
      throw new Error('Continuation creation lock changed during release and could not be restored.', {
        cause: error,
      });
    }
    throw new Error('Continuation creation lock ownership changed during release.');
  }
  await removeManagedTree(releaseDirectory);
}

function assertEquivalentManifest(existing: InputManifest, candidate: InputManifest): void {
  if (
    existing.requestFingerprint !== candidate.requestFingerprint
    || JSON.stringify(existing.inputs) !== JSON.stringify(candidate.inputs)
  ) {
    throw new Error('Continuation idempotency conflict: managed inputs or task facts differ from the first write.');
  }
}

function parseRedactionQuarantine(
  name: string,
): { jobId: string; ownerPid: number; ownerStartedAt: number | null; createdAt: number | null } | null {
  if (!name.startsWith(REDACTION_QUARANTINE_PREFIX)) return null;
  const match = /^\.redacting-(.+)-([1-9]\d*)(?:\.([1-9]\d*))?(?:\.([1-9]\d*))?-[a-f0-9]{16}$/.exec(name);
  if (!match) return null;
  try {
    assertJobId(match[1]);
  } catch {
    return null;
  }
  const ownerPid = Number(match[2]);
  if (!Number.isSafeInteger(ownerPid)) return null;
  const ownerStartedAt = match[3] === undefined ? null : Number(match[3]);
  if (ownerStartedAt !== null && !Number.isSafeInteger(ownerStartedAt)) return null;
  const createdAt = match[4] === undefined ? null : Number(match[4]);
  if (createdAt !== null && !Number.isSafeInteger(createdAt)) return null;
  return { jobId: match[1], ownerPid, ownerStartedAt, createdAt };
}

async function removeManagedTree(target: string): Promise<void> {
  let metadata;
  try {
    metadata = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    await fs.rm(target, { force: true });
    return;
  }
  try {
    await fs.chmod(target, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(target, entry);
    let childMetadata;
    try {
      childMetadata = await fs.lstat(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink()) {
      await removeManagedTree(child);
    } else {
      if (!childMetadata.isSymbolicLink()) {
        try {
          await fs.chmod(child, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
          throw error;
        }
      }
      await fs.rm(child, { force: true });
    }
  }
  try {
    await fs.rmdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
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

async function removeAgedOrphan(
  candidate: string,
  nowMs: number,
  orphanAgeMs: number,
): Promise<void> {
  const metadata = await fs.stat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata || nowMs - metadata.mtimeMs < orphanAgeMs) return;
  await removeManagedTree(candidate);
}
