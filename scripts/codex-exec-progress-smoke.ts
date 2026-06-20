import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  cleanupCodexExecProgressFiles,
  createCodexExecProgressSink,
} from '../src/codex-exec-progress.js';

async function touchAge(filePath: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(filePath, when, when);
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

const baseDir = await mkdtemp(join(tmpdir(), 'lark-progress-retention-'));
const progressDir = join(baseDir, '.lark-progress');
await mkdir(progressDir, { recursive: true });

const oldTurn = join(progressDir, 'turn-old');
const oldTurnFile = join(progressDir, 'turn-old-file');
const freshTurn = join(progressDir, 'turn-fresh');
const unrelated = join(progressDir, 'not-a-turn');
await mkdir(oldTurn, { recursive: true });
await mkdir(freshTurn, { recursive: true });
await mkdir(unrelated, { recursive: true });
await writeFile(join(oldTurn, 'progress.jsonl'), '{"token":"old"}\n', 'utf-8');
await writeFile(oldTurnFile, '{"token":"old-file"}\n', 'utf-8');
await writeFile(join(freshTurn, 'progress.jsonl'), '{"token":"fresh"}\n', 'utf-8');
await touchAge(oldTurn, 13 * 60 * 60 * 1000);
await touchAge(join(oldTurn, 'progress.jsonl'), 13 * 60 * 60 * 1000);
await touchAge(oldTurnFile, 13 * 60 * 60 * 1000);

const cleanup = await cleanupCodexExecProgressFiles(baseDir, {
  maxAgeMs: 12 * 60 * 60 * 1000,
});
assert.equal(cleanup.removed, 2);
assert.equal(existsSync(oldTurn), false);
assert.equal(existsSync(oldTurnFile), false);
assert.equal(existsSync(freshTurn), true);
assert.equal(existsSync(unrelated), true);

const sink = await createCodexExecProgressSink({
  baseDir,
  limits: {
    enabled: true,
    maxMessages: 1,
    maxChars: 100,
    minIntervalMs: 0,
    pollIntervalMs: 5,
  },
  caller: 'ou_owner',
  messageId: 'om_progress_permissions',
  chatId: 'oc_progress_permissions',
  send: async () => undefined,
});
assert.ok(sink, 'progress sink should be created');
const sinkDir = dirname(sink.filePath);
assert.equal(modeBits((await stat(progressDir)).mode), 0o700);
assert.equal(modeBits((await stat(sinkDir)).mode), 0o700);
assert.equal(modeBits((await stat(sink.filePath)).mode), 0o600);
assert.equal((await readdir(sinkDir)).includes('progress.jsonl'), true);
await sink.stop();
await rm(baseDir, { recursive: true, force: true });

console.log('codex-exec-progress smoke: PASS');
