import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LarkMessage } from '../src/lark-message.js';
import type { ContinuationAuditEvent } from '../src/ports/continuation.js';
import type { CodexExecRequest } from '../src/codex-exec.js';
import { handleContinuationCommand } from '../src/continuation/command-handler.js';
import { createContinuationRuntime } from '../src/continuation/runtime.js';

const root = await mkdtemp(path.join(tmpdir(), 'continuation-runtime-'));
const clock = { now: () => new Date('2026-07-17T12:00:00.000Z') };
const traceRequests: Array<Pick<CodexExecRequest, 'traceLogId' | 'traceRunId'>> = [];
const debugLines: string[] = [];
const auditEvents: ContinuationAuditEvent[] = [];
const delivered: string[] = [];
const invokedTools: string[] = [];

const runtime = await createContinuationRuntime({
  enabled: true,
  databasePath: path.join(root, 'jobs.sqlite'),
  artifactsDir: path.join(root, 'artifacts'),
  allowedWorkingRoot: root,
  maxSteps: 12,
  maxRetries: 2,
  maxAgeHours: 24,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'workspace-write',
  toolInvoker: {
    async recover() { return null; },
    async invoke(_claim, request) {
      invokedTools.push(request.tool);
      return {
        status: 'completed',
        result: { ok: true, message: '{"runtime":"tool-result"}' },
      };
    },
  },
  clock,
  getTransport: () => ({} as never),
  runCodexExec: async (request) => {
    traceRequests.push({
      traceLogId: request.traceLogId,
      traceRunId: request.traceRunId,
    });
    return traceRequests.length === 1 ? {
      text: JSON.stringify({
        outcome: 'tool_request',
        tool: 'lark_cli',
        args: ['doc', 'get'],
      }),
      sessionId: 'session_runtime',
    } : {
      text: JSON.stringify({
        outcome: 'completed',
        final_message: 'Sensitive result body delivered to the user.',
        result_summary: 'Done.',
        artifacts: [],
      }),
      sessionId: 'session_runtime',
    };
  },
  delivery: {
    async deliver(claim) {
      delivered.push(claim.payload);
      return { status: 'delivered', messageId: 'om_runtime_terminal' };
    },
  },
  audit: {
    async record(event) { auditEvents.push(event); },
  },
  debug: (line) => { debugLines.push(line); },
  retentionIntervalMs: 60_000,
});

assert.equal(runtime.health.available, true);
assert.ok(runtime.worker);
const sourceMessage: LarkMessage = {
  messageId: 'om_runtime_source',
  chatId: 'oc_runtime',
  chatType: 'group',
  senderId: 'ou_runtime_creator',
  text: 'Continue this work.',
  messageType: 'text',
  rawContent: '{"text":"Continue this work."}',
  threadId: 'omt_runtime',
};
const { job } = await runtime.service.createFromMessage({
  title: 'Runtime smoke task',
  objective: 'Finish objective with Bearer should-never-be-logged-token.',
  acceptance_criteria: ['Complete once.'],
  context_snapshot: {
    summary: 'Sensitive checkpoint body.',
    completed_steps: [],
    remaining_steps: ['Finish.'],
    constraints: [],
    decisions: [],
    references: [],
  },
  required_tools: ['lark_cli'],
}, sourceMessage);

await runtime.worker!.tick();
await waitFor(async () => (await runtime.service.getForActor(
  job.jobId,
  sourceMessage.senderId,
))?.status === 'completed', 'runtime completion');
await waitFor(() => delivered.length === 1, 'terminal delivery');

assert.equal(traceRequests.length, 2);
assert.deepEqual(invokedTools, ['lark_cli']);
assert.equal(traceRequests[0].traceLogId, job.jobId);
assert.match(traceRequests[0].traceRunId ?? '', /^att_/);
assert.ok(debugLines.some((line) => line.includes(job.jobId) && line.includes(traceRequests[0].traceRunId!)));
assert.ok(auditEvents.some((event) => event.jobId === job.jobId && event.attemptId === traceRequests[0].traceRunId));
const diagnostics = JSON.stringify({ debugLines, auditEvents, traceRequests });
assert.doesNotMatch(diagnostics, /Finish objective/);
assert.doesNotMatch(diagnostics, /Sensitive checkpoint body/);
assert.doesNotMatch(diagnostics, /Sensitive result body/);
assert.doesNotMatch(diagnostics, /should-never-be-logged-token/);
await runtime.close();

const degraded = await createContinuationRuntime({
  enabled: true,
  databasePath: path.join(root, 'broken.sqlite'),
  artifactsDir: path.join(root, 'broken-artifacts'),
  allowedWorkingRoot: root,
  maxSteps: 12,
  maxRetries: 2,
  maxAgeHours: 24,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'workspace-write',
  clock,
  getTransport: () => ({} as never),
  openRepository: async () => {
    throw new Error('repository failed with Bearer private-token');
  },
  debug: (line) => { debugLines.push(line); },
});
assert.equal(degraded.health.available, false);
assert.equal(degraded.worker, null);
await assert.rejects(
  () => degraded.service.listForActor('ou_runtime_creator'),
  /^Error: Continuation runtime is unavailable\.$/,
);
const degradedReplies: string[] = [];
assert.equal(await handleContinuationCommand({
  message: {
    ...sourceMessage,
    messageId: 'om_task_degraded',
    text: '/task list',
    rawContent: '{"text":"/task list"}',
  },
  service: degraded.service,
  ownerOpenId: null,
  sendReply: async (request) => {
    degradedReplies.push(request.text);
    return { sentCount: 1 };
  },
  auditCommand: async () => {},
}), true);
assert.equal(degradedReplies.at(-1), 'Continuation runtime is unavailable.');
await degraded.close();

const configuredDryRunDatabase = path.join(root, 'must-not-be-created.sqlite');
const dryRun = await createContinuationRuntime({
  enabled: true,
  databasePath: configuredDryRunDatabase,
  artifactsDir: path.join(root, 'must-not-be-created-artifacts'),
  allowedWorkingRoot: root,
  maxSteps: 12,
  maxRetries: 2,
  maxAgeHours: 24,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'workspace-write',
  clock,
  getTransport: () => ({} as never),
  dryRun: true,
});
assert.equal(dryRun.health.available, true);
await dryRun.close();
await assert.rejects(() => access(configuredDryRunDatabase));

console.log('continuation runtime smoke: PASS');

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
