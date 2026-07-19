import assert from 'node:assert/strict';
import type {
  DurableRunCreateRequest,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
  DurableRunRecord,
} from '../src/domain/durable-run.js';
import type {
  DurableRunDelivery,
  DurableRunRepository,
  DurableRunWorkload,
} from '../src/ports/durable-run.js';
import {
  createDurableRunRuntime,
  type DurableRunRegistration,
} from '../src/durable-run/runtime.js';
import { createChannelServicesStarter } from '../src/channel-services.js';

function workload(kind: string): DurableRunWorkload {
  return { kind } as DurableRunWorkload;
}

function repositoryHarness(events: string[]): DurableRunRepository {
  return {
    async initialize() { events.push('repository.initialize'); },
    async create(_request: DurableRunCreateRequest) { throw new Error('not used'); },
    async get() { return null; },
    async getActiveByConcurrencyKey() { return null; },
    async claimDue(kinds) { events.push(`claim:${[...kinds].sort().join(',')}`); return null; },
    async markExecutionStarted() { return 'stale'; },
    async heartbeat() { return false; },
    async commitTransition() { return 'stale'; },
    async failAttempt() { return 'stale'; },
    async recoverExpiredLeases(kinds) {
      events.push(`recover:${[...kinds].sort().join(',')}`);
      return [];
    },
    async claimDelivery(kinds, _workerId, _now, leaseExpiresAt) {
      events.push(`delivery:${[...kinds].sort().join(',')}:${leaseExpiresAt ?? 'default'}`);
      return null;
    },
    async heartbeatDelivery(claim, _now, leaseExpiresAt) {
      events.push(`delivery-heartbeat:${claim.workloadKind}:${leaseExpiresAt}`);
      return { ...claim, leaseExpiresAt };
    },
    async commitDelivery(_claim: DurableRunDeliveryClaim, _result: DurableRunDeliveryResult) {
      return 'stale';
    },
    close() { events.push('repository.close'); },
  };
}

const delivery = { async deliver() { return { status: 'superseded' as const }; } } as DurableRunDelivery;
const clock = { now: () => new Date('2026-07-19T00:00:00.000Z') };

function registration(
  kind: string,
  repository: DurableRunRepository,
  maxConcurrency: number,
): DurableRunRegistration {
  return { kind, repository, workload: workload(kind), delivery, maxConcurrency };
}

// One worker owns all registered workload kinds, with independent quotas. It
// remains stopped until the channel-ready path explicitly starts it.
{
  const events: string[] = [];
  const repository = repositoryHarness(events);
  await repository.initialize();
  events.push('channel.connect');
  const runtime = createDurableRunRuntime({
    baseRepository: repository,
    registrations: [
      registration('cron_prompt', repository, 2),
      registration('cron_message', repository, 3),
      registration('async_task', repository, 4),
    ],
    clock,
    scanIntervalMs: 60_000,
  });
  const worker = runtime.worker as any;
  assert.equal(worker.started, false, 'worker must not start before transport readiness');
  assert.deepEqual([...worker.workloads.keys()].sort(), ['async_task', 'cron_message', 'cron_prompt']);
  assert.deepEqual(worker.options.maxConcurrencyByWorkload, {
    cron_prompt: 2,
    cron_message: 3,
    async_task: 4,
  });
  runtime.start();
  assert.equal(worker.started, true);
  assert.deepEqual(events.slice(0, 2), ['repository.initialize', 'channel.connect']);
  await runtime.stop();
}

// Disabling continuations removes only async_task. Cron prompt/message remain
// registered on the same worker and are both scanned.
{
  const events: string[] = [];
  const repository = repositoryHarness(events);
  const runtime = createDurableRunRuntime({
    baseRepository: repository,
    registrations: [
      registration('cron_prompt', repository, 1),
      registration('cron_message', repository, 2),
    ],
    clock,
  });
  await runtime.tick();
  const worker = runtime.worker as any;
  assert.deepEqual([...worker.workloads.keys()].sort(), ['cron_message', 'cron_prompt']);
  assert.deepEqual(worker.options.maxConcurrencyByWorkload, {
    cron_prompt: 1,
    cron_message: 2,
  });
  assert.ok(events.some((event) => event === 'claim:cron_message,cron_prompt'));
  assert.ok(events.some((event) => event.startsWith('delivery:cron_message,cron_prompt:')));
  await runtime.stop();
}

