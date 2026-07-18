/**
 * Cron compatibility characterization suite.
 *
 * This suite fixes the scheduler admission and projection semantics before
 * the durable-run migration replaces the JSON runtime projection.
 */
import { createHash } from 'node:crypto';
import { JobScheduler } from '../src/scheduler.js';
import { appConfig } from '../src/config.js';
import {
  computeLatestDueRun,
  computeNextRun,
  type JobFile,
} from '../src/job-store.js';
import { IdentitySession } from '../src/identity-session.js';

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FixtureRepository {
  private jobs = new Map<string, JobFile>();

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

  async mutateJob(
    id: string,
    mutate: (job: JobFile) => void | false | Promise<void | false>,
  ): Promise<JobFile | null> {
    const current = this.jobs.get(id);
    if (!current) return null;
    const next = clone(current);
    if (await mutate(next) === false) return next;
    this.jobs.set(id, next);
    return clone(next);
  }

  replace(job: JobFile): void {
    this.jobs.set(job.meta.id, clone(job));
  }

  async get(id: string): Promise<JobFile> {
    const job = await this.readJob(id);
    if (!job) fail(`fixture ${id} disappeared unexpectedly`);
    return job;
  }
}

function makeJob(
  id: string,
  overrides: { meta?: Partial<JobFile['meta']>; runtime?: Partial<JobFile['runtime']> } = {},
): JobFile {
  return {
    meta: {
      id,
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
  clock: () => Date,
  sendMessage: (request: any) => Promise<{ messageId: string }> = async () => ({ messageId: 'om_compat' }),
): JobScheduler {
  return new JobScheduler({
    client: {} as any,
    transport: { sendMessage } as any,
    identitySession: new IdentitySession(() => null),
    clock,
    scanIntervalMs: 60_000,
    repository: {
      listAllJobs: () => repository.listAllJobs(),
      readJob: (id) => repository.readJob(id),
      mutateJob: (id, mutate) => repository.mutateJob(id, mutate),
    },
  });
}

let passed = 0;

// 1. Lifecycle calls preserve exact-boundary admission and run the job once.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const job = makeJob('exact-boundary', { runtime: { next_run_at: now.toISOString() } });
  const repository = new FixtureRepository([job]);
  let sends = 0;
  const scheduler = makeScheduler(repository, () => now, async () => {
    sends++;
    return { messageId: 'om_exact' };
  });

  await scheduler.start();
  await (scheduler as any).recoverMissedJobs();
  await (scheduler as any).tick();
  scheduler.stop();

  const persisted = await repository.get(job.meta.id);
  if (sends !== 1 || persisted.runtime.run_count !== 1) {
    fail(`1: exact boundary should run once, got sends=${sends}, run_count=${persisted.runtime.run_count}`);
  }
  passed++;
}

// 2. Multiple missed occurrences collapse to the latest due run key.
{
  const now = new Date('2026-06-07T01:17:00.000Z');
  const job = makeJob('latest-missed', {
    runtime: { next_run_at: '2026-06-07T01:00:00.000Z' },
  });
  const repository = new FixtureRepository([job]);
  const runUuids: string[] = [];
  const scheduler = makeScheduler(repository, () => now, async (request) => {
    runUuids.push(request.uuid);
    return { messageId: 'om_latest' };
  });

  await (scheduler as any).tick();

  const latestDue = '2026-06-07T01:15:00.000Z';
  const expectedUuid = createHash('sha256')
    .update(`scheduler:${job.meta.id}:${latestDue}`)
    .digest('hex')
    .slice(0, 32);
  if (runUuids.length !== 1 || runUuids[0] !== expectedUuid) {
    fail(`2: expected latest missed run key ${latestDue}, got ${JSON.stringify(runUuids)}`);
  }
  passed++;
}

// 3. Scheduled scans skip paused jobs, while manual runs preserve pause and next_run_at.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const futureNextRun = '2099-01-01T09:00:00.000Z';
  const job = makeJob('paused-manual', {
    meta: { status: 'paused' },
    runtime: { next_run_at: now.toISOString() },
  });
  const repository = new FixtureRepository([job]);
  let sends = 0;
  const scheduler = makeScheduler(repository, () => now, async () => {
    sends++;
    return { messageId: 'om_paused' };
  });

  await (scheduler as any).tick();
  if (sends !== 0) fail(`3: paused job was admitted by scheduled scan (${sends} sends)`);

  repository.replace({ ...job, runtime: { ...job.runtime, next_run_at: futureNextRun } });
  const manual = await scheduler.runJobNow(await repository.get(job.meta.id));
  const persisted = await repository.get(job.meta.id);
  if (!manual.started || sends !== 1) fail(`3: paused manual run was not admitted: ${JSON.stringify(manual)}`);
  if (persisted.meta.status !== 'paused' || persisted.runtime.next_run_at !== futureNextRun) {
    fail(`3: manual run changed paused projection: ${JSON.stringify(persisted)}`);
  }
  passed++;
}

