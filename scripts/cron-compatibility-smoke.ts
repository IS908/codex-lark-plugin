/** Cron schedule/admission compatibility characterization suite. */
import assert from 'node:assert/strict';
import { JobScheduler } from '../src/scheduler.js';
import { computeLatestDueRun, computeNextRun, jobTimezone } from '../src/job-store.js';
import type { JobFile } from '../src/job-contracts.js';
import type { CronAdmissionResult } from '../src/cron/run-admission.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FixtureRepository {
  private readonly jobs = new Map<string, JobFile>();

  constructor(jobs: JobFile[]) {
    for (const job of jobs) this.jobs.set(job.meta.id, clone(job));
  }

  async listAllJobs(): Promise<JobFile[]> {
    return [...this.jobs.values()].map(clone);
  }

  async readJob(id: string): Promise<JobFile | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  replace(job: JobFile): void {
    this.jobs.set(job.meta.id, clone(job));
  }
}

class AdmissionFixture {
  readonly scheduled: Array<{ jobId: string; occurrence: string; created: boolean }> = [];
  readonly manual: Array<{ jobId: string; requestId: string }> = [];
  private readonly scheduledKeys = new Set<string>();
  private readonly activeJobIds = new Set<string>();

  constructor(private readonly repository: FixtureRepository) {}

  async admitScheduled(job: JobFile, now: Date): Promise<CronAdmissionResult> {
    const fresh = await this.repository.readJob(job.meta.id);
    if (!sameDefinition(fresh, job)) return { admitted: false, reason: 'stale_job' };
    if (fresh.meta.status !== 'active') return { admitted: false, reason: 'paused' };
    if (Date.parse(fresh.runtime.next_run_at) > now.getTime()) {
      return { admitted: false, reason: 'not_due' };
    }
    const occurrence = computeLatestDueRun(fresh.meta.schedule, now, jobTimezone(fresh.meta));
    const key = `${fresh.meta.id}:${fresh.meta.created_at}:${fresh.meta.revision}:${occurrence}`;
    const created = !this.scheduledKeys.has(key);
    this.scheduledKeys.add(key);
    this.scheduled.push({ jobId: fresh.meta.id, occurrence, created });
    return { admitted: true, runId: `cron_scheduled_${this.scheduledKeys.size}`, created, scheduledOccurrence: occurrence };
  }

  async admitManual(job: JobFile, requestId: string): Promise<CronAdmissionResult> {
    const fresh = await this.repository.readJob(job.meta.id);
    if (!sameDefinition(fresh, job)) return { admitted: false, reason: 'stale_job' };
    if (this.activeJobIds.has(job.meta.id)) return { admitted: false, reason: 'already_running' };
    this.manual.push({ jobId: job.meta.id, requestId });
    return { admitted: true, runId: `cron_manual_${this.manual.length}`, created: true };
  }

  async waitForExecution(): Promise<'success'> {
    return 'success';
  }

  setActive(jobId: string): void {
    this.activeJobIds.add(jobId);
  }
}

function sameDefinition(fresh: JobFile | null, candidate: JobFile): fresh is JobFile {
  return Boolean(
    fresh
    && fresh.meta.created_at === candidate.meta.created_at
    && fresh.meta.revision === candidate.meta.revision,
  );
}

function makeJob(
  id: string,
  overrides: { meta?: Partial<JobFile['meta']>; runtime?: Partial<JobFile['runtime']> } = {},
): JobFile {
  return {
    meta: {
      id,
      revision: 1,
      name: id,
      type: 'message',
      schedule: '*/5 * * * *',
      schedule_human: 'every 5m',
      timezone: 'UTC',
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_origin',
      status: 'active',
      created_by: 'ou_owner',
      created_at: '2026-01-01T00:00:00.000Z',
      content: 'compatibility check',
      msg_type: 'text',
      ...overrides.meta,
    },
    runtime: {
      last_run_at: null,
      next_run_at: '2026-01-01T00:00:00.000Z',
      run_count: 0,
      last_error: null,
      ...overrides.runtime,
    },
  };
}

