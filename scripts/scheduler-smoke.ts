/**
 * Scheduler message-send smoke test.
 *
 * Verifies the Feishu API wrapper does not add a nested retry loop inside the
 * scheduler's existing job-level retry, and that a due job run uses a stable
 * Feishu message uuid for idempotency.
 */
import {
  JobScheduler,
  JOB_THREAD_PREFIX,
  jobCreatedAtHash,
  recordCronJobReportDelivery,
} from '../src/scheduler.js';
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
const originalCronTimezone = appConfig.cronTimezone;
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
  const trackedBotMessages: Array<{ id: string; meta: any }> = [];
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
    client: client as any,
    identitySession: new IdentitySession(() => null),
    botMessageTracker: {
      add: (id: string, meta: any) => trackedBotMessages.push({ id, meta }),
      has: () => false,
      get: () => undefined,
    } as any,
  });
  const job = makeJob();
  await (scheduler as any).executeMessageJob(job, job.runtime.next_run_at);
  await (scheduler as any).executeMessageJob(job, job.runtime.next_run_at);
  if (!uuids[0] || uuids[0] !== uuids[1]) {
    fail(`1: expected stable uuid for same runKey, got ${JSON.stringify(uuids)}`);
  }
  if (
    trackedBotMessages.length !== 2 ||
    trackedBotMessages[0].id !== 'om_1' ||
    trackedBotMessages[0].meta?.chatId !== 'oc_target' ||
    trackedBotMessages[1].id !== 'om_2'
  ) {
    fail(`1: scheduler bot tracker not updated: ${JSON.stringify(trackedBotMessages)}`);
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

// 10. Prompt jobs include created_at identity in synthetic thread_id.
{
  const id = 'prompt-thread-identity';
  const createdAt = '2026-06-07T02:00:00.000Z';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'summarize',
      content: undefined,
      msg_type: undefined,
      created_at: createdAt,
    } as Partial<JobFile['meta']>,
  });
  writeJobFixture(job);
  let threadId = '';
  let runnerCalls = 0;
  const scheduler = new JobScheduler({
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
    promptRunner: async (input: any) => {
      runnerCalls++;
      threadId = input.jobThreadId;
      return { report: 'thread ok' };
    },
  });
  await (scheduler as any).executeJob(job);
  const expectedPrefix = `${JOB_THREAD_PREFIX}${id}-${jobCreatedAtHash(createdAt)}-`;
  if (!threadId.startsWith(expectedPrefix)) {
    fail(`10: expected prompt thread_id to start with ${expectedPrefix}, got ${threadId}`);
  }
  const persisted = readJobFixture(id);
  const runId = threadId.slice(threadId.lastIndexOf('-') + 1);
  if (runnerCalls !== 1) {
    fail(`10: expected prompt runner once, got ${runnerCalls}`);
  }
  if (persisted.runtime.run_status !== 'success') {
    fail(`10: expected prompt run_status=success after exec runner, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.output_status !== 'generated') {
    fail(`10: expected prompt output_status=generated, got ${persisted.runtime.output_status}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`10: expected prompt delivery_status=sent, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.run_id !== runId) {
    fail(`10: expected persisted run_id=${runId}, got ${persisted.runtime.run_id}`);
  }
  passed++;
}

// 11. Scheduler uses the job's explicit timezone when advancing next_run_at.
{
  const id = 'per-job-timezone-next-run';
  const job = makeJob({
    meta: {
      id,
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      timezone: 'Asia/Shanghai',
    } as any,
    runtime: { next_run_at: '2026-07-01T01:00:00.000Z' },
  });
  writeJobFixture(job);
  const scheduler = new JobScheduler({
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
  });
  const originalNow = Date.now;
  (appConfig as { cronTimezone: string }).cronTimezone = 'UTC';
  Date.now = () => new Date('2026-07-02T00:30:00.000Z').getTime();
  try {
    await (scheduler as any).executeJob(job);
  } finally {
    Date.now = originalNow;
    (appConfig as { cronTimezone: string }).cronTimezone = originalCronTimezone;
  }
  const persisted = readJobFixture(id);
  if ((persisted.meta as any).timezone !== 'Asia/Shanghai') {
    fail(`11: expected job timezone to persist, got ${JSON.stringify(persisted.meta)}`);
  }
  if (persisted.runtime.next_run_at !== '2026-07-02T01:00:00.000Z') {
    fail(`11: expected next_run_at to use Asia/Shanghai 09:00, got ${persisted.runtime.next_run_at}`);
  }
  passed++;
}

// 12. Legacy pending prompt report delivery can still be recorded.
{
  const id = 'prompt-legacy-pending-report';
  const createdAt = '2026-06-07T02:30:00.000Z';
  const runId = '1760000000000';
  const report = '# Fast report\n\nDelivered by legacy pending reply.';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'summarize',
      content: undefined,
      msg_type: undefined,
      created_at: createdAt,
    } as Partial<JobFile['meta']>,
    runtime: {
      run_id: runId,
      run_status: 'started',
      output_status: 'empty',
      delivery_status: 'pending',
      report: null,
      report_type: null,
      delivery_error: null,
    },
  });
  writeJobFixture(job);
  const threadId = `${JOB_THREAD_PREFIX}${id}-${jobCreatedAtHash(createdAt)}-${runId}`;
  const updated = await recordCronJobReportDelivery(threadId, {
    runStatus: 'success',
    deliveryStatus: 'sent',
    report,
    reportType: 'job_result',
  });
  if (!updated) fail('12: expected legacy pending report delivery to update job');
  const persisted = readJobFixture(id);
  if (persisted.runtime.run_status !== 'success') {
    fail(`12: expected delivered run_status=success to be preserved, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`12: expected delivered status=sent to be preserved, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.report !== report) {
    fail(`12: expected delivered report to be preserved, got ${persisted.runtime.report}`);
  }
  passed++;
}

// 12b. Prompt jobs complete through the exec runner.
{
  const id = 'prompt-runner-completes';
  const createdAt = '2026-06-07T02:45:00.000Z';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'reply pong',
      content: undefined,
      msg_type: undefined,
      created_at: createdAt,
    } as Partial<JobFile['meta']>,
  });
  writeJobFixture(job);
  let runnerCalls = 0;
  const scheduler = new JobScheduler({
    client: { im: { v1: { message: { create: async () => ({ data: { message_id: 'om_ok' } }) } } } } as any,
    identitySession: new IdentitySession(() => null),
    promptRunner: async (input: any) => {
      runnerCalls++;
      const expectedPrefix = `${JOB_THREAD_PREFIX}${id}-${jobCreatedAtHash(createdAt)}-`;
      if (input.job.meta.id !== id) fail(`12b: runner received wrong job id ${input.job.meta.id}`);
      if (!input.jobThreadId.startsWith(expectedPrefix)) {
        fail(`12b: runner thread_id should start with ${expectedPrefix}, got ${input.jobThreadId}`);
      }
      if (!input.promptContent.includes('reply pong')) {
        fail(`12b: runner prompt should contain job prompt, got ${input.promptContent}`);
      }
      return { report: 'pong' };
    },
  } as any);
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (runnerCalls !== 1) fail(`12b: expected prompt runner once, got ${runnerCalls}`);
  if (persisted.runtime.run_status !== 'success') {
    fail(`12b: expected success run_status, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`12b: expected sent delivery_status, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.report !== 'pong') {
    fail(`12b: expected persisted report pong, got ${persisted.runtime.report}`);
  }
  passed++;
}

// 12c. Prompt exec timeouts include structured diagnostics and redacted tails.
{
  const id = 'prompt-timeout-diagnostics';
  const createdAt = '2026-06-07T02:50:00.000Z';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'build weekly report',
      content: undefined,
      msg_type: undefined,
      created_at: createdAt,
    } as Partial<JobFile['meta']>,
  });
  writeJobFixture(job);
  const createdMessages: any[] = [];
  const scheduler = new JobScheduler({
    client: {
      im: {
        v1: {
          message: {
            create: async (args: any) => {
              createdMessages.push(args);
              return { data: { message_id: 'om_timeout_diagnostics' } };
            },
          },
        },
      },
    } as any,
    identitySession: new IdentitySession(() => null),
    promptRunner: async (input: any) => {
      input.diagnostics.recordProgress('stage=fetch_quotes token=supersecret', Date.now(), 38);
      const err = new Error('codex exec timed out after 600000ms') as Error & {
        stdoutTail?: string;
        stderrTail?: string;
      };
      err.stdoutTail = 'latest stdout token=supersecret';
      err.stderrTail = 'latest stderr authorization=supersecret';
      throw err;
    },
  } as any);
  await (scheduler as any).executeJob(job);
  if (createdMessages.length !== 1) {
    fail(`12c: expected one timeout diagnostic report, got ${createdMessages.length}`);
  }
  const sentContent = JSON.parse(createdMessages[0].data.content);
  const text = sentContent.text ?? '';
  if (!text.includes('Diagnostics:')) fail(`12c: report missing diagnostics: ${text}`);
  if (!text.includes('current_stage: fetch_quotes')) fail(`12c: report missing current stage: ${text}`);
  if (!text.includes('last_progress: stage=fetch_quotes token=[redacted]')) {
    fail(`12c: report missing redacted progress: ${text}`);
  }
  if (!text.includes('stdout_tail: latest stdout token=[redacted]')) {
    fail(`12c: report missing redacted stdout tail: ${text}`);
  }
  if (!text.includes('stderr_tail: latest stderr authorization=[redacted]')) {
    fail(`12c: report missing redacted stderr tail: ${text}`);
  }
  if (text.includes('supersecret')) fail(`12c: report leaked sensitive text: ${text}`);
  const persisted = readJobFixture(id);
  if (persisted.runtime.run_status !== 'failed') {
    fail(`12c: expected failed run_status, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.diagnostics?.current_stage !== 'fetch_quotes') {
    fail(`12c: persisted diagnostics missing current stage: ${JSON.stringify(persisted.runtime.diagnostics)}`);
  }
  if (!persisted.runtime.diagnostics?.stages.some((stage) => stage.name === 'send_lark_error_report' && stage.status === 'success')) {
    fail(`12c: persisted diagnostics missing send_lark_error_report success: ${JSON.stringify(persisted.runtime.diagnostics)}`);
  }
  passed++;
}

