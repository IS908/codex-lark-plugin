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
const traceRequests: Array<Pick<CodexExecRequest, 'traceLogId' | 'traceRunId' | 'sandbox'>> = [];
const debugLines: string[] = [];
const auditEvents: ContinuationAuditEvent[] = [];
const delivered: string[] = [];
const invokedTools: string[] = [];

function checkpoint(criterionId: string) {
  return {
    schemaVersion: 2 as const,
    summary: 'Task completed with durable evidence.',
    currentStepId: 'finish',
    completedStepIds: ['finish'],
    completedCriterionIds: [criterionId],
    completedDeliverableIds: ['result'],
    remainingSteps: [],
    artifacts: [],
    evidence: [{
      id: 'result-evidence-entry',
      requirementId: 'result_evidence',
      criterionIds: [criterionId],
      reference: 'terminal-result',
    }],
    sideEffects: [],
    constraints: [],
    decisions: [],
    nextAction: null,
    stopReason: 'Acceptance criteria verified.',
  };
}

function wireCompletedOutcome(finalMessage: string) {
  const state = checkpoint('complete_once');
  return {
    outcome: 'completed',
    checkpoint: {
      schema_version: 2,
      summary: state.summary,
      current_step_id: state.currentStepId,
      completed_step_ids: state.completedStepIds,
      completed_criterion_ids: state.completedCriterionIds,
      completed_deliverable_ids: state.completedDeliverableIds,
      remaining_steps: [],
      artifacts: [],
      evidence: [{
        id: 'result-evidence-entry',
        requirement_id: 'result_evidence',
        criterion_ids: ['complete_once'],
        artifact_id: null,
        reference: 'terminal-result',
      }],
      side_effects: [],
      constraints: [],
      decisions: [],
      next_action: null,
      stop_reason: state.stopReason,
    },
    resume_after_seconds: null,
    final_message: finalMessage,
    result_summary: 'Done.',
    artifacts: [],
    error_code: null,
    error_summary: null,
    retryable: null,
    required_capability: null,
    completed_work: [],
    key_findings: [],
    unperformed_work: [],
    risks: [],
    next_steps: [],
    tool: null,
    args: [],
  };
}