// 4. Simultaneous manual and scheduled admissions yield one already_running response.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const job = makeJob('manual-scheduled-overlap', { runtime: { next_run_at: now.toISOString() } });
  const repository = new FixtureRepository([job]);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const enteredSend = new Promise<void>((resolve) => { entered = resolve; });
  const scheduler = makeScheduler(repository, () => now, async () => {
    entered();
    await blocked;
    return { messageId: 'om_overlap' };
  });

  const manual = scheduler.runJobNow(job);
  await enteredSend;
  const scheduled = await (scheduler as any).executeJob(job);
  release();
  await manual;

  if (scheduled.started || scheduled.reason !== 'already_running') {
    fail(`4: expected scheduled admission to return already_running, got ${JSON.stringify(scheduled)}`);
  }
  passed++;
}

// 5. A delete-and-recreate race rejects the stale projection.
{
  const now = new Date('2026-06-07T01:15:00.000Z');
  const oldJob = makeJob('recreated-id', {
    runtime: { next_run_at: now.toISOString() },
  });
  const replacement = makeJob('recreated-id', {
    meta: { created_at: '2026-06-07T01:16:00.000Z', content: 'replacement' },
    runtime: { next_run_at: '2099-01-01T00:00:00.000Z' },
  });
  const repository = new FixtureRepository([oldJob]);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const enteredSend = new Promise<void>((resolve) => { entered = resolve; });
  const scheduler = makeScheduler(repository, () => now, async () => {
    entered();
    await blocked;
    return { messageId: 'om_recreated' };
  });

  const staleRun = scheduler.runJobNow(oldJob);
  await enteredSend;
  repository.replace(replacement);
  release();
  await staleRun.then(
    () => fail('5: stale manual projection should reject'),
    () => {},
  );

  const persisted = await repository.get(oldJob.meta.id);
  if (persisted.meta.created_at !== replacement.meta.created_at || persisted.runtime.run_count !== 0) {
    fail(`5: stale projection changed replacement: ${JSON.stringify(persisted)}`);
  }
  passed++;
}

// 6. DST fixtures retain cron-parser's New York behavior, and persisted job timezone wins.
{
  const timezone = 'America/New_York';
  const springNow = new Date('2026-03-08T07:00:00.000Z');
  const fallNow = new Date('2026-11-01T06:00:00.000Z');
  const springLatest = computeLatestDueRun('0 2 * * *', springNow, timezone);
  const fallLatest = computeLatestDueRun('0 1 * * *', fallNow, timezone);
  if (springLatest !== '2026-03-07T07:00:00.000Z') {
    fail(`6: spring-forward latest occurrence changed: ${springLatest}`);
  }
  if (fallLatest !== '2026-11-01T06:00:00.000Z') {
    fail(`6: fall-back latest occurrence changed: ${fallLatest}`);
  }
  const springNext = computeNextRun('0 2 * * *', timezone, springNow);
  if (springNext !== '2026-03-09T06:00:00.000Z') {
    fail(`6: spring-forward next occurrence changed: ${springNext}`);
  }
  const fallNext = computeNextRun('0 1 * * *', timezone, fallNow);
  if (fallNext !== '2026-11-02T06:00:00.000Z') {
    fail(`6: fall-back next occurrence changed: ${fallNext}`);
  }

  const originalCronTimezone = appConfig.cronTimezone;
  (appConfig as { cronTimezone: string }).cronTimezone = 'UTC';
  try {
    const job = makeJob('job-timezone-wins', {
      meta: { schedule: '0 2 * * *', timezone },
      runtime: { next_run_at: '2026-03-07T07:00:00.000Z' },
    });
    const repository = new FixtureRepository([job]);
    const runUuids: string[] = [];
    const scheduler = makeScheduler(repository, () => springNow, async (request) => {
      runUuids.push(request.uuid);
      return { messageId: 'om_timezone' };
    });
    await (scheduler as any).tick();
    const expectedUuid = createHash('sha256')
      .update(`scheduler:${job.meta.id}:${springLatest}`)
      .digest('hex')
      .slice(0, 32);
    if (runUuids[0] !== expectedUuid) {
      fail(`6: persisted timezone did not win over app config: ${JSON.stringify(runUuids)}`);
    }
  } finally {
    (appConfig as { cronTimezone: string }).cronTimezone = originalCronTimezone;
  }
  passed++;
}

console.log(`cron compatibility smoke: ${passed}/6 PASS`);
