/**
 * Helpers for writing Lark SDK binary-resource responses to disk.
 *
 * The `client.im.v1.messageResource.get` API can return one of three response
 * shapes depending on the resource type and SDK version:
 *
 *  1. `Buffer` — raw bytes (rare)
 *  2. Object with `.writeFile(path)` method — legacy/fallback convenience
 *     wrapper. Used only when a readable stream is unavailable and a
 *     content-length header lets us preflight the byte cap.
 *  3. Readable stream — exposes `.pipe()`, iterable via `for await`
 *
 * Node's `fs.writeFile` only handles shape 1 natively (and streams in newer
 * Node), so callers must inspect and dispatch. This module centralises the
 * dispatch so we don't drift between `channel.downloadImage` and
 * `tools.download_attachment` (a real v1.0.5 bug — see #60).
 */
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { appConfig } from './config.js';
import { withTimeout } from './feishu-retry.js';

export type SdkResource =
  | Buffer
  | {
      writeFile?: (path: string) => Promise<void> | void;
      getReadableStream?: () => NodeJS.ReadableStream;
    }
  | NodeJS.ReadableStream
  | unknown;

export interface WriteSdkResourceOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Diagnostic shape descriptor — surfaced in error messages so callers can
 * tell *why* the write failed (helpful when an SDK upgrade introduces a new
 * shape we don't recognise).
 */
export function describeSdkResource(data: unknown): string {
  if (data === null || data === undefined) return String(data);
  if (Buffer.isBuffer(data)) return 'Buffer';
  if (typeof data === 'object' && data !== null) {
    const d = data as any;
    if (typeof d.getReadableStream === 'function') return 'object{getReadableStream()}';
    if (typeof d.writeFile === 'function') return 'object{writeFile()}';
    if (typeof d.pipe === 'function') return 'ReadableStream';
    const keys = Object.keys(d).slice(0, 5).join(',');
    return `object{${keys}}`;
  }
  return typeof data;
}

/**
 * Write a Lark SDK binary-resource response to `filePath`. Handles the three
 * known response shapes. Throws on unrecognised shape with a descriptor of
 * what was actually received — much more useful than a silent
 * `[object Object]` written to disk.
 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function tempPathFor(filePath: string): string {
  const shortBase = basename(filePath).slice(0, 80) || 'resource';
  return join(
    dirname(filePath),
    `.${shortBase}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {}
}

function ensureWithinLimit(bytes: number, maxBytes: number, label = 'resource'): void {
  if (bytes > maxBytes) {
    throw new Error(`writeSdkResource: ${label} exceeds maxBytes (${bytes} > ${maxBytes})`);
  }
}

function contentLengthOf(data: any): number | null {
  const headers = data?.headers;
  if (!headers) return null;

  let raw =
    headers['content-length'] ??
    headers['Content-Length'] ??
    (typeof headers.get === 'function' ? headers.get('content-length') : undefined);
  if (Array.isArray(raw)) raw = raw[0];

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function assertWriteFileFallbackAllowed(data: any, maxBytes: number): void {
  const contentLength = contentLengthOf(data);
  if (contentLength === null) {
    throw new Error(
      'writeSdkResource: writeFile-only SDK response cannot enforce maxBytes without content-length; ' +
        'SDK response must provide getReadableStream() for bounded downloads.',
    );
  }
  ensureWithinLimit(contentLength, maxBytes, 'content-length');
}

async function finalizeTempFile(tmpPath: string, filePath: string, maxBytes: number): Promise<void> {
  const stat = await fsp.stat(tmpPath);
  ensureWithinLimit(stat.size, maxBytes, 'resource');
  await fsp.rename(tmpPath, filePath);
}

function waitForWritable(out: NodeJS.WritableStream, event: 'drain' | 'finish', timeoutError: () => Error | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      out.off(event, onEvent);
      out.off('error', onError);
      out.off('close', onClose);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(timeoutError() ?? new Error(`writeSdkResource.stream closed before ${event}`));
    };

    out.once(event, onEvent);
    out.once('error', onError);
    out.once('close', onClose);
  });
}

async function destroyWritableAndWaitForClose(out: NodeJS.WritableStream): Promise<void> {
  if ((out as any).closed === true) return;
  const closed = finished(out as any, { cleanup: true }).catch(() => undefined);
  (out as any).destroy();
  await closed;
}

async function streamToDisk(
  stream: AsyncIterable<unknown> & { destroy?: (err?: Error) => void },
  tmpPath: string,
  maxBytes: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const out = createWriteStream(tmpPath, { flags: 'wx' });
  let bytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let timedOut: Error | null = null;

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      timedOut = err;
      stream.destroy?.(err);
      out.destroy();
    }, timeoutMs);
  }

  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      bytes += buf.length;
      ensureWithinLimit(bytes, maxBytes, 'stream');
      if (!out.write(buf)) await waitForWritable(out, 'drain', () => timedOut);
      if (timedOut) throw timedOut;
    }
    out.end();
    await waitForWritable(out, 'finish', () => timedOut);
    if (timedOut) throw timedOut;
  } catch (err) {
    stream.destroy?.(err instanceof Error ? err : new Error(String(err)));
    await destroyWritableAndWaitForClose(out);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function writeSdkResource(
  data: unknown,
  filePath: string,
  options: WriteSdkResourceOptions = {},
): Promise<void> {
  if (data === null || data === undefined) {
    throw new Error('writeSdkResource: data is null/undefined');
  }
  const maxBytes = positiveInt(options.maxBytes, appConfig.downloadMaxBytes);
  const timeoutMs = positiveInt(options.timeoutMs, appConfig.downloadTimeoutMs);
  await fsp.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);

  if (Buffer.isBuffer(data)) {
    ensureWithinLimit(data.length, maxBytes, 'Buffer');
    try {
      await fsp.writeFile(tmpPath, data, { flag: 'wx' });
      await finalizeTempFile(tmpPath, filePath, maxBytes);
    } catch (err) {
      await removeIfExists(tmpPath);
      throw err;
    }
    return;
  }

  const d = data as any;

  const readable = typeof d.getReadableStream === 'function' ? d.getReadableStream() : d;
  if (typeof readable?.pipe === 'function' || typeof readable?.[Symbol.asyncIterator] === 'function') {
    try {
      await streamToDisk(
        readable as AsyncIterable<unknown> & { destroy?: (err?: Error) => void },
        tmpPath,
        maxBytes,
        timeoutMs,
        'writeSdkResource.stream',
      );
      await finalizeTempFile(tmpPath, filePath, maxBytes);
    } catch (err) {
      readable.destroy?.(err instanceof Error ? err : new Error(String(err)));
      await removeIfExists(tmpPath);
      throw err;
    }
    return;
  }

  if (typeof d.writeFile === 'function') {
    assertWriteFileFallbackAllowed(d, maxBytes);
    let writePromise: Promise<unknown> | null = null;
    try {
      writePromise = Promise.resolve(d.writeFile(tmpPath));
      await withTimeout(writePromise, timeoutMs, 'writeSdkResource.writeFile');
      await finalizeTempFile(tmpPath, filePath, maxBytes);
    } catch (err) {
      if (writePromise) {
        void writePromise.finally(() => removeIfExists(tmpPath)).catch(() => undefined);
      }
      await removeIfExists(tmpPath);
      throw err;
    }
    return;
  }

  throw new Error(
    `writeSdkResource: unrecognised SDK response shape (${describeSdkResource(data)}) — ` +
      'the Lark SDK returned a value not matching Buffer / .writeFile() / Readable. ' +
      'Likely an SDK upgrade introduced a new shape; extend writeSdkResource.',
  );
}
