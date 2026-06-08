/**
 * Scheduler message-send smoke test.
 *
 * Verifies the Feishu API wrapper does not add a nested retry loop inside the
 * scheduler's existing job-level retry, and that a due job run uses a stable
 * Feishu message uuid for idempotency.
 */
import { JobScheduler } from '../src/scheduler.js';
import { IdentitySession } from '../src/identity-session.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { appConfig } from '../src/config.js';
import type { JobFile } from '../src/job-store.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const tmpJobsDir = mkdtempSync(path.join(tmpdir(), 'scheduler-smoke-jobs-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

function makeJob(overrides: { meta?: Partial<JobFile['meta']>; runtime?: Partial<JobFile['runtime']> } = {}): JobFile {
  return {
    version: 1,
    meta: {
      id: 'job_abc',
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
      created_at: '2026-06-07T00:00:00.000Z',
      updated_at: '2026-06-07T00:00:00.000Z',
      ...overrides.meta,
    },
    runtime: {
      next_run_at: '2026-06-07T01:00:00.000Z',
      last_run_at: null,
      last_error: null,
      run_count: 0,
      ...overrides.runtime,
    },
  };
}

function jobFile(id: string): string {
  return path.join(tmpJobsDir, `${id}.json`);
}

function writeJobFixture(job: JobFile): void {
  writeFileSync(jobFile(job.meta.id), JSON.stringify(job, null, 2));
}

function readJobFixture(id: string): JobFile {
  return JSON.parse(readFileSync(jobFile(id), 'utf-8')) as JobFile;
}

// 1. Same logical due run uses a stable uuid.
{
  const uuids: string[] = [];
  const client = {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            uuids.push(args.data.uuid);
            return { data: { message_id: `om_${uuids.length}` } };
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  const job = makeJob();
  await (scheduler as any).executeMessageJob(job, job.runtime.next_run_at);
  await (scheduler as any).executeMessageJob(job, job.runtime.next_run_at);
  if (!uuids[0] || uuids[0] !== uuids[1]) {
    fail(`1: expected stable uuid for same runKey, got ${JSON.stringify(uuids)}`);
  }
  passed++;
}

// 2. Inner wrapper attempts once; scheduler.executeJob owns delayed retries.
{
  let calls = 0;
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            calls++;
            const err = new Error('socket timeout') as Error & { code?: string };
            err.code = 'ETIMEDOUT';
            throw err;
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeMessageJob(makeJob(), '2026-06-07T01:00:00.000Z').then(
    () => fail('2: expected executeMessageJob to reject'),
    () => {},
  );
  if (calls !== 1) fail(`2: expected one inner Feishu call, got ${calls}`);
  passed++;
}

// 3. Scheduler-level retry still recognizes retryable failures after the
// inner Feishu wrapper exhausts its single attempt.
{
  let calls = 0;
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            calls++;
            if (calls === 1) {
              const err = new Error('rate limited') as Error & { status?: number; response?: { status: number } };
              err.status = 429;
              err.response = { status: 429 };
              throw err;
            }
            return { data: { message_id: 'om_ok' } };
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) =>
    realSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const job = makeJob();
    writeJobFixture(job);
    await (scheduler as any).executeJob(job);
    if (calls !== 2) fail(`3: expected one scheduler retry, got ${calls} Feishu calls`);
    if (job.runtime.run_count !== 1) fail(`3: expected successful run_count=1, got ${job.runtime.run_count}`);
    if (job.runtime.last_error !== null) fail(`3: expected last_error=null, got ${job.runtime.last_error}`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  passed++;
}

// 4. Overlapping ticks are skipped while the previous tick is still running.
{
  const job = makeJob({
    meta: { id: 'tick-overlap' },
    runtime: { next_run_at: '2026-06-07T01:00:00.000Z' },
  });
  writeJobFixture(job);
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
  });
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredExecution = new Promise<void>((resolve) => {
    entered = resolve;
  });
  (scheduler as any).executeJob = async () => {
    calls++;
    entered();
    await blocked;
  };

  const firstTick = (scheduler as any).tick();
  await enteredExecution;
  const secondTick = (scheduler as any).tick();
  if (calls !== 1) fail(`4: expected only one executeJob while tick overlaps, got ${calls}`);
  release();
  await firstTick;
  await secondTick;
  passed++;
}

// 5. Runtime persistence preserves user metadata edits made during execution.
{
  const id = 'runtime-meta-race';
  const job = makeJob({
    meta: { id, content: 'old content', schedule: '0 9 * * *', schedule_human: 'daily at 09:00' },
  });
  writeJobFixture(job);
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            const onDisk = readJobFixture(id);
            onDisk.meta.content = 'edited during send';
            onDisk.meta.schedule = '*/30 * * * *';
            onDisk.meta.schedule_human = 'every 30m';
            writeJobFixture(onDisk);
            return { data: { message_id: 'om_ok' } };
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (persisted.meta.content !== 'edited during send') {
    fail(`5: scheduler overwrote concurrent content edit: ${persisted.meta.content}`);
  }
  if (persisted.meta.schedule !== '*/30 * * * *') {
    fail(`5: scheduler overwrote concurrent schedule edit: ${persisted.meta.schedule}`);
  }
  if (persisted.runtime.run_count !== 1) {
    fail(`5: expected run_count=1, got ${persisted.runtime.run_count}`);
  }
  passed++;
}

