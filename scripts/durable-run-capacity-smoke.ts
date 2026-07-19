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
  DurableRunDelivery,
  DurableRunRepository,
  DurableRunWorkload,
} from '../src/ports/durable-run.js';
import { DurableRunWorker } from '../src/durable-run/worker.js';

const NOW = '2026-07-19T00:00:00.000Z';
const EXPIRES_AT = '2026-07-20T00:00:00.000Z';

interface CapacityHarness {
  repository: DurableRunRepository;
  claims: DurableRunClaim[];
  records: Map<string, DurableRunRecord>;
  deliveryClaims: DurableRunDeliveryClaim[];
  executionStarts: string[];
  transitions: string[];
  deliveryCommits: string[];
}

function makeClaim(workloadKind: string, label: string): DurableRunClaim {
  const run: DurableRunRecord = {
    runId: `run_${label}`,
    workloadKind,
    idempotencyKey: `idem_${label}`,
    status: 'running',
    inputVersion: 1,
    input: { label },
    stateVersion: 1,
    state: { phase: 'ready' },
    route: { chatId: 'chat_capacity' },
    actorOpenId: 'ou_capacity',
    nextRunAt: NOW,
    expiresAt: EXPIRES_AT,
    maxAttempts: 1,
    attemptCount: 1,
    rowVersion: 1,
  };
  return {
    run,
    workerId: 'capacity-worker',
    claimedRowVersion: 1,
    attempt: {
      attemptId: `attempt_${label}`,
      runId: run.runId,
      ordinal: 1,
      workerId: 'capacity-worker',
      claimedAt: NOW,
      heartbeatAt: NOW,
      leaseExpiresAt: '2026-07-19T00:01:00.000Z',
    },
  };
}

function makeDeliveryClaim(workloadKind: string, label: string): DurableRunDeliveryClaim {
  return {
    outboxId: `outbox_${label}`,
    runId: `run_delivery_${label}`,
    workloadKind,
    eventKey: `event_${label}`,
    kind: 'terminal',
    attemptId: `attempt_delivery_${label}`,
    workerId: 'capacity-worker-delivery',
    route: { chatId: 'chat_capacity' },
    idempotencyKey: `delivery_${label}`,
    payload: { label },
    attemptCount: 1,
    leaseExpiresAt: '2026-07-19T00:01:00.000Z',
  };
}

function createHarness(
  claims: DurableRunClaim[],
  deliveryClaims: DurableRunDeliveryClaim[] = [],
): CapacityHarness {
  const harness: Omit<CapacityHarness, 'repository'> = {
    claims: [...claims],
    records: new Map(claims.map((claim) => [claim.run.runId, claim.run])),
    deliveryClaims: [...deliveryClaims],
    executionStarts: [],
    transitions: [],
    deliveryCommits: [],
  };
  const repository: DurableRunRepository = {
    async initialize() {},
    async create(_request: DurableRunCreateRequest) { throw new Error('not used'); },
    async get(runId) { return harness.records.get(runId) ?? null; },
    async getActiveByConcurrencyKey() { return null; },
    async claimDue(workloadKinds) {
      const index = harness.claims.findIndex((claim) => workloadKinds.includes(claim.run.workloadKind));
      return index < 0 ? null : harness.claims.splice(index, 1)[0];
    },
    async markExecutionStarted(claim) {
      harness.executionStarts.push(claim.run.runId);
      return 'committed';
    },
    async heartbeat() { return true; },
    async commitTransition(claim, _transition: DurableRunTransition) {
      harness.transitions.push(claim.run.runId);
      return 'committed';
    },
    async failAttempt(_claim, _failure: DurableRunFailure) { return 'committed'; },
    async recoverExpiredLeases(): Promise<DurableRunInterruptedAttempt[]> { return []; },
    async claimDelivery(workloadKinds) {
      const index = harness.deliveryClaims.findIndex((claim) =>
        workloadKinds.includes(claim.workloadKind));
      return index < 0 ? null : harness.deliveryClaims.splice(index, 1)[0];
    },
    async commitDelivery(claim, _result: DurableRunDeliveryResult) {
      harness.deliveryCommits.push(claim.outboxId);
      return 'committed';
    },
    close() {},
  };
  return { ...harness, repository };
}

