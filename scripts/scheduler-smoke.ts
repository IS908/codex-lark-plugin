/**
 * Scheduler message-send smoke test.
 *
 * Verifies the Feishu API wrapper does not add a nested retry loop inside the
 * scheduler's existing job-level retry, and that a due job run uses a stable
 * Feishu message uuid for idempotency.
 */
import { JobScheduler } from '../src/scheduler.js';
import { IdentitySession } from '../src/identity-session.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { appConfig } from '../src/config.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const tmpJobsDir = mkdtempSync(path.join(tmpdir(), 'scheduler-smoke-jobs-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

function makeJob() {
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
    },
    runtime: {
      next_run_at: '2026-06-07T01:00:00.000Z',
      last_run_at: null,
      last_error: null,
      run_count: 0,
    },
  };
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
    await (scheduler as any).executeJob(job);
    if (calls !== 2) fail(`3: expected one scheduler retry, got ${calls} Feishu calls`);
    if (job.runtime.run_count !== 1) fail(`3: expected successful run_count=1, got ${job.runtime.run_count}`);
    if (job.runtime.last_error !== null) fail(`3: expected last_error=null, got ${job.runtime.last_error}`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  passed++;
}

(appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
rmSync(tmpJobsDir, { recursive: true, force: true });

console.log(`scheduler smoke: ${passed}/3 PASS`);
