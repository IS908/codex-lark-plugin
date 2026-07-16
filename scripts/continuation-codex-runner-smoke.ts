import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContinuationClaim, ContinuationJob } from '../src/domain/continuation.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import type { CodexExecRequest } from '../src/codex-exec.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-codex-runner-'));
process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CODEX_EXEC_TOOL_TRACE = 'false';
process.env.LARK_DEBUG_LOG = join(root, 'debug.log');
const {
  CONTINUATION_OUTPUT_SCHEMA,
  createContinuationCodexExecutor,
} = await import('../src/continuation/codex-runner.js');
const {
  CodexExecAbortedError,
  buildCodexExecArgs,
  runCodexExecCommand,
} = await import('../src/codex-exec.js');
const artifactsDir = join(root, 'artifacts');
const artifactStore = new ContinuationArtifactStore(artifactsDir);

function createJob(overrides: Partial<ContinuationJob> = {}): ContinuationJob {
  return {
    jobId: 'job_0123456789abcdef01234567',
    idempotencyKey: 'idem-runner',
    creatorOpenId: 'ou_creator',
    route: {
      kind: 'message_thread',
      conversationId: 'oc_runner',
      sourceMessageId: 'om_runner',
    },
    sourceMessageId: 'om_runner',
    title: 'Runner smoke',
    objective: 'Produce a verified result',
    acceptanceCriteria: ['return a structured outcome'],
    contextSnapshot: {
      summary: 'Foreground work is incomplete.',
      completedSteps: [],
      remainingSteps: ['finish the work'],
      constraints: ['do not publish'],
      decisions: [],
      references: [],
    },
    requiredTools: [],
    workingDirectory: root,
    model: 'gpt-5.4',
    parentSessionId: 'session-parent',
    maxSteps: 24,
    maxRetries: 3,
    timeoutSeconds: 60,
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
    rowVersion: 2,
    status: 'running',
    executionSessionId: 'session-background',
    checkpoint: undefined,
    stepCount: 0,
    failureCount: 0,
    nextRunAt: '2026-07-17T00:00:00.000Z',
    leaseOwner: 'worker-runner',
    leaseExpiresAt: '2026-07-17T00:00:30.000Z',
    heartbeatAt: '2026-07-17T00:00:00.000Z',
    resultArtifacts: [],
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function createClaim(overrides: Partial<ContinuationJob> = {}): ContinuationClaim {
  const job = createJob(overrides);
  return {
    job,
    workerId: 'worker-runner',
    claimedRowVersion: job.rowVersion,
    attempt: {
      attemptId: 'att_0123456789abcdef01234567',
      jobId: job.jobId,
      ordinal: 1,
      workerId: 'worker-runner',
      executionSessionId: job.executionSessionId,
      startedAt: '2026-07-17T00:00:00.000Z',
      heartbeatAt: '2026-07-17T00:00:00.000Z',
    },
  };
}

const schemaArgs = buildCodexExecArgs(
  {
    prompt: 'continue',
    outputSchema: CONTINUATION_OUTPUT_SCHEMA,
    configOverrides: [
      'approval_policy="never"',
      'sandbox_workspace_write.network_access=false',
    ],
    additionalWritableDirs: ['/tmp/artifacts'],
    resumeSessionId: 'session-background',
  },
  '/tmp/output.txt',
  '/tmp/outcome-schema.json',
);
assert.ok(schemaArgs.includes('--output-schema'));
assert.ok(schemaArgs.includes('/tmp/outcome-schema.json'));
assert.equal(schemaArgs.filter((value) => value === '--add-dir').length, 1);
assert.ok(schemaArgs.includes('approval_policy="never"'));
assert.ok(schemaArgs.includes('sandbox_workspace_write.network_access=false'));
assert.ok(schemaArgs.indexOf('--output-schema') < schemaArgs.indexOf('resume'));

const fakeCodex = join(root, 'fake-codex.js');
const observationPath = join(root, 'schema-observation.json');
await writeFile(fakeCodex, [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'const args = process.argv.slice(2);',
  'const outputFile = args[args.indexOf("--output-last-message") + 1];',
  'const schemaFile = args[args.indexOf("--output-schema") + 1];',
  'fs.writeFileSync(process.env.OBSERVATION_PATH, JSON.stringify({',
  '  args,',
  '  schema: JSON.parse(fs.readFileSync(schemaFile, "utf8")),',
  '  schemaMode: fs.statSync(schemaFile).mode & 0o777,',
  '}));',
  'console.log(JSON.stringify({ type: "thread.started", thread_id: "session-schema" }));',
  'fs.writeFileSync(outputFile, JSON.stringify({ outcome: "completed" }));',
].join('\n'), 'utf-8');
await chmod(fakeCodex, 0o755);

await runCodexExecCommand({
  prompt: 'schema',
  command: fakeCodex,
  cwd: root,
  timeoutMs: 5_000,
  outputSchema: CONTINUATION_OUTPUT_SCHEMA,
  extraEnv: { OBSERVATION_PATH: observationPath },
});
const observation = JSON.parse(await readFile(observationPath, 'utf-8')) as {
  args: string[];
  schema: unknown;
  schemaMode: number;
};
assert.deepEqual(observation.schema, CONTINUATION_OUTPUT_SCHEMA);
assert.equal(observation.schemaMode, 0o600);
assert.ok(observation.args.includes('--output-schema'));
const observedSchemaPath = observation.args[observation.args.indexOf('--output-schema') + 1];
await assert.rejects(stat(observedSchemaPath), /ENOENT/);

const abortCodex = join(root, 'abort-codex.js');
const abortReadyPath = join(root, 'abort-ready');
const abortSignalPath = join(root, 'abort-signal');
await writeFile(abortCodex, [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.env.READY_PATH, "ready");',
  'process.on("SIGTERM", () => {',
  '  fs.writeFileSync(process.env.SIGNAL_PATH, "SIGTERM");',
  '  process.exit(0);',
  '});',
  'setInterval(() => {}, 1000);',
].join('\n'), 'utf-8');
await chmod(abortCodex, 0o755);
const abortController = new AbortController();
const abortRun = runCodexExecCommand({
  prompt: 'abort',
  command: abortCodex,
  cwd: root,
  timeoutMs: 5_000,
  abortSignal: abortController.signal,
  extraEnv: { READY_PATH: abortReadyPath, SIGNAL_PATH: abortSignalPath },
});
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    await stat(abortReadyPath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
abortController.abort();
await assert.rejects(abortRun, (error: unknown) => error instanceof CodexExecAbortedError);
assert.equal(await readFile(abortSignalPath, 'utf-8'), 'SIGTERM');

const artifactRoot = await artifactStore.ensure(createJob().jobId);
await writeFile(join(artifactRoot, 'summary.md'), '# Result\n', 'utf-8');

const requests: CodexExecRequest[] = [];
const responses = [
  {
    text: JSON.stringify({
      outcome: 'continue',
      checkpoint: {
        summary: 'Inspected token=super-secret-value',
        completed_steps: ['inspect'],
        remaining_steps: ['finish'],
        constraints: ['do not publish'],
        decisions: ['use local inputs'],
        references: ['summary.md'],
      },
      next_step: 'finish',
      resume_after_seconds: 3,
    }),
    sessionId: 'session-next',
  },
  {
    text: JSON.stringify({
      outcome: 'completed',
      final_message: 'Finished with Bearer abcdefghijklmnopqrstuvwxyz123456',
      result_summary: 'Done password=hunter2-secret',
      artifacts: ['./reports/../summary.md'],
    }),
    sessionId: 'session-next',
  },
  {
    text: JSON.stringify({
      outcome: 'failed',
      error_code: 'temporary_failure',
      error_summary: 'Try again later.',
      retryable: true,
      completed_work: ['inspect'],
      unperformed_work: ['finish'],
    }),
  },
  {
    text: JSON.stringify({
      outcome: 'blocked',
      error_code: 'capability_unavailable',
      error_summary: 'Network access is unavailable.',
      required_capability: 'external network',
      completed_work: [],
      unperformed_work: ['fetch source'],
    }),
  },
];
const executor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'danger-full-access',
  runCodexExec: async (request) => {
    requests.push(request);
    const response = responses.shift();
    assert.ok(response);
    return response;
  },
});
const signal = new AbortController().signal;
const continuation = await executor.execute(createClaim(), signal);
assert.deepEqual(continuation, {
  executionSessionId: 'session-next',
  outcome: {
    outcome: 'continue',
    checkpoint: {
      summary: 'Inspected token=[redacted]',
      completedSteps: ['inspect'],
      remainingSteps: ['finish'],
      constraints: ['do not publish'],
      decisions: ['use local inputs'],
      references: ['summary.md'],
    },
    nextStep: 'finish',
    resumeAfterSeconds: 3,
  },
});
const completed = await executor.execute(createClaim(), signal);
assert.deepEqual(completed.outcome, {
  outcome: 'completed',
  finalMessage: 'Finished with Bearer [redacted]',
  resultSummary: 'Done password=[redacted]',
  artifacts: ['summary.md'],
});
assert.equal((await executor.execute(createClaim(), signal)).outcome.outcome, 'failed');
assert.equal((await executor.execute(createClaim(), signal)).outcome.outcome, 'blocked');

