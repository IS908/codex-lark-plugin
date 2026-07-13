import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
} from '../src/codex-session-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-06-17T00:00:00.000Z');
const root = await mkdtemp(join(tmpdir(), 'codex-session-store-'));
const store = new FileCodexExecSessionStore(root);
const sessionPath = (key: string) => join(root, `${Buffer.from(key, 'utf8').toString('base64url')}.json`);

const oldKey = buildCodexExecSessionKey('oc_old', 'omt_old');
const recentKey = buildCodexExecSessionKey('oc_recent');
const activeKey = buildCodexExecSessionKey('oc_active');

await store.set({
  key: oldKey,
  sessionId: 'old-session',
  chatId: 'oc_old',
  threadId: 'omt_old',
  updatedAt: new Date(now.getTime() - 20 * DAY_MS).toISOString(),
});
await utimes(sessionPath(oldKey), new Date(now.getTime() - 20 * DAY_MS), new Date(now.getTime() - 20 * DAY_MS));
await store.set({
  key: recentKey,
  sessionId: 'recent-session',
  chatId: 'oc_recent',
  updatedAt: new Date(now.getTime() - 2 * DAY_MS).toISOString(),
  generation: 3,
  cutoffMessageId: 'om_new_recent',
  cutoffTimestampMs: now.getTime() - DAY_MS,
  handoffSummary: 'recent handoff',
});
await store.set({
  key: activeKey,
  sessionId: 'active-session',
  chatId: 'oc_active',
  updatedAt: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
});
await utimes(sessionPath(activeKey), new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() - 30 * DAY_MS));
await writeFile(join(root, 'invalid.json'), '{"key":"broken"', 'utf8');
await writeFile(
  join(root, 'incomplete.json'),
  `${JSON.stringify({ key: 'incomplete', sessionId: 's', chatId: 'oc_missing_updated_at' })}\n`,
  'utf8',
);
await writeFile(join(root, 'notes.txt'), 'not a session record', 'utf8');
await mkdir(join(root, 'empty', 'child'), { recursive: true });

const dryRun = await store.cleanupExpired({
  retentionMs: 14 * DAY_MS,
  now,
  dryRun: true,
  activeKeys: new Set([activeKey]),
});
assert.equal(dryRun.scanned, 6);
assert.equal(dryRun.eligible, 1);
assert.equal(dryRun.deleted, 0);
assert.equal(dryRun.skippedActive, 1);
assert.equal(dryRun.skippedRecent, 1);
assert.equal(dryRun.skippedAbnormal, 2);
assert.equal(dryRun.skippedOther, 1);
assert.equal(dryRun.failed, 0);
assert.equal(dryRun.removedEmptyDirs, 0);
assert.deepEqual(dryRun.candidates.map((candidate) => candidate.key), [oldKey]);
assert.equal((await store.get(oldKey))?.sessionId, 'old-session');

const cleanup = await store.cleanupExpired({
  retentionMs: 14 * DAY_MS,
  now,
  dryRun: false,
  activeKeys: new Set([activeKey]),
});
assert.equal(cleanup.eligible, 1);
assert.equal(cleanup.deleted, 1);
assert.equal(cleanup.skippedActive, 1);
assert.equal(cleanup.skippedRecent, 1);
assert.equal(cleanup.skippedAbnormal, 2);
assert.equal(cleanup.skippedOther, 1);
assert.equal(cleanup.failed, 0);
assert.equal(cleanup.removedEmptyDirs, 2);
assert.equal(await store.get(oldKey), null);
assert.equal((await store.get(recentKey))?.sessionId, 'recent-session');
assert.equal((await store.get(recentKey))?.generation, 3);
assert.equal((await store.get(recentKey))?.cutoffMessageId, 'om_new_recent');
assert.equal((await store.get(recentKey))?.handoffSummary, 'recent handoff');
assert.equal((await store.get(activeKey))?.sessionId, 'active-session');
assert.equal(existsSync(join(root, 'empty')), false);
assert.equal(await readFile(join(root, 'invalid.json'), 'utf8'), '{"key":"broken"');
assert.ok((await stat(join(root, 'notes.txt'))).isFile());

console.log('codex-session-store smoke: PASS');
