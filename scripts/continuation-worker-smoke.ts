import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ContinuationClaim,
  ContinuationDeliveryClaim,
  ContinuationExecutionResult,
  ContinuationJob,
} from '../src/domain/continuation.js';
import { ContinuationExecutionError } from '../src/domain/continuation.js';
import type {
  ContinuationAudit,
  ContinuationClock,
  ContinuationExecutor,
  ContinuationRepository,
  ContinuationDelivery,
} from '../src/ports/continuation.js';
import { ContinuationWorker } from '../src/continuation/worker.js';
import { ContinuationInputStore } from '../src/continuation/input-store.js';
import { ContinuationService } from '../src/continuation/service.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';

function createJob(suffix: string): ContinuationJob {
  return {
    jobId: `job_${suffix.padEnd(24, '0').slice(0, 24)}`,
    idempotencyKey: `idem-${suffix}`,
    creatorOpenId: 'ou_creator',
    route: {
      kind: 'message_thread',
      conversationId: 'oc_worker',
      sourceMessageId: `om_${suffix}`,
    },
    sourceMessageId: `om_${suffix}`,
    title: `Worker ${suffix}`,
    objective: 'Complete the background task',
    acceptanceCriteria: ['finish'],
    contextSnapshot: {
      summary: 'Ready',
      completedSteps: [],
      remainingSteps: ['finish'],
      constraints: [],
      decisions: [],
      references: [],
    },
    requiredTools: [],
    workingDirectory: '/tmp',
    permissions: {
      profile: 'bounded',
      filesystem: { root: '/tmp', mode: 'workspace-write', requestedPaths: [] },
      hostTools: [],
      network: 'none',
      externalSideEffects: 'denied',
      approval: { mode: 'never' },
    },
    maxAttempts: 5,
    maxRetries: 3,
    timeoutSeconds: 60,
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
    rowVersion: 2,
    status: 'running',
    stepCount: 0,
    failureCount: 0,
    nextRunAt: '2026-07-17T00:00:00.000Z',
    leaseOwner: 'continuation-worker',
    leaseExpiresAt: '2026-07-17T00:00:30.000Z',
    heartbeatAt: '2026-07-17T00:00:00.000Z',
    resultArtifacts: [],
    updatedAt: '2026-07-17T00:00:00.000Z',
    retained: false,
  };
}

function createClaim(suffix: string): ContinuationClaim {
  const job = createJob(suffix);
  return {
    job,
    workerId: 'continuation-worker',
    claimedRowVersion: job.rowVersion,
    attempt: {
      attemptId: `att_${suffix.padEnd(24, '0').slice(0, 24)}`,
      jobId: job.jobId,
      ordinal: 1,
      workerId: 'continuation-worker',
      startedAt: '2026-07-17T00:00:00.000Z',
      heartbeatAt: '2026-07-17T00:00:00.000Z',
    },
  };
}

