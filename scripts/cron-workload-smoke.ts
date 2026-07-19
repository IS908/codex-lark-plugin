import assert from 'node:assert/strict';
import {
  assertDurableRunTransition,
  type DurableRunClaim,
  type DurableRunInterruptedAttempt,
} from '../src/domain/durable-run.js';
import { materializeDurableRunWorkloadClaim, materializeDurableRunWorkloadContext } from '../src/ports/durable-run.js';
import { CronMessageWorkload } from '../src/cron/message-workload.js';
import { CronPromptWorkload } from '../src/cron/direct-exec-workload.js';
import type { CronPromptExecution, CronRunInput, CronRunState } from '../src/cron/contracts.js';

const baseJob: CronRunInput['job'] = {
  id: 'job-1',
  createdAt: '2026-07-19T00:00:00.000Z',
  revision: 2,
  name: 'Daily report',
  type: 'prompt',
  schedule: '0 8 * * *',
  scheduleHuman: 'daily',
  timezone: 'Asia/Singapore',
  prompt: 'Generate the report.',
  targetChatId: 'oc_target',
  originChatId: 'oc_origin',
  createdBy: 'ou_creator',
};

function claimFor(kind: 'cron_prompt' | 'cron_message', job: CronRunInput['job']): DurableRunClaim {
  return {
    run: {
      runId: `run_${kind}`,
      workloadKind: kind,
      idempotencyKey: `idem_${kind}`,
      concurrencyKey: `cron-job:${job.id}@${job.createdAt}`,
      status: 'running',
      inputVersion: 1,
      input: { schemaVersion: 1, job } satisfies CronRunInput,
      stateVersion: 1,
      state: { schemaVersion: 1, phase: 'admitted' } satisfies CronRunState,
      route: { kind: 'cron_job', targetChatId: job.targetChatId, jobId: job.id },
      actorOpenId: job.createdBy,
      nextRunAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      maxAttempts: 4,
      attemptCount: 1,
      rowVersion: 2,
    },
    workerId: 'worker',
    claimedRowVersion: 2,
    attempt: {
      attemptId: `attempt_${kind}`,
      runId: `run_${kind}`,
      ordinal: 1,
      workerId: 'worker',
      claimedAt: '2026-07-19T00:00:00.000Z',
      heartbeatAt: '2026-07-19T00:00:00.000Z',
      leaseExpiresAt: '2026-07-19T00:01:00.000Z',
    },
  };
}

function diagnostic(status: 'success' | 'failed', error?: string): CronPromptExecution['diagnostics'] {
  return {
    run_id: 'run_cron_prompt',
    job_id: 'job-1',
    job_name: 'Daily report',
    schedule: 'daily',
    timezone: 'Asia/Singapore',
    timeout_ms: 1000,
    started_at: '2026-07-19T00:00:00.000Z',
    ended_at: '2026-07-19T00:00:01.000Z',
    duration_ms: 1000,
    status,
    stages: [],
    ...(error ? { error } : {}),
  };
}

