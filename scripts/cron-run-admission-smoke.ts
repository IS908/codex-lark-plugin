/**
 * Cron durable-run admission RED tests (Task 5).
 *
 * The result contract intentionally stays small:
 *   - admitted=true includes runId, created, and scheduledOccurrence when scheduled;
 *   - admitted=false includes a stable rejection reason.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../src/config.js';
import { CronRunAdmission } from '../src/cron/run-admission.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import {
  createInitialJobRuntime,
  deleteJob,
  mutateJob,
  readJob,
  writeJob,
  type JobFile,
} from '../src/job-store.js';
import type { DurableRunRepository } from '../src/ports/durable-run.js';

type JobRepository = {
  readJob(id: string): Promise<JobFile | null>;
  mutateJob(
    id: string,
    mutate: (job: JobFile) => void | false | Promise<void | false>,
  ): Promise<JobFile | null>;
};

function makeJob(
  id: string,
  overrides: { meta?: Partial<JobFile['meta']>; runtime?: Partial<JobFile['runtime']> } = {},
): JobFile {
  return {
    meta: {
      id,
      name: id,
      type: 'prompt',
      schedule: '*/5 * * * *',
      schedule_human: 'every 5m',
      timezone: 'UTC',
      prompt: `Run ${id}`,
      model: 'gpt-test',
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_origin',
      status: 'active',
      created_by: 'ou_owner',
      created_at: '2026-07-19T00:00:00.000Z',
      ...overrides.meta,
    },
    runtime: {
      ...createInitialJobRuntime('2026-07-19T01:00:00.000Z'),
      ...overrides.runtime,
    },
  } as JobFile;
}

function revisionOf(job: JobFile): number {
  return (job.meta as JobFile['meta'] & { revision: number }).revision;
}