class FakeClock implements ContinuationClock {
  constructor(private value = new Date('2026-07-17T00:00:00.000Z')) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

interface RepositoryHarness {
  repository: ContinuationRepository;
  claims: ContinuationClaim[];
  completed: Array<{ claim: ContinuationClaim; result: ContinuationExecutionResult }>;
  failures: Array<{ claim: ContinuationClaim; errorCode: string; retryable: boolean }>;
  cancellations: ContinuationClaim[];
  heartbeats: string[];
  deliveryResults: unknown[];
  recoverCalls: number;
  expireCalls: number;
  claimCalls: number;
  deliveryClaim: ContinuationDeliveryClaim | null;
  getStatus: ContinuationJob['status'];
}

function createRepositoryHarness(initialClaims: ContinuationClaim[] = []): RepositoryHarness {
  const harness = {
    claims: [...initialClaims],
    completed: [],
    failures: [],
    cancellations: [],
    heartbeats: [],
    deliveryResults: [],
    recoverCalls: 0,
    expireCalls: 0,
    claimCalls: 0,
    deliveryClaim: null,
    getStatus: 'running' as ContinuationJob['status'],
  } as RepositoryHarness;
  harness.repository = {
    async initialize() {},
    async healthCheck() {},
    async create() { throw new Error('not used'); },
    async get(jobId) {
      const source = initialClaims.find((claim) => claim.job.jobId === jobId)?.job
        ?? createJob('lookup');
      return { ...source, status: harness.getStatus };
    },
    async listByCreator() { return []; },
    async listAll() { return []; },
    async claimDue() {
      harness.claimCalls += 1;
      return harness.claims.shift() ?? null;
    },
    async heartbeat(jobId) {
      harness.heartbeats.push(jobId);
      return harness.getStatus === 'running';
    },
    async completeStep(claim, result) {
      harness.completed.push({ claim, result });
    },
    async failAttempt(claim, failure) {
      harness.failures.push({
        claim,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
      });
    },
    async requestCancel() { return 'missing'; },
    async completeCancellation(claim) { harness.cancellations.push(claim); },
    async recoverExpiredLeases() { harness.recoverCalls += 1; return 0; },
    async expireOverdue() { harness.expireCalls += 1; return 0; },
    async cloneForRetry() { throw new Error('not used'); },
    async redactTerminal() { return false; },
    async claimPendingDelivery() {
      const claim = harness.deliveryClaim;
      harness.deliveryClaim = null;
      return claim;
    },
    async markDeliveryResult(_claim, result) { harness.deliveryResults.push(result); },
    async purgeExpired() { return []; },
    close() {},
  };
  return harness;
}

function completedResult(message: string): ContinuationExecutionResult {
  return {
    outcome: { outcome: 'completed', finalMessage: message, artifacts: [] },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const auditEvents: string[] = [];
const auditDetails: string[] = [];
const audit: ContinuationAudit = {
  async record(event) {
    auditEvents.push(`${event.action}:${event.result}`);
    if (event.detail) auditDetails.push(`${event.action}:${event.detail}`);
  },
};

// Normal execution and terminal delivery are independent paths.
const normalHarness = createRepositoryHarness([createClaim('normal')]);
normalHarness.deliveryClaim = {
  outboxId: 'out_normal',
  jobId: 'job_normal000000000000000000',
  eventKey: 'terminal',
  kind: 'terminal',
  workerId: 'continuation-worker-delivery',
  route: {
    kind: 'message_thread',
    conversationId: 'oc_worker',
    sourceMessageId: 'om_normal',
  },
  idempotencyKey: 'ct_normal',
  payload: 'Task completed',
  status: 'sending',
  attemptCount: 1,
};
const normalExecutor: ContinuationExecutor = {
  async execute() { return completedResult('done'); },
};
const normalDelivery: ContinuationDelivery = {
  async deliver() { return { status: 'delivered', messageId: 'om_terminal' }; },
};
const normalWorker = new ContinuationWorker({
  repository: normalHarness.repository,
  executor: normalExecutor,
  delivery: normalDelivery,
  clock: new FakeClock(),
  audit,
  maxConcurrency: 1,
  scanIntervalMs: 1_000,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
});
await normalWorker.tick();
await waitFor(
  () => normalHarness.completed.length === 1 && normalHarness.deliveryResults.length === 1,
  'normal execution and delivery',
);
assert.equal(normalHarness.recoverCalls >= 1, true);
assert.equal(normalHarness.expireCalls >= 1, true);
assert.equal(normalHarness.completed[0].result.outcome.outcome, 'completed');
assert.deepEqual(normalHarness.deliveryResults[0], {
  status: 'delivered',
  messageId: 'om_terminal',
});
await normalWorker.stop();

// Max concurrency is enforced, and completion refills the available slot.
const concurrentHarness = createRepositoryHarness([
  createClaim('concurrent-a'),
  createClaim('concurrent-b'),
  createClaim('concurrent-c'),
]);
const releases: Array<() => void> = [];
const concurrentExecutor: ContinuationExecutor = {
  async execute(claim) {
    await new Promise<void>((resolve) => releases.push(resolve));
    return completedResult(claim.job.jobId);
  },
};
const noDelivery: ContinuationDelivery = {
  async deliver() { throw new Error('unexpected delivery'); },
};
const concurrentWorker = new ContinuationWorker({
  repository: concurrentHarness.repository,
  executor: concurrentExecutor,
  delivery: noDelivery,
  clock: new FakeClock(),
  audit,
  maxConcurrency: 2,
  heartbeatIntervalMs: 1_000,
});
await concurrentWorker.tick();
await waitFor(() => concurrentWorker.activeCount === 2, 'two active claims');
assert.equal(releases.length, 2);
releases.shift()?.();
await waitFor(() => releases.length === 2, 'third claim after a slot is released');
assert.equal(concurrentWorker.activeCount, 2);
releases.splice(0).forEach((release) => release());
await waitFor(() => concurrentHarness.completed.length === 3, 'all concurrent claims');
await concurrentWorker.stop();

// A cancel_requested status aborts the child and commits cancellation, not failure.
const cancelHarness = createRepositoryHarness([createClaim('cancel')]);
const cancelExecutor: ContinuationExecutor = {
  async execute(_claim, signal) {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return completedResult('unreachable');
  },
};
const cancelWorker = new ContinuationWorker({
  repository: cancelHarness.repository,
  executor: cancelExecutor,
  delivery: noDelivery,
  clock: new FakeClock(),
  audit,
  maxConcurrency: 1,
  heartbeatIntervalMs: 5,
  leaseDurationMs: 30,
});
await cancelWorker.tick();
await waitFor(() => cancelHarness.heartbeats.length >= 1, 'heartbeat renewal');
cancelHarness.getStatus = 'cancel_requested';
await waitFor(() => cancelHarness.cancellations.length === 1, 'running cancellation');
assert.equal(cancelHarness.failures.length, 0);
await cancelWorker.stop();

// Structured blocked outcomes complete through the repository; execution errors use bounded retry.
const blockedHarness = createRepositoryHarness([createClaim('blocked')]);
const blockedWorker = new ContinuationWorker({
  repository: blockedHarness.repository,
  executor: {
    async execute() {
      return {
        outcome: {
          outcome: 'blocked',
          errorCode: 'capability_unavailable',
          errorSummary: 'Unavailable',
          requiredCapability: 'network',
          completedWork: [],
          unperformedWork: ['fetch'],
        },
      };
    },
  },
  delivery: noDelivery,
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await blockedWorker.tick();
await waitFor(() => blockedHarness.completed.length === 1, 'blocked completion');
assert.equal(blockedHarness.completed[0].result.outcome.outcome, 'blocked');
await blockedWorker.stop();

const failureHarness = createRepositoryHarness([createClaim('failure')]);
const failureWorker = new ContinuationWorker({
  repository: failureHarness.repository,
  executor: { async execute() { throw new Error('provider unavailable'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await failureWorker.tick();
await waitFor(() => failureHarness.failures.length === 1, 'retryable execution failure');
assert.equal(failureHarness.failures[0].retryable, true);
assert.equal(failureHarness.failures[0].errorCode, 'continuation_execution_failed');
await failureWorker.stop();

const nonRetryableHarness = createRepositoryHarness([createClaim('non-retryable')]);
const nonRetryableWorker = new ContinuationWorker({
  repository: nonRetryableHarness.repository,
  executor: {
    async execute() {
      throw new ContinuationExecutionError(
        'invalid_continuation_output',
        'Invalid structured output.',
        false,
      );
    },
  },
  delivery: noDelivery,
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await nonRetryableWorker.tick();
await waitFor(() => nonRetryableHarness.failures.length === 1, 'non-retryable failure');
assert.equal(nonRetryableHarness.failures[0].errorCode, 'invalid_continuation_output');
assert.equal(nonRetryableHarness.failures[0].retryable, false);
await nonRetryableWorker.stop();

// Delivery errors only reschedule the outbox and never invoke the executor.
const deliveryHarness = createRepositoryHarness();
deliveryHarness.deliveryClaim = {
  outboxId: 'out_retry',
  jobId: 'job_retry0000000000000000000',
  eventKey: 'progress:att_retry0000000000000000000',
  kind: 'progress',
  attemptId: 'att_retry0000000000000000000',
  workerId: 'continuation-worker-delivery',
  route: {
    kind: 'message_thread',
    conversationId: 'oc_worker',
    sourceMessageId: 'om_retry',
  },
  idempotencyKey: 'ct_retry',
  payload: 'Task failed',
  status: 'sending',
  attemptCount: 1,
};
let deliveryExecutionCalls = 0;
const deliveryWorker = new ContinuationWorker({
  repository: deliveryHarness.repository,
  executor: { async execute() { deliveryExecutionCalls += 1; return completedResult('bad'); } },
  delivery: { async deliver() { throw new Error('temporary Lark failure'); } },
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await deliveryWorker.tick();
await waitFor(() => deliveryHarness.deliveryResults.length === 1, 'delivery retry');
assert.equal(deliveryExecutionCalls, 0);
assert.deepEqual(deliveryHarness.deliveryResults[0], {
  status: 'retry',
  errorCode: 'continuation_delivery_failed',
  errorSummary: 'temporary Lark failure',
});
await deliveryWorker.stop();

// Graceful stop aborts active children, leaves their lease for recovery, and blocks new claims.
const stopHarness = createRepositoryHarness([createClaim('stop'), createClaim('must-not-start')]);
let stopSignal: AbortSignal | undefined;
const stopWorker = new ContinuationWorker({
  repository: stopHarness.repository,
  executor: {
    async execute(_claim, signal) {
      stopSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true });
      });
      return completedResult('unreachable');
    },
  },
  delivery: noDelivery,
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await stopWorker.tick();
await waitFor(() => stopWorker.activeCount === 1, 'active shutdown claim');
const claimsBeforeStop = stopHarness.claimCalls;
await stopWorker.stop();
assert.equal(stopSignal?.aborted, true);
assert.equal(stopHarness.failures.length, 0);
await stopWorker.tick();
assert.equal(stopHarness.claimCalls, claimsBeforeStop);

assert.ok(auditEvents.includes('continuation.execute:ok'));
assert.ok(auditEvents.includes('continuation.execute.start:ok'));
assert.ok(auditDetails.some((detail) =>
  /continuation\.execute\.start:profile=bounded network=none external_side_effects=denied/.test(detail)));
assert.ok(auditEvents.includes('continuation.deliver:ok'));

// The real pre-claim integrity gate creates terminal delivery without invoking Codex.
const integrityRoot = await mkdtemp(path.join(tmpdir(), 'continuation-worker-integrity-'));
const integrityInputsDir = path.join(integrityRoot, 'inputs');
const integrityRepository = await SqliteContinuationRepository.open({
  databasePath: path.join(integrityRoot, 'jobs.sqlite'),
  artifactsDir: path.join(integrityRoot, 'artifacts'),
  inputsDir: integrityInputsDir,
  jitter: () => 0,
});
const integrityClock = new FakeClock();
const integrityService = new ContinuationService({
  repository: integrityRepository,
  allowedWorkingRoot: integrityRoot,
  filesystemMode: 'workspace-write',
  maxAttempts: 5,
  maxRetries: 3,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  clock: integrityClock,
});
const integritySource = path.join(integrityRoot, 'source.txt');
await writeFile(integritySource, 'worker integrity input', 'utf8');
const integrityJob = (await integrityService.createFromMessage({
  title: 'Integrity worker task',
  objective: 'Do not execute after input tampering.',
  deliverables: [{ id: 'result', description: 'A result.', required: true }],
  acceptance_criteria: [{
    id: 'complete',
    description: 'The task completes.',
    deliverable_ids: ['result'],
  }],
  verification_requirements: [{
    id: 'evidence',
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
}, {
  messageId: 'om_worker_integrity',
  chatId: 'oc_worker_integrity',
  chatType: 'p2p',
  senderId: 'ou_creator',
  text: 'Run in the background.',
  messageType: 'text',
  rawContent: '{"text":"Run in the background."}',
}, undefined, undefined, [{
  sourcePath: integritySource,
  fileName: 'source.txt',
  kind: 'message_attachment',
}])).job;
const integrityStore = new ContinuationInputStore(integrityInputsDir);
const integrityManagedPath = integrityStore.resolve(
  integrityJob.jobId,
  integrityJob.sourceFacts.inputs[0].relativePath,
);
await chmod(integrityManagedPath, 0o600);
await writeFile(integrityManagedPath, 'tampered', 'utf8');
await chmod(integrityManagedPath, 0o400);
let integrityExecutionCalls = 0;
let integrityDeliveryCalls = 0;
const integrityWorker = new ContinuationWorker({
  repository: integrityRepository,
  executor: {
    async execute() {
      integrityExecutionCalls += 1;
      return completedResult('must not run');
    },
  },
  delivery: {
    async deliver(claim) {
      integrityDeliveryCalls += 1;
      assert.equal(claim.kind, 'terminal');
      assert.doesNotMatch(claim.payload, /source\.txt|worker-integrity/i);
      return { status: 'delivered', messageId: 'om_integrity_terminal' };
    },
  },
  clock: integrityClock,
  maxConcurrency: 1,
});
await integrityWorker.tick();
await waitFor(() => integrityDeliveryCalls === 1, 'integrity terminal delivery');
assert.equal(integrityExecutionCalls, 0);
assert.equal((await integrityRepository.get(integrityJob.jobId))?.attemptCount, 0);
await integrityWorker.stop();
integrityRepository.close();
console.log('continuation worker smoke: PASS');
