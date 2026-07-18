import assert from 'node:assert/strict';
import {
  assertDurableRunTransition,
  assertKnownDurableRunWorkloadKind,
  cronManualRunIdempotencyKey,
  cronScheduledRunIdempotencyKey,
  isDurableRunTerminal,
  serializeDurableRunJson,
} from '../src/domain/durable-run.js';
import type { DurableRunTransition } from '../src/domain/durable-run.js';

for (const status of ['completed', 'partial', 'blocked', 'failed', 'cancelled'] as const) {
  assert.equal(isDurableRunTerminal(status), true, `${status} should be terminal`);
}
for (const status of [
  'queued',
  'running',
  'waiting_retry',
  'waiting_user',
  'recovering',
  'cancel_requested',
] as const) {
  assert.equal(isDurableRunTerminal(status), false, `${status} should not be terminal`);
}

const completedTransition: DurableRunTransition = {
  status: 'completed',
  stateVersion: 2,
  state: { report: 'done' },
  deliveries: [{
    kind: 'terminal_result',
    idempotencyKey: 'delivery:run-1:terminal',
    route: { chatId: 'oc_chat' },
    payload: { text: 'done' },
  }],
};
assert.doesNotThrow(() => assertDurableRunTransition('running', completedTransition));
assert.throws(
  () => assertDurableRunTransition('completed', { ...completedTransition, status: 'running' }),
  /Invalid durable run transition: completed -> running/,
);
assert.throws(
  () => assertDurableRunTransition('running', {
    status: 'waiting_retry',
    stateVersion: 2,
    state: {},
  }),
  /nextRunAt is required/,
);

assert.equal(serializeDurableRunJson({ report: 'ok' }, 'state', 64), '{"report":"ok"}');
assert.throws(
  () => serializeDurableRunJson({ report: 'x'.repeat(64) }, 'state', 64),
  /state JSON exceeds 64 bytes/,
);
assert.throws(
  () => serializeDurableRunJson({ report: undefined }, 'state', 64),
  /state must contain only JSON-compatible values/,
);

assert.equal(
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  'cron:daily-report:7:2026-07-19T01:00:00.000Z',
);
assert.equal(
  cronManualRunIdempotencyKey('daily-report', 7, 'request-123'),
  'cron-manual:daily-report:7:request-123',
);
assert.equal(
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  'scheduled idempotency keys should be stable',
);

assert.doesNotThrow(() => assertKnownDurableRunWorkloadKind('cron_prompt', [
  'async_task',
  'cron_prompt',
]));
assert.throws(
  () => assertKnownDurableRunWorkloadKind('unknown_kind', ['async_task', 'cron_prompt']),
  /Unknown durable run workload kind: unknown_kind/,
);

console.log('durable run domain smoke: PASS');