// The routed production repository must preserve the worker-selected delivery
// lease and forward heartbeats to the workload repository that owns the claim.
{
  const baseEvents: string[] = [];
  const cronEvents: string[] = [];
  const asyncEvents: string[] = [];
  const base = repositoryHarness(baseEvents);
  const cron = repositoryHarness(cronEvents);
  const asyncTask = repositoryHarness(asyncEvents);
  const runtime = createDurableRunRuntime({
    baseRepository: base,
    registrations: [
      registration('cron_prompt', cron, 1),
      registration('async_task', asyncTask, 1),
    ],
    clock,
    deliveryLeaseDurationMs: 45_000,
    deliveryHeartbeatIntervalMs: 10_000,
  });
  await runtime.repository.claimDelivery(
    ['cron_prompt'],
    'delivery-worker',
    '2026-07-19T00:00:00.000Z',
    '2026-07-19T00:00:45.000Z',
  );
  assert.deepEqual(cronEvents, [
    'delivery:cron_prompt:2026-07-19T00:00:45.000Z',
  ]);
  const claim: DurableRunDeliveryClaim = {
    outboxId: 'outbox_async',
    runId: 'run_async',
    workloadKind: 'async_task',
    eventKey: 'terminal',
    kind: 'terminal',
    workerId: 'delivery-worker',
    route: {},
    idempotencyKey: 'delivery:run_async:terminal',
    payload: 'done',
    attemptCount: 1,
    leaseExpiresAt: '2026-07-19T00:00:30.000Z',
  };
  const renewed = await runtime.repository.heartbeatDelivery?.(
    claim,
    '2026-07-19T00:00:10.000Z',
    '2026-07-19T00:00:55.000Z',
  );
  assert.equal(renewed?.leaseExpiresAt, '2026-07-19T00:00:55.000Z');
  assert.deepEqual(asyncEvents, [
    'delivery-heartbeat:async_task:2026-07-19T00:00:55.000Z',
  ]);
  await runtime.stop();
}

// Routed production scans must dispatch unclaimable terminalization to the
// workload strategy instead of letting the generic repository invent payloads.
{
  const events: string[] = [];
  const repository = repositoryHarness(events);
  const expiredRun: DurableRunRecord = {
    runId: 'run_expired_cron',
    workloadKind: 'cron_prompt',
    idempotencyKey: 'cron:expired',
    concurrencyKey: 'cron-job:expired',
    status: 'queued',
    inputVersion: 1,
    input: {},
    stateVersion: 1,
    state: {},
    route: {},
    actorOpenId: 'ou_owner',
    nextRunAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2026-07-18T23:59:59.000Z',
    maxAttempts: 4,
    attemptCount: 0,
    rowVersion: 1,
  };
  repository.claimDue = async (_kinds, _workerId, _now, _lease, _validate, resolve) => {
    const failure = resolve?.(expiredRun, 'expired');
    events.push(`terminal:${failure?.errorCode ?? 'none'}:${failure?.deliveries?.length ?? 0}`);
    return null;
  };
  const cronWorkload = {
    ...workload('cron_prompt'),
    terminalizeUnclaimable: () => ({
      errorCode: 'cron_run_expired',
      errorSummary: 'expired',
      deliveries: [{
        kind: 'cron_terminal',
        idempotencyKey: 'cron:run_expired_cron:terminal',
        route: {},
        payload: { reason: 'expired' },
      }],
    }),
  } as DurableRunWorkload;
  const runtime = createDurableRunRuntime({
    baseRepository: repository,
    registrations: [{
      kind: 'cron_prompt',
      repository,
      workload: cronWorkload,
      delivery,
      maxConcurrency: 1,
    }],
    clock,
  });
  await runtime.tick();
  assert.ok(events.includes('terminal:cron_run_expired:1'));
  await runtime.stop();
}

// Routed scans always provide the workload parser as a persisted-state
// validator, so corrupt rows are terminalized by storage instead of poisoning
// every later scan.
{
  const events: string[] = [];
  const repository = repositoryHarness(events);
  const corruptRun: DurableRunRecord = {
    runId: 'run_corrupt_cron',
    workloadKind: 'cron_prompt',
    idempotencyKey: 'cron:corrupt',
    status: 'queued',
    inputVersion: 1,
    input: { schemaVersion: 1 },
    stateVersion: 99,
    state: { schemaVersion: 99 },
    route: {},
    actorOpenId: 'ou_owner',
    nextRunAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    maxAttempts: 4,
    attemptCount: 0,
    rowVersion: 1,
  };
  repository.claimDue = async (_kinds, _worker, _now, _lease, validate) => {
    assert.ok(validate);
    assert.throws(() => validate(corruptRun), /unsupported persisted state/);
    events.push('invalid-state-detected');
    return null;
  };
  const validatingWorkload: DurableRunWorkload = {
    ...workload('cron_prompt'),
    parseInput: (value) => value,
    parseState: (_value, version) => {
      if (version !== 1) throw new Error('unsupported persisted state');
      return _value;
    },
  };
  const runtime = createDurableRunRuntime({
    baseRepository: repository,
    registrations: [{
      kind: 'cron_prompt',
      repository,
      workload: validatingWorkload,
      delivery,
      maxConcurrency: 1,
    }],
    clock,
  });
  await runtime.tick();
  assert.ok(events.includes('invalid-state-detected'));
  await runtime.stop();
}