// 12d. A delivered lifecycle-guard notice records a failed run without a second error message.
{
  const id = 'prompt-lifecycle-guarded';
  const job = makeJob({
    meta: {
      id,
      type: 'prompt',
      prompt: 'build a report and follow up later',
      content: undefined,
      msg_type: undefined,
    } as Partial<JobFile['meta']>,
  });
  writeJobFixture(job);
  let extraMessages = 0;
  const scheduler = new JobScheduler({
    client: {
      im: {
        v1: {
          message: {
            create: async () => {
              extraMessages++;
              return { data: { message_id: 'om_unexpected_duplicate' } };
            },
          },
        },
      },
    } as any,
    identitySession: new IdentitySession(() => null),
    promptRunner: async () => ({
      report:
        'This run could not establish a follow-up task, so no background work will continue. Please retry or use a supported scheduled task.',
      runStatus: 'failed',
      failureReason: 'Lifecycle guard blocked output: chinese-async-followup-promise',
    }),
  });
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (persisted.runtime.run_status !== 'failed') {
    fail(`12d: expected failed run_status, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`12d: expected sent delivery_status, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.report_type !== 'error_report') {
    fail(`12d: expected error_report, got ${persisted.runtime.report_type}`);
  }
  if (persisted.runtime.last_error !== 'Lifecycle guard blocked output: chinese-async-followup-promise') {
    fail(`12d: expected lifecycle failure reason, got ${persisted.runtime.last_error}`);
  }
  if (!persisted.runtime.diagnostics?.stages.some((stage) => stage.name === 'codex_exec' && stage.status === 'failed')) {
    fail(`12d: expected failed codex_exec diagnostic stage, got ${JSON.stringify(persisted.runtime.diagnostics)}`);
  }
  if (extraMessages !== 0) {
    fail(`12d: expected no duplicate error message, got ${extraMessages}`);
  }
  passed++;
}

// 13. Pausing a job during a transient retry window cancels the next send.
{
  const id = 'pause-before-retry';
  const job = makeJob({ meta: { id } });
  writeJobFixture(job);
  let calls = 0;
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            calls++;
            const onDisk = readJobFixture(id);
            onDisk.meta.status = 'paused';
            writeJobFixture(onDisk);
            const err = new Error('socket timeout') as Error & { code?: string };
            err.code = 'ETIMEDOUT';
            throw err;
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
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
  if (calls !== 1) fail(`13: expected paused job to cancel retry after 1 call, got ${calls}`);
  if (readJobFixture(id).meta.status !== 'paused') fail('13: expected job to remain paused');
  passed++;
}

// 14. Missing prompt runner persists an explicit defer signal.
{
  const id = 'prompt-runner-missing';
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
  const createdMessages: any[] = [];
  const scheduler = new JobScheduler({
    client: {
      im: {
        v1: {
          message: {
            create: async (args: any) => {
              createdMessages.push(args);
              return { data: { message_id: 'om_error_report' } };
            },
          },
        },
      },
    } as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeJob(job);
  const persisted = readJobFixture(id);
  if (persisted.meta.status !== 'active') {
    fail(`14: prompt delivery failure should stay active, got ${persisted.meta.status}`);
  }
  if (!persisted.runtime.last_error?.includes('[LARK_DEFER]')) {
    fail(`14: expected defer signal in last_error, got ${persisted.runtime.last_error}`);
  }
  if (createdMessages.length !== 1) {
    fail(`14: expected one error report message, got ${createdMessages.length}`);
  }
  const sentContent = JSON.parse(createdMessages[0].data.content);
  if (!sentContent.text?.includes('CronJob "daily ping" failed before a complete report could be delivered.')) {
    fail(`14: error report was not sent through Feishu payload: ${createdMessages[0].data.content}`);
  }
  if (persisted.runtime.run_status !== 'failed') {
    fail(`14: expected failed run_status, got ${persisted.runtime.run_status}`);
  }
  if (persisted.runtime.output_status !== 'generated') {
    fail(`14: expected generated error report output, got ${persisted.runtime.output_status}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`14: expected sent error report delivery, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.report_type !== 'error_report') {
    fail(`14: expected error_report type, got ${persisted.runtime.report_type}`);
  }
  if (!persisted.runtime.report?.includes('CronJob prompt execution failed')) {
    fail(`14: expected persisted error report body, got ${persisted.runtime.report}`);
  }
  if (!persisted.runtime.report?.includes('prompt runner is not configured')) {
    fail(`14: expected persisted error report body, got ${persisted.runtime.report}`);
  }
  passed++;
}

// 15. Prompt error-report Feishu delivery failures use scheduler-level retry.
{
  const id = 'prompt-error-report-retry';
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
  let createCalls = 0;
  const scheduler = new JobScheduler({
    client: {
      im: {
        v1: {
          message: {
            create: async () => {
              createCalls++;
              if (createCalls === 1) {
                const err = new Error('socket timeout') as Error & { code?: string };
                err.code = 'ETIMEDOUT';
                throw err;
              }
              return { data: { message_id: 'om_error_report_retry_ok' } };
            },
          },
        },
      },
    } as any,
    identitySession: new IdentitySession(() => null),
    promptRunner: async () => {
      throw new Error('codex exec unavailable');
    },
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
  if (createCalls !== 2) {
    fail(`15: expected retried error report delivery, got create=${createCalls}`);
  }
  if (persisted.runtime.delivery_status !== 'sent') {
    fail(`15: expected retried error report delivery_status=sent, got ${persisted.runtime.delivery_status}`);
  }
  if (persisted.runtime.report_type !== 'error_report') {
    fail(`15: expected error_report after retry, got ${persisted.runtime.report_type}`);
  }
  passed++;
}

// 16. A stale execution must not update a job that was deleted/recreated with the same id.
{
  const id = 'recreated-same-id';
  const oldJob = makeJob({
    meta: { id, content: 'old content', created_at: '2026-06-07T00:00:00.000Z' },
  });
  writeJobFixture(oldJob);
  const client = {
    im: {
      v1: {
        message: {
          create: async () => {
            const replacement = makeJob({
              meta: {
                id,
                content: 'new content',
                created_at: '2026-06-07T00:01:00.000Z',
              },
              runtime: {
                next_run_at: '2099-01-01T00:00:00.000Z',
                run_count: 0,
                last_error: null,
                last_run_at: null,
              },
            });
            writeJobFixture(replacement);
            return { data: { message_id: 'om_old_sent' } };
          },
        },
      },
    },
  };
  const scheduler = new JobScheduler({
    client: client as any,
    identitySession: new IdentitySession(() => null),
  });
  await (scheduler as any).executeJob(oldJob);
  const persisted = readJobFixture(id);
  if (persisted.meta.content !== 'new content') {
    fail(`11: replacement content was overwritten by stale execution: ${persisted.meta.content}`);
  }
  if (persisted.runtime.run_count !== 0 || persisted.runtime.last_run_at !== null) {
    fail(`11: stale execution updated replacement runtime: ${JSON.stringify(persisted.runtime)}`);
  }
  passed++;
}

// 20. Manual reruns reuse the persisted definition without shifting a future
// scheduled run, and paused jobs remain paused.
{
  const id = 'manual-rerun';
  const futureNextRun = '2099-01-01T09:00:00.000Z';
  const job = makeJob({
    meta: { id, content: 'original persisted task', status: 'paused' },
    runtime: { next_run_at: futureNextRun },
  });
  writeJobFixture(job);
  const sent: string[] = [];
  const scheduler = new JobScheduler({
    client: {} as any,
    transport: {
      sendMessage: async (request: any) => {
        sent.push(JSON.parse(request.input.raw.content).text);
        return { messageId: 'om_manual_rerun' };
      },
    } as any,
    identitySession: new IdentitySession(() => null),
  });
  const result = await scheduler.runJobNow(job);
  const persisted = readJobFixture(id);
  if (!result.started) fail(`20: expected manual rerun to start: ${JSON.stringify(result)}`);
  if (sent[0] !== 'original persisted task') fail(`20: manual rerun rebuilt task content: ${JSON.stringify(sent)}`);
  if (persisted.meta.status !== 'paused') fail(`20: manual rerun activated paused job: ${persisted.meta.status}`);
  if (persisted.runtime.next_run_at !== futureNextRun) {
    fail(`20: manual rerun shifted future schedule: ${persisted.runtime.next_run_at}`);
  }
  if (persisted.runtime.run_count !== 1) fail(`20: expected run_count=1, got ${persisted.runtime.run_count}`);
  passed++;
}

// 21. A second manual rerun is rejected while the same job is still running.
{
  const id = 'manual-overlap';
  const job = makeJob({ meta: { id }, runtime: { next_run_at: '2099-01-01T09:00:00.000Z' } });
  writeJobFixture(job);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const enteredSend = new Promise<void>((resolve) => { entered = resolve; });
  const scheduler = new JobScheduler({
    client: {} as any,
    transport: {
      sendMessage: async () => {
        entered();
        await blocked;
        return { messageId: 'om_manual_overlap' };
      },
    } as any,
    identitySession: new IdentitySession(() => null),
  });
  const firstRun = scheduler.runJobNow(job);
  await enteredSend;
  const overlap = await scheduler.runJobNow(job);
  if (overlap.started || overlap.reason !== 'already_running') {
    fail(`21: expected already_running rejection, got ${JSON.stringify(overlap)}`);
  }
  release();
  const first = await firstRun;
  if (!first.started) fail(`21: first manual rerun did not complete: ${JSON.stringify(first)}`);
  passed++;
}

(appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
(appConfig as { cronTimezone: string }).cronTimezone = originalCronTimezone;
rmSync(tmpJobsDir, { recursive: true, force: true });

console.log(`scheduler smoke: ${passed}/21 PASS`);