const runtime = await createContinuationRuntime({
  enabled: true,
  databasePath: path.join(root, 'jobs.sqlite'),
  artifactsDir: path.join(root, 'artifacts'),
  allowedWorkingRoot: root,
  maxAttempts: 5,
  maxRetries: 2,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'danger-full-access',
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
      sandbox: request.sandbox,
    });
    return traceRequests.length === 1 ? {
      text: JSON.stringify({
        outcome: 'tool_request',
        tool: 'lark_cli',
        args: ['doc', 'get'],
      }),
      sessionId: 'session_runtime',
    } : {
      text: JSON.stringify(wireCompletedOutcome('Sensitive result body delivered to the user.')),
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
  deliverables: [{ id: 'result', description: 'A completed result.', required: true }],
  acceptance_criteria: [{
    id: 'complete_once',
    description: 'Complete once.',
    deliverable_ids: ['result'],
  }],
  verification_requirements: [{
    id: 'result_evidence',
    description: 'Reference completion evidence.',
    kind: 'evidence_reference',
  }],
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
assert.equal(job.permissions.filesystem.mode, 'workspace-write');

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
assert.equal(traceRequests[0].sandbox, 'workspace-write');
assert.ok(debugLines.some((line) => line.includes(job.jobId) && line.includes(traceRequests[0].traceRunId!)));
assert.ok(auditEvents.some((event) => event.jobId === job.jobId && event.attemptId === traceRequests[0].traceRunId));
const diagnostics = JSON.stringify({ debugLines, auditEvents, traceRequests });
assert.doesNotMatch(diagnostics, /Finish objective/);
assert.doesNotMatch(diagnostics, /Sensitive checkpoint body/);
assert.doesNotMatch(diagnostics, /Sensitive result body/);
assert.doesNotMatch(diagnostics, /should-never-be-logged-token/);
await runtime.close();

const retentionRoot = path.join(root, 'retention-runtime');
const retentionDatabasePath = path.join(retentionRoot, 'jobs.sqlite');
const retentionArtifactsDir = path.join(retentionRoot, 'artifacts');
const retentionSource: LarkMessage = {
  ...sourceMessage,
  messageId: 'om_runtime_retention',
  chatId: 'oc_runtime_retention',
  senderId: 'ou_runtime_retention',
  threadId: 'omt_runtime_retention',
};
const seedRetentionRuntime = await createContinuationRuntime({
  enabled: true,
  databasePath: retentionDatabasePath,
  artifactsDir: retentionArtifactsDir,
  allowedWorkingRoot: root,
  maxAttempts: 5,
  maxRetries: 0,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'workspace-write',
  clock: { now: () => new Date('2026-06-01T00:00:00.000Z') },
  getTransport: () => ({} as never),
  executor: {
    async execute() {
      return {
        outcome: {
          outcome: 'completed',
          checkpoint: checkpoint('complete'),
          finalMessage: 'Archived.',
          artifacts: [],
        },
      };
    },
  },
  delivery: {
    async deliver() { return { status: 'delivered', messageId: 'om_runtime_archived' }; },
  },
  retentionIntervalMs: 60_000,
});
const retainedRuntimeJob = (await seedRetentionRuntime.service.createFromMessage({
  title: 'Runtime retention audit',
  objective: 'Complete and expire.',
  deliverables: [{ id: 'result', description: 'A completed result.', required: true }],
  acceptance_criteria: [{ id: 'complete', description: 'complete', deliverable_ids: ['result'] }],
  verification_requirements: [{
    id: 'result_evidence',
    description: 'Reference completion evidence.',
    kind: 'evidence_reference',
  }],
  context_snapshot: {
    summary: '',
    completed_steps: [],
    remaining_steps: ['complete'],
    constraints: [],
    decisions: [],
    references: [],
  },
  required_tools: [],
}, retentionSource)).job;
await seedRetentionRuntime.worker!.tick();
await waitFor(async () => (await seedRetentionRuntime.service.getForActor(
  retainedRuntimeJob.jobId,
  retentionSource.senderId,
)).deliveryStatus === 'delivered', 'retention seed delivery');
await seedRetentionRuntime.close();

const retentionAuditEvents: ContinuationAuditEvent[] = [];
const cleanupRuntime = await createContinuationRuntime({
  enabled: true,
  databasePath: retentionDatabasePath,
  artifactsDir: retentionArtifactsDir,
  allowedWorkingRoot: root,
  maxAttempts: 5,
  maxRetries: 0,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  retentionDays: 30,
  maxConcurrency: 1,
  configuredSandbox: 'workspace-write',
  clock: { now: () => new Date('2026-08-01T00:00:00.000Z') },
  getTransport: () => ({} as never),
  executor: {
    async execute() {
      return {
        outcome: {
          outcome: 'completed',
          checkpoint: checkpoint('complete'),
          finalMessage: 'unused',
          artifacts: [],
        },
      };
    },
  },
  delivery: {
    async deliver() { return { status: 'delivered', messageId: 'om_unused' }; },
  },
  audit: {
    async record(event) { retentionAuditEvents.push(event); },
  },
  retentionIntervalMs: 60_000,
});
assert.ok(retentionAuditEvents.some((event) =>
  event.action === 'continuation.cleanup'
  && event.jobId === retainedRuntimeJob.jobId
  && event.result === 'ok'));
await assert.rejects(
  () => cleanupRuntime.service.getForActor(
    retainedRuntimeJob.jobId,
    retentionSource.senderId,
  ),
  /Task not found or not accessible/,
);
await cleanupRuntime.close();

const degraded = await createContinuationRuntime({
  enabled: true,
  databasePath: path.join(root, 'broken.sqlite'),
  artifactsDir: path.join(root, 'broken-artifacts'),
  allowedWorkingRoot: root,
  maxAttempts: 5,
  maxRetries: 2,
  maxTotalMinutes: 30,
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
  maxAttempts: 5,
  maxRetries: 2,
  maxTotalMinutes: 30,
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