// Startup admission repair must finish before worker execution/delivery begins.
// A failed repair leaves the worker stopped so reconnect can retry cleanly.
{
  const events: string[] = [];
  let releaseRepair: (() => void) | undefined;
  const repairFinished = new Promise<void>((resolve) => { releaseRepair = resolve; });
  const start = createChannelServicesStarter({
    channel: {
      getClient: () => ({} as any),
      getLarkTransport: () => ({} as any),
      getBotMessageTracker: () => ({} as any),
      getLatestMessageTracker: () => ({} as any),
    },
    buffer: { async rearmFromDisk() { events.push('buffer.rearm'); } } as any,
    durableRunRuntime: {
      start() { events.push('runtime.start'); },
      async stop() { events.push('runtime.stop'); },
    } as any,
    cronAdmission: {} as any,
    schedulerFactory: () => ({
      runJobNow: async () => ({ started: false as const }),
      stop() { events.push('scheduler.stop'); },
      async start() {
        events.push('scheduler.repair.start');
        await repairFinished;
        events.push('scheduler.repair.done');
      },
    }),
  });
  const starting = start();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['buffer.rearm', 'scheduler.repair.start']);
  releaseRepair!();
  await starting;
  assert.deepEqual(events, ['buffer.rearm', 'scheduler.repair.start', 'scheduler.repair.done', 'runtime.start']);
  await start.stop();
  assert.deepEqual(events, [
    'buffer.rearm',
    'scheduler.repair.start',
    'scheduler.repair.done',
    'runtime.start',
    'scheduler.stop',
    'runtime.stop',
  ]);

  const failedEvents: string[] = [];
  const failingStart = createChannelServicesStarter({
    channel: {
      getClient: () => ({} as any),
      getLarkTransport: () => ({} as any),
      getBotMessageTracker: () => ({} as any),
      getLatestMessageTracker: () => ({} as any),
    },
    buffer: { async rearmFromDisk() { failedEvents.push('buffer.rearm'); } } as any,
    durableRunRuntime: {
      start() { failedEvents.push('runtime.start'); },
      async stop() { failedEvents.push('runtime.stop'); },
    } as any,
    cronAdmission: {} as any,
    schedulerFactory: () => ({
      runJobNow: async () => ({ started: false as const }),
      stop() { failedEvents.push('scheduler.stop'); },
      async start() {
        failedEvents.push('scheduler.repair.start');
        throw new Error('repair failed');
      },
    }),
  });
  await assert.rejects(failingStart(), /repair failed/);
  assert.deepEqual(failedEvents, ['buffer.rearm', 'scheduler.repair.start', 'scheduler.stop']);

  const retryEvents: string[] = [];
  let repairAttempts = 0;
  const retryingStart = createChannelServicesStarter({
    channel: {
      getClient: () => ({} as any),
      getLarkTransport: () => ({} as any),
      getBotMessageTracker: () => ({} as any),
      getLatestMessageTracker: () => ({} as any),
    },
    buffer: { async rearmFromDisk() { retryEvents.push('buffer.rearm'); } } as any,
    durableRunRuntime: {
      start() { retryEvents.push('runtime.start'); },
      async stop() { retryEvents.push('runtime.stop'); },
    } as any,
    cronAdmission: {} as any,
    schedulerFactory: () => ({
      runJobNow: async () => ({ started: false as const }),
      stop() { retryEvents.push('scheduler.stop'); },
      async start() {
        repairAttempts += 1;
        retryEvents.push(`scheduler.repair.${repairAttempts}`);
        if (repairAttempts === 1) throw new Error('transient repair failure');
      },
    }),
  });
  await assert.rejects(retryingStart(), /transient repair failure/);
  await retryingStart();
  assert.equal(repairAttempts, 2);
  assert.deepEqual(retryEvents, [
    'buffer.rearm',
    'scheduler.repair.1',
    'scheduler.stop',
    'buffer.rearm',
    'scheduler.repair.2',
    'runtime.start',
  ]);

  const workerFailureEvents: string[] = [];
  const workerFailingStart = createChannelServicesStarter({
    channel: {
      getClient: () => ({} as any),
      getLarkTransport: () => ({} as any),
      getBotMessageTracker: () => ({} as any),
      getLatestMessageTracker: () => ({} as any),
    },
    buffer: { async rearmFromDisk() { workerFailureEvents.push('buffer.rearm'); } } as any,
    durableRunRuntime: {
      start() {
        workerFailureEvents.push('runtime.start');
        throw new Error('worker failed');
      },
      async stop() { workerFailureEvents.push('runtime.stop'); },
    } as any,
    cronAdmission: {} as any,
    schedulerFactory: () => ({
      runJobNow: async () => ({ started: false as const }),
      stop() { workerFailureEvents.push('scheduler.stop'); },
      async start() { workerFailureEvents.push('scheduler.repair.done'); },
    }),
  });
  await assert.rejects(workerFailingStart(), /worker failed/);
  assert.deepEqual(workerFailureEvents, [
    'buffer.rearm',
    'scheduler.repair.done',
    'runtime.start',
    'scheduler.stop',
    'runtime.stop',
  ]);
}

console.log('durable run runtime smoke: PASS');
