import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContinuationClaim, ContinuationJob } from '../src/domain/continuation.js';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import { ContinuationInputStore } from '../src/continuation/input-store.js';
import type { CodexExecRequest } from '../src/codex-exec.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-codex-runner-'));
const canonicalRoot = await realpath(root);
process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CODEX_EXEC_TOOL_TRACE = 'false';
process.env.LARK_DEBUG_LOG = join(root, 'debug.log');
process.env.LARK_CODEX_EXEC_TRACE_LOG = join(root, 'trace.log');
const {
  CONTINUATION_OUTPUT_SCHEMA,
  createContinuationCodexExecutor,
} = await import('../src/continuation/codex-runner.js');
const {
  CodexExecAbortedError,
  CodexExecProcessError,
  buildCodexExecArgs,
  runCodexExecCommand,
} = await import('../src/codex-exec.js');
const artifactsDir = join(root, 'artifacts');
const artifactStore = new ContinuationArtifactStore(artifactsDir);

function createJob(overrides: Partial<ContinuationJob> = {}): ContinuationJob {
  const requiredTools = overrides.requiredTools ?? [];
  const route = {
    kind: 'message_thread' as const,
    conversationId: 'oc_runner',
    sourceMessageId: 'om_runner',
  };
  const contextSnapshot = {
    summary: 'Foreground work is incomplete.',
    completedSteps: [],
    remainingSteps: ['finish the work'],
    constraints: ['do not publish'],
    decisions: [],
    references: [],
  };
  const permissions = {
    profile: 'bounded' as const,
    filesystem: { root: canonicalRoot, mode: 'workspace-write' as const, requestedPaths: [] },
    hostTools: requiredTools,
    network: 'none' as const,
    externalSideEffects: 'denied' as const,
    approval: { mode: 'never' as const },
  };
  return {
    jobId: 'job_0123456789abcdef01234567',
    idempotencyKey: 'idem-runner',
    creatorOpenId: 'ou_creator',
    route,
    sourceMessageId: 'om_runner',
    title: 'Runner smoke',
    objective: 'Produce a verified result',
    acceptanceCriteria: ['return a structured outcome'],
    contextSnapshot,
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'captured',
      originalUserText: 'Produce a verified result.',
      quotedMessageText: null,
      creatorOpenId: 'ou_creator',
      chatId: 'oc_runner',
      chatType: 'p2p',
      route,
      sourceMessageId: 'om_runner',
      sourceMessageType: 'text',
      sourceTimestamp: null,
      inputs: [],
      workingDirectory: canonicalRoot,
      model: 'gpt-5.4',
      permissions,
    },
    taskContract: {
      schemaVersion: 1,
      title: 'Runner smoke',
      objective: 'Produce a verified result',
      deliverables: [{ id: 'result', description: 'A verified result.', required: true }],
      acceptanceCriteria: [{
        id: 'structured_outcome',
        description: 'return a structured outcome',
        deliverableIds: ['result'],
      }],
      verificationRequirements: [{
        id: 'result_evidence',
        description: 'Reference result evidence.',
        kind: 'evidence_reference',
      }],
      initialContext: contextSnapshot,
    },
    requiredTools,
    workingDirectory: canonicalRoot,
    permissions,
    model: 'gpt-5.4',
    parentSessionId: 'session-parent',
    maxAttempts: 5,
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
    retained: false,
    ...overrides,
  };
}

function createClaim(
  overrides: Partial<ContinuationJob> = {},
  attemptOrdinal = 1,
): ContinuationClaim {
  const job = createJob(overrides);
  return {
    job,
    workerId: 'worker-runner',
    claimedRowVersion: job.rowVersion,
    attempt: {
      attemptId: 'att_0123456789abcdef01234567',
      jobId: job.jobId,
      ordinal: attemptOrdinal,
      workerId: 'worker-runner',
      executionSessionId: job.executionSessionId,
      startedAt: '2026-07-17T00:00:00.000Z',
      heartbeatAt: '2026-07-17T00:00:00.000Z',
    },
  };
}

