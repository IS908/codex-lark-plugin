import assert from 'node:assert/strict';
import { addSdkImageDownloads } from '../src/inbound-attachment-downloader.js';

const writes: Array<{ data: unknown; filePath: string; maxBytes?: number; timeoutMs?: number }> = [];
const downloads: Array<{ messageId: string; fileKey: string; resourceType: 'image' | 'file' }> = [];

const makeOptions = () => ({
  inboxDir: '/tmp/codex-lark-inbox-test',
  now: () => 123456789,
  maxBytes: 10,
  timeoutMs: 20,
  log: () => {},
  writeResource: async (
    data: unknown,
    filePath: string,
    options: { maxBytes?: number; timeoutMs?: number },
  ) => {
    writes.push({ data, filePath, ...options });
  },
});

const makeTransport = (failKey?: string) => ({
  downloadResource: async (messageId: string, fileKey: string, resourceType: 'image' | 'file') => {
    downloads.push({ messageId, fileKey, resourceType });
    if (fileKey === failKey) throw new Error('download failed');
    return Buffer.from(`${messageId}:${fileKey}:${resourceType}`);
  },
});

{
  downloads.length = 0;
  writes.length = 0;
  const message = { messageId: 'om_sdk' };

  await addSdkImageDownloads(
    message,
    [
      { type: 'image', fileKey: 'img_one', fileName: 'one.png' },
      { type: 'file', fileKey: 'file_skip', fileName: 'skip.pdf' },
      { type: 'image', fileKey: 'img_two', fileName: 'two/name.png' },
      { type: 'image', fileName: 'missing-key.png' },
    ],
    makeTransport(),
    makeOptions(),
  );

  assert.deepEqual(downloads, [
    { messageId: 'om_sdk', fileKey: 'img_one', resourceType: 'image' },
    { messageId: 'om_sdk', fileKey: 'img_two', resourceType: 'image' },
  ]);
  assert.equal(message.imagePath, undefined);
  assert.deepEqual(message.imagePaths, [
    '/tmp/codex-lark-inbox-test/123456789-img_one-one.png',
    '/tmp/codex-lark-inbox-test/123456789-img_two-two_name.png',
  ]);
}

{
  downloads.length = 0;
  writes.length = 0;
  const message = { messageId: 'om_best_effort' };

  await addSdkImageDownloads(
    message,
    [
      { type: 'image', fileKey: 'img_ok', fileName: 'ok.png' },
      { type: 'image', fileKey: 'img_fail', fileName: 'fail.png' },
    ],
    makeTransport('img_fail'),
    makeOptions(),
  );

  assert.equal(message.imagePath, '/tmp/codex-lark-inbox-test/123456789-img_ok-ok.png');
  assert.equal(message.imagePaths, undefined);
}

console.log('inbound-attachment-downloader smoke: PASS');
