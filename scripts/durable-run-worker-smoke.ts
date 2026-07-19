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

  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}

class SystemClock implements DurableRunClock {
  now(): Date {
    return new Date();
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

function createShortLeaseClaim(kind: string, suffix: string, leaseMs: number): DurableRunClaim {
  const claim = createClaim(kind, suffix);
  const now = Date.now();
  claim.run.nextRunAt = new Date(now).toISOString();
  claim.run.expiresAt = new Date(now + 5_000).toISOString();
  claim.attempt.claimedAt = new Date(now).toISOString();
  claim.attempt.heartbeatAt = new Date(now).toISOString();
  claim.attempt.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  return claim;
}

function createDeliveryClaim(kind: string, suffix: string): DurableRunDeliveryClaim {
  const now = new Date();
  return {
    outboxId: `outbox_${suffix}`,
    runId: `run_${suffix}`,
    workloadKind: kind,
    eventKey: `event_${suffix}`,
    kind: 'terminal',
    workerId: 'durable-run-worker-delivery',
    route: { chatId: `chat_${suffix}` },
    idempotencyKey: `delivery_${suffix}`,
    payload: { message: suffix },
    attemptCount: 1,
    leaseExpiresAt: new Date(now.getTime() + 35).toISOString(),
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
  deliveryHeartbeats: DurableRunDeliveryClaim[];
  deliveryClaim: DurableRunDeliveryClaim | null;
  deliveryResults: DurableRunDeliveryResult[];
  interrupted: DurableRunInterruptedAttempt[];
  heartbeatAllowed: boolean;
  failedAttempts: string[];
  failures: DurableRunFailure[];
  releasedClaims: string[];
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
    deliveryHeartbeats: [],
    deliveryClaim: null,
    deliveryResults: [],
    interrupted: [],
    heartbeatAllowed: true,
    failedAttempts: [],
    failures: [],
    releasedClaims: [],
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
      return 'committed';
    },
    async releaseClaimBeforeExecution(claim) {
      harness.releasedClaims.push(claim.run.runId);
      return 'committed';
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
      return 'committed';
    },
    async failAttempt(claim, failure) {
      harness.failedAttempts.push(claim.run.runId);
      harness.failures.push(failure);
      return 'committed';
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
    async heartbeatDelivery(claim, _now, leaseExpiresAt) {
      const renewed = { ...claim, leaseExpiresAt };
      harness.deliveryHeartbeats.push(renewed);
      return renewed;
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
  signals: AbortSignal[];
  releases: Array<() => void>;
}

function createWorkloadHarness(
  kind: string,
  options: {
    hold?: boolean;
    holdPreflight?: boolean;
    preflightTransition?: DurableRunTransition;
    expiredTransition?: DurableRunTransition;
    unclaimableFailure?: {
      errorCode: string;
      errorSummary: string;
      deliveries?: DurableRunTransition['deliveries'];
    };
  } = {},
): WorkloadHarness {
  const harness = {
    parseInputCalls: 0,
    parseStateCalls: 0,
    preflightCalls: [],
    executeCalls: [],
    recoverCalls: [],
    signals: [],
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
      if (options.holdPreflight) {
        await new Promise<void>((resolve) => {
          harness.releases.push(resolve);
        });
      }
      return options.preflightTransition
        ? { action: 'transition', transition: options.preflightTransition }
        : { action: 'execute' };
    },
    async execute(claim, signal) {
      harness.executeCalls.push(claim.run.runId);
      harness.signals.push(signal);
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
    ...(options.expiredTransition
      ? { terminalizeExpiredAttempt: () => options.expiredTransition! }
      : {}),
    ...(options.unclaimableFailure
      ? { terminalizeUnclaimable: () => options.unclaimableFailure! }
      : {}),
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

// An active workload that reaches max age commits the workload-owned terminal
// transition, including its delivery, instead of a generic silent failure.
const activeExpiryClaim = createShortLeaseClaim('cron_prompt', 'active-expiry', 500);
activeExpiryClaim.run.expiresAt = new Date(Date.now() + 80).toISOString();
const activeExpiryRepository = createRepositoryHarness([activeExpiryClaim]);
const activeExpiryWorkload = createWorkloadHarness('cron_prompt', {
  hold: true,
  expiredTransition: {
    status: 'blocked',
    stateVersion: 1,
    state: { steps: 0 },
    errorCode: 'cron_execution_outcome_unknown',
    errorSummary: 'The Cron execution outcome is unknown.',
    deliveries: [{
      kind: 'cron_terminal',
      idempotencyKey: 'cron:active-expiry:terminal',
      route: activeExpiryClaim.run.route,
      payload: { message: 'The Cron execution outcome is unknown.' },
    }],
  },
});
const activeExpiryWorker = new DurableRunWorker({
  repository: activeExpiryRepository.repository,
  workloads: [activeExpiryWorkload.workload],
  delivery,
  clock: new SystemClock(),
  maxConcurrencyByWorkload: { cron_prompt: 1 },
  heartbeatIntervalMs: 20,
  leaseDurationMs: 500,
});
await activeExpiryWorker.tick();
await waitFor(() => activeExpiryRepository.transitions.length === 1, 'active expiry transition');
assert.equal(activeExpiryWorkload.signals[0]?.aborted, true);
assert.equal(activeExpiryRepository.transitions[0].transition.status, 'blocked');
assert.equal(activeExpiryRepository.transitions[0].transition.deliveries?.length, 1);
await activeExpiryWorker.stop();

// Expiry before the execution-start commit is a known no-side-effect failure,
// not an ambiguous execution outcome.
const preExecutionExpiryClaim = createClaim('cron_prompt', 'pre-execution-expiry');
preExecutionExpiryClaim.run.expiresAt = clock.now().toISOString();
const preExecutionExpiryRepository = createRepositoryHarness([preExecutionExpiryClaim]);
const preExecutionExpiryWorkload = createWorkloadHarness('cron_prompt', {
  expiredTransition: {
    status: 'blocked',
    stateVersion: 1,
    state: { steps: 0 },
    errorCode: 'must_not_be_used',
    errorSummary: 'Execution did not start.',
  },
  unclaimableFailure: {
    errorCode: 'cron_run_expired',
    errorSummary: 'The Cron run expired before execution started.',
    deliveries: [{
      kind: 'cron_terminal',
      idempotencyKey: 'cron:pre-execution-expiry:terminal',
      route: preExecutionExpiryClaim.run.route,
      payload: { message: 'The Cron run expired before execution started.' },
    }],
  },
});
const preExecutionExpiryWorker = new DurableRunWorker({
  repository: preExecutionExpiryRepository.repository,
  workloads: [preExecutionExpiryWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { cron_prompt: 1 },
});
await preExecutionExpiryWorker.tick();
await waitFor(
  () => preExecutionExpiryRepository.transitions.length === 1,
  'pre-execution expiry transition',
);
assert.deepEqual(preExecutionExpiryRepository.executionStarts, []);
assert.equal(preExecutionExpiryRepository.transitions[0].transition.status, 'failed');
assert.equal(preExecutionExpiryRepository.transitions[0].transition.errorCode, 'cron_run_expired');
assert.equal(preExecutionExpiryRepository.transitions[0].transition.deliveries?.length, 1);
await preExecutionExpiryWorker.stop();

// An unexpected adapter failure after the kernel-owned send boundary is
// ambiguous and must not be replayed.
const thrownDeliveryRepository = createRepositoryHarness();
thrownDeliveryRepository.deliveryClaim = createDeliveryClaim('async_task', 'thrown-delivery');
const thrownDeliveryWorker = new DurableRunWorker({
  repository: thrownDeliveryRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: { async deliver() { throw new Error('malformed delivery adapter state'); } },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await thrownDeliveryWorker.tick();
await waitFor(() => thrownDeliveryRepository.deliveryResults.length === 1, 'thrown delivery result');
assert.deepEqual(thrownDeliveryRepository.deliveryResults[0], {
  status: 'unknown',
  errorCode: 'durable_run_delivery_outcome_unknown',
  errorSummary: 'malformed delivery adapter state',
});
await thrownDeliveryWorker.stop();

// A managed adapter that fails before marking the external-send boundary is
// safe to retry with bounded backoff.
const preBoundaryFailureRepository = createRepositoryHarness();
preBoundaryFailureRepository.deliveryClaim = createDeliveryClaim(
  'async_task',
  'pre-boundary-failure',
);
const preBoundaryFailureWorker = new DurableRunWorker({
  repository: preBoundaryFailureRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    managesExternalSendBoundary: true,
    async deliver() { throw new Error('projection unavailable'); },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await preBoundaryFailureWorker.tick();
await waitFor(
  () => preBoundaryFailureRepository.deliveryResults.length === 1,
  'pre-boundary delivery failure',
);
assert.deepEqual(preBoundaryFailureRepository.deliveryResults[0], {
  status: 'retry',
  errorCode: 'durable_run_delivery_failed',
  errorSummary: 'projection unavailable',
  retryAt: '2026-07-19T00:00:30.000Z',
});
await preBoundaryFailureWorker.stop();

// Adapters that own the external-send boundary must invoke the worker context
// before reporting a potentially sent outcome.
const missingBoundaryRepository = createRepositoryHarness();
missingBoundaryRepository.deliveryClaim = createDeliveryClaim('async_task', 'missing-boundary');
const missingBoundaryWorker = new DurableRunWorker({
  repository: missingBoundaryRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    managesExternalSendBoundary: true,
    async deliver() { return { status: 'sent', messageId: 'om_unfenced' }; },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await missingBoundaryWorker.tick();
await waitFor(
  () => missingBoundaryRepository.deliveryResults.length === 1,
  'missing delivery boundary result',
);
assert.deepEqual(missingBoundaryRepository.deliveryResults[0], {
  status: 'failed',
  errorCode: 'durable_run_delivery_boundary_missing',
  errorSummary: 'The delivery adapter did not persist its external send boundary.',
});
await missingBoundaryWorker.stop();

// The kernel owns interrupted-send safety. It never invokes ordinary deliver,
// and it rejects a recovery adapter that tries to classify the row as sent.
const interruptedDeliveryRepository = createRepositoryHarness();
interruptedDeliveryRepository.deliveryClaim = {
  ...createDeliveryClaim('async_task', 'interrupted-delivery'),
  recoveredFromExpiredLease: true,
};
let ordinaryDeliveryCalls = 0;
let interruptedRecoveryCalls = 0;
const interruptedDeliveryWorker = new DurableRunWorker({
  repository: interruptedDeliveryRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    async deliver() {
      ordinaryDeliveryCalls += 1;
      return { status: 'sent', messageId: 'must_not_send' };
    },
    async recoverInterruptedDelivery() {
      interruptedRecoveryCalls += 1;
      return { status: 'sent', messageId: 'must_not_confirm' };
    },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await interruptedDeliveryWorker.tick();
await waitFor(
  () => interruptedDeliveryRepository.deliveryResults.length === 1,
  'interrupted delivery terminalization',
);
assert.equal(ordinaryDeliveryCalls, 0);
assert.equal(interruptedRecoveryCalls, 1);
assert.equal(interruptedDeliveryRepository.deliveryResults[0].status, 'unknown');
await interruptedDeliveryWorker.stop();

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

// A delayed preflight transition cannot commit after its confirmed lease expires.
const expiredPreflightClaim = createShortLeaseClaim('async_task', 'preflight-expired', 60);
const expiredPreflightRepository = createRepositoryHarness([expiredPreflightClaim]);
const expiredPreflightWorkload = createWorkloadHarness('async_task', {
  holdPreflight: true,
  preflightTransition: {
    status: 'completed',
    stateVersion: 1,
    state: { steps: 1 },
    deliveries: [{
      kind: 'terminal',
      idempotencyKey: `terminal:${expiredPreflightClaim.run.runId}`,
      route: expiredPreflightClaim.run.route,
      payload: { message: 'must not commit after lease loss' },
    }],
  },
});
const expiredPreflightWorker = new DurableRunWorker({
  repository: expiredPreflightRepository.repository,
  workloads: [expiredPreflightWorkload.workload],
  delivery,
  clock: new SystemClock(),
  maxConcurrencyByWorkload: { async_task: 1 },
  heartbeatIntervalMs: 1_000,
  leaseDurationMs: 1_000,
});
await expiredPreflightWorker.tick();
await waitFor(() => expiredPreflightWorkload.preflightCalls.length === 1, 'delayed preflight entry');
await new Promise((resolve) => setTimeout(resolve, 80));
expiredPreflightWorkload.releases.shift()?.();
await waitFor(() => expiredPreflightWorker.activeCount === 0, 'expired delayed preflight completion');
assert.deepEqual(expiredPreflightRepository.transitions, []);
assert.deepEqual(expiredPreflightRepository.failedAttempts, []);
assert.deepEqual(expiredPreflightRepository.deliveryResults, []);
await expiredPreflightWorker.stop();

// A delayed preflight transition cannot commit after stop aborts its claim.
const stoppedPreflightClaim = createClaim('async_task', 'preflight-stopped');
const stoppedPreflightRepository = createRepositoryHarness([stoppedPreflightClaim]);
const stoppedPreflightWorkload = createWorkloadHarness('async_task', {
  holdPreflight: true,
  preflightTransition: {
    status: 'completed',
    stateVersion: 1,
    state: { steps: 1 },
    deliveries: [{
      kind: 'terminal',
      idempotencyKey: `terminal:${stoppedPreflightClaim.run.runId}`,
      route: stoppedPreflightClaim.run.route,
      payload: { message: 'must not commit after shutdown' },
    }],
  },
});
const stoppedPreflightWorker = new DurableRunWorker({
  repository: stoppedPreflightRepository.repository,
  workloads: [stoppedPreflightWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await stoppedPreflightWorker.tick();
await waitFor(() => stoppedPreflightWorkload.preflightCalls.length === 1, 'stoppable preflight entry');
const stoppingPreflight = stoppedPreflightWorker.stop();
stoppedPreflightWorkload.releases.shift()?.();
await stoppingPreflight;
assert.deepEqual(stoppedPreflightRepository.transitions, []);
assert.deepEqual(stoppedPreflightRepository.failedAttempts, []);
assert.deepEqual(stoppedPreflightRepository.deliveryResults, []);

// A stale execution-start CAS is lease loss: execution and every later mutation stay untouched.
const staleMarkClaim = createClaim('async_task', 'stale-mark');
const staleMarkRepository = createRepositoryHarness([staleMarkClaim]);
const staleMarkWorkload = createWorkloadHarness('async_task');
let staleMarkEntered = false;
let releaseStaleMark!: () => void;
const staleMarkReleased = new Promise<void>((resolve) => { releaseStaleMark = resolve; });
staleMarkRepository.repository.markExecutionStarted = async () => {
  staleMarkEntered = true;
  await staleMarkReleased;
  return 'stale' as never;
};
const staleMarkWorker = new DurableRunWorker({
  repository: staleMarkRepository.repository,
  workloads: [staleMarkWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await staleMarkWorker.tick();
await waitFor(() => staleMarkEntered, 'stale execution-start CAS');
releaseStaleMark();
await waitFor(() => staleMarkWorker.activeCount === 0, 'stale execution-start completion');
assert.deepEqual(staleMarkWorkload.executeCalls, []);
assert.deepEqual(staleMarkRepository.transitions, []);
assert.deepEqual(staleMarkRepository.failedAttempts, []);
assert.deepEqual(staleMarkRepository.deliveryResults, []);
await staleMarkWorker.stop();

// A stale transition CAS never creates state or outbox, and is observed as lease loss.
const staleCommitClaim = createClaim('async_task', 'stale-commit');
const staleCommitRepository = createRepositoryHarness([staleCommitClaim]);
const staleCommitWorkload = createWorkloadHarness('async_task');
let staleCommitEntered = false;
let releaseStaleCommit!: () => void;
const staleCommitReleased = new Promise<void>((resolve) => { releaseStaleCommit = resolve; });
staleCommitRepository.repository.commitTransition = async () => {
  staleCommitEntered = true;
  await staleCommitReleased;
  return 'stale' as never;
};
const staleCommitWorker = new DurableRunWorker({
  repository: staleCommitRepository.repository,
  workloads: [staleCommitWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await staleCommitWorker.tick();
await waitFor(() => staleCommitEntered, 'stale transition CAS');
releaseStaleCommit();
await waitFor(() => staleCommitWorker.activeCount === 0, 'stale transition completion');
assert.equal(staleCommitWorkload.signals[0]?.aborted, true);
assert.deepEqual(staleCommitRepository.transitions, []);
assert.deepEqual(staleCommitRepository.failedAttempts, []);
assert.deepEqual(staleCommitRepository.deliveryResults, []);
await staleCommitWorker.stop();

// A stale failure CAS is not itself an execution failure and cannot create state or outbox.
const staleFailureClaim = createClaim('async_task', 'stale-failure');
const staleFailureRepository = createRepositoryHarness([staleFailureClaim]);
const staleFailureWorkload = createWorkloadHarness('async_task');
staleFailureWorkload.workload.execute = async (_claim, signal) => {
  staleFailureWorkload.signals.push(signal);
  throw new Error('execution failed after ownership moved');
};
let staleFailureEntered = false;
let releaseStaleFailure!: () => void;
const staleFailureReleased = new Promise<void>((resolve) => { releaseStaleFailure = resolve; });
staleFailureRepository.repository.failAttempt = async () => {
  staleFailureEntered = true;
  await staleFailureReleased;
  return 'stale' as never;
};
const staleFailureWorker = new DurableRunWorker({
  repository: staleFailureRepository.repository,
  workloads: [staleFailureWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await staleFailureWorker.tick();
await waitFor(() => staleFailureEntered, 'stale failure CAS');
releaseStaleFailure();
await waitFor(() => staleFailureWorker.activeCount === 0, 'stale failure completion');
assert.equal(staleFailureWorkload.signals[0]?.aborted, true);
assert.deepEqual(staleFailureRepository.transitions, []);
assert.deepEqual(staleFailureRepository.failedAttempts, []);
assert.deepEqual(staleFailureRepository.deliveryResults, []);
await staleFailureWorker.stop();

// stop() can interleave after the status read settles but before execution-start mutation.
const stopInterleaveClaim = createClaim('async_task', 'stop-interleave');
const stopInterleaveRepository = createRepositoryHarness([stopInterleaveClaim]);
const stopInterleaveWorkload = createWorkloadHarness('async_task');
const stopInterleaveGet = stopInterleaveRepository.repository.get.bind(
  stopInterleaveRepository.repository,
);
let stopInterleaveGetEntered = false;
let releaseStopInterleaveGet!: () => void;
const stopInterleaveGetReleased = new Promise<void>((resolve) => {
  releaseStopInterleaveGet = resolve;
});
stopInterleaveRepository.repository.get = async (runId) => {
  if (!stopInterleaveGetEntered) {
    stopInterleaveGetEntered = true;
    await stopInterleaveGetReleased;
  }
  return stopInterleaveGet(runId);
};
const stopInterleaveWorker = new DurableRunWorker({
  repository: stopInterleaveRepository.repository,
  workloads: [stopInterleaveWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await stopInterleaveWorker.tick();
await waitFor(() => stopInterleaveGetEntered, 'stop interleave status read');
let stopInterleavePromise: Promise<void> | undefined;
releaseStopInterleaveGet();
queueMicrotask(() => { stopInterleavePromise = stopInterleaveWorker.stop(); });
await waitFor(() => stopInterleavePromise !== undefined, 'interleaved stop');
await stopInterleavePromise;
assert.deepEqual(stopInterleaveRepository.executionStarts, []);
assert.deepEqual(stopInterleaveWorkload.executeCalls, []);
assert.deepEqual(stopInterleaveRepository.transitions, []);

// The confirmed lease can expire in the same status-read/mutation microtask gap.
const deadlineInterleaveClock = new FakeClock();
const deadlineInterleaveClaim = createClaim('async_task', 'deadline-interleave');
const deadlineInterleaveRepository = createRepositoryHarness([deadlineInterleaveClaim]);
const deadlineInterleaveWorkload = createWorkloadHarness('async_task', {
  preflightTransition: {
    status: 'completed',
    stateVersion: 1,
    state: { steps: 1 },
    deliveries: [{
      kind: 'terminal',
      idempotencyKey: `terminal:${deadlineInterleaveClaim.run.runId}`,
      route: deadlineInterleaveClaim.run.route,
      payload: { message: 'must not commit across the deadline gap' },
    }],
  },
});
const deadlineInterleaveGet = deadlineInterleaveRepository.repository.get.bind(
  deadlineInterleaveRepository.repository,
);
let deadlineInterleaveGetEntered = false;
let releaseDeadlineInterleaveGet!: () => void;
const deadlineInterleaveGetReleased = new Promise<void>((resolve) => {
  releaseDeadlineInterleaveGet = resolve;
});
deadlineInterleaveRepository.repository.get = async (runId) => {
  if (!deadlineInterleaveGetEntered) {
    deadlineInterleaveGetEntered = true;
    await deadlineInterleaveGetReleased;
  }
  return deadlineInterleaveGet(runId);
};
const deadlineInterleaveWorker = new DurableRunWorker({
  repository: deadlineInterleaveRepository.repository,
  workloads: [deadlineInterleaveWorkload.workload],
  delivery,
  clock: deadlineInterleaveClock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await deadlineInterleaveWorker.tick();
await waitFor(() => deadlineInterleaveGetEntered, 'deadline interleave status read');
releaseDeadlineInterleaveGet();
queueMicrotask(() => { deadlineInterleaveClock.advance(30_001); });
await waitFor(() => deadlineInterleaveWorker.activeCount === 0, 'deadline interleave completion');
assert.deepEqual(deadlineInterleaveRepository.transitions, []);
assert.deepEqual(deadlineInterleaveRepository.failedAttempts, []);
assert.deepEqual(deadlineInterleaveRepository.deliveryResults, []);
await deadlineInterleaveWorker.stop();

// Max-age is rechecked after the status read, so delayed timers cannot allow a
// normal completion to commit after the Run expires.
const maxAgeInterleaveClock = new FakeClock();
const maxAgeInterleaveClaim = createClaim('async_task', 'max-age-interleave');
maxAgeInterleaveClaim.run.expiresAt = '2026-07-19T00:00:00.010Z';
const maxAgeInterleaveRepository = createRepositoryHarness([maxAgeInterleaveClaim]);
const maxAgeInterleaveWorkload = createWorkloadHarness('async_task', {
  preflightTransition: {
    status: 'completed',
    stateVersion: 1,
    state: { steps: 1 },
  },
  unclaimableFailure: {
    errorCode: 'run_expired',
    errorSummary: 'The Run expired before completion.',
  },
});
const maxAgeInterleaveGet = maxAgeInterleaveRepository.repository.get.bind(
  maxAgeInterleaveRepository.repository,
);
let maxAgeGetEntered = false;
let releaseMaxAgeGet!: () => void;
const maxAgeGetReleased = new Promise<void>((resolve) => { releaseMaxAgeGet = resolve; });
maxAgeInterleaveRepository.repository.get = async (runId) => {
  if (!maxAgeGetEntered) {
    maxAgeGetEntered = true;
    await maxAgeGetReleased;
  }
  return maxAgeInterleaveGet(runId);
};
const maxAgeInterleaveWorker = new DurableRunWorker({
  repository: maxAgeInterleaveRepository.repository,
  workloads: [maxAgeInterleaveWorkload.workload],
  delivery,
  clock: maxAgeInterleaveClock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await maxAgeInterleaveWorker.tick();
await waitFor(() => maxAgeGetEntered, 'max-age interleave status read');
maxAgeInterleaveClock.advance(11);
releaseMaxAgeGet();
await waitFor(() => maxAgeInterleaveRepository.transitions.length === 1, 'max-age terminal transition');
assert.equal(maxAgeInterleaveRepository.transitions[0].transition.status, 'failed');
assert.equal(maxAgeInterleaveRepository.transitions[0].transition.errorCode, 'run_expired');
await maxAgeInterleaveWorker.stop();

// A rejection observed after the confirmed deadline cannot be persisted as an attempt failure.
const deadlineFailureClock = new FakeClock();
const deadlineFailureClaim = createClaim('async_task', 'deadline-failure');
const deadlineFailureRepository = createRepositoryHarness([deadlineFailureClaim]);
const deadlineFailureWorkload = createWorkloadHarness('async_task');
deadlineFailureWorkload.workload.execute = async (_claim, signal) => {
  deadlineFailureWorkload.signals.push(signal);
  throw new Error('execution failed at the lease boundary');
};
const deadlineFailureGet = deadlineFailureRepository.repository.get.bind(
  deadlineFailureRepository.repository,
);
let deadlineFailureGetEntered = false;
let deadlineFailureGetCalls = 0;
let releaseDeadlineFailureGet!: () => void;
const deadlineFailureGetReleased = new Promise<void>((resolve) => {
  releaseDeadlineFailureGet = resolve;
});
deadlineFailureRepository.repository.get = async (runId) => {
  deadlineFailureGetCalls += 1;
  if (deadlineFailureGetCalls === 2) {
    deadlineFailureGetEntered = true;
    await deadlineFailureGetReleased;
  }
  return deadlineFailureGet(runId);
};
const deadlineFailureWorker = new DurableRunWorker({
  repository: deadlineFailureRepository.repository,
  workloads: [deadlineFailureWorkload.workload],
  delivery,
  clock: deadlineFailureClock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await deadlineFailureWorker.tick();
await waitFor(() => deadlineFailureGetEntered, 'deadline failure status read');
deadlineFailureClock.advance(30_001);
releaseDeadlineFailureGet();
await waitFor(() => deadlineFailureWorker.activeCount === 0, 'deadline failure completion');
assert.equal(deadlineFailureWorkload.signals[0]?.aborted, true);
assert.deepEqual(deadlineFailureRepository.failedAttempts, []);
assert.deepEqual(deadlineFailureRepository.transitions, []);
assert.deepEqual(deadlineFailureRepository.deliveryResults, []);
await deadlineFailureWorker.stop();

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

// Expired pre-execution recovery terminalizes immediately, regardless of the
// remaining attempt budget, so it cannot loop forever behind a concurrency key.
for (const maxAttempts of [3, 1]) {
  const expiredClaim = createClaim('async_task', `expired-recovery-${maxAttempts}`);
  expiredClaim.run.expiresAt = '2026-07-19T00:00:00.000Z';
  expiredClaim.run.maxAttempts = maxAttempts;
  const repository = createRepositoryHarness();
  repository.interrupted.push({
    claim: expiredClaim,
    recoveredAt: '2026-07-19T00:00:00.000Z',
    executionPhase: 'claimed',
    operationRisk: 'pure',
  });
  const terminalDelivery = {
    kind: 'terminal',
    idempotencyKey: `terminal:${expiredClaim.run.runId}`,
    route: expiredClaim.run.route,
    payload: { message: 'expired before execution' },
  } as const;
  const workload = createWorkloadHarness('async_task', {
    unclaimableFailure: {
      errorCode: 'cron_run_expired',
      errorSummary: 'expired before execution',
      deliveries: [terminalDelivery],
    },
  });
  const worker = new DurableRunWorker({
    repository: repository.repository,
    workloads: [workload.workload],
    delivery,
    clock,
    maxConcurrencyByWorkload: { async_task: 1 },
  });
  await worker.tick();
  assert.deepEqual(workload.recoverCalls, []);
  assert.equal(repository.transitions[0]?.transition.status, 'failed');
  assert.equal(repository.transitions[0]?.transition.errorCode, 'cron_run_expired');
  assert.equal(repository.transitions[0]?.transition.deliveries?.length, 1);
  await worker.stop();
}

// One malformed recovered row is failed closed without starving later recoveries.
const malformedRecoveryClaim = createClaim('async_task', 'malformed-recovery');
malformedRecoveryClaim.run.stateVersion = 2;
const validRecoveryClaim = createClaim('async_task', 'valid-recovery');
const isolatedRecoveryRepository = createRepositoryHarness();
isolatedRecoveryRepository.interrupted.push(
  {
    claim: malformedRecoveryClaim,
    recoveredAt: '2026-07-19T00:00:00.000Z',
    executionPhase: 'claimed',
    operationRisk: 'unknown',
  },
  {
    claim: validRecoveryClaim,
    recoveredAt: '2026-07-19T00:00:00.000Z',
    executionPhase: 'claimed',
    operationRisk: 'unknown',
  },
);
const isolatedRecoveryWorkload = createWorkloadHarness('async_task');
const isolatedRecoveryWorker = new DurableRunWorker({
  repository: isolatedRecoveryRepository.repository,
  workloads: [isolatedRecoveryWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await isolatedRecoveryWorker.tick();
assert.deepEqual(isolatedRecoveryRepository.failedAttempts, [malformedRecoveryClaim.run.runId]);
assert.deepEqual(isolatedRecoveryWorkload.recoverCalls, [validRecoveryClaim.run.runId]);
assert.equal(isolatedRecoveryRepository.transitions[0]?.claim.run.runId, validRecoveryClaim.run.runId);
await isolatedRecoveryWorker.stop();

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

// A throwing heartbeat cannot let execution outlive the last confirmed lease deadline.
const throwingLeaseClaim = createShortLeaseClaim('async_task', 'lease-throw', 80);
const throwingLeaseRepository = createRepositoryHarness([throwingLeaseClaim]);
throwingLeaseRepository.repository.heartbeat = async (claim) => {
  throwingLeaseRepository.heartbeats.push(claim.run.runId);
  throw new Error('heartbeat unavailable');
};
const throwingLeaseWorkload = createWorkloadHarness('async_task', { hold: true });
const throwingLeaseWorker = new DurableRunWorker({
  repository: throwingLeaseRepository.repository,
  workloads: [throwingLeaseWorkload.workload],
  delivery,
  clock: new SystemClock(),
  maxConcurrencyByWorkload: { async_task: 1 },
  heartbeatIntervalMs: 5,
  leaseDurationMs: 100,
});
await throwingLeaseWorker.tick();
await waitFor(() => throwingLeaseRepository.heartbeats.length >= 1, 'throwing heartbeat');
await waitFor(() => throwingLeaseWorker.activeCount === 0, 'throwing heartbeat lease deadline');
assert.deepEqual(throwingLeaseRepository.transitions, []);
assert.deepEqual(throwingLeaseRepository.failedAttempts, []);
await throwingLeaseWorker.stop();

// Only a successful heartbeat extends the deadline; a subsequent hung heartbeat remains bounded.
const hangingLeaseClaim = createShortLeaseClaim('async_task', 'lease-hang', 80);
const initialHangingDeadline = Date.parse(hangingLeaseClaim.attempt.leaseExpiresAt);
const hangingLeaseRepository = createRepositoryHarness([hangingLeaseClaim]);
let hangingHeartbeatCalls = 0;
hangingLeaseRepository.repository.heartbeat = async (claim) => {
  hangingLeaseRepository.heartbeats.push(claim.run.runId);
  hangingHeartbeatCalls += 1;
  if (hangingHeartbeatCalls === 1) return true;
  return new Promise<boolean>(() => {});
};
const hangingLeaseWorkload = createWorkloadHarness('async_task', { hold: true });
const hangingLeaseWorker = new DurableRunWorker({
  repository: hangingLeaseRepository.repository,
  workloads: [hangingLeaseWorkload.workload],
  delivery,
  clock: new SystemClock(),
  maxConcurrencyByWorkload: { async_task: 1 },
  heartbeatIntervalMs: 10,
  leaseDurationMs: 180,
});
await hangingLeaseWorker.tick();
await waitFor(() => hangingHeartbeatCalls >= 2, 'hung heartbeat after successful renewal');
const waitPastInitialDeadline = Math.max(0, initialHangingDeadline - Date.now() + 25);
await new Promise((resolve) => setTimeout(resolve, waitPastInitialDeadline));
assert.equal(hangingLeaseWorker.activeCount, 1);
await waitFor(() => hangingLeaseWorker.activeCount === 0, 'hung heartbeat renewed lease deadline');
assert.deepEqual(hangingLeaseRepository.transitions, []);
assert.deepEqual(hangingLeaseRepository.failedAttempts, []);
await hangingLeaseWorker.stop();

// Recovery failures are isolated from the delivery pump.
const recoveryErrorRepository = createRepositoryHarness();
recoveryErrorRepository.deliveryClaim = createDeliveryClaim('async_task', 'recovery-error');
recoveryErrorRepository.repository.recoverExpiredLeases = async () => {
  throw new Error('recovery unavailable');
};
const recoveryErrorDeliveries: string[] = [];
const recoveryErrorWorker = new DurableRunWorker({
  repository: recoveryErrorRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    async deliver(claim) {
      recoveryErrorDeliveries.push(claim.outboxId);
      return { status: 'sent', messageId: 'om_recovery_error' };
    },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await assert.rejects(recoveryErrorWorker.tick(), /recovery unavailable/);
await waitFor(() => recoveryErrorRepository.deliveryResults.length === 1, 'delivery after recovery error');
assert.deepEqual(recoveryErrorDeliveries, ['outbox_recovery-error']);
await recoveryErrorWorker.stop();

// Claim failures are isolated from the delivery pump.
const claimErrorRepository = createRepositoryHarness();
claimErrorRepository.deliveryClaim = createDeliveryClaim('async_task', 'claim-error');
claimErrorRepository.repository.claimDue = async () => {
  throw new Error('claim unavailable');
};
const claimErrorDeliveries: string[] = [];
const claimErrorWorker = new DurableRunWorker({
  repository: claimErrorRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    async deliver(claim) {
      claimErrorDeliveries.push(claim.outboxId);
      return { status: 'sent', messageId: 'om_claim_error' };
    },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 1 },
});
await assert.rejects(claimErrorWorker.tick(), /claim unavailable/);
await waitFor(() => claimErrorRepository.deliveryResults.length === 1, 'delivery after claim error');
assert.deepEqual(claimErrorDeliveries, ['outbox_claim-error']);
await claimErrorWorker.stop();

// A continuously refilled short-task quota cannot make delivery wait for the backlog to drain.
const backlogClaims = Array.from(
  { length: 25 },
  (_, index) => createClaim('async_task', `backlog-${index}`),
);
const backlogRepository = createRepositoryHarness(backlogClaims);
backlogRepository.deliveryClaim = createDeliveryClaim('async_task', 'backlog');
const backlogWorkload = createWorkloadHarness('async_task');
let executionCountAtDelivery = -1;
const backlogWorker = new DurableRunWorker({
  repository: backlogRepository.repository,
  workloads: [backlogWorkload.workload],
  delivery: {
    async deliver() {
      executionCountAtDelivery = backlogWorkload.executeCalls.length;
      return { status: 'sent', messageId: 'om_backlog' };
    },
  },
  clock,
  maxConcurrencyByWorkload: { async_task: 2 },
});
await backlogWorker.tick();
await waitFor(() => backlogRepository.deliveryResults.length === 1, 'delivery during execution backlog');
assert.equal(executionCountAtDelivery < backlogClaims.length, true);
await waitFor(() => backlogRepository.transitions.length === backlogClaims.length, 'backlog completion');
await backlogWorker.stop();

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

// A claim that returns after shutdown begins is released without consuming an attempt.
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
assert.deepEqual(claimRaceRepository.releasedClaims, ['run_claim-race']);

// Shutdown after the execution marker but before invocation atomically releases
// the unexecuted Attempt instead of recovering it as an unknown side effect.
const markerRaceClaim = createClaim('cron_prompt', 'marker-race');
const markerRaceRepository = createRepositoryHarness([markerRaceClaim]);
const markerRaceWorkload = createWorkloadHarness('cron_prompt');
let markerRaceWorker!: DurableRunWorker;
let markerRaceStop: Promise<void> | undefined;
markerRaceRepository.repository.markExecutionStarted = async (claim) => {
  markerRaceRepository.executionStarts.push(claim.run.runId);
  claim.attempt.executionStartedAt = clock.now().toISOString();
  markerRaceStop = markerRaceWorker.stop();
  return 'committed';
};
markerRaceWorker = new DurableRunWorker({
  repository: markerRaceRepository.repository,
  workloads: [markerRaceWorkload.workload],
  delivery,
  clock,
  maxConcurrencyByWorkload: { cron_prompt: 1 },
});
await markerRaceWorker.tick();
await markerRaceStop;
assert.deepEqual(markerRaceWorkload.executeCalls, []);
assert.deepEqual(markerRaceRepository.releasedClaims, ['run_marker-race']);
assert.deepEqual(markerRaceRepository.transitions, []);

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
assert.deepEqual(deliveryRaceRepository.deliveryResults, [{
  status: 'retry',
  errorCode: 'durable_run_delivery_shutdown_before_send',
  errorSummary: 'Worker shutdown started before delivery; the claim was released.',
  retryAt: '2026-07-19T00:00:00.000Z',
  resetAttemptCount: true,
}]);

// A successful slow delivery must retain its ownership fence by renewing the worker lease.
const slowDeliveryRepository = createRepositoryHarness();
const slowClaim = createDeliveryClaim('async_task', 'slow-delivery');
slowDeliveryRepository.deliveryClaim = slowClaim;
let releaseSlowDelivery: (() => void) | undefined;
const slowDeliveryWorker = new DurableRunWorker({
  repository: slowDeliveryRepository.repository,
  workloads: [createWorkloadHarness('async_task').workload],
  delivery: {
    async deliver() {
      await new Promise<void>((resolve) => { releaseSlowDelivery = resolve; });
      return { status: 'sent', messageId: 'om_slow_delivery' };
    },
  },
  clock: new SystemClock(),
  maxConcurrencyByWorkload: { async_task: 1 },
  deliveryLeaseDurationMs: 40,
  deliveryHeartbeatIntervalMs: 10,
});
await slowDeliveryWorker.tick();
await waitFor(
  () => slowDeliveryRepository.deliveryHeartbeats.length >= 1,
  'initial delivery lease heartbeat',
);
const stoppingSlowDelivery = slowDeliveryWorker.stop();
const heartbeatsAtShutdown = slowDeliveryRepository.deliveryHeartbeats.length;
await waitFor(
  () => slowDeliveryRepository.deliveryHeartbeats.length > heartbeatsAtShutdown,
  'delivery lease heartbeat during graceful shutdown',
);
releaseSlowDelivery?.();
await stoppingSlowDelivery;
await waitFor(() => slowDeliveryRepository.deliveryResults.length === 1, 'slow delivery commit');
assert.equal(slowDeliveryRepository.deliveryResults[0]?.status, 'sent');
assert.notEqual(
  slowDeliveryRepository.deliveryHeartbeats.at(-1)?.leaseExpiresAt,
  slowClaim.leaseExpiresAt,
);

console.log('durable run worker smoke: PASS');
