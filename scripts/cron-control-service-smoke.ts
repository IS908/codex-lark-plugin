import assert from 'node:assert/strict';
import type { JobFile } from '../src/job-contracts.js';
import { createCronControlService } from '../src/cron/control-service.js';
import { JobScheduler } from '../src/scheduler.js';

function makeJob(overrides: {
  meta?: Partial<JobFile['meta']>;
  runtime?: Partial<JobFile['runtime']>;
} = {}): JobFile {
  return {
    meta: {
      id: 'daily-report',
      revision: 3,
      name: 'Daily report',
      type: 'prompt',
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      timezone: 'Asia/Singapore',
      prompt: 'private portfolio prompt',
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_origin',
      status: 'active',
      created_by: 'ou_owner',
      created_at: '2026-11-01T00:00:00.000Z',
      ...overrides.meta,
    },
    runtime: {
      last_run_at: '2026-11-15T01:00:00.000Z',
      next_run_at: '2026-11-16T01:00:00.000Z',
      run_count: 7,
      last_error: null,
      ...overrides.runtime,
    },
  };
}

let current = makeJob();
const updates: Array<Record<string, unknown>> = [];
const starts: JobFile[] = [];
const service = createCronControlService({
  async resolveJob(reference) {
    return reference.jobId === current.meta.id
      ? { ok: true as const, job: current }
      : { ok: false as const, code: 'job_not_found' as const, message: 'not found' };
  },
  async updateJob(input) {
    updates.push(input as unknown as Record<string, unknown>);
    if (input.expectedCreatedAt !== current.meta.created_at) {
      return { ok: false as const, code: 'stale_job' as const, message: 'stale' };
    }
    current = makeJob({ meta: { ...current.meta, status: input.updates.status ?? current.meta.status } });
    return { ok: true as const, job: current };
  },
  async startJobNow(job) {
    starts.push(job);
    return { started: true, runId: 'cron_manual_001' };
  },
});

const paused = await service.pause({
  caller: 'ou_owner',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(paused.ok, true);
assert.equal(paused.code, 'paused');
assert.match(paused.message, /已暂停「Daily report」/);
assert.match(paused.message, /已开始的本次执行不会被取消/);
assert.equal(updates.length, 1);
assert.equal((updates[0] as any).expectedCreatedAt, '2026-11-01T00:00:00.000Z');

const pausedAgain = await service.pause({
  caller: 'ou_owner',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(pausedAgain.ok, true);
assert.equal(pausedAgain.code, 'already_paused');
assert.equal(updates.length, 1, 'idempotent pause should not rewrite the Job');

current = makeJob();
const denied = await service.pause({
  caller: 'ou_other',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(denied.ok, false);
assert.equal(denied.code, 'owner_mismatch');

const stale = await service.pause({
  caller: 'ou_owner',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-10-01T00:00:00.000Z',
});
assert.equal(stale.ok, false);
assert.equal(stale.code, 'stale_job');

const crossChat = await service.pause({
  caller: 'ou_owner',
  chatId: 'oc_other',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(crossChat.ok, false);
assert.equal(crossChat.code, 'wrong_chat');

const groupView = await service.view({
  caller: 'ou_group_member',
  chatId: 'oc_target',
  isPrivateChat: false,
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(groupView.ok, true);
assert.match(groupView.message, /Daily report/);
assert.match(groupView.message, /daily-report/);
assert.doesNotMatch(groupView.message, /private portfolio prompt/);

const ownerView = await service.view({
  caller: 'ou_owner',
  chatId: 'oc_target',
  isPrivateChat: false,
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(ownerView.ok, true);
assert.match(ownerView.message, /private portfolio prompt/);

const privateViewDenied = await service.view({
  caller: 'ou_other',
  chatId: 'oc_target',
  isPrivateChat: true,
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(privateViewDenied.ok, false);
assert.equal(privateViewDenied.code, 'not_visible');

const started = await service.runNow({
  caller: 'ou_owner',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(started.ok, true);
assert.equal(started.code, 'started');
assert.match(started.message, /已开始运行「Daily report」/);
assert.equal(starts.length, 1);

const unavailableService = createCronControlService({
  async resolveJob() { return { ok: true as const, job: makeJob() }; },
  async startJobNow() { return { started: false as const, reason: 'runner_unavailable' as const }; },
});
const unavailable = await unavailableService.runNow({
  caller: 'ou_owner',
  chatId: 'oc_target',
  jobId: 'daily-report',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
});
assert.equal(unavailable.ok, false);
assert.equal(unavailable.code, 'runner_unavailable');
assert.match(unavailable.message, /尚未就绪/);

let admitCalls = 0;
let waitCalls = 0;
const scheduler = new JobScheduler({
  admission: {
    async admitManual() {
      admitCalls += 1;
      return { admitted: true as const, created: true, runId: 'cron_admitted_001' };
    },
    async waitForExecution() {
      waitCalls += 1;
      return 'success' as const;
    },
  } as any,
  repository: { async listAllJobs() { return []; } },
  scanIntervalMs: 60_000,
});
assert.deepEqual(await scheduler.startJobNow(makeJob()), {
  started: true,
  runId: 'cron_admitted_001',
});
assert.equal(admitCalls, 1);
assert.equal(waitCalls, 0, 'startJobNow must return after durable admission');

console.log('cron control service smoke: PASS');