function createBlockingWorkload(kind: string, releases: Array<() => void>): DurableRunWorkload {
  return {
    kind,
    parseInput(value) { return value; },
    parseState(value) { return value; },
    async preflight() { return { action: 'execute' }; },
    async execute(_claim, signal) {
      return new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    reduce(claim) {
      return {
        status: 'completed',
        stateVersion: claim.run.stateVersion,
        state: claim.run.state,
      };
    },
    recoverInterruptedAttempt(context) {
      return {
        status: 'blocked',
        stateVersion: context.claim.run.stateVersion,
        state: context.claim.run.state,
      };
    },
  };
}

function createWorker(
  harness: CapacityHarness,
  releases: Array<() => void>,
  delivery: DurableRunDelivery = { async deliver() { return { status: 'sent', messageId: 'om_capacity' }; } },
): DurableRunWorker {
  return new DurableRunWorker({
    repository: harness.repository,
    workloads: [
      createBlockingWorkload('async_task', releases),
      createBlockingWorkload('cron_prompt', releases),
    ],
    delivery,
    clock: { now: () => new Date(NOW) },
    maxConcurrencyByWorkload: { async_task: 1, cron_prompt: 1 },
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

// Saturating async_task must still leave the independent Cron quota claimable.
{
  const releases: Array<() => void> = [];
  const harness = createHarness([
    makeClaim('async_task', 'async-first'),
    makeClaim('async_task', 'async-blocked'),
    makeClaim('cron_prompt', 'cron-after-async-saturation'),
  ]);
  const worker = createWorker(harness, releases);
  await worker.tick();
  await waitFor(() => worker.activeCount === 2, 'Cron start while async_task is saturated');
  assert.deepEqual(harness.executionStarts.sort(), [
    'run_async-first',
    'run_cron-after-async-saturation',
  ]);
  assert.equal(harness.claims[0]?.run.runId, 'run_async-blocked');
  await worker.stop();
}

// Saturating the Cron quota must still leave async_task independently claimable.
{
  const releases: Array<() => void> = [];
  const harness = createHarness([
    makeClaim('cron_prompt', 'cron-first'),
    makeClaim('cron_prompt', 'cron-blocked'),
    makeClaim('async_task', 'async-after-cron-saturation'),
  ]);
  const worker = createWorker(harness, releases);
  await worker.tick();
  await waitFor(() => worker.activeCount === 2, 'async_task start while Cron is saturated');
  assert.deepEqual(harness.executionStarts.sort(), [
    'run_async-after-cron-saturation',
    'run_cron-first',
  ]);
  assert.equal(harness.claims[0]?.run.runId, 'run_cron-blocked');
  await worker.stop();
}

// The single delivery pump remains live while both execution quotas are occupied.
{
  const releases: Array<() => void> = [];
  const harness = createHarness([
    makeClaim('async_task', 'delivery-async'),
    makeClaim('cron_prompt', 'delivery-cron'),
  ]);
  const deliveries: string[] = [];
  const worker = createWorker(harness, releases, {
    async deliver(claim) {
      deliveries.push(claim.outboxId);
      return { status: 'sent', messageId: `om_${claim.outboxId}` };
    },
  });
  await worker.tick();
  await waitFor(() => worker.activeCount === 2, 'both workload quotas to be occupied');
  harness.deliveryClaims.push(
    makeDeliveryClaim('async_task', 'async'),
    makeDeliveryClaim('cron_prompt', 'cron'),
  );
  await worker.tick();
  await waitFor(() => harness.deliveryCommits.length === 2, 'shared delivery loop to drain both workloads');
  assert.deepEqual(deliveries.sort(), ['outbox_async', 'outbox_cron']);
  assert.deepEqual(harness.deliveryCommits.sort(), ['outbox_async', 'outbox_cron']);
  await worker.stop();
}

console.log('durable run capacity smoke: PASS');
