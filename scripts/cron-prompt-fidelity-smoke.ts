import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentitySession } from '../src/identity-session.js';
import { cronJobPrompt } from '../src/prompts.js';
import { createCronPromptExecutor } from '../src/cron/prompt-executor.js';
import type { CronPromptExecutionInput } from '../src/cron/contracts.js';
import { CodexExecPreStartError } from '../src/codex-exec.js';

const identity = new IdentitySession(() => null);
const sessionStore = {
  async get() { return null; },
  async set() {},
  async delete() {},
};
const actionDispatcher = { async execute() { return []; } };
const calls: any[] = [];
const executor = createCronPromptExecutor({
  identitySession: identity,
  sessionStore,
  actionDispatcher: actionDispatcher as any,
  sessionHealth: undefined,
  deliver: async (options) => {
    calls.push(options);
    assert.equal(identity.getCaller(options.message.chatId, options.message.threadId), 'ou_creator');
    await options.deliverySink?.({ text: '# Daily report\n\nDone.', runtimeFooter: undefined });
  },
});

const input: CronPromptExecutionInput = {
  runId: 'cron_0123456789abcdef',
  job: {
    id: 'daily-report',
    createdAt: '2026-07-19T00:00:00.000Z',
    revision: 3,
    name: 'Daily report',
    type: 'prompt',
    schedule: '0 8 * * *',
    scheduleHuman: 'every day at 08:00',
    timezone: 'Asia/Singapore',
    prompt: 'Review yesterday and produce a report.',
    model: 'gpt-test',
    targetChatId: 'oc_target',
    originChatId: 'oc_origin',
    createdBy: 'ou_creator',
  },
};
const controller = new AbortController();
const result = await executor(input, controller.signal);

assert.equal(calls.length, 1);
const call = calls[0];
assert.equal(call.message.text, cronJobPrompt(input.job.name, input.job.targetChatId, input.job.prompt));
assert.equal(call.message.chatId, 'oc_target');
assert.equal(call.message.senderId, 'ou_creator');
assert.equal(call.message.chatType, 'cronjob');
assert.equal(call.message.messageType, 'cronjob');
assert.match(call.message.threadId, /^job-daily-report-[a-f0-9]{12}-cron_0123456789abcdef$/);
assert.equal(call.modelOverride, 'gpt-test');
assert.equal(call.traceLogId, 'daily-report');
assert.equal(call.traceRunId, 'cron_0123456789abcdef');
assert.equal(call.progressVisible, false);
assert.equal(call.abortSignal, controller.signal);
assert.equal(call.sessionStore, sessionStore);
assert.equal(call.actionDispatcher, actionDispatcher);
assert.deepEqual(call.actionPolicy?.blockedActionTypes, [
  'send_message',
  'recall_message',
  'create_job',
  'run_job',
  'update_job',
  'disable_job',
  'delete_job',
  'upsert_job',
  'create_continuation_job',
]);
assert.equal(typeof call.deliverySink, 'function');
assert.equal(call.sendReply, undefined);
assert.equal(result.report, '# Daily report\n\nDone.');
assert.equal(result.runStatus, 'success');
assert.equal(result.failureReason, null);
assert.equal(result.diagnostics.status, 'success');
assert.equal(result.diagnostics.job_id, 'daily-report');
assert.equal(identity._activeChannelTurnCount(), 0);