function countCronRuns(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM durable_runs
      WHERE workload_kind LIKE 'cron%'
    `).get() as { count: number };
    return Number(row.count);
  } finally {
    database.close();
  }
}

async function withHarness(
  name: string,
  jobs: JobFile[],
  test: (context: {
    admission: CronRunAdmission;
    runs: DurableRunRepository;
    databasePath: string;
    job(id: string): Promise<JobFile>;
  }) => Promise<void>,
  jobRepository: JobRepository = { readJob, mutateJob },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `cron-admission-${name}-`));
  const jobsDir = join(root, 'jobs');
  const databasePath = join(root, 'durable-runs.sqlite');
  const originalJobsDir = appConfig.jobsDir;
  (appConfig as { jobsDir: string }).jobsDir = jobsDir;
  const runs = await SqliteDurableRunRepository.open({ databasePath });

  try {
    for (const job of jobs) await writeJob(job);
    const admission = new CronRunAdmission({
      runRepository: runs,
      jobRepository,
    });
    await test({
      admission,
      runs,
      databasePath,
      job: async (id) => {
        const persisted = await readJob(id);
        assert.ok(persisted, `expected persisted job ${id}`);
        return persisted;
      },
    });
  } finally {
    runs.close();
    (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
    await rm(root, { recursive: true, force: true });
  }
}

// 1. Concurrent scheduled admission uses the latest missed occurrence and one
// stable idempotent Run; exactly-on-boundary occurrences are included.
await withHarness('scheduled-idempotency', [makeJob('scheduled-stable')], async ({
  admission,
  databasePath,
  job,
}) => {
  const candidate = await job('scheduled-stable');
  const now = new Date('2026-07-19T01:17:00.000Z');
  const results = await Promise.all([
    admission.admitScheduled(structuredClone(candidate), now),
    admission.admitScheduled(structuredClone(candidate), now),
  ]);

  assert.equal(results[0].admitted, true);
  assert.equal(results[1].admitted, true);
  assert.equal(results[0].runId, results[1].runId);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  assert.equal(results[0].scheduledOccurrence, '2026-07-19T01:15:00.000Z');
  assert.equal(results[1].scheduledOccurrence, '2026-07-19T01:15:00.000Z');
  assert.equal(countCronRuns(databasePath), 1);
  assert.equal((await job('scheduled-stable')).runtime.next_run_at, '2026-07-19T01:20:00.000Z');
});

await withHarness('exact-boundary', [makeJob('exact-boundary', {
  runtime: { next_run_at: '2026-07-19T01:15:00.000Z' },
})], async ({ admission, runs, job }) => {
  const result = await admission.admitScheduled(
    await job('exact-boundary'),
    new Date('2026-07-19T01:15:00.000Z'),
  );
  assert.equal(result.admitted, true);
  assert.equal(result.created, true);
  assert.equal(result.scheduledOccurrence, '2026-07-19T01:15:00.000Z');
  const run = await runs.get(result.runId);
  assert.equal(run?.workloadKind, 'cron_prompt');
  assert.deepEqual(run?.input, {
    schemaVersion: 1,
    job: {
      id: 'exact-boundary',
      createdAt: '2026-07-19T00:00:00.000Z',
      revision: 1,
      name: 'exact-boundary',
      type: 'prompt',
      schedule: '*/5 * * * *',
      scheduleHuman: 'every 5m',
      timezone: 'UTC',
      scheduledOccurrence: '2026-07-19T01:15:00.000Z',
      prompt: 'Run exact-boundary',
      model: 'gpt-test',
      targetChatId: 'oc_target',
      originChatId: 'oc_origin',
      createdBy: 'ou_owner',
    },
  });
  assert.deepEqual(run?.route, {
    kind: 'cron_job',
    targetChatId: 'oc_target',
    originChatId: 'oc_origin',
    jobId: 'exact-boundary',
    createdAt: '2026-07-19T00:00:00.000Z',
    revision: 1,
  });
});

// 2. The cursor update is a CAS over definition identity and revision. A
// semantic edit injected between Run creation and projection remains intact,
// and admission cannot overwrite that revision's cursor.
{
  let injectConcurrentEdit = true;
  const racingRepository: JobRepository = {
    readJob,
    mutateJob: async (id, mutate) => {
      if (injectConcurrentEdit) {
        injectConcurrentEdit = false;
        await mutateJob(id, (latest) => {
          latest.meta.target_chat_id = 'oc_concurrent_edit';
        });
      }
      return mutateJob(id, mutate);
    },
  };
await withHarness('cursor-cas', [makeJob('cursor-cas')], async ({ admission, job }) => {
    const candidate = await job('cursor-cas');
    const originalRevision = revisionOf(candidate);
    const result = await admission.admitScheduled(
      candidate,
      new Date('2026-07-19T01:17:00.000Z'),
    );
    assert.equal(result.admitted, true);
    const persisted = await job('cursor-cas');
    assert.equal(persisted.meta.target_chat_id, 'oc_concurrent_edit');
    assert.equal(revisionOf(persisted), originalRevision + 1);
    assert.equal(
      persisted.runtime.next_run_at,
      '2026-07-19T01:00:00.000Z',
      'stale admission must not advance the concurrently edited definition cursor',
    );
  }, racingRepository);
}

{
  let failProjection = true;
  const crashAfterRunRepository: JobRepository = {
    readJob,
    mutateJob: async (id, mutate) => {
      if (failProjection) {
        failProjection = false;
        throw new Error('simulated crash after Run commit');
      }
      return mutateJob(id, mutate);
    },
  };
  await withHarness('cursor-repair', [makeJob('cursor-repair')], async ({ runs, databasePath, job }) => {
    const candidate = await job('cursor-repair');
    const now = new Date('2026-07-19T01:17:00.000Z');
    const crashingAdmission = new CronRunAdmission({
      runRepository: runs,
      jobRepository: crashAfterRunRepository,
    });
    await assert.rejects(
      crashingAdmission.admitScheduled(candidate, now),
      /simulated crash after Run commit/u,
    );
    assert.equal(countCronRuns(databasePath), 1);
    assert.equal((await job('cursor-repair')).runtime.next_run_at, '2026-07-19T01:00:00.000Z');

    const repaired = await new CronRunAdmission({ runRepository: runs }).admitScheduled(candidate, now);
    assert.equal(repaired.admitted, true);
    assert.equal(repaired.created, false);
    assert.equal(countCronRuns(databasePath), 1);
    assert.equal((await job('cursor-repair')).runtime.next_run_at, '2026-07-19T01:20:00.000Z');
  });
}

// 3. Scheduled admission rejects paused definitions; a trusted manual request
// accepts the same paused definition without mutating status or schedule cursor.
await withHarness('paused', [makeJob('paused-job', {
  meta: { status: 'paused' },
  runtime: { next_run_at: '2099-01-01T00:00:00.000Z' },
})], async ({ admission, databasePath, job }) => {
  const paused = await job('paused-job');
  const scheduled = await admission.admitScheduled(paused, new Date('2099-01-01T00:00:00.000Z'));
  assert.equal(scheduled.admitted, false);
  assert.equal(scheduled.reason, 'paused');
  assert.equal(countCronRuns(databasePath), 0);

  const manual = await admission.admitManual(paused, 'request-paused-1', new Date('2026-07-19T01:17:00.000Z'));
  assert.equal(manual.admitted, true);
  assert.equal(manual.created, true);
  const persisted = await job('paused-job');
  assert.equal(persisted.meta.status, 'paused');
  assert.equal(persisted.runtime.next_run_at, '2099-01-01T00:00:00.000Z');
});

// 4. Manual request IDs are idempotent, while a different manual or scheduled
// request cannot overlap a non-terminal Run for the same Job instance.
await withHarness('manual-idempotency-overlap', [makeJob('manual-stable')], async ({ admission, databasePath, job }) => {
  const candidate = await job('manual-stable');
  const now = new Date('2026-07-19T01:17:00.000Z');
  const first = await admission.admitManual(candidate, 'request-stable', now);
  const duplicate = await admission.admitManual(candidate, 'request-stable', now);
  assert.equal(first.admitted, true);
  assert.equal(first.created, true);
  assert.equal(duplicate.admitted, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.runId, first.runId);

  const overlappingManual = await admission.admitManual(candidate, 'request-other', now);
  assert.equal(overlappingManual.admitted, false);
  assert.equal(overlappingManual.reason, 'already_running');
  const overlappingScheduled = await admission.admitScheduled(candidate, now);
  assert.equal(overlappingScheduled.admitted, false);
  assert.equal(overlappingScheduled.reason, 'already_running');
  assert.equal(countCronRuns(databasePath), 1);
});

await withHarness('concurrent-manual-overlap', [makeJob('manual-concurrent')], async ({ admission, databasePath, job }) => {
  const candidate = await job('manual-concurrent');
  const now = new Date('2026-07-19T01:17:00.000Z');
  const results = await Promise.all([
    admission.admitManual(structuredClone(candidate), 'request-concurrent-a', now),
    admission.admitManual(structuredClone(candidate), 'request-concurrent-b', now),
  ]);
  assert.equal(results.filter((result) => result.admitted).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.admitted).map((result) => result.reason),
    ['already_running'],
  );
  assert.equal(countCronRuns(databasePath), 1);
});

await withHarness('cross-instance-overlap', [makeJob('manual-cross-instance')], async ({
  admission,
  databasePath,
  job,
}) => {
  const secondRuns = await SqliteDurableRunRepository.open({ databasePath });
  try {
    const secondAdmission = new CronRunAdmission({ runRepository: secondRuns });
    const candidate = await job('manual-cross-instance');
    const now = new Date('2026-07-19T01:17:00.000Z');
    const results = await Promise.all([
      admission.admitManual(structuredClone(candidate), 'request-cross-instance-a', now),
      secondAdmission.admitManual(structuredClone(candidate), 'request-cross-instance-b', now),
    ]);
    assert.equal(results.filter((result) => result.admitted).length, 1);
    assert.deepEqual(
      results.filter((result) => !result.admitted).map((result) => result.reason),
      ['already_running'],
    );
    assert.equal(countCronRuns(databasePath), 1);
  } finally {
    secondRuns.close();
  }
});

// 5. A stale snapshot cannot admit against a deleted-and-recreated Job ID.
await withHarness('delete-recreate', [makeJob('recreated-job')], async ({ admission, databasePath, job }) => {
  const stale = await job('recreated-job');
  assert.equal(await deleteJob('recreated-job'), true);
  await writeJob(makeJob('recreated-job', {
    meta: {
      created_at: '2026-07-19T02:00:00.000Z',
      prompt: 'Replacement definition',
    },
  }));

  const rejected = await admission.admitManual(stale, 'request-stale', new Date('2026-07-19T02:01:00.000Z'));
  assert.equal(rejected.admitted, false);
  assert.equal(rejected.reason, 'stale_job');
  assert.equal(countCronRuns(databasePath), 0);

  const replacement = await job('recreated-job');
  const accepted = await admission.admitManual(
    replacement,
    'request-replacement',
    new Date('2026-07-19T02:01:00.000Z'),
  );
  assert.equal(accepted.admitted, true);
  assert.equal(accepted.created, true);
  assert.equal(countCronRuns(databasePath), 1);
});

// 6. waitForExecution observes execution terminal state only; delivery may
// continue independently in later tasks.
await withHarness('wait-terminal', [makeJob('wait-terminal')], async ({ admission, runs, job }) => {
  const candidate = await job('wait-terminal');
  const now = new Date('2026-07-19T01:17:00.000Z');
  const admitted = await admission.admitManual(candidate, 'request-success', now);
  assert.equal(admitted.admitted, true);
  assert.ok(admitted.runId);
  const run = await runs.get(admitted.runId);
  assert.ok(run);
  const claim = await runs.claimDue(
    [run.workloadKind],
    'cron-admission-smoke-worker',
    now.toISOString(),
    '2026-07-19T01:18:00.000Z',
  );
  assert.ok(claim);
  assert.equal(await runs.markExecutionStarted(claim, now.toISOString()), 'committed');
  assert.equal(await runs.commitTransition(claim, {
    status: 'completed',
    stateVersion: run.stateVersion,
    state: run.state,
  }, '2026-07-19T01:17:01.000Z'), 'committed');
  assert.equal(
    await admission.waitForExecution(admitted.runId, AbortSignal.timeout(2_000)),
    'success',
  );

  const failedAdmission = await admission.admitManual(candidate, 'request-failed', now);
  assert.equal(failedAdmission.admitted, true);
  assert.ok(failedAdmission.runId);
  const failedRun = await runs.get(failedAdmission.runId);
  assert.ok(failedRun);
  const failedClaim = await runs.claimDue(
    [failedRun.workloadKind],
    'cron-admission-smoke-worker',
    now.toISOString(),
    '2026-07-19T01:18:00.000Z',
  );
  assert.ok(failedClaim);
  assert.equal(await runs.markExecutionStarted(failedClaim, now.toISOString()), 'committed');
  assert.equal(await runs.commitTransition(failedClaim, {
    status: 'failed',
    stateVersion: failedRun.stateVersion,
    state: failedRun.state,
    errorCode: 'cron_test_failure',
    errorSummary: 'Cron admission smoke failure.',
  }, '2026-07-19T01:17:02.000Z'), 'committed');
  assert.equal(
    await admission.waitForExecution(failedAdmission.runId, AbortSignal.timeout(2_000)),
    'failed',
  );
});

console.log('cron run admission smoke: PASS');
