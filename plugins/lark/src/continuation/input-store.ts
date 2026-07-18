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

const MANIFEST_FILE = '.manifest.json';
const DEFAULT_ORPHAN_AGE_MS = 60 * 60 * 1_000;
const CREATION_LOCK_PREFIX = '.creating-';
const CREATION_LOCK_WAIT_MS = 5 * 60 * 1_000;

export function continuationJobId(idempotencyKey: string): string {
  if (!idempotencyKey) throw new Error('Continuation idempotency key is required.');
  return `job_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
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
    while (true) {
      try {
        await fs.mkdir(lockDirectory, { mode: 0o700 });
        try {
          await fs.writeFile(
            path.join(lockDirectory, 'owner.json'),
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
            { mode: 0o600, flag: 'wx' },
          );
        } catch (error) {
          await removeManagedTree(lockDirectory).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new Error('Continuation creation is already in progress for this idempotency key.');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await operation();
    } finally {
      await removeManagedTree(lockDirectory).catch(() => {});
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
        const relativePath = `${id}-${source.fileName}`;
        const copied = await copyRegularFile(
          source.sourcePath,
          path.join(stagingDirectory, relativePath),
          this.maxFileBytes,
        );
        totalBytes += copied.sizeBytes;
        if (totalBytes > this.maxTotalBytes) {
          throw new Error(`Continuation input total byte limit exceeded: ${totalBytes} > ${this.maxTotalBytes}.`);
        }
        artifacts.push({
          id,
          kind: source.kind,
          fileName: source.fileName,
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
    })), requestFingerprint);
  }

  async verify(
    jobId: string,
    artifacts: readonly AsyncTaskInputArtifact[],
  ): Promise<ContinuationInputVerification> {
    if (artifacts.length === 0) return { ok: true };
    try {
      const directory = this.jobDirectory(jobId);
      await assertDirectory(directory);
      for (const artifact of artifacts) {
        validateArtifact(artifact);
        const filePath = this.resolve(jobId, artifact.relativePath);
        const metadata = await fs.lstat(filePath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) return { ok: false, reason: 'invalid' };
        if (metadata.size !== artifact.sizeBytes) return { ok: false, reason: 'modified' };
        const digest = await sha256File(filePath);
        if (digest !== artifact.sha256) return { ok: false, reason: 'modified' };
      }
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'invalid' };
    }
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

  async cleanupOrphans(jobIds: ReadonlySet<string>, nowMs = Date.now()): Promise<void> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const liveCreationJobs = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(CREATION_LOCK_PREFIX)) continue;
      const lockDirectory = path.join(this.rootDir, entry.name);
      const jobId = entry.name.slice(CREATION_LOCK_PREFIX.length);
      const owner = await readCreationOwner(lockDirectory);
      if (owner !== null && isProcessAlive(owner)) {
        liveCreationJobs.add(jobId);
        continue;
      }
      const metadata = await fs.stat(lockDirectory);
      if (nowMs - metadata.mtimeMs >= this.orphanAgeMs) {
        await removeManagedTree(lockDirectory);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const isStaging = entry.name.startsWith('.staging-');
      if (entry.name.startsWith(CREATION_LOCK_PREFIX)) continue;
      if (!isStaging && jobIds.has(entry.name)) continue;
      if (!isStaging && liveCreationJobs.has(entry.name)) continue;
      if (isStaging && [...liveCreationJobs].some((jobId) =>
        entry.name.startsWith(`.staging-${jobId}-`))) continue;
      const candidate = path.join(this.rootDir, entry.name);
      const metadata = await fs.stat(candidate);
      if (nowMs - metadata.mtimeMs < this.orphanAgeMs) continue;
      await removeManagedTree(candidate);
    }
  }

  private validateSources(sources: readonly AsyncTaskSourceInput[]): void {
    if (sources.length > this.maxFiles) {
      throw new Error(`Continuation input file count exceeds ${this.maxFiles}.`);
    }
    const names = new Set<string>();
    for (const source of sources) {
      if (!['message_image', 'message_attachment'].includes(source.kind)) {
        throw new Error('Continuation input kind is invalid.');
      }
      validateFileName(source.fileName);
      const key = source.fileName.normalize('NFC').toLocaleLowerCase('en-US');
      if (names.has(key)) throw new Error('Duplicate continuation input file name collision.');
      names.add(key);
      if (!path.isAbsolute(source.sourcePath)) {
        throw new Error('Continuation input source path must be absolute and server-admitted.');
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
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  maxFileBytes: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
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

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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

function isInstallRace(error: unknown): boolean {
  return ['EACCES', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
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

async function readCreationOwner(lockDirectory: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8')) as {
      pid?: unknown;
    };
    return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function assertEquivalentManifest(existing: InputManifest, candidate: InputManifest): void {
  if (
    existing.requestFingerprint !== candidate.requestFingerprint
    || JSON.stringify(existing.inputs) !== JSON.stringify(candidate.inputs)
  ) {
    throw new Error('Continuation idempotency conflict: managed inputs or task facts differ from the first write.');
  }
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
  await fs.chmod(target, 0o700);
  for (const entry of await fs.readdir(target)) {
    const child = path.join(target, entry);
    const childMetadata = await fs.lstat(child);
    if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink()) {
      await removeManagedTree(child);
    } else {
      if (!childMetadata.isSymbolicLink()) await fs.chmod(child, 0o600);
      await fs.rm(child, { force: true });
    }
  }
  await fs.rmdir(target);
}
