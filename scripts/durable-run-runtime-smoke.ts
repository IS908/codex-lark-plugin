import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  DurableRunCreateRequest,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
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
    async claimDelivery(kinds) {
      events.push(`delivery:${[...kinds].sort().join(',')}`);
      return null;
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
  assert.ok(events.some((event) => event === 'delivery:cron_message,cron_prompt'));
  await runtime.stop();
}

// Production ordering and fail-closed wiring: persistence must be awaited
// before SDK connect; only the ready callback starts the shared worker; Cron
// registration is unconditional while continuation registration is conditional.
{
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const servicesSource = readFileSync(new URL('../src/channel-services.ts', import.meta.url), 'utf8');
  const persistenceAt = indexSource.indexOf('createContinuationRuntime(');
  const sharedRuntimeAt = indexSource.indexOf('createDurableRunRuntime(');
  const connectAt = indexSource.indexOf('startSdkChannelRuntimeWithRetry(');
  assert.ok(persistenceAt >= 0, 'index must initialize durable persistence');
  assert.ok(sharedRuntimeAt > persistenceAt, 'shared worker must use initialized persistence');
  assert.ok(connectAt > sharedRuntimeAt, 'durable persistence must initialize before Lark connect');
  assert.match(indexSource, /standaloneWorker:\s*false/);
  assert.match(indexSource, /cron_prompt/);
  assert.match(indexSource, /cron_message/);
  assert.match(indexSource, /continuationEnabled[\s\S]*async_task/);
  assert.match(servicesSource, /durableRunRuntime\.start\(\)/);
  assert.doesNotMatch(servicesSource, /continuationWorker\?\.start\(\)/);
  assert.doesNotMatch(servicesSource, /promptRunner|transport\.sendMessage/);
}

console.log('durable run runtime smoke: PASS');
