import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readWorkspaceCleanupLedger, verifyWorkspaceCleanupLedger } from '../src/durable-run/workspace-cleanup-ledger.js';

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-ledger-fixture-')));
const live = path.join(directory, 'jobs.sqlite');
const database = new DatabaseSync(live);
const allowTestDestination = async (directory: string) => assert.ok(directory.startsWith(`${await fs.realpath('/tmp')}/lark-cleanup-preview-`));
try {
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture (value TEXT);');
  database.prepare('INSERT INTO fixture VALUES (?)').run('uncheckpointed');
  const disk = await fs.readFile(live);
  const wal = await fs.readFile(`${live}-wal`);
  const names = (await fs.readdir(directory)).sort();
  const snapshot = await readWorkspaceCleanupLedger(live, (reader) => {
    assert.throws(() => reader.exec("INSERT INTO fixture VALUES ('not-allowed')"));
    return reader.prepare('SELECT value FROM fixture').get()?.value;
  }, allowTestDestination);
  assert.equal(snapshot.value, 'uncheckpointed');
  assert.equal(await verifyWorkspaceCleanupLedger(live, snapshot.stamp), true);
  assert.deepEqual(await fs.readFile(live), disk);
  assert.deepEqual(await fs.readFile(`${live}-wal`), wal);
  assert.deepEqual((await fs.readdir(directory)).sort(), names);

  database.prepare('INSERT INTO fixture VALUES (?)').run('next');
  assert.equal(await verifyWorkspaceCleanupLedger(live, snapshot.stamp), false);
  await assert.rejects(readWorkspaceCleanupLedger(live, (reader) => {
    database.prepare('INSERT INTO fixture VALUES (?)').run('during snapshot use');
    return reader.prepare('SELECT count(*) AS count FROM fixture').get()?.count;
  }, allowTestDestination), { code: 'ledger_changed' });
  let rejectedDestination: string | undefined;
  await assert.rejects(readWorkspaceCleanupLedger(live, () => assert.fail('must refuse before opening the copy'), async (candidate) => {
    rejectedDestination = candidate;
    throw new Error('Temporary destination overlaps managed storage.');
  }), { code: 'ledger_unavailable' });
  assert.ok(rejectedDestination);
  await assert.rejects(fs.lstat(rejectedDestination), { code: 'ENOENT' });
  await fs.symlink(live, path.join(directory, 'alias.sqlite'));
  await assert.rejects(readWorkspaceCleanupLedger(path.join(directory, 'alias.sqlite'), () => null, allowTestDestination), { code: 'ledger_unavailable' });
  await assert.rejects(readWorkspaceCleanupLedger(path.join(directory, 'missing.sqlite'), () => null, allowTestDestination), { code: 'ledger_unavailable' });
  assert.equal(await fs.lstat(path.join(directory, 'missing.sqlite')).catch(() => undefined), undefined);
} finally {
  database.close();
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('workspace cleanup ledger snapshot: PASS');
