import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLarkInstanceLock } from '../src/instance-lock.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { SqliteWorkspaceCleanupClaims } from '../src/durable-run/workspace-cleanup-claims.js';
import { readProtectedPathReferences } from '../src/durable-run/workspace-cleanup-references.js';
import { runStartupWorkspaceCleanup } from '../src/workspace-cleanup-startup.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-cleanup-startup-')));
const state = path.join(work, 'state');
const config = path.join(work, 'config');
const databasePath = path.join(state, 'test.sqlite');
const configPath = path.join(config, 'managed-workspace.json');
const policyPath = path.join(config, 'managed-workspace-cleanup.json');
for (const location of ['state', 'config', 'logs', 'scratch', 'artifacts', 'source']) {
  await fs.mkdir(path.join(work, location), { mode: 0o700 });
}
const repository = await SqliteDurableRunRepository.open({ databasePath });
const ledger = new DatabaseSync(databasePath, { timeout: 0 });
const lock = await acquireLarkInstanceLock('fixture', state, path.join(work, 'logs'));
try {
  const roots = { scratch: await pinWorkspacePath(work, 'scratch'), artifacts: await pinWorkspacePath(work, 'artifacts') };
  const project = await pinWorkspacePath(work, 'source');
  await fs.writeFile(configPath, JSON.stringify({ version: 1, scratchRoot: roots.scratch.directory, artifactRoot: roots.artifacts.directory }), { mode: 0o600 });
  const now = '2026-11-22T00:00:00.000Z';
  const request = { databasePath, configPath, policyPath, lock, authorizedRoots: [work] as const,
    protectedDirectories: [path.join(work, 'logs')], continuationRoot: work, minimumAgeDays: 30, dryRun: false, now: () => new Date(now) };
  const hasJournal = () => !!ledger.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace_cleanup_claims'").get();
  const enable = (maxScratchBytes: number) => fs.writeFile(policyPath, JSON.stringify({
    version: 1, enabled: true, maxScratchBytes, maxRunsPerStartup: 1,
  }), { mode: 0o600 });
  assert.equal((await runStartupWorkspaceCleanup(request)).status, 'disabled');
  assert.equal(hasJournal(), false);
  await enable(1);
  assert.equal((await runStartupWorkspaceCleanup({ ...request, dryRun: true, lock: null })).status, 'disabled');
  assert.equal((await runStartupWorkspaceCleanup({ ...request, lock: null })).reason, 'lock_unverified');
  assert.equal((await runStartupWorkspaceCleanup({ ...request, databasePath: path.join(state, 'missing.sqlite') })).reason, 'ledger_unavailable');
  await assert.rejects(fs.lstat(path.join(state, 'missing.sqlite')), { code: 'ENOENT' });
  assert.equal(hasJournal(), false);

  const store = repository.getManagedWorkspaceStore();
  const fixture = async (runId: string, date: string, delivery: 'sent' | 'pending' = 'sent',
    kind: 'async_task' | 'cron_prompt' = 'cron_prompt') => {
    const owner = { kind, runId } as const;
    const allocation = await store.ensure({ owner, roots, createdAt: date, authorizedRoots: [work], project,
      dependencyRegistryConfigPath: configPath });
    await fs.writeFile(path.join(allocation.artifacts.directory, 'report.txt'), 'formal output');
    await repository.create({ runId, workloadKind: owner.kind, idempotencyKey: `fixture:${runId}`, inputVersion: 1,
      input: { job: kind === 'cron_prompt' ? { workspaceProject: project }
        : { workingDirectory: project.directory, permissions: { filesystem: { root: work, requestedPaths: [] } } } },
      stateVersion: 1, state: {}, route: { kind: 'fixture' },
      actorOpenId: 'ou_fixture', nextRunAt: date, expiresAt: '2026-11-25T00:00:00.000Z', maxAttempts: 2 }, date);
    ledger.prepare("UPDATE durable_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ?").run(date, runId);
    ledger.prepare(`INSERT INTO durable_outbox (outbox_id, run_id, event_key, kind, route_json, idempotency_key, payload_json,
      status, next_attempt_at, message_id, created_at, updated_at)
      VALUES (?, ?, 'terminal', ?, '{}', ?, '{}', ?, ?, ?, ?, ?)`)
      .run(runId, runId, kind === 'async_task' ? 'terminal' : 'cron_terminal', `receipt:${runId}`, delivery, date,
        delivery === 'sent' ? `om_${runId}` : null, date, date);
    return allocation;
  };
  const aged = await fixture('job_abcdef0123456789', '2026-07-19T00:00:00.000Z', 'sent', 'async_task');
  const second = await fixture('second-old', '2026-08-19T00:00:00.000Z');
  const pending = await fixture('pending-delivery', '2026-06-19T00:00:00.000Z', 'pending');
  const recent = await fixture('within-retention', '2026-11-20T00:00:00.000Z');
  const legacy = path.join(roots.scratch.directory, 'unregistered.bin');
  await fs.writeFile(legacy, Buffer.alloc(128 * 1024, 42));
  ledger.prepare(`WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM count WHERE n < 1100)
    INSERT INTO workspace_unmanaged_foreground (run_id, admission_json)
    SELECT 'past-' || n, ? FROM count`).run(JSON.stringify({ project }));
  const protectedPaths = readProtectedPathReferences(ledger);
  assert.equal(protectedPaths.limitReached, false);
  assert.deepEqual(protectedPaths.paths, [project.directory]);
  await enable(16 * 1024 * 1024);
  const below = await runStartupWorkspaceCleanup(request);
  assert.equal(below.removed, 0);
  assert.equal(below.reason, 'within_capacity');
  assert.equal(await fs.stat(aged.scratch.directory).then((entry) => entry.isDirectory()), true);
  ledger.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');
  const scan = new SqliteWorkspaceCleanupClaims(ledger);
  const cutoff = '2026-10-22T00:00:00.000Z';
  const firstPage = scan.candidates(roots.scratch, cutoff, 1);
  assert.deepEqual(firstPage.map(({ owner }) => owner), [pending.owner]);
  scan.recordCandidateScan(roots.scratch, firstPage[0]);
  assert.deepEqual(new SqliteWorkspaceCleanupClaims(ledger).candidates(roots.scratch, cutoff, 1).map(({ owner }) => owner), [aged.owner]);
  await enable(1);
  const unscannable = path.join(roots.scratch.directory, ...Array<string>(35).fill('nested'));
  await fs.mkdir(unscannable, { recursive: true, mode: 0o700 });
  assert.equal((await runStartupWorkspaceCleanup(request)).reason, 'inventory_unverified');
  await fs.rm(path.join(roots.scratch.directory, 'nested'), { recursive: true });

  const first = await runStartupWorkspaceCleanup(request);
  assert.equal(first.removed, 1);
  await assert.rejects(fs.lstat(aged.scratch.directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(aged.artifacts.directory, 'report.txt'), 'utf8'), 'formal output');
  const retryOwner = { kind: 'async_task', runId: 'job_retryabcdef0123456789' } as const;
  const retry = await store.ensure({ owner: retryOwner, roots, createdAt: now, authorizedRoots: [work], project,
    dependencyRegistryConfigPath: configPath });
  const artifactStore = new ContinuationArtifactStore(roots.artifacts.directory);
  const managed = (allocation: typeof aged) => artifactStore.forManagedJob(allocation.owner.runId, allocation.artifacts,
    () => store.openDirectory(allocation.owner, 'artifacts', [work]), store.retryArtifactStages(allocation.owner));
  const digest = createHash('sha256').update('formal output').digest('hex');
  assert.ok(await managed(aged).copyVerified(aged.owner.runId, retry.owner.runId, [{
    id: 'artifact-1', deliverableId: 'report', path: 'report.txt', sha256: digest,
  }], managed(retry)));
  assert.equal((await managed(retry).readArtifact(retry.owner.runId, 'report.txt', digest)).toString(), 'formal output');
  assert.equal(await fs.stat(second.scratch.directory).then((entry) => entry.isDirectory()), true);
  const next = await runStartupWorkspaceCleanup(request);
  assert.equal(next.removed, 1);
  await assert.rejects(fs.lstat(second.scratch.directory), { code: 'ENOENT' });
  assert.equal(await fs.stat(pending.scratch.directory).then((entry) => entry.isDirectory()), true);
  assert.equal(await fs.stat(recent.scratch.directory).then((entry) => entry.isDirectory()), true);
  assert.equal((await fs.readFile(legacy)).byteLength, 128 * 1024);
  const restricted = await fixture('job_narrowabcdef01234567', '2026-06-10T00:00:00.000Z', 'sent', 'async_task');
  assert.equal((await runStartupWorkspaceCleanup({ ...request, continuationRoot: project.directory })).removed, 0);
  assert.equal(await fs.stat(restricted.scratch.directory).then((entry) => entry.isDirectory()), true);
  assert.equal((await runStartupWorkspaceCleanup({ ...request, protectedDirectories: [roots.scratch.directory] })).removed, 0);

  const home = path.join(work, 'fixture-home');
  const channel = path.join(home, '.codex/channels/lark');
  const bootConfig = path.join(channel, 'runtime-config');
  const bootDb = path.join(channel, 'runtime/continuations/jobs.sqlite');
  const bootWork = path.join(channel, 'codex-exec-workdir');
  const bootScratch = path.join(bootWork, 'scratch');
  const bootArtifacts = path.join(bootWork, 'artifacts');
  const launcherTmp = path.join(work, 'launcher-tmp');
  await fs.mkdir(launcherTmp, { mode: 0o700 });
  await fs.mkdir(bootConfig, { recursive: true, mode: 0o700 });
  await fs.mkdir(bootScratch, { recursive: true, mode: 0o700 });
  await fs.mkdir(bootArtifacts, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(bootConfig, path.basename(configPath)), JSON.stringify({
    version: 1, scratchRoot: bootScratch, artifactRoot: bootArtifacts,
  }), { mode: 0o600 });
  await fs.copyFile(policyPath, path.join(bootConfig, path.basename(policyPath)));
  const bootRepo = await SqliteDurableRunRepository.open({ databasePath: bootDb });
  bootRepo.getManagedWorkspaceStore();
  bootRepo.close();
  const hold = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', [
    'import sys, os, fcntl', 'fd = os.open(sys.argv[1], os.O_DIRECTORY | os.O_RDONLY)',
    'fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)', 'print("locked", flush=True)', 'sys.stdin.read()',
  ].join('\n'), bootScratch], { stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(hold, 'close');
  try {
    assert.equal(String((await once(hold.stdout, 'data'))[0]), 'locked\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: launcherTmp,
      LARK_APP_ID: 'cleanup_fixture', LARK_APP_SECRET: 'fixture-secret', LARK_CODEX_EXEC_CWD: '',
      LARK_CONTINUATION_WORKING_ROOT: bootWork };
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args],
      { env, encoding: 'utf8', timeout: 10_000, input: '' });
    const dryRun = run(['--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.doesNotMatch(dryRun.stderr, /\[workspace-cleanup\]/);
    const blocked = run([]);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /native_operation_in_progress/);
    assert.doesNotMatch(blocked.stderr, /Lark runtime connecting/);
    const closedDb = new DatabaseSync(bootDb, { readOnly: true });
    try { assert.equal(closedDb.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace_cleanup_claims'").get(), undefined); }
    finally { closedDb.close(); }
  } finally { hold.stdin.end(); await closed; }
} finally {
  lock.release();
  ledger.close();
  repository.close();
  await fs.rm(work, { recursive: true, force: true });
}
console.log('workspace cleanup startup: PASS');
