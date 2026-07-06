import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import { createInitialJobRuntime, type JobFile } from '../src/job-store.js';
import { createCodexExecActionDispatcher } from '../src/codex-exec-actions.js';
import type { LarkChannel } from '../src/channel.js';
import {
  createMockLarkClient,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} from './test-helpers/tool-fixtures.js';

function readJob(jobsDir: string, id: string): JobFile {
  return JSON.parse(readFileSync(join(jobsDir, `${id}.json`), 'utf-8')) as JobFile;
}

function assertInitialRuntimeShape(job: JobFile): void {
  const expected = createInitialJobRuntime(job.runtime.next_run_at);
  assert.deepEqual(Object.keys(job.runtime).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (key === 'next_run_at') continue;
    assert.equal(job.runtime[key], expected[key], `runtime.${String(key)}`);
  }
}

function comparableJobShape(job: JobFile): Record<string, unknown> {
  assertInitialRuntimeShape(job);
  return {
    type: job.meta.type,
    schedule: job.meta.schedule,
    schedule_human: job.meta.schedule_human,
    timezone: job.meta.timezone,
    content: job.meta.content,
    msg_type: job.meta.msg_type,
    target_chat_id: job.meta.target_chat_id,
    origin_chat_id: job.meta.origin_chat_id,
    status: job.meta.status,
    created_by: job.meta.created_by,
    model: job.meta.model ?? null,
    runtime_keys: Object.keys(job.runtime).sort(),
    runtime_last_run_at: job.runtime.last_run_at,
    runtime_run_count: job.runtime.run_count,
    runtime_last_error: job.runtime.last_error,
    runtime_run_id: job.runtime.run_id ?? null,
    runtime_run_status: job.runtime.run_status ?? null,
    runtime_output_status: job.runtime.output_status ?? null,
    runtime_delivery_status: job.runtime.delivery_status ?? null,
    runtime_report: job.runtime.report ?? null,
    runtime_report_type: job.runtime.report_type ?? null,
    runtime_delivery_error: job.runtime.delivery_error ?? null,
    runtime_diagnostics: job.runtime.diagnostics ?? null,
  };
}

let passed = 0;
const jobsDir = mkdtempSync(join(tmpdir(), 'job-lifecycle-parity-'));
const originalJobsDir = appConfig.jobsDir;
const originalCronTimezone = appConfig.cronTimezone;
(appConfig as { jobsDir: string }).jobsDir = jobsDir;
(appConfig as { cronTimezone: string }).cronTimezone = 'Asia/Shanghai';

try {
  const identity = new IdentitySession(() => null);
  identity.setCaller('oc_parity', 'thread_parity', 'ou_parity');
  const noopMemory = createNoopMemoryStore();
  const fakeClient = createMockLarkClient();
  const fakeChannel = createPrivateChatChannel() as unknown as LarkChannel;
  const { server: fakeServer, getTool } = createToolServerHarness();

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

  const createJobTool = getTool('create_job');
  const updateJobTool = getTool('update_job');
  const dispatcher = createCodexExecActionDispatcher({
    memoryStore: noopMemory,
    identitySession: identity,
  });
  const execMessage = {
    messageId: 'om_parity',
    chatId: 'oc_parity',
    threadId: 'thread_parity',
    chatType: 'group' as const,
    senderId: 'ou_parity',
    text: 'create parity job',
    messageType: 'text' as const,
    rawContent: '{}',
  };

  const mcpCreate = await createJobTool({
    name: 'MCP Parity Job',
    type: 'message',
    schedule: 'daily at 09:00',
    timezone: 'Asia/Tokyo',
    content: 'parity reminder',
    target_chat_id: 'oc_target',
    chat_id: 'oc_parity',
    thread_id: 'thread_parity',
  });
  assert.equal(mcpCreate.isError, undefined, JSON.stringify(mcpCreate));

  const execCreate = await dispatcher.execute({
    message: execMessage,
    actions: [
      {
        type: 'create_job',
        name: 'Exec Parity Job',
        job_type: 'message',
        schedule: 'daily at 09:00',
        timezone: 'Asia/Tokyo',
        content: 'parity reminder',
        target_chat_id: 'oc_target',
      },
    ],
  });
  assert.equal(execCreate[0].ok, true, JSON.stringify(execCreate));
  assert.deepEqual(
    comparableJobShape(readJob(jobsDir, 'mcp-parity-job')),
    comparableJobShape(readJob(jobsDir, 'exec-parity-job')),
  );
  passed++;

  const mcpUpdate = await updateJobTool({
    id: 'mcp-parity-job',
    status: 'paused',
    schedule: 'daily at 10:00',
    content: 'updated parity reminder',
    chat_id: 'oc_parity',
    thread_id: 'thread_parity',
  });
  assert.equal(mcpUpdate.isError, undefined, JSON.stringify(mcpUpdate));

  const execUpsert = await dispatcher.execute({
    message: execMessage,
    actions: [
      {
        type: 'upsert_job',
        name: 'Exec Parity Job',
        job_type: 'message',
        schedule: 'daily at 10:00',
        timezone: 'Asia/Tokyo',
        content: 'updated parity reminder',
        target_chat_id: 'oc_target',
        status: 'paused',
      },
    ],
  });
  assert.equal(execUpsert[0].ok, true, JSON.stringify(execUpsert));
  assert.deepEqual(
    comparableJobShape(readJob(jobsDir, 'mcp-parity-job')),
    comparableJobShape(readJob(jobsDir, 'exec-parity-job')),
  );
  passed++;
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  (appConfig as { cronTimezone: string }).cronTimezone = originalCronTimezone;
  rmSync(jobsDir, { recursive: true, force: true });
}

console.log(`job-lifecycle parity smoke: ${passed}/2 PASS`);