const firstRequest = requests[0];
assert.equal(firstRequest.traceLogId, createJob().jobId);
assert.equal(firstRequest.traceRunId, createClaim().attempt.attemptId);
assert.equal(firstRequest.resumeSessionId, 'session-background');
assert.equal(firstRequest.profile, null);
assert.equal(firstRequest.ignoreUserConfig, true);
assert.equal(firstRequest.sandbox, 'workspace-write');
assert.equal(firstRequest.model, 'gpt-5.4');
assert.deepEqual(firstRequest.configOverrides, [
  'approval_policy="never"',
  'sandbox_workspace_write.network_access=false',
]);
assert.deepEqual(firstRequest.additionalWritableDirs, [artifactRoot]);

async function executeRaw(text: string): Promise<void> {
  const strictExecutor = createContinuationCodexExecutor({
    artifactStore,
    configuredSandbox: 'workspace-write',
    runCodexExec: async () => ({ text }),
  });
  await strictExecutor.execute(createClaim(), signal);
}

await assert.rejects(
  executeRaw(JSON.stringify({
    outcome: 'completed',
    final_message: 'done',
    artifacts: [],
    route: { conversation_id: 'must-not-be-accepted' },
  })),
  /unrecognized|unknown/i,
);
await assert.rejects(
  executeRaw(JSON.stringify({ outcome: 'completed', artifacts: [] })),
  /final_message|required/i,
);

const fallbackRequests: CodexExecRequest[] = [];
const fallbackExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'read-only',
  runCodexExec: async (request) => {
    fallbackRequests.push(request);
    if (request.resumeSessionId) throw new Error('session not found');
    return {
      text: JSON.stringify({ outcome: 'completed', final_message: 'fresh', artifacts: [] }),
      sessionId: 'session-fresh',
    };
  },
});
const fallbackResult = await fallbackExecutor.execute(createClaim(), signal);
assert.equal(fallbackResult.executionSessionId, 'session-fresh');
assert.deepEqual(fallbackRequests.map((request) => request.resumeSessionId), [
  'session-background',
  null,
]);
assert.equal(fallbackRequests[0].sandbox, 'read-only');

const clearedSessionExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  runCodexExec: async (request) => {
    if (request.resumeSessionId) throw new Error('thread does not exist');
    return JSON.stringify({ outcome: 'completed', final_message: 'fresh', artifacts: [] });
  },
});
assert.equal(
  (await clearedSessionExecutor.execute(createClaim(), signal)).executionSessionId,
  null,
);

console.log('continuation codex runner smoke: PASS');
