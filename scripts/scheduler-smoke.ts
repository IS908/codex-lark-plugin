import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JobScheduler } from '../src/scheduler.js';
import type { JobFile } from '../src/job-contracts.js';
import type { CronAdmissionResult } from '../src/cron/run-admission.js';

const NOW = new Date('2026-07-19T03:00:00.000Z');

function makeJob(overrides: {
  meta?: Partial<JobFile['meta']>;
  runtime?: Partial<JobFile['runtime']>;
} = {}): JobFile {
  return {
    meta: {
      id: 'job_abc',
      revision: 1,
      name: 'daily ping',
      type: 'message',
      status: 'active',
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_origin',
      created_by: 'ou_owner',
      content: 'hello',
      msg_type: 'text',
      created_at: '2026-07-19T00:00:00.000Z',
      ...overrides.meta,
    },
    runtime: {
      next_run_at: '2026-07-19T02:59:00.000Z',
      last_run_at: null,
      last_error: null,
      run_count: 0,
      ...overrides.runtime,
    },
  };
}

function harness(options: {
  jobs?: JobFile[];
  scheduled?: CronAdmissionResult;
  manual?: CronAdmissionResult;
  wait?: 'success' | 'failed';
  scheduledError?: Error;
} = {}) {
  const jobs = options.jobs ?? [makeJob()];
  const scheduledCalls: Array<{ job: JobFile; now: Date }> = [];
  const manualCalls: Array<{ job: JobFile; requestId: string; now: Date }> = [];
  const waitCalls: string[] = [];
  const repairCalls: string[] = [];
  const admission = {
    async repairProjection(job: JobFile) {
      repairCalls.push(job.meta.id);
    },
    async admitScheduled(job: JobFile, now: Date) {
      scheduledCalls.push({ job, now });
      if (options.scheduledError) throw options.scheduledError;
      return options.scheduled ?? { admitted: true, runId: 'cron_scheduled', created: true };
    },
    async admitManual(job: JobFile, requestId: string, now: Date) {
      manualCalls.push({ job, requestId, now });
      return options.manual ?? { admitted: true, runId: 'cron_manual', created: true };
    },
    async waitForExecution(runId: string) {
      waitCalls.push(runId);
      return options.wait ?? 'success';
    },
  };
  const scheduler = new JobScheduler({
    admission: admission as any,
    clock: () => new Date(NOW),
    repository: {
      async listAllJobs() { return jobs; },
    },
  });
  return {
    scheduler,
    scheduledCalls,
    manualCalls,
    waitCalls,
    repairCalls,
  };
}

// Due scheduled jobs are admitted into SQLite and return immediately. The
// Scheduler does not execute workload code, send Feishu messages, or wait.
{
  const test = harness();
  await (test.scheduler as any).tick();
  assert.equal(test.scheduledCalls.length, 1);
  assert.equal(test.scheduledCalls[0].job.meta.id, 'job_abc');
  assert.equal(test.scheduledCalls[0].now.toISOString(), NOW.toISOString());
  assert.equal(test.waitCalls.length, 0);
}

// Paused jobs are skipped by the scanner. Active definitions are passed to the
// admission service, which owns the authoritative due/cursor decision.
{
  const test = harness({
    jobs: [
      makeJob({ meta: { id: 'paused', status: 'paused' } }),
      makeJob({ meta: { id: 'future' }, runtime: { next_run_at: '2026-07-20T00:00:00.000Z' } }),
    ],
    scheduled: { admitted: false, reason: 'not_due' },
  });
  await (test.scheduler as any).tick();
  assert.equal(test.scheduledCalls.length, 1);
  assert.equal(test.scheduledCalls[0].job.meta.id, 'future');
  assert.deepEqual(test.repairCalls.sort(), ['future', 'paused']);
}

// Manual execution admits the persisted definition and waits for the durable
// terminal execution state so the existing run_job command stays synchronous.
{
  const paused = makeJob({ meta: { status: 'paused' } });
  const test = harness({ jobs: [paused], wait: 'success' });
  const result = await (test.scheduler as any).runJobNow(paused, 'action-request-123');
  assert.deepEqual(result, { started: true, outcome: 'success' });
  assert.equal(test.manualCalls.length, 1);
  assert.match(test.manualCalls[0].requestId, /^manual:[0-9a-f-]{36}$/);
  assert.equal(test.manualCalls[0].now.toISOString(), NOW.toISOString());
  assert.deepEqual(test.waitCalls, ['cron_manual']);
}

// Durable overlap rejection remains the command-facing already_running result.
{
  const job = makeJob();
  const test = harness({
    jobs: [job],
    manual: { admitted: false, reason: 'already_running' },
  });
  const result = await (test.scheduler as any).runJobNow(job, 'action-request-overlap');
  assert.deepEqual(result, { started: false, reason: 'already_running' });
  assert.equal(test.waitCalls.length, 0);
}

// Admission/storage failures fail closed. They must not fall through to the
// removed legacy direct executor or mutate compatibility runtime fields.
{
  const job = makeJob();
  const before = structuredClone(job);
  const test = harness({ jobs: [job], scheduledError: new Error('sqlite unavailable') });
  await (test.scheduler as any).tick();
  assert.deepEqual(job, before);
}

// Shutdown is an admission barrier: it waits for an already-running scan to
// finish before the durable worker/repository can be stopped.
{
  let releaseScan!: () => void;
  let scanEntered!: () => void;
  const entered = new Promise<void>((resolve) => { scanEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseScan = resolve; });
  const scheduler = new JobScheduler({
    admission: {} as any,
    repository: {
      async listAllJobs() {
        scanEntered();
        await blocked;
        return [];
      },
    },
  });
  const ticking = scheduler.tick();
  await entered;
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releaseScan();
  await Promise.all([ticking, stopping]);
  assert.equal(stopped, true);
}

// Manual admission participates in the same shutdown barrier. Calls that
// arrive after stop begins are rejected without touching the admission port.
{
  let releaseAdmission!: () => void;
  let admissionEntered!: () => void;
  const entered = new Promise<void>((resolve) => { admissionEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let manualCalls = 0;
  const scheduler = new JobScheduler({
    admission: {
      async admitManual() {
        manualCalls += 1;
        admissionEntered();
        await blocked;
        return { admitted: false as const, reason: 'stale_job' as const };
      },
    } as any,
  });
  const running = scheduler.runJobNow(makeJob());
  await entered;
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.deepEqual(await scheduler.runJobNow(makeJob()), {
    started: false,
    reason: 'stale_job',
    outcome: 'failed',
  });
  assert.equal(manualCalls, 1);
  releaseAdmission();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
}

// Architectural deletion guard: there is one admission path and no dormant
// direct execution/retry fallback left to revive in a later refactor.
{
  const scheduler = JobScheduler.prototype as any;
  for (const method of [
    'executeJob',
    'executeJobUnlocked',
    'executeMessageJob',
    'executePromptJob',
  ]) {
    assert.equal(method in scheduler, false, `legacy Scheduler method remains: ${method}`);
  }
  const source = readFileSync(new URL('../src/scheduler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /promptRunner|activeJobIds|MAX_SCHEDULER_RETRIES|schedulerRetryDelayMs/);
  assert.doesNotMatch(source, /transport\.sendMessage|executeMessageJob|executePromptJob/);
  assert.doesNotMatch(source, /recordCronJobReportDelivery/);
}

console.log('scheduler smoke: 8/8 PASS');
