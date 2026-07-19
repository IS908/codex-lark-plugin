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
import type { DurableRunInterruptedAttempt } from '../src/domain/durable-run.js';
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
  const route = {
    kind: 'message_thread' as const,
    conversationId: 'oc_worker',
    sourceMessageId: `om_${suffix}`,
  };
  const permissions = {
    profile: 'bounded' as const,
    filesystem: { root: '/tmp', mode: 'workspace-write' as const, requestedPaths: [] },
    hostTools: [],
    network: 'none' as const,
    externalSideEffects: 'denied' as const,
    approval: { mode: 'never' as const },
  };
  const contextSnapshot = {
    summary: 'Ready',
    completedSteps: [],
    remainingSteps: ['finish'],
    constraints: [],
    decisions: [],
    references: [],
  };
  return {
    jobId: `job_${suffix.padEnd(24, '0').slice(0, 24)}`,
    idempotencyKey: `idem-${suffix}`,
    creatorOpenId: 'ou_creator',
    route,
    sourceMessageId: `om_${suffix}`,
    title: `Worker ${suffix}`,
    objective: 'Complete the background task',
    acceptanceCriteria: ['finish'],
    contextSnapshot,
    sourceFacts: {
      schemaVersion: 1,
      provenance: 'legacy_unavailable',
      originalUserText: null,
      sourceContextText: null,
      quotedMessageText: null,
      creatorOpenId: 'ou_creator',
      chatId: 'oc_worker',
      chatType: 'p2p',
      route,
      sourceMessageId: `om_${suffix}`,
      sourceMessageType: 'text',
      sourceTimestamp: '2026-07-17T00:00:00.000Z',
      inputs: [],
      workingDirectory: '/tmp',
      model: null,
      permissions,
    },
    taskContract: {
      schemaVersion: 1,
      title: `Worker ${suffix}`,
      objective: 'Complete the background task',
      deliverables: [],
      acceptanceCriteria: [{ id: 'finish', description: 'finish', deliverableIds: [] }],
      verificationRequirements: [],
      initialContext: contextSnapshot,
    },
    requiredTools: [],
    workingDirectory: '/tmp',
    permissions,
    maxAttempts: 5,
    maxRetries: 3,
    timeoutSeconds: 60,
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
    rowVersion: 2,
    status: 'running',
    recoveryTotalCount: 0,
    recoveryFingerprintCounts: {},
    noProgressCount: 0,
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

function interruptedAttempt(suffix: string): DurableRunInterruptedAttempt {
  const claim = createClaim(suffix);
  return {
    claim: {
      run: {
        runId: claim.job.jobId,
        workloadKind: 'async_task',
        idempotencyKey: claim.job.idempotencyKey,
        status: claim.job.status,
        inputVersion: 1,
        input: { schemaVersion: 1, job: claim.job },
        stateVersion: 1,
        state: { schemaVersion: 1, job: claim.job },
        route: claim.job.route,
        actorOpenId: claim.job.creatorOpenId,
        nextRunAt: claim.job.nextRunAt,
        expiresAt: claim.job.expiresAt,
        maxAttempts: claim.job.maxAttempts,
        attemptCount: 1,
        rowVersion: claim.claimedRowVersion + 1,
      },
      attempt: {
        attemptId: claim.attempt.attemptId,
        runId: claim.job.jobId,
        ordinal: claim.attempt.ordinal,
        workerId: claim.workerId,
        claimedAt: claim.attempt.startedAt,
        heartbeatAt: claim.attempt.heartbeatAt,
        leaseExpiresAt: '2026-07-17T00:00:00.000Z',
        executionStartedAt: claim.attempt.startedAt,
      },
      workerId: claim.workerId,
      claimedRowVersion: claim.claimedRowVersion + 1,
    },
    recoveredAt: '2026-07-17T00:00:01.000Z',
    executionPhase: 'execution_started',
    operationRisk: 'unknown',
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
  recoveries: DurableRunInterruptedAttempt[];
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
    recoveries: [],
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
    async markExecutionStarted() { return 'committed'; },
    async completeStep(claim, result) {
      harness.completed.push({ claim, result });
      return 'committed';
    },
    async failAttempt(claim, failure) {
      harness.failures.push({
        claim,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
      });
      return 'committed';
    },
    async requestCancel() { return 'missing'; },
    async completeCancellation(claim) {
      harness.cancellations.push(claim);
      return 'committed';
    },
    async recoverExpiredLeases() {
      harness.recoverCalls += 1;
      return harness.recoveries.splice(0);
    },
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
    outcome: {
      outcome: 'completed',
      checkpoint: workerCheckpoint(),
      finalMessage: message,
      artifacts: [],
    },
  };
}

function workerCheckpoint() {
  return {
    schemaVersion: 2 as const,
    summary: 'Worker step completed.',
    currentStepId: 'finish',
    completedStepIds: ['finish'],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps: [],
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: [],
    decisions: [],
    nextAction: null,
    stopReason: 'Worker smoke outcome.',
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
const debugMessages: string[] = [];
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
  debug(message) { debugMessages.push(message); },
});
await normalWorker.tick();
await waitFor(
  () => normalHarness.completed.length === 1 && normalHarness.deliveryResults.length === 1,
  'normal execution and delivery',
);
await waitFor(
  () => debugMessages.some((message) => message.includes('event=step_committed'))
    && debugMessages.some((message) => message.includes('event=delivery_committed')),
  'normal execution and delivery diagnostics',
);
assert.equal(normalHarness.recoverCalls >= 1, true);
assert.equal(normalHarness.expireCalls >= 1, true);
assert.equal(normalHarness.completed[0].result.outcome.outcome, 'completed');
assert.deepEqual(normalHarness.deliveryResults[0], {
  status: 'delivered',
  messageId: 'om_terminal',
});
assert.ok(debugMessages.some((message) => message.includes('event=claimed')));
assert.ok(debugMessages.some((message) => message.includes('event=step_committed')));
assert.ok(debugMessages.some((message) => message.includes('event=delivery_committed')));
await normalWorker.stop();

// Expired opaque execution is reduced by the Async Task workload and never blindly re-executed.
const recoveryHarness = createRepositoryHarness();
recoveryHarness.recoveries.push(interruptedAttempt('structured-recovery'));
let recoveryExecutionCalls = 0;
const recoveryWorker = new ContinuationWorker({
  repository: recoveryHarness.repository,
  executor: {
    async execute() {
      recoveryExecutionCalls += 1;
      return completedResult('must not execute');
    },
  },
  delivery: normalDelivery,
  clock: new FakeClock(new Date('2026-07-17T00:00:01.000Z')),
  maxConcurrency: 1,
});
await recoveryWorker.tick();
await waitFor(() => recoveryHarness.completed.length === 1, 'structured recovery commit');
assert.equal(recoveryExecutionCalls, 0);
assert.equal(recoveryHarness.completed[0]?.result.outcome.outcome, 'waiting_user');
if (recoveryHarness.completed[0]?.result.outcome.outcome === 'waiting_user') {
  assert.equal(
    recoveryHarness.completed[0].result.outcome.failure.operationRisk,
    'unknown',
  );
}
await recoveryWorker.stop();

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
await waitFor(() => releases.length === 2, 'two executing claims');
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
          checkpoint: workerCheckpoint(),
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

// A stale continuation execution-start result is mapped to lease loss before Codex executes.
const staleStartHarness = createRepositoryHarness([createClaim('stale-start')]);
staleStartHarness.repository.markExecutionStarted = async () => 'stale';
let staleStartExecutionCalls = 0;
const staleStartWorker = new ContinuationWorker({
  repository: staleStartHarness.repository,
  executor: {
    async execute() {
      staleStartExecutionCalls += 1;
      return completedResult('must not execute');
    },
  },
  delivery: noDelivery,
  clock: new FakeClock(),
  maxConcurrency: 1,
});
await staleStartWorker.tick();
await waitFor(() => staleStartWorker.activeCount === 0, 'stale continuation execution start');
assert.equal(staleStartExecutionCalls, 0);
assert.deepEqual(staleStartHarness.completed, []);
assert.deepEqual(staleStartHarness.failures, []);
await staleStartWorker.stop();

// Stale step and failure commits stay stale instead of emitting committed diagnostics.
const staleStepHarness = createRepositoryHarness([createClaim('stale-step')]);
staleStepHarness.repository.completeStep = async () => 'stale';
const staleStepDebug: string[] = [];
const staleStepWorker = new ContinuationWorker({
  repository: staleStepHarness.repository,
  executor: { async execute() { return completedResult('stale result'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  debug(message) { staleStepDebug.push(message); },
  maxConcurrency: 1,
});
await staleStepWorker.tick();
await waitFor(() => staleStepWorker.activeCount === 0, 'stale continuation step');
assert.equal(staleStepDebug.some((message) => message.includes('event=step_committed')), false);
assert.deepEqual(staleStepHarness.failures, []);
await staleStepWorker.stop();

const staleFailureHarness = createRepositoryHarness([createClaim('stale-failure')]);
staleFailureHarness.repository.failAttempt = async () => 'stale';
const staleFailureDebug: string[] = [];
const staleFailureWorker = new ContinuationWorker({
  repository: staleFailureHarness.repository,
  executor: { async execute() { throw new Error('executor failed'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  debug(message) { staleFailureDebug.push(message); },
  maxConcurrency: 1,
});
await staleFailureWorker.tick();
await waitFor(() => staleFailureWorker.activeCount === 0, 'stale continuation failure');
assert.equal(staleFailureDebug.some((message) => message.includes('event=attempt_failed')), false);
assert.deepEqual(staleFailureHarness.failures, []);
await staleFailureWorker.stop();

// Real mutation storage errors propagate to the worker-state boundary and are never reclassified.
const markStorageErrorHarness = createRepositoryHarness([createClaim('mark-storage-error')]);
markStorageErrorHarness.repository.markExecutionStarted = async () => {
  throw new Error('execution-start storage unavailable');
};
const markStorageErrorAudit: string[] = [];
const markStorageErrorWorker = new ContinuationWorker({
  repository: markStorageErrorHarness.repository,
  executor: { async execute() { return completedResult('unreachable'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) markStorageErrorAudit.push(`${event.action}:${event.detail}`);
    },
  },
  maxConcurrency: 1,
});
await markStorageErrorWorker.tick();
await waitFor(() => markStorageErrorWorker.activeCount === 0, 'execution-start storage error');
assert.ok(markStorageErrorAudit.includes('continuation.execute:worker_state_error'));
assert.deepEqual(markStorageErrorHarness.failures, []);
await markStorageErrorWorker.stop();

const stepStorageErrorHarness = createRepositoryHarness([createClaim('step-storage-error')]);
stepStorageErrorHarness.repository.completeStep = async () => {
  throw new Error('step storage unavailable');
};
const stepStorageErrorAudit: string[] = [];
const stepStorageErrorWorker = new ContinuationWorker({
  repository: stepStorageErrorHarness.repository,
  executor: { async execute() { return completedResult('cannot commit'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) stepStorageErrorAudit.push(`${event.action}:${event.detail}`);
    },
  },
  maxConcurrency: 1,
});
await stepStorageErrorWorker.tick();
await waitFor(() => stepStorageErrorWorker.activeCount === 0, 'step storage error');
assert.ok(stepStorageErrorAudit.includes('continuation.execute:worker_state_error'));
assert.deepEqual(stepStorageErrorHarness.failures, []);
await stepStorageErrorWorker.stop();

const failureStorageErrorHarness = createRepositoryHarness([createClaim('failure-storage-error')]);
failureStorageErrorHarness.repository.failAttempt = async () => {
  throw new Error('failure storage unavailable');
};
const failureStorageErrorAudit: string[] = [];
const failureStorageErrorDebug: string[] = [];
const failureStorageErrorWorker = new ContinuationWorker({
  repository: failureStorageErrorHarness.repository,
  executor: { async execute() { throw new Error('provider unavailable'); } },
  delivery: noDelivery,
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) failureStorageErrorAudit.push(`${event.action}:${event.detail}`);
    },
  },
  debug(message) { failureStorageErrorDebug.push(message); },
  maxConcurrency: 1,
});
await failureStorageErrorWorker.tick();
await waitFor(() => failureStorageErrorWorker.activeCount === 0, 'failure storage error');
assert.ok(failureStorageErrorAudit.includes('continuation.execute:worker_state_error'));
assert.equal(
  failureStorageErrorDebug.some((message) => message.includes('event=attempt_failed')),
  false,
);
await failureStorageErrorWorker.stop();

// Top-level worker state errors retain the legacy continuation audit and debug boundary.
const workerStateHarness = createRepositoryHarness([createClaim('worker-state-error')]);
const workerStateGet = workerStateHarness.repository.get.bind(workerStateHarness.repository);
let workerStateExecutionCompleted = false;
workerStateHarness.repository.get = async (jobId) => {
  if (workerStateExecutionCompleted) throw new Error('state read unavailable');
  return workerStateGet(jobId);
};
const workerStateAuditDetails: string[] = [];
const workerStateDebugMessages: string[] = [];
const workerStateWorker = new ContinuationWorker({
  repository: workerStateHarness.repository,
  executor: {
    async execute() {
      workerStateExecutionCompleted = true;
      return completedResult('state read will fail');
    },
  },
  delivery: noDelivery,
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) workerStateAuditDetails.push(`${event.action}:${event.detail}`);
    },
  },
  debug(message) { workerStateDebugMessages.push(message); },
  maxConcurrency: 1,
});
await workerStateWorker.tick();
await waitFor(() => workerStateWorker.activeCount === 0, 'top-level worker state error');
assert.ok(workerStateAuditDetails.includes('continuation.execute:worker_state_error'));
assert.ok(workerStateDebugMessages.some((message) => message.includes('event=worker_state_error')));
assert.deepEqual(workerStateHarness.failures, []);
await workerStateWorker.stop();

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
const deliveryAuditDetails: string[] = [];
const deliveryDebugMessages: string[] = [];
const deliveryWorker = new ContinuationWorker({
  repository: deliveryHarness.repository,
  executor: { async execute() { deliveryExecutionCalls += 1; return completedResult('bad'); } },
  delivery: { async deliver() { throw new Error('temporary Lark failure'); } },
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) deliveryAuditDetails.push(`${event.action}:${event.detail}`);
    },
  },
  debug(message) { deliveryDebugMessages.push(message); },
  maxConcurrency: 1,
});
await deliveryWorker.tick();
await waitFor(() => deliveryHarness.deliveryResults.length === 1, 'delivery retry');
await waitFor(() => deliveryAuditDetails.length >= 1, 'delivery failure audit');
assert.equal(deliveryExecutionCalls, 0);
assert.deepEqual(deliveryHarness.deliveryResults[0], {
  status: 'retry',
  errorCode: 'continuation_delivery_failed',
  errorSummary: 'temporary Lark failure',
});
assert.ok(deliveryAuditDetails.includes(
  'continuation.deliver:progress:progress:att_retry0000000000000000000:continuation_delivery_failed',
));
assert.equal(deliveryDebugMessages.some((message) => message.includes('event=delivery_committed')), false);
await deliveryWorker.stop();

