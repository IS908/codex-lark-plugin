import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContinuationCreateRequest } from '../src/domain/continuation.js';

const root = await mkdtemp(join(tmpdir(), 'continuation-local-cli-'));
process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_AUDIT_LOG = join(root, 'audit.log');

const { SqliteContinuationRepository } = await import('../src/continuation/sqlite-repository.js');
const { createContinuationLocalCliToolInvoker } = await import(
  '../src/continuation/local-cli-tool-invoker.js'
);

const databasePath = join(root, 'jobs.sqlite');
const artifactsDir = join(root, 'artifacts');
const configPath = join(root, 'local-cli-tools.json');
const helperPath = join(root, 'helper.js');
const countPath = join(root, 'count.txt');
const now = '2026-07-17T00:00:00.000Z';

await writeFile(helperPath, [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'fs.appendFileSync(process.env.COUNT_PATH, "x");',
  'process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));',
].join('\n'), 'utf-8');
await chmod(helperPath, 0o755);
await writeFile(configPath, JSON.stringify({
  tools: {
    lark_cli: {
      command: process.execPath,
      fixedArgs: [helperPath],
      paramBlocklist: ['--secret'],
      env: { COUNT_PATH: countPath },
      allowedCallers: ['ou_creator'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  },
}, null, 2), 'utf-8');

function request(suffix: string, requiredTools: string[]): ContinuationCreateRequest {
  const route = {
    kind: 'message_thread' as const,
    conversationId: 'oc_tool',
    sourceMessageId: `om_${suffix}`,
  };
  const contextSnapshot = {
    summary: '',
    completedSteps: [],
    remainingSteps: ['invoke tool'],
    constraints: [],
    decisions: [],
    references: [],
  };
  const permissions = {
    profile: 'bounded' as const,
    filesystem: { root, mode: 'workspace-write' as const, requestedPaths: [] },
    hostTools: requiredTools,
    network: 'none' as const,
    externalSideEffects: 'denied' as const,
    approval: { mode: 'never' as const },
  };
  return {
    idempotencyKey: `idem-${suffix}`,
    creatorOpenId: 'ou_creator',
    route,
    sourceMessageId: `om_${suffix}`,
    title: `Tool ${suffix}`,
    objective: 'Use one configured local CLI tool.',
    acceptanceCriteria: ['return the tool result'],
    contextSnapshot,
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'captured',
      originalUserText: 'Use one configured local CLI tool.',
      quotedMessageText: null,
      creatorOpenId: 'ou_creator',
      chatId: 'oc_tool',
      chatType: 'p2p',
      route,
      sourceMessageId: `om_${suffix}`,
      sourceMessageType: 'text',
      sourceTimestamp: null,
      inputs: [],
      workingDirectory: root,
      model: null,
      permissions,
    },
    taskContract: {
      schemaVersion: 1,
      title: `Tool ${suffix}`,
      objective: 'Use one configured local CLI tool.',
      deliverables: [{ id: 'tool_result', description: 'The configured tool result.', required: true }],
      acceptanceCriteria: [{
        id: 'tool_result_returned',
        description: 'return the tool result',
        deliverableIds: ['tool_result'],
      }],
      verificationRequirements: [{
        id: 'tool_result_evidence',
        description: 'Reference the configured tool result.',
        kind: 'evidence_reference',
      }],
      initialContext: contextSnapshot,
    },
    sourceInputs: [],
    requiredTools,
    workingDirectory: root,
    permissions,
    maxAttempts: 4,
    maxRetries: 0,
    timeoutSeconds: 30,
    createdAt: now,
    expiresAt: '2026-07-18T00:00:00.000Z',
  };
}

const repository = await SqliteContinuationRepository.open({ databasePath, artifactsDir });
try {
  const declaredJob = await repository.create(request('declared', ['lark_cli']));
  const declaredClaim = await repository.claimDue(
    'worker-tool',
    now,
    '2026-07-17T00:00:30.000Z',
  );
  assert.equal(declaredClaim?.job.jobId, declaredJob.job.jobId);
  assert.ok(declaredClaim);

  const invoker = createContinuationLocalCliToolInvoker({
    repository,
    configPath,
    now: () => new Date(now),
  });
  const toolRequest = { tool: 'lark_cli', args: ['doc', 'get', '--id', 'doc_1'] };
  const first = await invoker.invoke(
    declaredClaim,
    toolRequest,
    new AbortController().signal,
  );
  assert.equal(first.status, 'completed');
  assert.equal(first.status === 'completed' && first.result.ok, true);
  assert.match(first.status === 'completed' ? first.result.message : '', /doc_1/);
  assert.deepEqual(await invoker.recover(declaredClaim), {
    status: 'completed',
    tool: 'lark_cli',
    result: first.status === 'completed' ? first.result : { ok: false, message: '' },
  });

  const replay = await invoker.invoke(
    declaredClaim,
    toolRequest,
    new AbortController().signal,
  );
  assert.deepEqual(replay, first);
  assert.equal(await readFile(countPath, 'utf-8'), 'x');

  await repository.completeStep(declaredClaim, {
    outcome: {
      outcome: 'continue',
      checkpoint: {
        summary: 'first tool complete',
        completedSteps: [],
        remainingSteps: [],
        constraints: [],
        decisions: [],
        references: [],
      },
      nextStep: 'finish',
    },
  }, now);

  const progress = await repository.claimPendingDelivery('delivery-tool', now);
  assert.equal(progress?.kind, 'progress');
  await repository.markDeliveryResult(
    progress!,
    { status: 'delivered', messageId: 'om_tool_progress' },
    now,
  );

  const nextClaim = await repository.claimDue(
    'worker-tool',
    now,
    '2026-07-17T00:00:30.000Z',
  );
  assert.ok(nextClaim);
  const pending = await repository.beginToolCall(nextClaim, toolRequest, now);
  assert.equal(pending.status, 'execute');
  assert.deepEqual(await invoker.recover(nextClaim), {
    status: 'blocked',
    tool: 'lark_cli',
    errorCode: 'continuation_tool_outcome_unknown',
    errorSummary: 'The previous local CLI invocation may have completed; it will not be replayed automatically.',
  });
  const unknown = await invoker.invoke(
    nextClaim,
    toolRequest,
    new AbortController().signal,
  );
  assert.deepEqual(unknown, {
    status: 'blocked',
    errorCode: 'continuation_tool_outcome_unknown',
    errorSummary: 'The previous local CLI invocation may have completed; it will not be replayed automatically.',
  });
  assert.equal(await readFile(countPath, 'utf-8'), 'x');
} finally {
  repository.close();
}

console.log('continuation local CLI invoker smoke: PASS');