async function executePrompt(result: CronPromptExecution | Error) {
  const workload = new CronPromptWorkload({
    executor: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const raw = claimFor('cron_prompt', baseJob);
  const context = materializeDurableRunWorkloadContext(workload, raw.run);
  const claim = materializeDurableRunWorkloadClaim(raw, context);
  const execution = await workload.execute(claim, new AbortController().signal);
  return { workload, claim, transition: workload.reduce(claim, execution) };
}

const success = await executePrompt({
  report: '# Report\n\nComplete.',
  runStatus: 'success',
  failureReason: null,
  diagnostics: diagnostic('success'),
});
assert.equal(success.transition.status, 'completed');
assert.equal(success.transition.deliveries?.length, 1);
assert.equal(success.transition.deliveries?.[0].kind, 'cron_terminal');
assert.equal(success.transition.deliveries?.[0].idempotencyKey, 'cron:run_cron_prompt:terminal');
assert.deepEqual(success.transition.deliveries?.[0].route, success.claim.run.route);
assert.equal((success.transition.deliveries?.[0].payload as any).report, '# Report\n\nComplete.');
assert.equal((success.transition.state as CronRunState).phase, 'completed');
assert.equal(success.transition.attempt?.operationRisk, 'unknown');
assert.doesNotThrow(() => assertDurableRunTransition('running', success.transition));

const lifecycle = await executePrompt({
  report: 'I cannot promise a later follow-up.',
  runStatus: 'failed',
  failureReason: 'Lifecycle guard blocked output: chinese-async-followup-promise',
  diagnostics: diagnostic('failed', 'blocked'),
});
assert.equal(lifecycle.transition.status, 'failed');
assert.match((lifecycle.transition.deliveries?.[0].payload as any).report, /cannot promise/);
assert.match(lifecycle.transition.errorSummary ?? '', /Lifecycle guard/);

const empty = await executePrompt({
  report: '   ',
  runStatus: 'success',
  failureReason: null,
  diagnostics: diagnostic('success'),
});
assert.equal(empty.transition.status, 'failed');
assert.match((empty.transition.deliveries?.[0].payload as any).report, /failed before a complete report could be delivered/i);
assert.equal((empty.transition.deliveries?.[0].payload as any).reportType, 'error_report');

const secret = 'secret=abcdefghijklmnopqrstuvwxyz';
const failed = await executePrompt(new Error(`exec exploded ${secret} ${'x'.repeat(5000)}`));
const failurePayload = failed.transition.deliveries?.[0].payload as any;
assert.equal(failed.transition.status, 'failed');
assert.match(failurePayload.report, /^CronJob "Daily report" failed before a complete report could be delivered\./);
assert.doesNotMatch(failurePayload.report, /abcdefghijklmnopqrstuvwxyz/);
assert.ok(failurePayload.report.length < 10_000);
assert.ok(JSON.stringify(failurePayload.diagnostics).length < 20_000);
assert.doesNotThrow(() => assertDurableRunTransition('running', failed.transition));

const messageJob: CronRunInput['job'] = {
  ...baseJob,
  type: 'message',
  prompt: undefined,
  content: 'Scheduled notice',
  messageType: 'text',
};
const messageWorkload = new CronMessageWorkload();
const rawMessage = claimFor('cron_message', messageJob);
const messageContext = materializeDurableRunWorkloadContext(messageWorkload, rawMessage.run);
const messageClaim = materializeDurableRunWorkloadClaim(rawMessage, messageContext);
const messageResult = await messageWorkload.execute(messageClaim, new AbortController().signal);
const messageTransition = messageWorkload.reduce(messageClaim, messageResult);
assert.equal(messageTransition.status, 'completed');
assert.equal((messageTransition.deliveries?.[0].payload as any).content, 'Scheduled notice');
assert.equal((messageTransition.deliveries?.[0].payload as any).messageType, 'text');
assert.equal(messageTransition.attempt?.operationRisk, 'pure');
assert.doesNotThrow(() => assertDurableRunTransition('running', messageTransition));

assert.throws(() => messageWorkload.parseInput({ schemaVersion: 1, job: { ...messageJob, content: '' } }, 1));
assert.throws(() => success.workload.parseInput({ schemaVersion: 1, job: { ...baseJob, prompt: '' } }, 1));
assert.throws(() => success.workload.parseState({ schemaVersion: 1, phase: 'completed', commit: {} }, 1));
const malformedDiagnostics = structuredClone(success.transition.state) as any;
malformedDiagnostics.commit.diagnostics.stages = [{ name: 42, status: 'bogus' }];
assert.throws(() => success.workload.parseState(malformedDiagnostics, 1));
const completedContext = {
  ...messageContext,
  state: messageTransition.state as CronRunState,
};
const completedPreflight = await messageWorkload.preflight(completedContext);
assert.equal(completedPreflight.action, 'transition');
if (completedPreflight.action === 'transition') {
  assert.equal(completedPreflight.transition.status, 'blocked');
}

const interrupted: DurableRunInterruptedAttempt = {
  claim: claimFor('cron_prompt', baseJob),
  recoveredAt: '2026-07-19T00:02:00.000Z',
  executionPhase: 'execution_started',
  operationRisk: 'unknown',
};
const recovery = success.workload.recoverInterruptedAttempt(interrupted);
assert.equal(recovery.status, 'blocked');
assert.equal(recovery.deliveries?.length, 1);
assert.match((recovery.deliveries?.[0].payload as any).report, /outcome is unknown/i);
assert.doesNotThrow(() => assertDurableRunTransition('running', recovery));

console.log('cron workload smoke: PASS');
