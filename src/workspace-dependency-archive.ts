import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Parser } from 'tar';
import { fromRandomAccessReaderPromise, RandomAccessReader } from 'yauzl';

const defaultLimits = { bytes: 2 * 1024 ** 3, entries: 150_000 };
const block = 4096;
const readSize = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class WorkspaceDependencyArchiveError extends Error {
  constructor(readonly code: 'dependency_archive_invalid' | 'dependency_archive_budget_exceeded') {
    super(code === 'dependency_archive_invalid'
      ? 'A selected dependency archive uses an invalid or unsupported layout.'
      : 'The selected dependency archives exceed the install expansion budget.');
  }
}

/** Read-only inspection. Charge every install occurrence, not just each cache blob. */
export function createWorkspaceDependencyExpansionBudget(limits = defaultLimits) {
  let bytes = 0;
  let entries = 0;
  let tarStreamBytes = 0;
  let usable = true;
  const exceeds = () => { throw new WorkspaceDependencyArchiveError('dependency_archive_budget_exceeded'); };
  const charge = (extra: number, slots: number, copies: number) => {
    bytes += extra * copies;
    entries += slots * copies;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(entries) || bytes > limits.bytes || entries > limits.entries) exceeds();
  };
  return {
    async inspect(file: FileHandle, size: number, ecosystem: 'npm' | 'pip', copies = 1) {
      if (!usable || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(copies) || copies < 1) invalid();
      try {
        const seen = new Set<string>();
        charge(block, 1, copies);
        const entry = (name: string, length: number, directory: boolean) => {
          const parts = archivePath(name, directory);
          if (ecosystem === 'npm' && (parts[0] !== 'package' || (!directory && parts.length < 2))) invalid();
          const key = parts.join('/');
          if (seen.has(key) || !Number.isSafeInteger(length) || length < 0 || (directory && length !== 0)) invalid();
          seen.add(key);
          // Count implicit parent directories too, without crediting shared prefixes.
          charge(Math.ceil(length / block) * block + block * parts.length, parts.length, copies);
        };
        if (ecosystem === 'npm') {
          await inspectTar(file, size, entry, (length) => {
            tarStreamBytes += length * copies;
            if (tarStreamBytes > limits.bytes) exceeds();
          });
        } else await inspectWheel(file, size, entry);
        if (!seen.size) invalid();
      } catch (error) {
        usable = false;
        if (error instanceof WorkspaceDependencyArchiveError) throw error;
        invalid();
      }
    },
  };
}

type RecordEntry = (name: string, length: number, directory: boolean) => void;

async function inspectTar(file: FileHandle, size: number, record: RecordEntry, count: (bytes: number) => void) {
  let error: unknown;
  let ended = false;
  const parser = new Parser({ strict: true, brotli: false, zstd: false, maxMetaEntrySize: 16 * 1024,
    onReadEntry(entry) {
      const directory = entry.type === 'Directory';
      if (entry.type !== 'File' && entry.type !== 'OldFile' && !directory) invalid();
      record(entry.path, entry.size, directory);
      entry.resume();
    },
  });
  parser.on('error', (err) => { error = err; });
  parser.on('ignoredEntry', invalid);
  parser.on('meta', validateTarMetadata);
  parser.on('end', () => { ended = true; });
  let first = true;
  await pipeline(Readable.from(readRange(file, 0, size)), createGunzip(), async (chunks) => {
    for await (const data of chunks) {
      const chunk: Buffer = data;
      count(chunk.length);
      if (first) {
        // The outer stream is the only decompressor; do not feed another compressed stream to the parser.
        if (chunk[0] < 0x20 || chunk[0] > 0x7e) invalid();
        first = false;
      }
      parser.write(chunk);
      if (error) throw error;
    }
    parser.end();
    if (error) throw error;
    if (!ended) invalid();
  });
}

function validateTarMetadata(meta: string) {
  // Ordinary PAX metadata is supported; reject extensions that can change file type or physical size.
  const lines = meta.replace(/\n$/, '').split('\n');
  for (const line of lines) {
    const item = /^(\d+) (path|mtime|atime|ctime|uid|gid|uname|gname)=([^\u0000-\u001f]*)$/.exec(line);
    if (!item || Number(item[1]) !== Buffer.byteLength(line) + 1) invalid();
  }
}

async function inspectWheel(file: FileHandle, size: number, record: RecordEntry) {
  const reader = new PinnedZipReader(file);
  const zip = await fromRandomAccessReaderPromise(reader, size, { autoClose: true, decodeStrings: false, validateEntrySizes: true });
  for await (const entry of zip.eachEntry()) {
    const name = utf8.decode(entry.fileNameRaw);
    const directory = name.endsWith('/');
    const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
    const flags = entry.generalPurposeBitFlag;
    if (!Buffer.from(name).equals(entry.fileNameRaw) || (flags & ~0x080e) !== 0
      || (!(flags & 0x0800) && /[^\x00-\x7f]/.test(name))
      || (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000))
      || ![0, 8].includes(entry.compressionMethod)) invalid();
    const local = await zip.readLocalFileHeaderPromise(entry);
    const agrees = (localValue: number, centralValue: number) => localValue === centralValue || ((flags & 8) !== 0 && localValue === 0);
    if (!local.fileName.equals(entry.fileNameRaw) || local.generalPurposeBitFlag !== flags
      || local.compressionMethod !== entry.compressionMethod || !agrees(local.crc32, entry.crc32)
      || !agrees(local.uncompressedSize, entry.uncompressedSize) || !agrees(local.compressedSize, entry.compressedSize)) invalid();
    record(name, entry.uncompressedSize, directory);
    const stream = await zip.openReadStreamPromise(entry);
    for await (const _chunk of stream) { /* Drain to validate the measured expansion without extracting anything. */ }
  }
}

class PinnedZipReader extends RandomAccessReader {
  constructor(private readonly file: FileHandle) { super(); }
  override _readStreamForRange(start: number, end: number): Readable {
    return Readable.from(readRange(this.file, start, end));
  }
  override close(callback: (err: Error | null) => void): void { callback(null); }
}

async function* readRange(file: FileHandle, start: number, end: number) {
  for (let offset = start; offset < end;) {
    const buffer = Buffer.allocUnsafe(Math.min(readSize, end - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) invalid();
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function archivePath(value: string, directory: boolean): string[] {
  const name = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = name.split('/');
  if (!name || Buffer.byteLength(name) > 4096 || parts.length > 96 || /[\\:\u0000-\u001f\u007f\ufffd]/u.test(name)
    || parts.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) invalid();
  return parts;
}

function invalid(): never { throw new WorkspaceDependencyArchiveError('dependency_archive_invalid'); }