// An explicit retry result keeps the ordinary retry audit and committed diagnostic semantics.
const explicitRetryHarness = createRepositoryHarness();
explicitRetryHarness.deliveryClaim = {
  outboxId: 'out_explicit_retry',
  jobId: 'job_explicit_retry000000000',
  eventKey: 'progress:att_explicit_retry0000000',
  kind: 'progress',
  attemptId: 'att_explicit_retry0000000',
  workerId: 'continuation-worker-delivery',
  route: {
    kind: 'message_thread',
    conversationId: 'oc_worker',
    sourceMessageId: 'om_explicit_retry',
  },
  idempotencyKey: 'ct_explicit_retry',
  payload: 'Retry later',
  status: 'sending',
  attemptCount: 1,
};
const explicitRetryAuditDetails: string[] = [];
const explicitRetryDebugMessages: string[] = [];
const explicitRetryWorker = new ContinuationWorker({
  repository: explicitRetryHarness.repository,
  executor: { async execute() { return completedResult('unexpected'); } },
  delivery: {
    async deliver() {
      return {
        status: 'retry',
        errorCode: 'rate_limited',
        errorSummary: 'Try later.',
      };
    },
  },
  clock: new FakeClock(),
  audit: {
    async record(event) {
      if (event.detail) explicitRetryAuditDetails.push(`${event.action}:${event.detail}`);
    },
  },
  debug(message) { explicitRetryDebugMessages.push(message); },
  maxConcurrency: 1,
});
await explicitRetryWorker.tick();
await waitFor(() => explicitRetryHarness.deliveryResults.length === 1, 'explicit delivery retry');
await waitFor(
  () => explicitRetryDebugMessages.some((message) => message.includes('event=delivery_committed')),
  'explicit delivery retry diagnostic',
);
assert.deepEqual(explicitRetryHarness.deliveryResults[0], {
  status: 'retry',
  errorCode: 'rate_limited',
  errorSummary: 'Try later.',
});
assert.ok(explicitRetryAuditDetails.includes(
  'continuation.deliver:progress:progress:att_explicit_retry0000000:retry',
));
await explicitRetryWorker.stop();

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
assert.equal((await integrityRepository.get(integrityJob.jobId))?.attemptCount, 1);
await integrityWorker.stop();
integrityRepository.close();
console.log('continuation worker smoke: PASS');