function assertStrictOutputSchema(schema: unknown, path = 'root'): void {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} must be an object`);
  const record = schema as Record<string, unknown>;
  assert.equal('oneOf' in record, false, `${path} must not use oneOf`);
  assert.equal('anyOf' in record, false, `${path} must not use anyOf`);
  assert.equal('allOf' in record, false, `${path} must not use allOf`);
  const types = Array.isArray(record.type) ? record.type : [record.type];
  if (types.includes('object')) {
    const properties = record.properties as Record<string, unknown> | undefined;
    assert.ok(properties, `${path}.properties must exist`);
    assert.deepEqual(
      [...((record.required as string[] | undefined) ?? [])].sort(),
      Object.keys(properties).sort(),
      `${path}.required must include every property`,
    );
    for (const [key, value] of Object.entries(properties)) {
      assertStrictOutputSchema(value, `${path}.${key}`);
    }
  }
  if (record.items) assertStrictOutputSchema(record.items, `${path}.items`);
}

assertStrictOutputSchema(CONTINUATION_OUTPUT_SCHEMA);
assert.equal(CONTINUATION_OUTPUT_SCHEMA.type, 'object');
const continuationOutputProperties = CONTINUATION_OUTPUT_SCHEMA.properties as Record<
  string,
  { type?: unknown }
>;
for (const key of [
  'artifacts',
  'completed_work',
  'key_findings',
  'unperformed_work',
  'risks',
  'next_steps',
  'args',
]) {
  assert.equal(
    continuationOutputProperties[key]?.type,
    'array',
    `${key} must always be an array; use [] when it does not apply`,
  );
}

function wireOutcome(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    outcome: 'completed',
    checkpoint: null,
    next_step: null,
    resume_after_seconds: null,
    final_message: null,
    result_summary: null,
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
    ...fields,
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
  'console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "item_audit", status: "completed", command: "git status --short" } }));',
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

await runCodexExecCommand({
  prompt: 'forced trace',
  command: fakeCodex,
  cwd: root,
  timeoutMs: 5_000,
  outputSchema: CONTINUATION_OUTPUT_SCHEMA,
  traceLogId: 'job_forced_trace',
  traceRunId: 'att_forced_trace',
  forceToolTrace: true,
  extraEnv: { OBSERVATION_PATH: observationPath },
});
const forcedTrace = await readFile(join(root, 'trace.log'), 'utf-8');
assert.match(forcedTrace, /job_forced_trace/);
assert.match(forcedTrace, /item_audit/);
assert.match(forcedTrace, /git status --short/);

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
    text: JSON.stringify(wireOutcome({
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
    })),
    sessionId: 'session-next',
  },
  {
    text: JSON.stringify(wireOutcome({
      outcome: 'completed',
      final_message: 'Finished with Bearer abcdefghijklmnopqrstuvwxyz123456',
      result_summary: 'Done password=hunter2-secret',
      artifacts: ['./reports/../summary.md'],
    })),
    sessionId: 'session-next',
  },
  {
    text: JSON.stringify(wireOutcome({
      outcome: 'failed',
      error_code: 'temporary_failure',
      error_summary: 'Try again later.',
      retryable: true,
      completed_work: ['inspect'],
      unperformed_work: ['finish'],
    })),
  },
  {
    text: JSON.stringify(wireOutcome({
      outcome: 'blocked',
      error_code: 'capability_unavailable',
      error_summary: 'Network access is unavailable.',
      required_capability: 'external network',
      completed_work: [],
      unperformed_work: ['fetch source'],
    })),
  },
];
const executor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'danger-full-access',
  currentWorkingRoot: canonicalRoot,
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

const convergenceRequests: CodexExecRequest[] = [];
const convergenceExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  runCodexExec: async (request) => {
    convergenceRequests.push(request);
    return {
      text: JSON.stringify(wireOutcome({
        outcome: 'continue',
        checkpoint: {
          summary: 'Validated the current implementation.',
          completed_steps: ['reviewed persistence'],
          remaining_steps: ['run production validation'],
          constraints: ['production credentials are unavailable'],
          decisions: ['preserve the current migration'],
          references: ['summary.md'],
        },
        next_step: 'run production validation',
      })),
      sessionId: 'session-convergence',
    };
  },
});
const penultimate = await convergenceExecutor.execute(createClaim({ maxAttempts: 5 }, 4), signal);
assert.equal(penultimate.outcome.outcome, 'continue');
assert.match(convergenceRequests[0].prompt, /attempt 4 of 5/i);
assert.match(convergenceRequests[0].prompt, /penultimate attempt/i);
const forced = await convergenceExecutor.execute(createClaim({ maxAttempts: 5 }, 5), signal);
assert.match(convergenceRequests[1].prompt, /attempt 5 of 5/i);
assert.match(convergenceRequests[1].prompt, /continue.*forbidden/i);
assert.deepEqual(forced, {
  executionSessionId: 'session-convergence',
  outcome: {
    outcome: 'partial',
    completedWork: ['reviewed persistence'],
    keyFindings: ['Validated the current implementation.'],
    unperformedWork: ['run production validation'],
    risks: ['production credentials are unavailable'],
    nextSteps: ['run production validation'],
    artifacts: [],
  },
});

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
assert.equal(firstRequest.forceToolTrace, undefined);
assert.match(firstRequest.prompt, /one bounded, highest-priority step/i);
assert.match(firstRequest.prompt, /continue only if measurable progress was made/i);
assert.match(firstRequest.prompt, /another attempt is available/i);
assert.match(firstRequest.prompt, /return completed when the acceptance criteria/i);
assert.match(firstRequest.prompt, /do not repeat completed work/i);
assert.match(firstRequest.prompt, /do not expand scope/i);

const managedInputSource = join(root, 'managed-input-source.txt');
await writeFile(managedInputSource, 'runner input', 'utf8');
const inputStore = new ContinuationInputStore(join(root, 'inputs'));
const managedInstallation = await inputStore.install(createJob().jobId, [{
  sourcePath: managedInputSource,
  fileName: 'runner-input.txt',
  kind: 'message_attachment',
}]);
const managedInputRequests: CodexExecRequest[] = [];
const managedInputExecutor = createContinuationCodexExecutor({
  artifactStore,
  inputStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  runCodexExec: async (request) => {
    managedInputRequests.push(request);
    return {
      text: JSON.stringify(wireOutcome({
        outcome: 'completed',
        final_message: 'managed input complete',
      })),
    };
  },
});
const managedInputJob = createJob();
managedInputJob.sourceFacts = {
  ...managedInputJob.sourceFacts,
  inputs: managedInstallation.artifacts,
};
await managedInputExecutor.execute(createClaim(managedInputJob), signal);
const managedInputPath = inputStore.resolve(
  managedInputJob.jobId,
  managedInstallation.artifacts[0].relativePath,
);
assert.match(managedInputRequests[0].prompt, new RegExp(managedInputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(managedInputRequests[0].prompt, /managed input.*read-only/i);
assert.deepEqual(managedInputRequests[0].additionalWritableDirs, [artifactRoot]);

const trustedRequests: CodexExecRequest[] = [];
const trustedExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  canUseTrustedPersonalWorkspace: () => true,
  runCodexExec: async (request) => {
    trustedRequests.push(request);
    return {
      text: JSON.stringify(wireOutcome({
        outcome: 'completed',
        final_message: 'trusted complete',
      })),
    };
  },
});
await trustedExecutor.execute(createClaim({
  permissions: {
    profile: 'trusted_personal_workspace',
    filesystem: {
      root: canonicalRoot,
      mode: 'workspace-write',
      requestedPaths: ['/tmp/example-repository'],
    },
    hostTools: [],
    network: 'enabled',
    externalSideEffects: 'allowed',
    approval: { mode: 'never' },
  },
}), signal);
assert.deepEqual(trustedRequests[0].configOverrides, [
  'approval_policy="never"',
  'sandbox_permissions=["disk-full-read-access"]',
  'sandbox_workspace_write.network_access=true',
]);
assert.equal(trustedRequests[0].forceToolTrace, true);
assert.match(trustedRequests[0].prompt, /trusted_personal_workspace/);
assert.match(trustedRequests[0].prompt, /external side effects.*allowed/i);
assert.match(trustedRequests[0].prompt, /\/tmp\/example-repository/);

let revokedTrustedCodexCalls = 0;
const revokedTrustedExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  canUseTrustedPersonalWorkspace: () => false,
  runCodexExec: async () => {
    revokedTrustedCodexCalls += 1;
    return { text: JSON.stringify(wireOutcome({ final_message: 'must not run' })) };
  },
});
const revokedTrusted = await revokedTrustedExecutor.execute(createClaim({
  permissions: {
    profile: 'trusted_personal_workspace',
    filesystem: {
      root: canonicalRoot,
      mode: 'workspace-write',
      requestedPaths: ['/tmp/example-repository'],
    },
    hostTools: [],
    network: 'enabled',
    externalSideEffects: 'allowed',
    approval: { mode: 'never' },
  },
}), signal);
assert.equal(revokedTrustedCodexCalls, 0);
assert.deepEqual(revokedTrusted.outcome, {
  outcome: 'blocked',
  errorCode: 'continuation_trusted_profile_revoked',
  errorSummary: 'The creator is no longer eligible for trusted_personal_workspace.',
  requiredCapability: 'trusted_personal_workspace',
  completedWork: [],
  unperformedWork: ['Restore owner or allowed_user_ids eligibility, then retry the task.'],
});

const readOnlyRequests: CodexExecRequest[] = [];
const readOnlyExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  runCodexExec: async (request) => {
    readOnlyRequests.push(request);
    return {
      text: JSON.stringify({ outcome: 'completed', final_message: 'read only', artifacts: [] }),
    };
  },
});
await readOnlyExecutor.execute(createClaim({
  permissions: {
    profile: 'bounded',
    filesystem: { root: canonicalRoot, mode: 'read-only', requestedPaths: [] },
    hostTools: [],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  },
}), signal);
assert.equal(readOnlyRequests[0].sandbox, 'read-only');

const narrowedRoot = join(canonicalRoot, 'narrowed-current-root');
await mkdir(narrowedRoot);
let policyDeniedCodexCalls = 0;
const policyDeniedExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: await realpath(narrowedRoot),
  runCodexExec: async () => {
    policyDeniedCodexCalls += 1;
    return { text: JSON.stringify({ outcome: 'completed', final_message: 'unsafe', artifacts: [] }) };
  },
});
const policyDenied = await policyDeniedExecutor.execute(createClaim(), signal);
assert.equal(policyDeniedCodexCalls, 0);
assert.deepEqual(policyDenied.outcome, {
  outcome: 'blocked',
  errorCode: 'continuation_working_directory_denied',
  errorSummary: 'The continuation working directory is no longer authorized by its snapshot and current operator policy.',
  requiredCapability: 'filesystem.workspace',
  completedWork: [],
  unperformedWork: ['Use an authorized continuation working directory.'],
});

let interactiveApprovalCodexCalls = 0;
const interactiveApprovalExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  runCodexExec: async () => {
    interactiveApprovalCodexCalls += 1;
    return { text: JSON.stringify({ outcome: 'completed', final_message: 'unsafe', artifacts: [] }) };
  },
});
const interactiveApproval = await interactiveApprovalExecutor.execute(createClaim({
  permissions: {
    profile: 'bounded',
    filesystem: { root: canonicalRoot, mode: 'workspace-write', requestedPaths: [] },
    hostTools: [],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'interactive' },
  },
}), signal);
assert.equal(interactiveApprovalCodexCalls, 0);
assert.deepEqual(interactiveApproval.outcome, {
  outcome: 'blocked',
  errorCode: 'continuation_approval_unavailable',
  errorSummary: 'Interactive approval is reserved but is not enabled for continuation tasks.',
  requiredCapability: 'approval.interactive',
  completedWork: [],
  unperformedWork: ['Obtain one-time interactive approval for this continuation step.'],
});

async function executeRaw(text: string): Promise<void> {
  const strictExecutor = createContinuationCodexExecutor({
    artifactStore,
    configuredSandbox: 'workspace-write',
    currentWorkingRoot: canonicalRoot,
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

await executeRaw(JSON.stringify(wireOutcome({
  outcome: 'completed',
  final_message: 'wire-format complete',
  artifacts: [],
})));

const rejectedSchemaExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  runCodexExec: async () => {
    throw new CodexExecProcessError(
      1,
      null,
      '',
      '{"error":{"code":"invalid_json_schema","message":"oneOf is not permitted"}}',
      'invalid_json_schema',
    );
  },
});
await assert.rejects(
  rejectedSchemaExecutor.execute(createClaim(), signal),
  (error: unknown) => {
    assert.ok(error && typeof error === 'object');
    const failure = error as { errorCode?: unknown; errorSummary?: unknown; retryable?: unknown };
    assert.equal(failure.errorCode, 'codex_output_schema_rejected');
    assert.equal(failure.errorSummary, 'Codex rejected the continuation output schema before execution.');
    assert.equal(failure.retryable, false);
    return true;
  },
);

const toolRequests: CodexExecRequest[] = [];
const toolInvocations: Array<{ tool: string; args: string[] }> = [];
const toolResponses = [
  {
    text: JSON.stringify(wireOutcome({
      outcome: 'tool_request',
      tool: 'lark_cli',
      args: ['doc', 'get', '--token', 'doc_1'],
    })),
    sessionId: 'session-tool',
  },
  {
    text: JSON.stringify({
      outcome: 'completed',
      final_message: 'Fetched the document.',
      artifacts: [],
    }),
    sessionId: 'session-tool',
  },
];
const toolExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() { return null; },
    async invoke(_claim, request) {
      toolInvocations.push(request);
      return {
        status: 'completed' as const,
        result: { ok: true, message: '{"title":"Release plan"}' },
      };
    },
  },
  runCodexExec: async (request) => {
    toolRequests.push(request);
    const response = toolResponses.shift();
    assert.ok(response);
    return response;
  },
});
const toolResult = await toolExecutor.execute(
  createClaim({ requiredTools: ['lark_cli'] }),
  signal,
);
assert.equal(toolResult.outcome.outcome, 'completed');
assert.deepEqual(toolInvocations, [
  { tool: 'lark_cli', args: ['doc', 'get', '--token', 'doc_1'] },
]);
assert.equal(toolRequests.length, 2);
assert.equal(toolRequests[1].resumeSessionId, 'session-tool');
assert.match(toolRequests[1].prompt, /Continuation Tool Result/);
assert.match(toolRequests[1].prompt, /Release plan/);
assert.equal(toolRequests[1].sandbox, 'workspace-write');
assert.deepEqual(toolRequests[1].configOverrides, [
  'approval_policy="never"',
  'sandbox_workspace_write.network_access=false',
]);

const undeclaredExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() { return null; },
    async invoke() {
      assert.fail('undeclared tools must not reach the host invoker');
    },
  },
  runCodexExec: async () => ({
    text: JSON.stringify({ outcome: 'tool_request', tool: 'lark_cli', args: [] }),
  }),
});
const undeclared = await undeclaredExecutor.execute(createClaim(), signal);
assert.deepEqual(undeclared.outcome, {
  outcome: 'blocked',
  errorCode: 'continuation_tool_not_declared',
  errorSummary: 'Local CLI tool "lark_cli" was not declared in required_tools.',
  requiredCapability: 'lark_cli',
  completedWork: [],
  unperformedWork: ['Invoke the required local CLI tool.'],
});

const deniedExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() { return null; },
    async invoke() {
      return {
        status: 'completed' as const,
        result: { ok: false, message: 'Caller is not authorized.' },
      };
    },
  },
  runCodexExec: async () => ({
    text: JSON.stringify({ outcome: 'tool_request', tool: 'lark_cli', args: [] }),
  }),
});
const denied = await deniedExecutor.execute(
  createClaim({ requiredTools: ['lark_cli'] }),
  signal,
);
assert.equal(denied.outcome.outcome, 'blocked');
assert.equal('errorCode' in denied.outcome && denied.outcome.errorCode, 'continuation_tool_denied');

let repeatedRequestCount = 0;
const repeatedExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() { return null; },
    async invoke() {
      return { status: 'completed' as const, result: { ok: true, message: '{}' } };
    },
  },
  runCodexExec: async () => {
    repeatedRequestCount += 1;
    return {
      text: JSON.stringify({ outcome: 'tool_request', tool: 'lark_cli', args: [] }),
      sessionId: 'session-repeated',
    };
  },
});
const repeated = await repeatedExecutor.execute(
  createClaim({ requiredTools: ['lark_cli'] }),
  signal,
);
assert.equal(repeatedRequestCount, 2);
assert.equal(repeated.outcome.outcome, 'blocked');
assert.equal(
  'errorCode' in repeated.outcome && repeated.outcome.errorCode,
  'continuation_tool_call_limit',
);

const recoveryRequests: CodexExecRequest[] = [];
const recoveryExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() {
      return {
        status: 'completed' as const,
        tool: 'lark_cli',
        result: { ok: true, message: '{"recovered":true}' },
      };
    },
    async invoke() {
      assert.fail('a recovered tool result must not execute again');
    },
  },
  runCodexExec: async (request) => {
    recoveryRequests.push(request);
    return {
      text: JSON.stringify({
        outcome: 'completed',
        final_message: 'Recovered without replay.',
        artifacts: [],
      }),
      sessionId: 'session-recovery',
    };
  },
});
const recoveredResult = await recoveryExecutor.execute(
  createClaim({ requiredTools: ['lark_cli'] }),
  signal,
);
assert.equal(recoveredResult.outcome.outcome, 'completed');
assert.equal(recoveryRequests.length, 1);
assert.match(recoveryRequests[0].prompt, /Continuation Tool Result/);
assert.match(recoveryRequests[0].prompt, /recovered/);
assert.match(recoveryRequests[0].prompt, /Durable Continuation Step/);
assert.match(recoveryRequests[0].prompt, /Produce a verified result/);

let unknownRecoveryCodexCalls = 0;
const unknownRecoveryExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'workspace-write',
  currentWorkingRoot: canonicalRoot,
  toolInvoker: {
    async recover() {
      return {
        status: 'blocked' as const,
        tool: 'lark_cli',
        errorCode: 'continuation_tool_outcome_unknown',
        errorSummary: 'The prior call has an unknown outcome.',
      };
    },
    async invoke() {
      assert.fail('unknown recovery must not execute again');
    },
  },
  runCodexExec: async () => {
    unknownRecoveryCodexCalls += 1;
    return { text: '' };
  },
});
const unknownRecovery = await unknownRecoveryExecutor.execute(
  createClaim({ requiredTools: ['lark_cli'] }),
  signal,
);
assert.equal(unknownRecoveryCodexCalls, 0);
assert.equal(unknownRecovery.outcome.outcome, 'blocked');
assert.equal(
  'errorCode' in unknownRecovery.outcome && unknownRecovery.outcome.errorCode,
  'continuation_tool_outcome_unknown',
);

const fallbackRequests: CodexExecRequest[] = [];
const fallbackExecutor = createContinuationCodexExecutor({
  artifactStore,
  configuredSandbox: 'read-only',
  currentWorkingRoot: canonicalRoot,
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
  currentWorkingRoot: canonicalRoot,
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