const { appConfig } = await import('../src/config.js');
const execBaseDir = await mkdtemp(join(tmpdir(), 'cron-prompt-fidelity-'));
(appConfig as any).codexExecCwd = execBaseDir;
(appConfig as any).codexExecProgressEnabled = true;
let execRequest: any;
let directMutationDispatches = 0;
const dispatchedActionTypes: string[] = [];
const realDeliveryExecutor = createCronPromptExecutor({
  identitySession: identity,
  sessionStore,
  actionDispatcher: {
    async execute(request) {
      dispatchedActionTypes.push(...request.actions.map((action: any) => action.type));
      directMutationDispatches += request.actions.filter(
        (action: any) => action.type === 'send_message' || action.type === 'recall_message',
      ).length;
      return request.actions.map((action: any) => ({ ok: true, action: action.type, message: 'executed' }));
    },
  } as any,
  useCodexSessions: false,
  progressBaseDir: execBaseDir,
  actionBaseDir: execBaseDir,
  runCodexExec: async (request) => {
    execRequest = request;
    assert.ok(request.progress, 'Cron generation should collect hidden progress for diagnostics.');
    await appendFile(
      request.progress!.filePath,
      `${JSON.stringify({
        version: 1,
        token: request.progress!.token,
        type: 'emit_lark_message',
        mode: 'progress',
        content: 'stage=generate_report Draft complete.',
      })}\n`,
      'utf8',
    );
    await appendFile(
      request.actions!.filePath,
      `${JSON.stringify({
        version: 1,
        token: request.actions!.token,
        type: 'lark_action_request',
        actions: [
          { type: 'send_message', message: { kind: 'file', source: 'local_path', path: '/tmp/report.txt' } },
          { type: 'run_job', job_id: 'another-cron-job' },
          {
            type: 'create_continuation_job',
            title: 'Nested task',
            objective: 'This must not be admitted from a Cron prompt.',
            deliverables: [{ id: 'result', description: 'result', required: true }],
            acceptance_criteria: [{ id: 'done', description: 'done', deliverable_ids: ['result'] }],
            verification_requirements: [{ id: 'evidence', description: 'evidence', kind: 'evidence_reference' }],
            context_snapshot: {
              summary: 'nested',
              completed_steps: [],
              remaining_steps: ['run'],
              constraints: [],
              decisions: [],
              references: [],
            },
            required_tools: [],
            working_directory: '.',
          },
          { type: 'run_local_cli_tool', tool: 'report-media-helper', args: ['--preview'] },
        ],
      })}\n`,
      'utf8',
    );
    return 'Generated through the real delivery path.';
  },
});
const realResult = await realDeliveryExecutor(input, controller.signal);
assert.equal(execRequest.cwd, execBaseDir);
assert.equal(execRequest.model, 'gpt-test');
assert.equal(execRequest.traceLogId, 'daily-report');
assert.equal(execRequest.traceRunId, 'cron_0123456789abcdef');
assert.equal(execRequest.abortSignal, controller.signal);
assert.match(execRequest.prompt, /\[CronJob\]/);
assert.match(execRequest.prompt, /Review yesterday and produce a report\./);
assert.doesNotMatch(execRequest.prompt, /"type":"send_message"/);
assert.doesNotMatch(execRequest.prompt, /For cronjob schedule fields/);
assert.doesNotMatch(execRequest.prompt, /For existing cronjobs/);
assert.doesNotMatch(execRequest.prompt, /successfully creates an explicit continuation or cronjob/);
assert.match(execRequest.prompt, /This generation-only turn cannot create background work/);
for (const blockedType of [
  'create_job',
  'run_job',
  'update_job',
  'disable_job',
  'delete_job',
  'upsert_job',
  'create_continuation_job',
]) {
  assert.doesNotMatch(
    execRequest.prompt,
    new RegExp(`"type":"${blockedType}"`),
    `${blockedType} must not be advertised during Cron generation`,
  );
}
assert.equal(directMutationDispatches, 0);
assert.deepEqual(dispatchedActionTypes, ['run_local_cli_tool']);
assert.match(realResult.report, /Generated through the real delivery path\./);
assert.match(realResult.report, /Cron generation cannot mutate Feishu messages/);
assert.equal(realResult.runStatus, 'failed');
assert.equal(realResult.diagnostics.progress?.content, 'stage=generate_report Draft complete.');

const retrySafeExecutor = createCronPromptExecutor({
  identitySession: identity,
  sessionStore,
  deliver: async () => {
    throw new CodexExecPreStartError(Object.assign(
      new Error('temporary spawn failure before Codex execution'),
      { code: 'EAGAIN' },
    ));
  },
});
await assert.rejects(
  retrySafeExecutor(input, controller.signal),
  /temporary spawn failure/,
);
assert.equal(identity._activeChannelTurnCount(), 0);

let completedExecCalls = 0;
const postExecutionFailure = createCronPromptExecutor({
  identitySession: identity,
  sessionStore: {
    async get() { return null; },
    async set() {
      throw Object.assign(new Error('session store file descriptor exhausted'), { code: 'EMFILE' });
    },
    async delete() {},
  },
  useCodexSessions: true,
  runCodexExec: async () => {
    completedExecCalls += 1;
    return { text: 'Codex already completed.', sessionId: 'session_completed' };
  },
});
const postExecutionResult = await postExecutionFailure(input, controller.signal);
assert.equal(completedExecCalls, 1);
assert.equal(postExecutionResult.runStatus, 'failed');
assert.equal(postExecutionResult.retrySafe, undefined);
assert.match(postExecutionResult.failureReason ?? '', /session store file descriptor exhausted/);

console.log('cron prompt fidelity smoke: PASS');
