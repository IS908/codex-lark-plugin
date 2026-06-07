/**
 * download_attachment + writeSdkResource smoke test.
 *
 * Verifies:
 *  - All three Lark SDK response shapes (Buffer / object.writeFile / Readable)
 *    are correctly written to disk by `writeSdkResource`.
 *  - The `download_attachment` tool routes resourceType by file_key prefix
 *    (img_* -> image, else -> file).
 *  - Saved filename preserves the original extension when `file_name` is
 *    provided (regression guard for the PDF-Codex-Read bug).
 *  - Error path returns a diagnostic message (not the old generic
 *    "Failed to download attachment").
 *  - Unknown SDK shape throws with a descriptive error (helps future
 *    SDK-upgrade triage).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { writeSdkResource, describeSdkResource } from '../src/sdk-resource.js';
import { capSanitizedFilename } from '../src/tools.js';
import { registerTools } from '../src/tools.js';
import { appConfig } from '../src/config.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

const tmpInbox = mkdtempSync(path.join(tmpdir(), 'download-attach-inbox-'));
const originalInboxDir = appConfig.inboxDir;
(appConfig as { inboxDir: string }).inboxDir = tmpInbox;

async function assertRejects(promise: Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await promise;
    fail(`${label}: expected rejection`);
  } catch (err: any) {
    if (!pattern.test(err?.message ?? String(err))) {
      fail(`${label}: rejection mismatch: ${err?.message ?? String(err)}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNoTempFiles(label: string): void {
  const leftovers = readdirSync(tmpInbox).filter((name) => name.includes('.tmp-'));
  if (leftovers.length) fail(`${label}: temp files left behind: ${leftovers.join(', ')}`);
}

// 1. writeSdkResource: shape 1 (Buffer)
{
  const filePath = path.join(tmpInbox, 'shape1.bin');
  await writeSdkResource(Buffer.from('buffer-content'), filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'buffer-content') fail(`1: buffer write mismatch: ${written}`);
  passed++;
}

// 2. writeSdkResource: shape 2 (object with .writeFile method)
{
  const filePath = path.join(tmpInbox, 'shape2.bin');
  const mockSdkResp = {
    headers: { 'content-length': '21' },
    async writeFile(p: string): Promise<void> {
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, 'sdk-writeFile-content');
    },
  };
  await writeSdkResource(mockSdkResp, filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'sdk-writeFile-content') fail(`2: sdk writeFile mismatch: ${written}`);
  passed++;
}

// 2b. writeFile-only fallback rejects when it cannot preflight maxBytes.
{
  const filePath = path.join(tmpInbox, 'shape2-no-length.bin');
  let writeFileCalled = false;
  const mockSdkResp = {
    async writeFile(p: string): Promise<void> {
      writeFileCalled = true;
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, 'should-not-write');
    },
  };
  await assertRejects(
    writeSdkResource(mockSdkResp, filePath),
    /writeFile-only SDK response cannot enforce maxBytes/,
    '2b',
  );
  if (writeFileCalled) fail('2b: writeFile should not be called without content-length preflight');
  if (existsSync(filePath)) fail('2b: writeFile-only no-length file should not be written');
  assertNoTempFiles('2b');
  passed++;
}

// 2c. writeFile-only fallback rejects oversize content-length before writing.
{
  const filePath = path.join(tmpInbox, 'shape2-too-large.bin');
  let writeFileCalled = false;
  const mockSdkResp = {
    headers: { 'content-length': '8' },
    async writeFile(p: string): Promise<void> {
      writeFileCalled = true;
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, '12345678');
    },
  };
  await assertRejects(
    writeSdkResource(mockSdkResp, filePath, { maxBytes: 6 }),
    /content-length exceeds maxBytes/,
    '2c',
  );
  if (writeFileCalled) fail('2c: writeFile should not be called for oversize content-length');
  if (existsSync(filePath)) fail('2c: over-cap writeFile fallback should not be written');
  assertNoTempFiles('2c');
  passed++;
}

// 2d. writeFile fallback synchronous failures still clean up temp paths.
{
  const filePath = path.join(tmpInbox, 'shape2-sync-throw.bin');
  const mockSdkResp = {
    headers: { 'content-length': '4' },
    writeFile(): void {
      throw new Error('sync writeFile boom');
    },
  };
  await assertRejects(
    writeSdkResource(mockSdkResp, filePath),
    /sync writeFile boom/,
    '2d',
  );
  if (existsSync(filePath)) fail('2d: sync-throw writeFile fallback should not be written');
  assertNoTempFiles('2d');
  passed++;
}

// 3. writeSdkResource: shape 3 (Readable stream)
{
  const filePath = path.join(tmpInbox, 'shape3.bin');
  const stream = Readable.from([Buffer.from('chunk1-'), Buffer.from('chunk2')]);
  await writeSdkResource(stream, filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'chunk1-chunk2') fail(`3: stream write mismatch: ${written}`);
  passed++;
}

// 3b. writeSdkResource: Buffer size cap rejects before writing
{
  const filePath = path.join(tmpInbox, 'too-large-buffer.bin');
  await assertRejects(
    writeSdkResource(Buffer.from('too-large'), filePath, { maxBytes: 3 }),
    /exceeds maxBytes/,
    '3b',
  );
  if (existsSync(filePath)) fail('3b: over-cap buffer should not be written');
  assertNoTempFiles('3b');
  passed++;
}

// 3c. writeSdkResource: streams to disk and enforces byte cap
{
  const filePath = path.join(tmpInbox, 'too-large-stream.bin');
  const stream = Readable.from([Buffer.from('1234'), Buffer.from('5678')]);
  await assertRejects(
    writeSdkResource(stream, filePath, { maxBytes: 6 }),
    /exceeds maxBytes/,
    '3c',
  );
  if (existsSync(filePath)) fail('3c: over-cap stream file should be removed');
  assertNoTempFiles('3c');
  passed++;
}

// 3d. writeSdkResource: stalled streams time out
{
  const filePath = path.join(tmpInbox, 'stall-stream.bin');
  const stalled = new Readable({
    read() {},
  });
  await assertRejects(
    writeSdkResource(stalled, filePath, { timeoutMs: 5 }),
    /timed out after 5ms/,
    '3d',
  );
  if (existsSync(filePath)) fail('3d: timed-out stream file should be removed');
  assertNoTempFiles('3d');
  stalled.destroy();
  passed++;
}

// 3e. SDK wrapper shape prefers getReadableStream over writeFile so byte caps
// are enforced before writing the full resource.
{
  const filePath = path.join(tmpInbox, 'sdk-wrapper-too-large.bin');
  let writeFileCalled = false;
  const sdkWrapper = {
    async writeFile(): Promise<void> {
      writeFileCalled = true;
      throw new Error('writeFile should not be used when getReadableStream exists');
    },
    getReadableStream() {
      return Readable.from([Buffer.from('1234'), Buffer.from('5678')]);
    },
  };
  await assertRejects(
    writeSdkResource(sdkWrapper, filePath, { maxBytes: 6 }),
    /exceeds maxBytes/,
    '3e',
  );
  if (writeFileCalled) fail('3e: writeFile should not be called for SDK stream wrapper');
  if (existsSync(filePath)) fail('3e: over-cap SDK stream file should be removed');
  assertNoTempFiles('3e');
  passed++;
}

// 3f. SDK wrapper stream timeout destroys and cleans up.
{
  const filePath = path.join(tmpInbox, 'sdk-wrapper-stall.bin');
  const stalled = new Readable({
    read() {},
  });
  const sdkWrapper = {
    getReadableStream() {
      return stalled;
    },
  };
  await assertRejects(
    writeSdkResource(sdkWrapper, filePath, { timeoutMs: 5 }),
    /timed out after 5ms/,
    '3f',
  );
  if (existsSync(filePath)) fail('3f: timed-out SDK stream file should be removed');
  assertNoTempFiles('3f');
  stalled.destroy();
  passed++;
}

// 3g. Long final basenames still work because temp names are capped separately.
{
  const longName = `${'a'.repeat(240)}.txt`;
  const filePath = path.join(tmpInbox, longName);
  await writeSdkResource(Buffer.from('long-name-ok'), filePath);
  const written = readFileSync(filePath, 'utf-8');
  if (written !== 'long-name-ok') fail(`3g: long basename write mismatch: ${written}`);
  passed++;
}

// 3h. Delayed SDK writeFile fallback cannot be cancelled, so timeout cleanup
// must also remove temp files created after writeSdkResource rejects.
{
  const filePath = path.join(tmpInbox, 'sdk-writefile-timeout.bin');
  const mockSdkResp = {
    headers: { 'content-length': '10' },
    async writeFile(p: string): Promise<void> {
      const fsp = await import('node:fs/promises');
      await delay(20);
      await fsp.writeFile(p, 'late-write');
    },
  };
  await assertRejects(
    writeSdkResource(mockSdkResp, filePath, { timeoutMs: 5 }),
    /writeSdkResource\.writeFile timed out after 5ms/,
    '3h',
  );
  await delay(40);
  if (existsSync(filePath)) fail('3h: timed-out writeFile fallback should not be finalized');
  assertNoTempFiles('3h');
  passed++;
}

// 4. writeSdkResource: unknown shape throws descriptively
{
  try {
    await writeSdkResource({ randomKey: 'no writeFile, no pipe' }, path.join(tmpInbox, 'nope.bin'));
    fail('4: should have thrown on unknown shape');
  } catch (err: any) {
    if (!/unrecognised SDK response shape/.test(err.message)) {
      fail(`4: error message lacks diagnostic: ${err.message}`);
    }
    if (!/object\{randomKey\}/.test(err.message)) {
      fail(`4: error message lacks shape descriptor: ${err.message}`);
    }
  }
  passed++;
}

// 5. writeSdkResource: null/undefined throws cleanly
{
  try {
    await writeSdkResource(null, path.join(tmpInbox, 'null.bin'));
    fail('5a: should have thrown on null');
  } catch (err: any) {
    if (!/null/.test(err.message)) fail(`5a: bad null error: ${err.message}`);
  }
  try {
    await writeSdkResource(undefined, path.join(tmpInbox, 'undef.bin'));
    fail('5b: should have thrown on undefined');
  } catch (err: any) {
    if (!/undefined/.test(err.message)) fail(`5b: bad undefined error: ${err.message}`);
  }
  passed++;
}

// 6. describeSdkResource: produces useful labels
{
  if (describeSdkResource(Buffer.from('x')) !== 'Buffer') fail('6: Buffer label');
  if (describeSdkResource({ writeFile: () => {} }) !== 'object{writeFile()}') fail('6: writeFile label');
  if (describeSdkResource({ getReadableStream: () => Readable.from([]), writeFile: () => {} }) !== 'object{getReadableStream()}') {
    fail('6: getReadableStream label');
  }
  if (describeSdkResource(Readable.from([])) !== 'ReadableStream') fail('6: stream label');
  if (describeSdkResource(null) !== 'null') fail('6: null label');
  passed++;
}

const apiCalls: { method: string; args: any }[] = [];

function mockClient(respFor: (fileKey: string, type: string) => unknown) {
  return {
    im: {
      v1: {
        message: { create: async () => ({}), reply: async () => ({}) },
        messageReaction: { create: async () => {}, delete: async () => {} },
        image: { create: async () => ({}), get: async () => Buffer.from('') },
        file: { create: async () => ({}) },
        messageResource: {
          get: async (args: any) => {
            apiCalls.push({ method: 'messageResource.get', args });
            return respFor(args?.path?.file_key, args?.params?.type);
          },
        },
      },
    },
  };
}

const noopMemory = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async () => {},
} as unknown as MemoryStore;

const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;
const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

function setup(respFor: (fileKey: string, type: string) => unknown) {
  apiCalls.length = 0;
  const client = mockClient(respFor);
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('chat_001', undefined, 'ou_caller');
  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    { record() {}, flush: async () => {}, startAutoFlush: () => {}, stopAutoFlush: () => {} } as any,
    new Map<string, string>(),
    { ids: new Set(), add() {}, has: () => false } as any,
    undefined,
  );
  const dl = handlers.get('download_attachment');
  if (!dl) fail('download_attachment handler not registered');
  return dl;
}

// 7. img_* file_key routes to type='image'
{
  const dl = setup(() => Buffer.from('img-bytes'));
  const r = await dl({ message_id: 'om_x', file_key: 'img_abc' });
  if (apiCalls[0]?.args?.params?.type !== 'image') {
    fail(`7: expected type=image for img_* key, got ${apiCalls[0]?.args?.params?.type}`);
  }
  if (!/Downloaded to /.test(r.content[0].text)) fail(`7: success text wrong: ${r.content[0].text}`);
  passed++;
}

// 8. file_v3_* file_key routes to type='file'
{
  const dl = setup(() => Buffer.from('pdf-bytes'));
  await dl({ message_id: 'om_x', file_key: 'file_v3_xyz' });
  if (apiCalls[0]?.args?.params?.type !== 'file') {
    fail(`8: expected type=file for non-img key, got ${apiCalls[0]?.args?.params?.type}`);
  }
  passed++;
}

// 9. file_name preserves extension in saved path
{
  const dl = setup(() => Buffer.from('pdf-bytes'));
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: 'report.pdf',
  });
  const txt = r.content[0].text as string;
  if (!txt.endsWith('file_v3_xyz-report.pdf')) {
    fail(`9: expected save path to end with file_v3_xyz-report.pdf, got: ${txt}`);
  }
  passed++;
}

// 10. file_name sanitization (path traversal / bad chars)
{
  const dl = setup(() => Buffer.from('x'));
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: '../../../etc/passwd',
  });
  const txt = r.content[0].text as string;
  if (/\.\.\//.test(txt) || /\/etc\//.test(txt)) {
    fail(`10: path traversal not sanitized: ${txt}`);
  }
  if (!/passwd/.test(txt)) fail(`10: legitimate filename component lost: ${txt}`);
  passed++;
}

// 11. Shape 2 (writeFile method) end-to-end through the tool
{
  const dl = setup(() => ({
    headers: { 'content-length': '22' },
    async writeFile(p: string): Promise<void> {
      const fsp = await import('node:fs/promises');
      await fsp.writeFile(p, 'shape-2-end-to-end');
    },
  }));
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_pdf', file_name: 'doc.pdf' });
  const txt = r.content[0].text as string;
  const match = /Downloaded to (.+)/.exec(txt);
  if (!match) fail(`11: success text malformed: ${txt}`);
  const saved = readFileSync(match![1], 'utf-8');
  if (saved !== 'shape-2-end-to-end') fail(`11: file content wrong: ${saved}`);
  passed++;
}

// 12. SDK API error -> diagnostic, not generic "Failed"
{
  const dl = setup(() => {
    const err: any = new Error('boom');
    err.response = { data: { code: 99991668, msg: 'invalid file_key' } };
    throw err;
  });
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_bad' });
  if (!r.isError) fail('12: should set isError');
  const txt = r.content[0].text as string;
  if (!/99991668/.test(txt)) fail(`12: error code missing: ${txt}`);
  if (!/invalid file_key/.test(txt)) fail(`12: error msg missing: ${txt}`);
  if (!/file_v3_bad/.test(txt)) fail(`12: file_key context missing: ${txt}`);
  passed++;
}

// 13. Unknown SDK shape -> tool returns diagnostic isError
{
  const dl = setup(() => ({ unknownShape: true }));
  const r = await dl({ message_id: 'om_x', file_key: 'file_v3_xyz' });
  if (!r.isError) fail('13: should set isError for unknown shape');
  const txt = r.content[0].text as string;
  if (!/unrecognised SDK response shape/.test(txt)) {
    fail(`13: diagnostic text missing: ${txt}`);
  }
  passed++;
}

// 14. download_attachment passes configured maxBytes into writeSdkResource.
{
  const originalDownloadMaxBytes = appConfig.downloadMaxBytes;
  (appConfig as { downloadMaxBytes: number }).downloadMaxBytes = 3;
  try {
    const dl = setup(() => Readable.from([Buffer.from('1234')]));
    const r = await dl({ message_id: 'om_x', file_key: 'file_v3_big', file_name: 'big.bin' });
    if (!r.isError) fail('14: over-cap handler download should return isError');
    const txt = r.content[0].text as string;
    if (!/exceeds maxBytes/.test(txt)) fail(`14: maxBytes error missing: ${txt}`);
    if (existsSync(path.join(tmpInbox, 'file_v3_big-big.bin'))) fail('14: over-cap handler file should not be written');
    assertNoTempFiles('14');
  } finally {
    (appConfig as { downloadMaxBytes: number }).downloadMaxBytes = originalDownloadMaxBytes;
  }
  passed++;
}

// 15. download_attachment passes configured timeout into writeSdkResource.
{
  const originalDownloadTimeoutMs = appConfig.downloadTimeoutMs;
  const stalled = new Readable({
    read() {},
  });
  (appConfig as { downloadTimeoutMs: number }).downloadTimeoutMs = 5;
  try {
    const dl = setup(() => stalled);
    const r = await dl({ message_id: 'om_x', file_key: 'file_v3_stall', file_name: 'stall.bin' });
    if (!r.isError) fail('15: stalled handler download should return isError');
    const txt = r.content[0].text as string;
    if (!/timed out after 5ms/.test(txt)) fail(`15: timeout error missing: ${txt}`);
    if (existsSync(path.join(tmpInbox, 'file_v3_stall-stall.bin'))) fail('15: timed-out handler file should not be written');
    assertNoTempFiles('15');
  } finally {
    stalled.destroy();
    (appConfig as { downloadTimeoutMs: number }).downloadTimeoutMs = originalDownloadTimeoutMs;
  }
  passed++;
}

// 10b. file_name length cap preserves extension (NAME_MAX defense)
{
  const dl = setup(() => Buffer.from('x'));
  // 400-char filename; cap should kick in but .pdf must survive
  const longName = 'a'.repeat(400) + '.pdf';
  const r = await dl({
    message_id: 'om_x',
    file_key: 'file_v3_xyz',
    file_name: longName,
  });
  const txt = r.content[0].text as string;
  const match = /Downloaded to (.+)/.exec(txt);
  if (!match) fail(`10b: tool did not succeed: ${txt}`);
  const baseName = path.basename(match![1]);
  const sanitizedPortion = baseName.slice(baseName.indexOf('-') + 1);
  if (sanitizedPortion.length > 200) {
    fail(`10b: sanitized portion not capped: ${sanitizedPortion.length} chars`);
  }
  if (!sanitizedPortion.endsWith('.pdf')) {
    fail(`10b: extension lost during cap: ${sanitizedPortion}`);
  }
  passed++;
}

// 10c. capSanitizedFilename helper — direct unit tests
{
  // Short names pass through (sanitized)
  if (capSanitizedFilename('report.pdf', 200) !== 'report.pdf') fail('10c.1');
  // Long stem, extension preserved
  const r2 = capSanitizedFilename('a'.repeat(300) + '.pdf', 200);
  if (!r2.endsWith('.pdf')) fail(`10c.2: ext lost: ${r2}`);
  if (r2.length > 200) fail(`10c.2: not capped: ${r2.length}`);
  // No extension
  const r3 = capSanitizedFilename('x'.repeat(300), 200);
  if (r3.length !== 200) fail(`10c.3: no-ext cap: ${r3.length}`);
  // Pathological long extension — capped at half maxLen so stem keeps space
  const r4 = capSanitizedFilename('stem.' + 'e'.repeat(300), 200);
  if (r4.length > 200) fail(`10c.4: long-ext not capped: ${r4.length}`);
  if (!r4.startsWith('stem')) fail(`10c.4: stem lost: ${r4}`);
  // Leading-dot file (e.g. ".env") — no extension to preserve
  if (capSanitizedFilename('.env', 200) !== '.env') fail('10c.5');
  // CJK chars stripped (sanitization preserved)
  if (capSanitizedFilename('报告.pdf', 200) !== '__.pdf') fail('10c.6');
  // path traversal stripped
  const r7 = capSanitizedFilename('../../etc/passwd', 200);
  if (r7.includes('/') || r7.includes('..')) fail(`10c.7: traversal: ${r7}`);
  passed++;
}

rmSync(tmpInbox, { recursive: true, force: true });
(appConfig as { inboxDir: string }).inboxDir = originalInboxDir;

console.log(`download-attachment smoke: ${passed}/27 PASS`);
