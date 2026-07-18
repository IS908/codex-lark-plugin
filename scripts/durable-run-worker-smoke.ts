import assert from 'node:assert/strict';
import type {
  DurableRunClaim,
  DurableRunCreateRequest,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunRecord,
  DurableRunTransition,
} from '../src/domain/durable-run.js';
import type {
  DurableRunClock,
  DurableRunDelivery,
  DurableRunRepository,
  DurableRunWorkload,
} from '../src/ports/durable-run.js';
import { DurableRunWorker } from '../src/durable-run/worker.js';

interface SmokeInput {
  label: string;
}

interface SmokeState {
  steps: number;
}

interface SmokeResult {
  message: string;
}

class FakeClock implements DurableRunClock {
  constructor(private value = new Date('2026-07-19T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.value);
  }
}

function createRun(kind: string, suffix: string): DurableRunRecord {
  return {
    runId: `run_${suffix}`,
    workloadKind: kind,
    idempotencyKey: `idem_${suffix}`,
    status: 'running',
    inputVersion: 1,
    input: { label: suffix },
    stateVersion: 1,
    state: { steps: 0 },
    route: { chatId: `chat_${suffix}` },
    actorOpenId: 'ou_worker',
    nextRunAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    maxAttempts: 3,
    attemptCount: 1,
    rowVersion: 2,
  };
}

function createClaim(kind: string, suffix: string): DurableRunClaim {
  const run = createRun(kind, suffix);
  return {
    run,
    workerId: 'durable-run-worker',
    claimedRowVersion: run.rowVersion,
    attempt: {
      attemptId: `attempt_${suffix}`,
      runId: run.runId,
      ordinal: 1,
      workerId: 'durable-run-worker',
      claimedAt: '2026-07-19T00:00:00.000Z',
      heartbeatAt: '2026-07-19T00:00:00.000Z',
      leaseExpiresAt: '2026-07-19T00:00:30.000Z',
    },
  };
}

function createDeliveryClaim(kind: string, suffix: string): DurableRunDeliveryClaim {
  return {
    outboxId: `outbox_${suffix}`,
    runId: `run_${suffix}`,
    workloadKind: kind,
    kind: 'terminal',
    workerId: 'durable-run-worker-delivery',
    route: { chatId: `chat_${suffix}` },
    idempotencyKey: `delivery_${suffix}`,
    payload: { message: suffix },
    attemptCount: 1,
  };
}

interface RepositoryHarness {
  repository: DurableRunRepository;
  claims: DurableRunClaim[];
  records: Map<string, DurableRunRecord>;
  transitions: Array<{ claim: DurableRunClaim; transition: DurableRunTransition }>;
  executionStarts: string[];
  heartbeats: string[];
  claimKindRequests: string[][];
  deliveryKindRequests: string[][];
  deliveryClaim: DurableRunDeliveryClaim | null;
  deliveryResults: DurableRunDeliveryResult[];
  interrupted: DurableRunInterruptedAttempt[];
  heartbeatAllowed: boolean;
  failedAttempts: string[];
  failures: DurableRunFailure[];
  commitError?: Error;
}

function createRepositoryHarness(initialClaims: DurableRunClaim[] = []): RepositoryHarness {
  const records = new Map(initialClaims.map((claim) => [claim.run.runId, claim.run]));
  const harness = {
    claims: [...initialClaims],
    records,
    transitions: [],
    executionStarts: [],
    heartbeats: [],
    claimKindRequests: [],
    deliveryKindRequests: [],
    deliveryClaim: null,
    deliveryResults: [],
    interrupted: [],
    heartbeatAllowed: true,
    failedAttempts: [],
    failures: [],
  } as RepositoryHarness;
  harness.repository = {
    async initialize() {},
    async create(_request: DurableRunCreateRequest) { throw new Error('not used'); },
    async get(runId) { return harness.records.get(runId) ?? null; },
    async claimDue(workloadKinds) {
      harness.claimKindRequests.push([...workloadKinds]);
      const index = harness.claims.findIndex((claim) => workloadKinds.includes(claim.run.workloadKind));
      if (index < 0) return null;
      return harness.claims.splice(index, 1)[0];
    },
    async markExecutionStarted(claim) {
      harness.executionStarts.push(claim.run.runId);
    },
    async heartbeat(claim) {
      harness.heartbeats.push(claim.run.runId);
      return harness.heartbeatAllowed;
    },
    async commitTransition(claim, transition) {
      if (harness.commitError) throw harness.commitError;
      harness.transitions.push({ claim, transition });
      harness.records.set(claim.run.runId, {
        ...claim.run,
        status: transition.status,
        stateVersion: transition.stateVersion,
        state: transition.state,
        rowVersion: claim.run.rowVersion + 1,
      });
    },
    async failAttempt(claim, failure) {
      harness.failedAttempts.push(claim.run.runId);
      harness.failures.push(failure);
    },
    async recoverExpiredLeases() {
      const interrupted = harness.interrupted;
      harness.interrupted = [];
      return interrupted;
    },
    async claimDelivery(workloadKinds) {
      harness.deliveryKindRequests.push([...workloadKinds]);
      const claim = harness.deliveryClaim;
      if (!claim || !workloadKinds.includes(claim.workloadKind)) return null;
      harness.deliveryClaim = null;
      return claim;
    },
    async commitDelivery(_claim, result) {
      harness.deliveryResults.push(result);
    },
    close() {},
  };
  return harness;
}

interface WorkloadHarness {
  workload: DurableRunWorkload<SmokeInput, SmokeState, SmokeResult>;
  parseInputCalls: number;
  parseStateCalls: number;
  preflightCalls: string[];
  executeCalls: string[];
  recoverCalls: string[];
  releases: Array<() => void>;
}

function createWorkloadHarness(
  kind: string,
  options: { hold?: boolean; preflightTransition?: DurableRunTransition } = {},
): WorkloadHarness {
  const harness = {
    parseInputCalls: 0,
    parseStateCalls: 0,
    preflightCalls: [],
    executeCalls: [],
    recoverCalls: [],
    releases: [],
  } as WorkloadHarness;
  harness.workload = {
    kind,
    parseInput(value, version) {
      assert.equal(version, 1);
      harness.parseInputCalls += 1;
      assert.equal(typeof value, 'object');
      return value as SmokeInput;
    },
    parseState(value, version) {
      assert.equal(version, 1);
      harness.parseStateCalls += 1;
      assert.equal(typeof value, 'object');
      return value as SmokeState;
    },
    async preflight(context) {
      harness.preflightCalls.push(context.runId);
      return options.preflightTransition
        ? { action: 'transition', transition: options.preflightTransition }
        : { action: 'execute' };
    },
    async execute(claim, signal) {
      harness.executeCalls.push(claim.run.runId);
      if (options.hold) {
        await new Promise<void>((resolve, reject) => {
          harness.releases.push(resolve);
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { message: claim.run.input.label };
    },
    reduce(claim, result) {
      return {
        status: 'completed',
        stateVersion: 1,
        state: { steps: claim.run.state.steps + 1 },
        deliveries: [{
          kind: 'terminal',
          idempotencyKey: `terminal:${claim.run.runId}`,
          route: claim.run.route,
          payload: { message: result.message },
        }],
      };
    },
    recoverInterruptedAttempt(interrupted) {
      harness.recoverCalls.push(interrupted.claim.run.runId);
      return {
        status: interrupted.executionPhase === 'execution_started' ? 'blocked' : 'waiting_retry',
        stateVersion: interrupted.claim.run.stateVersion,
        state: interrupted.claim.run.state,
        ...(interrupted.executionPhase === 'execution_started'
          ? {
              errorCode: 'unknown_execution_outcome',
              errorSummary: 'Execution was interrupted after side effects may have started.',
            }
          : { nextRunAt: interrupted.recoveredAt }),
      };
    },
  };
  return harness;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const clock = new FakeClock();

// Typed materialization and preflight happen before execution; terminal state and outbox commit together.
const normalClaim = createClaim('async_task', 'normal');
const normalRepository = createRepositoryHarness([normalClaim]);
const normalWorkload = createWorkloadHarness('async_task');
normalRepository.deliveryClaim = createDeliveryClaim('async_task', 'normal');
const delivered: string[] = [];
const delivery: DurableRunDelivery = {
  async deliver(claim) {
    delivered.push(claim.outboxId);
    return { status: 'sent', messageId: 'om_normal' };
  },
};
const normalWorker = new DurableRunWorker({
  repository: normalRepository.repository,
  workloads: [normalWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await normalWorker.tick();
await waitFor(
  () => normalRepository.transitions.length === 1 && normalRepository.deliveryResults.length === 1,
  'normal transition and delivery',
);
assert.deepEqual(normalRepository.executionStarts, [normalClaim.run.runId]);
assert.equal(normalWorkload.parseInputCalls > 0, true);
assert.equal(normalWorkload.parseStateCalls > 0, true);
assert.deepEqual(normalWorkload.preflightCalls, [normalClaim.run.runId]);
assert.deepEqual(normalWorkload.executeCalls, [normalClaim.run.runId]);
assert.equal(normalRepository.transitions[0].transition.status, 'completed');
assert.equal(normalRepository.transitions[0].transition.deliveries?.length, 1);
assert.deepEqual(delivered, ['outbox_normal']);
assert.deepEqual(normalRepository.deliveryResults, [{ status: 'sent', messageId: 'om_normal' }]);
await normalWorker.stop();

// Preflight can commit without starting execution.
const preflightClaim = createClaim('async_task', 'preflight');
const preflightRepository = createRepositoryHarness([preflightClaim]);
const preflightWorkload = createWorkloadHarness('async_task', {
  preflightTransition: {
    status: 'failed',
    stateVersion: 1,
    state: { steps: 0 },
    errorCode: 'invalid_input',
    errorSummary: 'Input cannot be executed.',
  },
});
const preflightWorker = new DurableRunWorker({
  repository: preflightRepository.repository,
  workloads: [preflightWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await preflightWorker.tick();
await waitFor(() => preflightRepository.transitions.length === 1, 'preflight transition');
assert.deepEqual(preflightRepository.executionStarts, []);
assert.deepEqual(preflightWorkload.executeCalls, []);
await preflightWorker.stop();

// Structured interrupted attempts are reduced by their workload and never blindly replayed.
const recoveredClaim = createClaim('async_task', 'recovered');
const recoveryRepository = createRepositoryHarness();
recoveryRepository.interrupted.push({
  claim: recoveredClaim,
  recoveredAt: '2026-07-19T00:00:00.000Z',
  executionPhase: 'execution_started',
  operationRisk: 'external_side_effect',
});
const recoveryWorkload = createWorkloadHarness('async_task');
const recoveryWorker = new DurableRunWorker({
  repository: recoveryRepository.repository,
  workloads: [recoveryWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await recoveryWorker.tick();
assert.deepEqual(recoveryWorkload.recoverCalls, [recoveredClaim.run.runId]);
assert.equal(recoveryRepository.transitions[0].transition.status, 'blocked');
assert.deepEqual(recoveryWorkload.executeCalls, []);
await recoveryWorker.stop();

// An unknown transition commit outcome is left to lease recovery, never converted into a replayable failure.
const commitUnknownClaim = createClaim('async_task', 'commit-unknown');
const commitUnknownRepository = createRepositoryHarness([commitUnknownClaim]);
commitUnknownRepository.commitError = new Error('commit acknowledgement lost');
const commitUnknownWorkload = createWorkloadHarness('async_task');
const commitUnknownWorker = new DurableRunWorker({
  repository: commitUnknownRepository.repository,
  workloads: [commitUnknownWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await commitUnknownWorker.tick();
await waitFor(() => commitUnknownWorker.activeCount === 0, 'unknown commit outcome');
assert.deepEqual(commitUnknownRepository.failedAttempts, []);
await commitUnknownWorker.stop();

const failureClaim = createClaim('async_task', 'bounded-failure');
const failureRepository = createRepositoryHarness([failureClaim]);
const failureWorkload = createWorkloadHarness('async_task');
failureWorkload.workload.execute = async () => { throw new Error(''); };
const failureWorker = new DurableRunWorker({
  repository: failureRepository.repository,
  workloads: [failureWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await failureWorker.tick();
await waitFor(() => failureRepository.failures.length === 1, 'bounded execution failure');
assert.equal(failureRepository.failures[0].diagnostic.length > 0, true);
assert.equal(failureRepository.failures[0].fingerprint.length <= 128, true);
await failureWorker.stop();

// Workload quotas are independent: a saturated async_task quota does not block cron.
const quotaRepository = createRepositoryHarness([
  createClaim('async_task', 'async-a'),
  createClaim('async_task', 'async-b'),
  createClaim('cron', 'cron-a'),
  createClaim('cron', 'cron-b'),
]);
const asyncWorkload = createWorkloadHarness('async_task', { hold: true });
const cronWorkload = createWorkloadHarness('cron', { hold: true });
const quotaWorker = new DurableRunWorker({
  repository: quotaRepository.repository,
  workloads: [asyncWorkload.workload, cronWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1, cron: 2 },
  heartbeatIntervalMs: 10,
  leaseDurationMs: 100,
});
await quotaWorker.tick();
await waitFor(() => quotaWorker.activeCount === 3, 'independent workload capacity');
assert.equal(asyncWorkload.executeCalls.length, 1);
assert.equal(cronWorkload.executeCalls.length, 2);
assert.equal(quotaRepository.claims.some((claim) => claim.run.runId === 'run_async-b'), true);
await waitFor(() => quotaRepository.heartbeats.length >= 3, 'active heartbeats');
asyncWorkload.releases.shift()?.();
await waitFor(() => asyncWorkload.executeCalls.length === 2, 'async quota refill');
asyncWorkload.releases.splice(0).forEach((release) => release());
cronWorkload.releases.splice(0).forEach((release) => release());
await waitFor(() => quotaRepository.transitions.length === 4, 'quota executions complete');
await quotaWorker.stop();

// Lease loss aborts an active execution without committing or failing the attempt.
const leaseRepository = createRepositoryHarness([createClaim('async_task', 'lease-loss')]);
const leaseWorkload = createWorkloadHarness('async_task', { hold: true });
const leaseWorker = new DurableRunWorker({
  repository: leaseRepository.repository,
  workloads: [leaseWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
  heartbeatIntervalMs: 5,
  leaseDurationMs: 30,
});
await leaseWorker.tick();
leaseRepository.heartbeatAllowed = false;
await waitFor(() => leaseWorker.activeCount === 0, 'lease loss abort');
assert.equal(leaseRepository.transitions.length, 0);
await leaseWorker.stop();

// Stop aborts children, waits for them, and prevents further claims.
const stopRepository = createRepositoryHarness([
  createClaim('async_task', 'stop-active'),
  createClaim('async_task', 'stop-pending'),
]);
const stopWorkload = createWorkloadHarness('async_task', { hold: true });
const stopWorker = new DurableRunWorker({
  repository: stopRepository.repository,
  workloads: [stopWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await stopWorker.tick();
await waitFor(() => stopWorker.activeCount === 1, 'active shutdown execution');
const claimCallsBeforeStop = stopRepository.claimKindRequests.length;
await stopWorker.stop();
assert.equal(stopRepository.transitions.length, 0);
await stopWorker.tick();
assert.equal(stopRepository.claimKindRequests.length, claimCallsBeforeStop);

// A claim that returns after shutdown begins is not started and remains recoverable by lease expiry.
const claimRaceRepository = createRepositoryHarness([createClaim('async_task', 'claim-race')]);
const originalClaimDue = claimRaceRepository.repository.claimDue.bind(claimRaceRepository.repository);
let releaseDelayedClaim: (() => void) | undefined;
let delayedClaimEntered = false;
claimRaceRepository.repository.claimDue = async (...args) => {
  delayedClaimEntered = true;
  await new Promise<void>((resolve) => { releaseDelayedClaim = resolve; });
  return originalClaimDue(...args);
};
const claimRaceWorkload = createWorkloadHarness('async_task');
const claimRaceWorker = new DurableRunWorker({
  repository: claimRaceRepository.repository,
  workloads: [claimRaceWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
const racingTick = claimRaceWorker.tick();
await waitFor(() => delayedClaimEntered, 'delayed claim entry');
const racingStop = claimRaceWorker.stop();
releaseDelayedClaim?.();
await Promise.all([racingTick, racingStop]);
assert.deepEqual(claimRaceWorkload.executeCalls, []);
assert.equal(claimRaceRepository.transitions.length, 0);

const deliveryRaceRepository = createRepositoryHarness();
deliveryRaceRepository.deliveryClaim = createDeliveryClaim('async_task', 'delivery-race');
const originalClaimDelivery = deliveryRaceRepository.repository.claimDelivery.bind(
  deliveryRaceRepository.repository,
);
let releaseDelayedDelivery: (() => void) | undefined;
let delayedDeliveryEntered = false;
deliveryRaceRepository.repository.claimDelivery = async (...args) => {
  delayedDeliveryEntered = true;
  await new Promise<void>((resolve) => { releaseDelayedDelivery = resolve; });
  return originalClaimDelivery(...args);
};
const deliveryRaceCalls: string[] = [];
const deliveryRaceWorker = new DurableRunWorker({
  repository: deliveryRaceRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    async deliver(claim) {
      deliveryRaceCalls.push(claim.outboxId);
      return { status: 'sent', messageId: 'om_delivery_race' };
    },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
const deliveryRacingTick = deliveryRaceWorker.tick();
await waitFor(() => delayedDeliveryEntered, 'delayed delivery claim entry');
const deliveryRacingStop = deliveryRaceWorker.stop();
releaseDelayedDelivery?.();
await Promise.all([deliveryRacingTick, deliveryRacingStop]);
assert.deepEqual(deliveryRaceCalls, []);
assert.deepEqual(deliveryRaceRepository.deliveryResults, []);

console.log('durable run worker smoke: PASS');
