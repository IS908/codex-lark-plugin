import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workerPath = new URL('./cron-durable-restart-worker.ts', import.meta.url).pathname;

type CrashStage =
  | 'before-admission-commit'
  | 'after-run-commit-before-cursor'
  | 'after-claim-before-execution'
  | 'after-execution-started-before-attempt-commit'
  | 'after-attempt-outbox-commit-before-delivery'
  | 'after-send-before-delivery-commit';

interface PersistedRun {
  status: string;
  attemptCount: number;
  state: { phase: string };
}

for (const stage of [
  'before-admission-commit',
  'after-run-commit-before-cursor',
  'after-claim-before-execution',
  'after-execution-started-before-attempt-commit',
  'after-attempt-outbox-commit-before-delivery',
  'after-send-before-delivery-commit',
] satisfies CrashStage[]) {
  await verifyCrashBoundary(stage);
}

async function verifyCrashBoundary(stage: CrashStage): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `cron-durable-restart-${stage}-`));
  try {
    const crashed = spawnWorker('crash', stage, root);
    await waitForMarker(crashed, `CRASH_READY:${stage}`);
    crashed.kill('SIGKILL');
    await waitForExit(crashed);

    if (stage === 'before-admission-commit') {
      assert.equal(await runCount(root), 0, 'a pre-commit crash must not manufacture a Run');
      await runWorker('resume-admission', stage, root);
      assert.equal(await runCount(root), 1, 'restart must admit the missing scheduled Run');
      assert.equal((await job(root)).runtime.next_run_at, '2026-07-19T01:20:00.000Z');
      return;
    }

    if (stage === 'after-run-commit-before-cursor') {
      assert.equal(await runCount(root), 1, 'Run commit must survive a projection crash');
      assert.equal((await job(root)).runtime.next_run_at, '2026-07-19T01:00:00.000Z');
      await runWorker('resume-admission', stage, root);
      assert.equal(await runCount(root), 1, 'idempotent admission must not create a duplicate Run');
      assert.equal((await job(root)).runtime.next_run_at, '2026-07-19T01:20:00.000Z');
      return;
    }

    if (stage === 'after-claim-before-execution') {
      assert.equal(await executionCount(root), 0, 'claimed work must not execute before execution starts');
      await expireLeases(root);
      await runWorker('resume-worker', stage, root);
      assert.equal(await executionCount(root), 1, 'claimed work must be safely replayed after recovery');
      const run = await persistedRun(root);
      assert.equal(run.status, 'completed');
      assert.equal(run.attemptCount, 2, 'safe recovery must claim a new Attempt before replaying');
      assert.equal(await outboxStatus(root), 'sent');
      assert.equal(await confirmedDeliveryCount(root), 1);
      return;
    }

    if (stage === 'after-execution-started-before-attempt-commit') {
      assert.equal(await executionCount(root), 1, 'the opaque execution must have begun exactly once');
      await expireLeases(root);
      await runWorker('resume-worker', stage, root);
      const run = await persistedRun(root);
      assert.equal(run.status, 'blocked', 'opaque execution recovery must require confirmation');
      assert.equal(run.state.phase, 'completed');
      assert.equal(await executionCount(root), 1, 'opaque execution must never be blindly replayed');
      assert.equal(await outboxStatus(root), 'sent');
      assert.equal(await confirmedDeliveryCount(root), 1);
      return;
    }

    if (stage === 'after-attempt-outbox-commit-before-delivery') {
      assert.equal((await persistedRun(root)).status, 'completed');
      assert.equal(await outboxStatus(root), 'pending');
      await runWorker('resume-worker', stage, root);
      assert.equal(await executionCount(root), 1, 'restart must deliver the committed outbox, not execute again');
      assert.equal(await outboxStatus(root), 'sent');
      assert.equal(await confirmedDeliveryCount(root), 1);
      return;
    }

    assert.equal(await executionCount(root), 1);
    assert.equal(await confirmedDeliveryCount(root), 1, 'the first sender confirmed one delivery');
    await expireLeases(root);
    await runWorker('resume-worker', stage, root);
    assert.equal(await executionCount(root), 1, 'delivery restart must never re-execute the Run');
    assert.equal(await outboxStatus(root), 'sent');
    assert.equal(
      await confirmedDeliveryCount(root),
      1,
      'reusing the durable delivery idempotency key must not confirm a duplicate delivery',
    );
    const attempts = await deliveryAttemptKeys(root);
    assert.equal(attempts.length, 2, 'send-before-commit recovery must retry the durable outbox once');
    assert.equal(new Set(attempts).size, 1, 'both send attempts must reuse one persisted idempotency key');
    assert.match(attempts[0], /^cron:cron_[a-f0-9]{32}:terminal$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function spawnWorker(mode: 'crash' | 'resume-admission' | 'resume-worker', stage: CrashStage, root: string) {
  return spawn(process.execPath, ['--import', 'tsx', workerPath, mode, stage, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runWorker(
  mode: 'resume-admission' | 'resume-worker',
  stage: CrashStage,
  root: string,
): Promise<void> {
  const child = spawnWorker(mode, stage, root);
  const output = await collectOutput(child);
  assert.equal(output.code, 0, output.stderr || output.stdout);
  assert.match(output.stdout, /RESUME_COMPLETE/);
}

async function waitForMarker(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (stdout.includes(marker)) return;
    if (child.exitCode !== null) throw new Error(stderr || `Child exited before ${marker}.`);
    await delay(10);
  }
  child.kill('SIGKILL');
  throw new Error(`Timed out waiting for ${marker}: ${stderr}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function collectOutput(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, stdout, stderr };
}

function database(root: string): DatabaseSync {
  return new DatabaseSync(join(root, 'durable-runs.sqlite'), { readOnly: true });
}

async function runCount(root: string): Promise<number> {
  const db = database(root);
  try {
    return Number((db.prepare('SELECT COUNT(*) AS count FROM durable_runs').get() as { count: number }).count);
  } finally {
    db.close();
  }
}

async function persistedRun(root: string): Promise<PersistedRun> {
  const db = database(root);
  try {
    const row = db.prepare(`
      SELECT status, attempt_count AS attemptCount, state_json AS stateJson
      FROM durable_runs
      LIMIT 1
    `).get() as { status: string; attemptCount: number; stateJson: string } | undefined;
    assert.ok(row, 'expected a durable Run');
    return { status: row.status, attemptCount: Number(row.attemptCount), state: JSON.parse(row.stateJson) };
  } finally {
    db.close();
  }
}

async function outboxStatus(root: string): Promise<string> {
  const db = database(root);
  try {
    const row = db.prepare('SELECT status FROM durable_outbox LIMIT 1').get() as { status: string } | undefined;
    assert.ok(row, 'expected a durable outbox row');
    return row.status;
  } finally {
    db.close();
  }
}

async function expireLeases(root: string): Promise<void> {
  const db = new DatabaseSync(join(root, 'durable-runs.sqlite'));
  try {
    const expired = '2000-01-01T00:00:00.000Z';
    db.prepare('UPDATE durable_runs SET lease_expires_at = ? WHERE lease_expires_at IS NOT NULL').run(expired);
    db.prepare('UPDATE durable_attempts SET lease_expires_at = ? WHERE finished_at IS NULL').run(expired);
    db.prepare('UPDATE durable_outbox SET lease_expires_at = ? WHERE status = \'sending\'').run(expired);
  } finally {
    db.close();
  }
}

async function job(root: string): Promise<{ runtime: { next_run_at: string } }> {
  return JSON.parse(await readFile(join(root, 'jobs', 'durable-restart.json'), 'utf8'));
}

async function executionCount(root: string): Promise<number> {
  return lineCount(join(root, 'executions.log'));
}

async function confirmedDeliveryCount(root: string): Promise<number> {
  return lineCount(join(root, 'deliveries.log'));
}

async function deliveryAttemptKeys(root: string): Promise<string[]> {
  return (await readFile(join(root, 'delivery-attempts.log'), 'utf8'))
    .split('\n')
    .filter(Boolean);
}

async function lineCount(path: string): Promise<number> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log('cron durable restart smoke: PASS');