function makeScheduler(
  repository: FixtureRepository,
  admission: AdmissionFixture,
  clock: () => Date,
): JobScheduler {
  return new JobScheduler({
    admission: admission as any,
    clock,
    scanIntervalMs: 60_000,
    repository: {
      listAllJobs: () => repository.listAllJobs(),
    },
  });
}

let passed = 0;

// Exact-boundary recovery and repeated scans resolve to one durable admission key.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const repository = new FixtureRepository([
    makeJob('exact-boundary', { runtime: { next_run_at: now.toISOString() } }),
  ]);
  const admission = new AdmissionFixture(repository);
  const scheduler = makeScheduler(repository, admission, () => now);
  await scheduler.start();
  await scheduler.recoverMissedJobs();
  await scheduler.tick();
  await scheduler.stop();
  assert.equal(admission.scheduled.filter((entry) => entry.created).length, 1);
  assert.equal(admission.scheduled.at(-1)?.occurrence, now.toISOString());
  passed++;
}

// Multiple missed occurrences collapse to the latest due occurrence.
{
  const now = new Date('2026-06-07T01:17:00.000Z');
  const repository = new FixtureRepository([
    makeJob('latest-missed', { runtime: { next_run_at: '2026-06-07T01:00:00.000Z' } }),
  ]);
  const admission = new AdmissionFixture(repository);
  await makeScheduler(repository, admission, () => now).tick();
  assert.equal(admission.scheduled[0]?.occurrence, '2026-06-07T01:15:00.000Z');
  passed++;
}

// Scheduled scans skip paused Jobs, while manual admission preserves the JSON definition.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const job = makeJob('paused-manual', {
    meta: { status: 'paused' },
    runtime: { next_run_at: '2099-01-01T09:00:00.000Z' },
  });
  const repository = new FixtureRepository([job]);
  const admission = new AdmissionFixture(repository);
  const scheduler = makeScheduler(repository, admission, () => now);
  await scheduler.tick();
  assert.equal(admission.scheduled.length, 0);
  assert.deepEqual(await scheduler.runJobNow(job), { started: true, outcome: 'success' });
  assert.deepEqual(await repository.readJob(job.meta.id), job);
  passed++;
}

// Durable overlap and delete/recreate races retain command-facing rejection reasons.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const job = makeJob('overlap-stale');
  const repository = new FixtureRepository([job]);
  const admission = new AdmissionFixture(repository);
  const scheduler = makeScheduler(repository, admission, () => now);
  admission.setActive(job.meta.id);
  assert.deepEqual(await scheduler.runJobNow(job), { started: false, reason: 'already_running' });
  repository.replace(makeJob(job.meta.id, {
    meta: { created_at: '2026-06-07T01:16:00.000Z', revision: 1 },
  }));
  assert.deepEqual(
    await scheduler.runJobNow(job),
    { started: false, reason: 'stale_job', outcome: 'failed' },
  );
  passed++;
}

// DST behavior remains owned by cron-parser, and persisted Job timezone wins.
{
  const timezone = 'America/New_York';
  const springNow = new Date('2026-03-08T07:00:00.000Z');
  const fallNow = new Date('2026-11-01T06:00:00.000Z');
  assert.equal(computeLatestDueRun('0 2 * * *', springNow, timezone), '2026-03-07T07:00:00.000Z');
  assert.equal(computeLatestDueRun('0 1 * * *', fallNow, timezone), '2026-11-01T06:00:00.000Z');
  assert.equal(computeNextRun('0 2 * * *', timezone, springNow), '2026-03-09T06:00:00.000Z');
  assert.equal(computeNextRun('0 1 * * *', timezone, fallNow), '2026-11-02T06:00:00.000Z');

  const job = makeJob('job-timezone-wins', {
    meta: { schedule: '0 2 * * *', timezone },
    runtime: { next_run_at: '2026-03-07T07:00:00.000Z' },
  });
  const repository = new FixtureRepository([job]);
  const admission = new AdmissionFixture(repository);
  await makeScheduler(repository, admission, () => springNow).tick();
  assert.equal(admission.scheduled[0]?.occurrence, '2026-03-07T07:00:00.000Z');
  passed++;
}

console.log(`cron compatibility smoke: ${passed}/5 PASS`);
