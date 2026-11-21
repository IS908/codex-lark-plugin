import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { SqliteManagedWorkspaceStore } from '../src/durable-run/sqlite-managed-workspace.js';
import type { ManagedGitSelection } from '../src/domain/managed-workspace.js';
import { parseWorkspaceMountTable, workspaceBackingAliases, workspaceMountLayoutSupported } from '../src/managed-workspace-ancestry.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { previewWorkspaceCleanup, supportsScratch } from '../src/workspace-cleanup-preview.js';
import { readWorkspaceGitCacheIdentity } from '../src/workspace-git-snapshot.js';

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
const env = { ...process.env, HOME: home, USERPROFILE: home, LARK_CODEX_EXEC_CWD: work, LARK_CONTINUATION_WORKING_ROOT: work,
  LARK_CONTINUATION_RETENTION_DAYS: '30', LARK_APP_SECRET: 'do-not-print-secret' };
const cli = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/configure-doctor-cli.ts',
  '--workspace-cleanup-preview', ...args], { env, encoding: 'utf8' });
for (const dir of [scratchRoot, artifactRoot, project, path.dirname(configPath), path.dirname(databasePath)]) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
await fs.writeFile(configPath, JSON.stringify({ version: 1, scratchRoot, artifactRoot }));
const repository = await SqliteDurableRunRepository.open({ databasePath });
const database = new DatabaseSync(databasePath);
try {
  const firstBoot = { host: 'a'.repeat(64), boot: 'b'.repeat(64) };
  const secondBoot = { ...firstBoot, boot: 'c'.repeat(64) };
  let workerEpoch = firstBoot;
  const exclusive = async () => true;
  const store = new SqliteManagedWorkspaceStore(database, async () => workerEpoch, exclusive);
  const roots = { scratch: await pinWorkspacePath(work, scratchRoot), artifacts: await pinWorkspacePath(work, artifactRoot) };
  const authorizedRoots = [work] as const;
  const sourceBinding = await pinWorkspacePath(work, project);
  const options = { configPath, databasePath, authorizedRoots, minimumAgeDays: 30, now, readEpoch: async () => firstBoot, checkExclusiveStorage: exclusive };
  const register = async (runId: string, kind: 'foreground' | 'cron_prompt' | 'async_task', status: 'queued' | 'cancelled',
    delivery: 'pending' | 'sent' = 'sent', git?: ManagedGitSelection) => {
    const allocation = await store.ensure({ roots, owner: { runId, kind }, createdAt: old, authorizedRoots,
      ...(kind === 'foreground' ? { foregroundSessionKey: 'oc_fixture' } : {}), ...(git ? { git, project: sourceBinding } : {}),
      dependencyRegistryConfigPath: configPath });
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
  const recordAttempt = (runId: string, pending = false) => {
    database.prepare('UPDATE durable_runs SET attempt_count = 1 WHERE run_id = ?').run(runId);
    database.prepare(`INSERT INTO durable_attempts (attempt_id, run_id, ordinal, worker_id, claimed_at, heartbeat_at,
      lease_expires_at, execution_started_at, finished_at, execution_phase, outcome, recovery_pending)
      VALUES (?, ?, 1, 'worker', ?, ?, ?, ?, ?, 'execution_started', ?, ?)`).run(`attempt:${runId}`, runId,
      old, old, old, old, pending ? null : old, pending ? null : 'cancelled', pending ? 1 : 0);
  };
  const unused = await register('unused', 'cron_prompt', 'cancelled');
  const mountTable = parseWorkspaceMountTable('10 1 8:1 / / rw - ext4 /dev/example rw\n'
    + `11 10 8:1 ${scratchRoot} /mnt/cleanup-fixture rw - ext4 /dev/example rw\n`);
  const linuxPolicy = {
    supports: (directory: string) => workspaceMountLayoutSupported([directory], mountTable),
    aliases: (directory: string) => workspaceBackingAliases(directory, mountTable),
    contains: (root: string, directory: string) => directory === root || directory.startsWith(`${root}/`),
  };
  assert.equal(linuxPolicy.supports(unused.scratch.directory), true);
  assert.ok(linuxPolicy.aliases(unused.scratch.directory).includes(`/mnt/cleanup-fixture/${path.basename(unused.scratch.directory)}`));
  assert.equal(supportsScratch(unused.scratch.directory, roots.scratch, linuxPolicy, 'linux'), false);
  const foreground = await register('foreground', 'foreground', 'queued');
  store.rememberForegroundArtifacts(foreground.owner.runId, { version: 2, sessionKey: 'oc_fixture', actorId: 'ou_fixture',
    chatId: 'oc_fixture', sourceMessageId: 'om_fixture', messageType: 'text', reply: { status: 'pending', text: 'do-not-print-report' },
    files: [{ status: 'pending', reference: { relativePath: 'report.txt', sha256: 'a'.repeat(64) } }] });
  const queued = await register('queued', 'cron_prompt', 'queued');
  const pending = await register('pending', 'async_task', 'cancelled', 'pending');
  const attempted = await register('attempted', 'async_task', 'cancelled');
  recordAttempt(attempted.owner.runId);
  const interrupted = await register('interrupted', 'async_task', 'cancelled');
  recordAttempt(interrupted.owner.runId, true);
  const oldWriter = await register('old-writer', 'cron_prompt', 'cancelled');
  recordAttempt(oldWriter.owner.runId);
  const previousRuntime = new DatabaseSync(databasePath);
  try { previousRuntime.prepare('UPDATE workspace_run_allocations SET last_used_at = last_used_at WHERE run_id = ?').run(oldWriter.owner.runId); }
  finally { previousRuntime.close(); }
  workerEpoch = { ...firstBoot, host: 'd'.repeat(64) };
  const foreign = await register('foreign', 'cron_prompt', 'cancelled');
  recordAttempt(foreign.owner.runId);
  workerEpoch = firstBoot;

  const bare = path.join(work, 'git-cache');
  const pack = path.join(bare, 'objects', 'pack');
  await fs.mkdir(pack, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(bare, 'refs'), { mode: 0o700 });
  const gitCommand = (args: string[], stdin?: string) => execFileSync('git', args, { input: stdin, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  gitCommand(['init', '-q', '--object-format=sha1', project]);
  await fs.writeFile(path.join(project, 'tracked.txt'), 'original');
  await fs.writeFile(path.join(project, '.gitignore'), 'ignored.txt\n');
  gitCommand(['-C', project, 'add', 'tracked.txt', '.gitignore']);
  gitCommand(['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = gitCommand(['-C', project, 'rev-parse', 'HEAD']);
  await fs.writeFile(path.join(bare, 'HEAD'), `${commit}\n`);
  await fs.writeFile(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  gitCommand(['-C', project, '-c', 'pack.writeReverseIndex=false', 'pack-objects', '--no-write-bitmap-index', '--revs', path.join(pack, 'pack')], `${commit}\n`);
  const gitDirectory = await pinWorkspacePath(work, bare);
  const git = { cache: gitDirectory, ...await readWorkspaceGitCacheIdentity({ authorizedRoots, gitDirectory, commit,
    repositoryId: 'e'.repeat(64), scope: 'cleanup-fixture' }) };
  const cleanGit = await register('clean-git', 'cron_prompt', 'cancelled', 'sent', git);
  recordAttempt(cleanGit.owner.runId);
  const dirtyGit = await register('dirty-git', 'cron_prompt', 'cancelled', 'sent', git);
  recordAttempt(dirtyGit.owner.runId);
  await fs.writeFile(path.join(dirtyGit.gitCheckout!.checkout.directory, 'ignored.txt'), 'operator content');
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
  assert.ok(row(cleanGit)?.reasons.includes('process_quiescence_unverified'));
  assert.ok(row(retrySource)?.reasons.includes('retry_or_staging_reference'));
  assert.ok(row(alias)?.reasons.includes('directory_unverified'));
  assert.ok(row(withFile)?.reasons.includes('scratch_contains_files'));
  assert.deepEqual((await fs.readdir(scratchRoot)).sort(), before);
  assert.equal(await fs.readFile(path.join(unused.artifacts.directory, 'protected.txt'), 'utf8'), 'never touched');

  const bootOptions = { ...options, readEpoch: async () => secondBoot };
  const bootReport = await previewWorkspaceCleanup(bootOptions);
  const finding = (allocation: typeof unused, input = bootReport) => input.entries.find(({ leaf }) => leaf === path.basename(allocation.scratch.directory));
  assert.equal(finding(attempted)?.disposition, 'candidate');
  assert.ok(finding(attempted)?.reasons.includes('last_use_on_prior_host_boot'));
  assert.ok(finding(interrupted)?.reasons.includes('open_execution_reference'));
  assert.ok(finding(pending)?.reasons.includes('delivery_not_confirmed'));
  assert.ok(finding(oldWriter)?.reasons.includes('process_quiescence_unverified'));
  assert.ok(finding(foreign)?.reasons.includes('process_quiescence_unverified'));
  assert.ok(finding(cleanGit)?.reasons.includes('expired_original_checkout'));
  assert.ok(finding(dirtyGit)?.reasons.includes('git_baseline_unverified_or_changed'));
  const sharedStorage = await previewWorkspaceCleanup({ ...bootOptions, checkExclusiveStorage: async () => false });
  assert.ok(finding(attempted, sharedStorage)?.reasons.includes('process_quiescence_unverified'));
  const cliJson: typeof report = JSON.parse(cli(['--json']));
  assert.equal(cliJson.readOnly, true);
  if (process.platform === 'linux') {
    // The same stored witnesses that qualify under the injected epoch must not qualify on Linux.
    for (const allocation of [attempted, cleanGit]) {
      const entry = finding(allocation, cliJson);
      assert.equal(entry?.disposition, 'retain');
      assert.ok(entry.reasons.includes('process_quiescence_unverified'));
    }
  }
  const clean = cleanGit.gitCheckout!.checkout.directory;
  const tracked = path.join(clean, 'tracked.txt');
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const attr = process.platform === 'darwin' ? 'com.example.cleanup-fixture' : 'user.cleanup-fixture';
    const tool = process.platform === 'darwin' ? '/usr/bin/xattr' : '/usr/bin/setfattr';
    const write = process.platform === 'darwin' ? ['-w', attr, 'fixture-metadata'] : ['-n', attr, '-v', 'fixture-metadata'];
    const remove = process.platform === 'darwin' ? ['-d', attr] : ['-x', attr];
    for (const [target, allocation] of [[tracked, cleanGit], [unused.scratch.directory, unused]] as const) {
      execFileSync(tool, [...write, target]);
      try {
        assert.equal(finding(allocation, await previewWorkspaceCleanup(bootOptions))?.disposition, 'retain',
          'extended metadata is not covered by the pristine baseline or the empty directory check');
      } finally { execFileSync(tool, [...remove, target]); }
    }
  }
  await fs.writeFile(path.join(clean, '.git', 'refs', 'private'), `${commit}\n`);
  assert.ok(finding(cleanGit, await previewWorkspaceCleanup(bootOptions))?.reasons.includes('git_baseline_unverified_or_changed'));
  await fs.unlink(path.join(clean, '.git', 'refs', 'private'));
  await fs.writeFile(tracked, 'changed by the run');
  assert.ok(finding(cleanGit, await previewWorkspaceCleanup(bootOptions))?.reasons.includes('git_baseline_unverified_or_changed'));
  await fs.writeFile(tracked, 'original');
  const missingCache = `${bare}-unavailable`;
  const open = fs.open.bind(fs);
  const lateFile = path.join(attempted.scratch.directory, 'late-arrival.txt');
  let lateReads = 0;
  const writeLateFile = mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (args[0] === tracked && ++lateReads === 2) await fs.writeFile(lateFile, 'fixture');
    return open(...args);
  });
  try {
    const raced = await previewWorkspaceCleanup(bootOptions);
    assert.ok(lateReads >= 2);
    assert.equal(finding(attempted, raced)?.disposition, 'retain', 'a previously scanned candidate changed before reporting');
  } finally {
    writeLateFile.mock.restore();
    await fs.rm(lateFile, { force: true });
  }
  let trackedReads = 0;
  let cacheMovedDuringScan = false;
  const moveCache = mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (args[0] === tracked && ++trackedReads === 2) {
      await fs.rename(bare, missingCache);
      cacheMovedDuringScan = true;
    }
    return open(...args);
  });
  try {
    const racedCache = await previewWorkspaceCleanup(bootOptions);
    assert.ok(cacheMovedDuringScan);
    assert.ok(finding(cleanGit, racedCache)?.reasons.includes('git_backing_unverified'));
  } finally {
    moveCache.mock.restore();
    if (cacheMovedDuringScan) await fs.rename(missingCache, bare);
  }
  await fs.rename(bare, missingCache);
  try { assert.ok(finding(cleanGit, await previewWorkspaceCleanup(bootOptions))?.reasons.includes('git_backing_unverified')); }
  finally { await fs.rename(missingCache, bare); }
  database.exec('DROP TRIGGER workspace_cleanup_forget_legacy_use');
  assert.ok(finding(attempted, await previewWorkspaceCleanup(bootOptions))?.reasons.includes('process_quiescence_unverified'));
  new SqliteManagedWorkspaceStore(database, async () => workerEpoch, exclusive);
  assert.equal(database.prepare('SELECT host FROM workspace_cleanup_evidence WHERE run_id = ?').get(attempted.owner.runId)?.host, null);
  const currentUse = await register('current-use', 'async_task', 'cancelled');
  recordAttempt(currentUse.owner.runId);
  workerEpoch = secondBoot;
  for (const allocation of [currentUse, oldWriter]) {
    await store.ensure({ roots, owner: allocation.owner, createdAt: old, authorizedRoots, dependencyRegistryConfigPath: configPath });
  }
  assert.ok(finding(currentUse, await previewWorkspaceCleanup(bootOptions))?.reasons.includes('process_quiescence_unverified'));
  assert.equal(database.prepare('SELECT host FROM workspace_cleanup_evidence WHERE run_id = ?').get(oldWriter.owner.runId)?.host, null);

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

  assert.match(cli([]), /read-only, advisory/);
  assert.doesNotMatch(cli(['--json']), /do-not-print/);
  assert.deepEqual((await fs.readdir(scratchRoot)).sort(), [...before, path.basename(currentUse.scratch.directory)].sort());
} finally {
  database.close();
  repository.close();
  await fs.rm(home, { recursive: true, force: true });
}
console.log('workspace cleanup preview: PASS');
