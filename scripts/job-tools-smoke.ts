/**
 * Job MCP tool smoke tests.
 *
 * Focuses on update_job behavior that is easy to regress when moving from a
 * read/edit/write flow to job-store.mutateJob.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import type { JobFile } from '../src/job-store.js';
import type { LarkChannel } from '../src/channel.js';
import {
  createMockLarkClient,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} from './test-helpers/tool-fixtures.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const { server: fakeServer, handlers, getTool } = createToolServerHarness();
const noopMemory = createNoopMemoryStore();
const fakeClient = createMockLarkClient();

function makeJob(overrides: Partial<JobFile['meta']> = {}, runtime: Partial<JobFile['runtime']> = {}): JobFile {
  return {
    meta: {
      id: 'tool-job',
      name: 'Tool Job',
      type: 'message',
      schedule: '*/30 * * * *',
      schedule_human: 'every 30m',
      content: 'old',
      msg_type: 'text',
      target_chat_id: 'chat_target',
      origin_chat_id: 'chat_owner',
      model: 'gpt-old',
      status: 'paused',
      created_by: 'ou_owner',
      created_at: '2026-06-07T00:00:00.000Z',
      ...overrides,
    },
    runtime: {
      last_run_at: null,
      next_run_at: '2099-01-01T00:00:00.000Z',
      run_count: 3,
      last_error: 'old error',
      ...runtime,
    },
  };
}

const jobsDir = mkdtempSync(join(tmpdir(), 'job-tools-smoke-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = jobsDir;

function pathFor(id: string): string {
  return join(jobsDir, `${id}.json`);
}

function writeJob(job: JobFile): void {
  writeFileSync(pathFor(job.meta.id), JSON.stringify(job, null, 2));
}

function readJob(id: string): JobFile {
  return JSON.parse(readFileSync(pathFor(id), 'utf-8')) as JobFile;
}

try {
  const identity = new IdentitySession(() => null);
  identity.setCaller('chat_owner', 'thread_owner', 'ou_owner');
  identity.setCaller('chat_other', 'thread_other', 'ou_other');
  const fakeChannel = createPrivateChatChannel() as unknown as LarkChannel;

  registerTools(
    fakeServer as any,
    fakeClient as any,
    noopMemory,
    identity,
    fakeChannel,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const updateJob = getTool('update_job');

  // 1. Missing job returns an MCP error.
  {
    const r = await updateJob({ id: 'missing', content: 'x', chat_id: 'chat_owner', thread_id: 'thread_owner' });
    if (!r.isError) fail(`1: missing job should return isError, got ${JSON.stringify(r)}`);
    passed++;
  }

  // 2. Owner mismatch is denied and leaves the file unchanged.
  {
    const job = makeJob({ id: 'owner-only', content: 'old' });
    writeJob(job);
    const r = await updateJob({ id: 'owner-only', content: 'hacked', chat_id: 'chat_other', thread_id: 'thread_other' });
    if (!r.isError) fail(`2: non-owner update should return isError, got ${JSON.stringify(r)}`);
    if (readJob('owner-only').meta.content !== 'old') fail('2: non-owner update changed content');
    passed++;
  }

  // 3. Invalid schedule is rejected before any mutation.
  {
    const job = makeJob({ id: 'bad-schedule', content: 'old' });
    writeJob(job);
    const r = await updateJob({
      id: 'bad-schedule',
      schedule: 'every 7m',
      content: 'new',
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    if (!r.isError) fail(`3: invalid schedule should return isError, got ${JSON.stringify(r)}`);
    const persisted = readJob('bad-schedule');
    if (persisted.meta.content !== 'old') fail('3: invalid schedule still mutated content');
    if (persisted.meta.schedule !== '*/30 * * * *') fail(`3: schedule changed to ${persisted.meta.schedule}`);
    passed++;
  }

  // 4. Resume recomputes next_run_at and normal fields still update.
  {
    const job = makeJob({ id: 'resume-update', status: 'paused', content: 'old', model: 'gpt-old' });
    writeJob(job);
    const r = await updateJob({
      id: 'resume-update',
      status: 'active',
      content: 'new',
      name: 'New Name',
      model: '',
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    if (r.isError) fail(`4: owner update should succeed, got ${JSON.stringify(r)}`);
    const persisted = readJob('resume-update');
    if (persisted.meta.status !== 'active') fail(`4: expected active, got ${persisted.meta.status}`);
    if (persisted.meta.content !== 'new') fail(`4: content not updated: ${persisted.meta.content}`);
    if (persisted.meta.name !== 'New Name') fail(`4: name not updated: ${persisted.meta.name}`);
    if (persisted.meta.model !== undefined) fail(`4: model should be cleared, got ${persisted.meta.model}`);
    if (persisted.runtime.next_run_at === '2099-01-01T00:00:00.000Z') {
      fail('4: resume did not recompute next_run_at');
    }
    if (persisted.runtime.run_count !== 3 || persisted.runtime.last_error !== 'old error') {
      fail(`4: runtime fields unexpectedly changed: ${JSON.stringify(persisted.runtime)}`);
    }
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(jobsDir, { recursive: true, force: true });
}

console.log(`job-tools smoke: ${passed}/4 PASS`);