// 6. A far-past missed job uses the most recent due slot as its run key.
{
  const id = 'latest-missed-slot';
  const fixedNow = new Date('2026-06-07T01:17:00.000Z').getTime();
  const job = makeJob({
    meta: { id, schedule: '*/5 * * * *', schedule_human: 'every 5m' },
    runtime: { next_run_at: '2026-06-07T01:00:00.000Z' },
  });
  writeJobFixture(job);
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
  });
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  let runKey = '';
  (scheduler as any).executeMessageJob = async (_job: JobFile, capturedRunKey: string) => {
    runKey = capturedRunKey;
  };
  try {
    await (scheduler as any).executeJob(job);
  } finally {
    Date.now = originalNow;
  }
  if (runKey !== '2026-06-07T01:15:00.000Z') {
    fail(`6: expected latest missed run key 01:15, got ${runKey}`);
  }
  passed++;
}

// 7. Permanent Feishu target errors auto-pause the job.
{
  const id = 'permanent-target-error';
  const job = makeJob({ meta: { id } });
  writeJobFixture(job);
  let calls = 0;
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            calls++;
            const err = new Error('permission denied') as Error & { response?: { status: number; data: { code: number; msg: string } } };
            err.response = { status: 403, data: { code: 99991672, msg: 'permission denied' } };
            throw err;
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (calls !== 1) fail(`7: permanent error should not retry, got ${calls} calls`);
  if (persisted.meta.status !== 'paused') fail(`7: expected job auto-paused, got ${persisted.meta.status}`);
  if (!persisted.runtime.last_error?.includes('auto-paused')) {
    fail(`7: expected auto-pause audit in last_error, got ${persisted.runtime.last_error}`);
  }
  passed++;
}

// 8. Exhausted transient failures stay active for a future retry window.
{
  const id = 'transient-exhausted';
  const job = makeJob({ meta: { id } });
  writeJobFixture(job);
  let calls = 0;
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            calls++;
            const err = new Error('socket timeout') as Error & { code?: string };
            err.code = 'ETIMEDOUT';
            throw err;
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) =>
    realSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    await (scheduler as any).executeJob(job);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const persisted = readJobFixture(id);
  if (calls !== 4) fail(`8: expected initial call + 3 scheduler retries, got ${calls}`);
  if (persisted.meta.status !== 'active') fail(`8: transient failure should stay active, got ${persisted.meta.status}`);
  if (persisted.runtime.last_error?.includes('auto-paused')) {
    fail(`8: transient failure should not auto-pause, got ${persisted.runtime.last_error}`);
  }
  passed++;
}

// 9. Stable uuid derives from the latest missed run key, not the stale first missed slot.
{
  const id = 'uuid-latest-slot';
  const fixedNow = new Date('2026-06-07T01:17:00.000Z').getTime();
  const job = makeJob({
    meta: { id, schedule: '*/5 * * * *', schedule_human: 'every 5m' },
    runtime: { next_run_at: '2026-06-07T01:00:00.000Z' },
  });
  writeJobFixture(job);
  let uuid = '';
  const client = {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            uuid = args.data.uuid;
            return { data: { message_id: 'om_ok' } };
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    server: { notification: async () => {} } as any,
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await (scheduler as any).executeJob(job);
  } finally {
    Date.now = originalNow;
  }
  const expectedUuid = createHash('sha256')
    .update(`scheduler:${id}:2026-06-07T01:15:00.000Z`)
    .digest('hex')
    .slice(0, 32);
  if (uuid !== expectedUuid) {
    fail(`9: expected uuid for latest missed slot ${expectedUuid}, got ${uuid}`);
  }
  passed++;
}

// 10. Prompt notification delivery failures persist an explicit defer signal.
{
  const id = 'prompt-delivery-failure';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'summarize',
      content: undefined,
      msg_type: undefined,
    } as Partial<JobFile['meta']>,
  });
  writeJobFixture(job);
  const scheduler = new JobScheduler({
    server: { notification: async () => { throw new Error('channel unavailable'); } } as any,
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (persisted.meta.status !== 'active') {
    fail(`10: prompt delivery failure should stay active, got ${persisted.meta.status}`);
  }
  if (!persisted.runtime.last_error?.includes('[LARK_DEFER]')) {
    fail(`10: expected defer signal in last_error, got ${persisted.runtime.last_error}`);
  }
  passed++;
}

(appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
rmSync(tmpJobsDir, { recursive: true, force: true });

console.log(`scheduler smoke: ${passed}/10 PASS`);
