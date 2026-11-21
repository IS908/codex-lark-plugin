import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { previewWorkspaceCleanup } from '../src/workspace-cleanup-preview.js';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-preview-fixture-')));
const work = path.join(home, 'work');
const scratchRoot = path.join(work, 'scratch');
const artifactRoot = path.join(work, 'artifacts');
const project = path.join(work, 'source');
const channel = path.join(home, '.codex/channels/lark');
const configPath = path.join(channel, 'runtime-config/managed-workspace.json');
const databasePath = path.join(channel, 'runtime/continuations/jobs.sqlite');
const now = new Date('2026-11-22T00:00:00.000Z');
const old = '2026-07-19T00:00:00.000Z';
for (const dir of [scratchRoot, artifactRoot, project, path.dirname(configPath), path.dirname(databasePath)]) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
await fs.writeFile(configPath, JSON.stringify({ version: 1, scratchRoot, artifactRoot }));
const repository = await SqliteDurableRunRepository.open({ databasePath });
const database = new DatabaseSync(databasePath);
try {
  const store = repository.getManagedWorkspaceStore();
  const roots = { scratch: await pinWorkspacePath(work, scratchRoot), artifacts: await pinWorkspacePath(work, artifactRoot) };
  const authorizedRoots = [work] as const;
  const sourceBinding = await pinWorkspacePath(work, project);
  const options = { configPath, databasePath, authorizedRoots, minimumAgeDays: 30, now };
  const register = async (runId: string, kind: 'foreground' | 'cron_prompt' | 'async_task', status: 'queued' | 'cancelled',
    delivery: 'pending' | 'sent' = 'sent') => {
    const allocation = await store.ensure({ roots, owner: { runId, kind }, createdAt: old, authorizedRoots,
      ...(kind === 'foreground' ? { foregroundSessionKey: 'oc_fixture' } : {}), dependencyRegistryConfigPath: configPath });
    if (kind !== 'foreground') {
      await repository.create({ runId, workloadKind: kind, idempotencyKey: `fixture:${runId}`,
        inputVersion: 1, input: { job: { objective: 'do-not-print-task-data',
          ...(kind === 'async_task' ? { workingDirectory: project, permissions: { filesystem: { requestedPaths: [] } } }
            : { workspaceProject: sourceBinding }) } }, stateVersion: 1, state: {},
        route: { kind: 'fixture' }, actorOpenId: 'ou_fixture', nextRunAt: old, expiresAt: '2026-07-20T00:00:00.000Z', maxAttempts: 2 }, old);
      if (status === 'cancelled') {
        database.prepare('UPDATE durable_runs SET status = ?, completed_at = ? WHERE run_id = ?').run(status, old, runId);
        database.prepare(`INSERT INTO durable_outbox (outbox_id, run_id, event_key, kind, route_json, idempotency_key, payload_json,
          status, next_attempt_at, message_id, created_at, updated_at) VALUES (?, ?, 'terminal', ?, '{}', ?, '{}', ?, ?, ?, ?, ?)`)
          .run(`outbox:${runId}`, runId, kind === 'async_task' ? 'terminal' : 'cron_terminal', `delivery:${runId}`,
            delivery, old, delivery === 'sent' ? `om_fixture_${runId}` : null, old, old);
      }
    }
    return allocation;
  };
  const unused = await register('unused', 'cron_prompt', 'cancelled');
  const foreground = await register('foreground', 'foreground', 'queued');
  store.rememberForegroundArtifacts(foreground.owner.runId, { version: 2, sessionKey: 'oc_fixture', actorId: 'ou_fixture',
    chatId: 'oc_fixture', sourceMessageId: 'om_fixture', messageType: 'text', reply: { status: 'pending', text: 'do-not-print-report' },
    files: [{ status: 'pending', reference: { relativePath: 'report.txt', sha256: 'a'.repeat(64) } }] });
  const queued = await register('queued', 'cron_prompt', 'queued');
  const pending = await register('pending', 'async_task', 'cancelled', 'pending');
  const attempted = await register('attempted', 'async_task', 'cancelled');
  database.prepare('UPDATE durable_runs SET attempt_count = 1 WHERE run_id = ?').run(attempted.owner.runId);
  const retrySource = await register('retry-source', 'async_task', 'cancelled');
  const retry = await register('retry', 'async_task', 'queued');
  database.prepare("UPDATE durable_runs SET input_json = json_set(input_json, '$.job.retryOfJobId', ?) WHERE run_id = ?")
    .run(retrySource.owner.runId, retry.owner.runId);
  const alias = await register('alias', 'cron_prompt', 'cancelled');
  await fs.rmdir(alias.scratch.directory);
  await fs.symlink(unused.scratch.directory, alias.scratch.directory);
  const withFile = await register('file', 'cron_prompt', 'cancelled');
  await fs.writeFile(path.join(withFile.scratch.directory, 'private.txt'), 'do-not-print-file-content');
  const legacy = path.join(scratchRoot, 'old-unmanaged-directory');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(unused.artifacts.directory, 'protected.txt'), 'never touched');
  const before = (await fs.readdir(scratchRoot)).sort();
  const report = await previewWorkspaceCleanup(options);
  assert.equal(report.status, 'complete');
  assert.equal(report.readOnly, true);
  assert.equal(report.unregisteredObserved, 1);
  const row = (allocation: typeof unused) => report.entries.find((entry) => entry.leaf === path.basename(allocation.scratch.directory));
  assert.equal(row(unused)?.disposition, 'candidate');
  assert.ok(row(foreground)?.reasons.includes('foreground_quiescence_untracked'));
  assert.ok(row(foreground)?.reasons.includes('delivery_not_confirmed'));
  assert.ok(row(queued)?.reasons.includes('live_or_recoverable_run'));
  assert.ok(row(pending)?.reasons.includes('delivery_not_confirmed'));
  assert.ok(row(attempted)?.reasons.includes('process_quiescence_unverified'));
  assert.ok(row(retrySource)?.reasons.includes('retry_or_staging_reference'));
  assert.ok(row(alias)?.reasons.includes('directory_unverified'));
  assert.ok(row(withFile)?.reasons.includes('scratch_contains_files'));
  assert.deepEqual((await fs.readdir(scratchRoot)).sort(), before);
  assert.equal(await fs.readFile(path.join(unused.artifacts.directory, 'protected.txt'), 'utf8'), 'never touched');

  const newArtifacts = path.join(work, 'new-artifacts');
  await fs.mkdir(newArtifacts, { mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify({ version: 1, scratchRoot, artifactRoot: newArtifacts }));
  const historic = await previewWorkspaceCleanup(options);
  assert.ok(historic.entries.length);
  assert.ok(historic.entries.every(({ disposition, reasons }) => disposition === 'retain' && reasons.includes('historical_root')));
  await fs.writeFile(configPath, JSON.stringify({ version: 1, scratchRoot, artifactRoot }));

  const opendir = fs.opendir.bind(fs);
  const legacyAlias = path.join(work, 'legacy-async-cwd');
  await fs.symlink(unused.scratch.directory, legacyAlias);
  database.prepare("UPDATE durable_runs SET input_json = json_set(input_json, '$.job.workingDirectory', ?) WHERE run_id = ?")
    .run(legacyAlias, retry.owner.runId);
  const referenced = await previewWorkspaceCleanup(options);
  assert.ok(referenced.entries.find(({ leaf }) => leaf === path.basename(unused.scratch.directory))?.reasons.includes('saved_workspace_reference'));
  database.prepare("UPDATE durable_runs SET input_json = json_set(input_json, '$.job.workingDirectory', ?) WHERE run_id = ?")
    .run(project, retry.owner.runId);

  let swapped = false;
  let observedScratch = 0;
  const moved = path.join(work, 'moved-scratch');
  const lstat = fs.lstat.bind(fs);
  const replacement = mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
    if (args[0] === unused.scratch.directory && ++observedScratch === 2) {
      swapped = true;
      await fs.rename(unused.scratch.directory, moved);
      await fs.mkdir(unused.scratch.directory, { mode: 0o700 });
    }
    return lstat(...args);
  });
  try {
    const replaced = await previewWorkspaceCleanup(options);
    assert.ok(swapped);
    assert.equal(replaced.entries.find(({ leaf }) => leaf === path.basename(unused.scratch.directory))?.disposition, 'retain');
  } finally {
    replacement.mock.restore();
    if (swapped) { await fs.rmdir(unused.scratch.directory); await fs.rename(moved, unused.scratch.directory); }
  }

  observedScratch = 0;
  const permissions = mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
    if (args[0] === unused.scratch.directory && ++observedScratch === 2) await fs.chmod(unused.scratch.directory, 0o777);
    return lstat(...args);
  });
  try {
    const unprotected = await previewWorkspaceCleanup(options);
    assert.ok(observedScratch >= 2);
    assert.equal(unprotected.entries.find(({ leaf }) => leaf === path.basename(unused.scratch.directory))?.disposition, 'retain');
  } finally { permissions.mock.restore(); await fs.chmod(unused.scratch.directory, 0o700); }

  let changed = false;
  const interposer = mock.method(fs, 'opendir', async (...args: Parameters<typeof opendir>) => {
    if (args[0] === scratchRoot && !changed) {
      changed = true;
      database.prepare("UPDATE durable_outbox SET status = 'pending' WHERE run_id = ?").run(unused.owner.runId);
    }
    return opendir(...args);
  });
  try {
    const raced = await previewWorkspaceCleanup(options);
    assert.ok(changed);
    assert.equal(raced.status, 'partial');
    assert.ok(raced.observations.includes('ledger_changed'));
    assert.ok(!raced.entries.some(({ disposition }) => disposition === 'candidate'));
  } finally { interposer.mock.restore(); }

  const env = { ...process.env, HOME: home, USERPROFILE: home, LARK_CODEX_EXEC_CWD: work, LARK_CONTINUATION_WORKING_ROOT: work,
    LARK_CONTINUATION_RETENTION_DAYS: '30', LARK_APP_SECRET: 'do-not-print-secret' };
  const cli = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/configure-doctor-cli.ts',
    '--workspace-cleanup-preview', ...args], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(cli(['--json'])).readOnly, true);
  assert.match(cli([]), /read-only, advisory/);
  assert.doesNotMatch(cli(['--json']), /do-not-print/);
  assert.deepEqual((await fs.readdir(scratchRoot)).sort(), before);
} finally {
  database.close();
  repository.close();
  await fs.rm(home, { recursive: true, force: true });
}
console.log('workspace cleanup preview: PASS');
