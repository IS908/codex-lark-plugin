import assert from 'node:assert/strict';
import {
  assertDurableRunTransition,
  assertKnownDurableRunWorkloadKind,
  cronManualRunIdempotencyKey,
  cronScheduledRunIdempotencyKey,
  isDurableRunTerminal,
  serializeDurableRunJson,
} from '../src/domain/durable-run.js';
import type {
  DurableRunClaim,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunRecord,
  DurableRunStatus,
  DurableRunTransition,
} from '../src/domain/durable-run.js';
import {
  materializeDurableRunWorkloadClaim,
  materializeDurableRunWorkloadContext,
} from '../src/ports/durable-run.js';
import type {
  DurableRunRepository,
  DurableRunWorkload,
} from '../src/ports/durable-run.js';

const statuses: readonly DurableRunStatus[] = [
  'queued',
  'running',
  'waiting_retry',
  'waiting_user',
  'recovering',
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancel_requested',
  'cancelled',
];
const terminalStatuses = new Set<DurableRunStatus>([
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancelled',
]);

for (const status of statuses) {
  assert.equal(
    isDurableRunTerminal(status),
    terminalStatuses.has(status),
    `${status} terminal recognition`,
  );
}

const allowedTransitions: Readonly<Record<DurableRunStatus, readonly DurableRunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: [
    'waiting_retry',
    'waiting_user',
    'recovering',
    'completed',
    'partial',
    'blocked',
    'failed',
    'cancel_requested',
    'cancelled',
  ],
  waiting_retry: ['running', 'cancelled'],
  waiting_user: ['queued', 'cancelled'],
  recovering: [
    'running',
    'waiting_retry',
    'waiting_user',
    'blocked',
    'failed',
    'cancelled',
  ],
  completed: [],
  partial: [],
  blocked: [],
  failed: [],
  cancel_requested: ['completed', 'partial', 'blocked', 'failed', 'cancelled'],
  cancelled: [],
};

for (const currentStatus of statuses) {
  for (const nextStatus of statuses) {
    const transition: DurableRunTransition = {
      status: nextStatus,
      stateVersion: 2,
      state: { nextStatus },
      ...(
        nextStatus === 'waiting_retry' || nextStatus === 'recovering'
          ? { nextRunAt: '2026-07-19T01:00:00.000Z' }
          : {}
      ),
    };
    const label = `${currentStatus} -> ${nextStatus}`;
    if (allowedTransitions[currentStatus].includes(nextStatus)) {
      assert.doesNotThrow(() => assertDurableRunTransition(currentStatus, transition), label);
    } else {
      assert.throws(
        () => assertDurableRunTransition(currentStatus, transition),
        /Invalid durable run transition/,
        label,
      );
    }
  }
}

assert.throws(
  () => assertDurableRunTransition('running', {
    status: 'waiting_retry',
    stateVersion: 2,
    state: {},
  }),
  /nextRunAt is required/,
);
for (const nextRunAt of ['not-a-date', '2026-07-19T01:00:00Z', '2026-02-30T01:00:00.000Z']) {
  assert.throws(
    () => assertDurableRunTransition('running', {
      status: 'waiting_retry',
      stateVersion: 2,
      state: {},
      nextRunAt,
    }),
    /nextRunAt must be a canonical ISO timestamp/,
    `reject invalid or non-canonical nextRunAt ${nextRunAt}`,
  );
}
assert.throws(
  () => assertDurableRunTransition('running', {
    status: 'completed',
    stateVersion: 2,
    state: {},
    nextRunAt: 'invalid-even-when-optional',
  }),
  /nextRunAt must be a canonical ISO timestamp/,
);
for (const stateVersion of [0, -1, 1.5, Number.NaN]) {
  assert.throws(
    () => assertDurableRunTransition('running', {
      status: 'completed',
      stateVersion,
      state: {},
    }),
    /stateVersion must be a positive integer/,
  );
}

const validFailure: DurableRunFailure = {
  category: 'unknown',
  retrySafety: 'unknown',
  capabilityAvailable: true,
  operationRisk: 'external_side_effect',
  hints: ['Confirm the external outcome.'],
  failedStep: 'publish-result',
  diagnostic: 'The worker lease expired after execution started.',
  fingerprint: 'lease-expired:publish-result',
};
const completedTransition: DurableRunTransition = {
  status: 'completed',
  stateVersion: 2,
  state: { report: 'done' },
  errorCode: 'durable_run_completed',
  errorSummary: 'No error.',
  failure: validFailure,
  deliveries: [{
    kind: 'terminal_result',
    idempotencyKey: 'delivery:run-1:terminal',
    route: { chatId: 'oc_chat' },
    payload: { text: 'done' },
  }],
};
assert.doesNotThrow(() => assertDurableRunTransition('running', completedTransition));
for (const [field, value, pattern] of [
  ['errorCode', '', /errorCode is required/],
  ['errorCode', 'x'.repeat(129), /errorCode exceeds 128 characters/],
  ['errorSummary', '', /errorSummary is required/],
  ['errorSummary', 'x'.repeat(4_001), /errorSummary exceeds 4000 characters/],
] as const) {
  assert.throws(
    () => assertDurableRunTransition('running', {
      ...completedTransition,
      [field]: value,
    }),
    pattern,
  );
}
for (const [failure, pattern] of [
  [{ ...validFailure, hints: Array.from({ length: 9 }, () => 'hint') }, /failure hints exceeds 8 entries/],
  [{ ...validFailure, hints: ['x'.repeat(501)] }, /failure hint exceeds 500 characters/],
  [{ ...validFailure, failedStep: '' }, /failure failedStep is required/],
  [{ ...validFailure, diagnostic: 'x'.repeat(1_001) }, /failure diagnostic exceeds 1000 characters/],
  [{ ...validFailure, fingerprint: 'x'.repeat(129) }, /failure fingerprint exceeds 128 characters/],
  [{ ...validFailure, capabilityAvailable: 'yes' }, /failure capabilityAvailable must be boolean/],
] as const) {
  assert.throws(
    () => assertDurableRunTransition('running', {
      ...completedTransition,
      failure: failure as DurableRunFailure,
    }),
    pattern,
  );
}

assert.throws(
  () => assertDurableRunTransition('running', {
    ...completedTransition,
    deliveries: Array.from({ length: 17 }, (_, index) => ({
      kind: 'terminal_result',
      idempotencyKey: `delivery:${index}`,
      route: {},
      payload: {},
    })),
  }),
  /deliveries exceeds 16 entries/,
);
assert.throws(
  () => assertDurableRunTransition('running', {
    ...completedTransition,
    deliveries: null as unknown as DurableRunTransition['deliveries'],
  }),
  /deliveries must be an array/,
);
assert.throws(
  () => assertDurableRunTransition('running', {
    ...completedTransition,
    deliveries: [null as unknown as NonNullable<DurableRunTransition['deliveries']>[number]],
  }),
  /delivery must be an object/,
);
assert.throws(
  () => assertDurableRunTransition('running', {
    ...completedTransition,
    deliveries: [
      completedTransition.deliveries![0],
      { ...completedTransition.deliveries![0] },
    ],
  }),
  /duplicate delivery idempotencyKey/,
);
for (const [delivery, pattern] of [
  [{ ...completedTransition.deliveries![0], kind: 'x'.repeat(129) }, /delivery kind exceeds 128 characters/],
  [{ ...completedTransition.deliveries![0], idempotencyKey: 'x'.repeat(513) }, /delivery idempotencyKey exceeds 512 characters/],
] as const) {
  assert.throws(
    () => assertDurableRunTransition('running', {
      ...completedTransition,
      deliveries: [delivery],
    }),
    pattern,
  );
}

assert.equal(serializeDurableRunJson({ report: 'ok' }, 'state', 64), '{"report":"ok"}');
assert.equal(serializeDurableRunJson('😀', 'state', 6), '"😀"');
assert.throws(
  () => serializeDurableRunJson('😀', 'state', 5),
  /state JSON exceeds 5 bytes/,
);
assert.throws(
  () => serializeDurableRunJson({ report: 'x'.repeat(64) }, 'state', 64),
  /state JSON exceeds 64 bytes/,
);
for (const value of [
  { report: undefined },
  { report: Number.NaN },
  { report: Number.POSITIVE_INFINITY },
  { report: 1n },
  new Date('2026-07-19T01:00:00.000Z'),
]) {
  assert.throws(
    () => serializeDurableRunJson(value, 'state', 256),
    /state must contain only JSON-compatible values/,
  );
}
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
assert.throws(
  () => serializeDurableRunJson(cyclic, 'state', 256),
  /state must contain only JSON-compatible values/,
);
const accessorValue = {};
Object.defineProperty(accessorValue, 'unstable', {
  enumerable: true,
  get: () => 'changes-between-validation-and-stringify',
});
assert.throws(
  () => serializeDurableRunJson(accessorValue, 'state', 256),
  /state must contain only JSON-compatible values/,
);
let proxiedArrayReads = 0;
const proxiedArray = new Proxy([1], {
  get(target, property, receiver) {
    proxiedArrayReads += 1;
    return Reflect.get(target, property, receiver) as unknown;
  },
});
assert.equal(serializeDurableRunJson(proxiedArray, 'state', 256), '[1]');
assert.equal(proxiedArrayReads, 0, 'JSON snapshot must not reread proxied array values');
let depthBoundary: unknown = 'leaf';
for (let index = 0; index < 64; index += 1) depthBoundary = { child: depthBoundary };
assert.doesNotThrow(() => serializeDurableRunJson(depthBoundary, 'state', 1_024));
assert.throws(
  () => serializeDurableRunJson({ child: depthBoundary }, 'state', 1_024),
  /state must contain only JSON-compatible values/,
);

assert.equal(
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  'cron:daily-report:7:2026-07-19T01%3A00%3A00.000Z',
);
assert.equal(
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00Z'),
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  'equivalent scheduled instants must use the same key',
);
assert.equal(
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T09:00:00+08:00'),
  cronScheduledRunIdempotencyKey('daily-report', 7, '2026-07-19T01:00:00.000Z'),
  'offset-equivalent scheduled instants must use the same key',
);
assert.notEqual(
  cronScheduledRunIdempotencyKey('a', 1, '2026-07-19T01:00:00.000Z'),
  cronScheduledRunIdempotencyKey('a:1', 1, '2026-07-19T01:00:00.000Z'),
  'scheduled job components must be delimiter-safe',
);
assert.equal(
  cronManualRunIdempotencyKey('daily:report', 7, 'request:123'),
  'cron-manual:daily%3Areport:7:request%3A123',
);
assert.notEqual(
  cronManualRunIdempotencyKey('a', 1, 'b:2:c'),
  cronManualRunIdempotencyKey('a:1:b', 2, 'c'),
  'manual keys must not collide across component boundaries',
);
for (const scheduledOccurrence of ['', 'not-a-date', '2026-02-30T01:00:00.000Z']) {
  assert.throws(
    () => cronScheduledRunIdempotencyKey('daily-report', 7, scheduledOccurrence),
    /scheduledOccurrence must be a valid timestamp/,
  );
}

interface SmokeInput {
  prompt: string;
}

interface SmokeState {
  completedSteps: number;
}

let inputParseCount = 0;
let stateParseCount = 0;
const workload: DurableRunWorkload<SmokeInput, SmokeState, string> = {
  kind: 'smoke',
  parseInput(value, version) {
    inputParseCount += 1;
    assert.equal(version, 3);
    assert.deepEqual(value, { prompt: 'run the smoke' });
    return { prompt: 'parsed input' };
  },
  parseState(value, version) {
    stateParseCount += 1;
    assert.equal(version, 4);
    assert.deepEqual(value, { completedSteps: 1 });
    return { completedSteps: 2 };
  },
  async preflight(context) {
    assert.equal(context.input.prompt, 'parsed input');
    assert.equal(context.state.completedSteps, 2);
    return { action: 'execute' };
  },
  async execute(claim) {
    assert.equal(claim.run.input.prompt, 'parsed input');
    assert.equal(claim.run.state.completedSteps, 2);
    return `${claim.run.input.prompt}:${claim.run.state.completedSteps}`;
  },
  reduce(claim, result) {
    assert.equal(claim.run.input.prompt, 'parsed input');
    assert.equal(claim.run.state.completedSteps, 2);
    assert.equal(result, 'parsed input:2');
    return {
      status: 'completed',
      stateVersion: 5,
      state: { completedSteps: claim.run.state.completedSteps + 1 },
    };
  },
  recoverInterruptedAttempt(context) {
    assert.equal(context.executionPhase, 'execution_started');
    assert.equal(context.operationRisk, 'external_side_effect');
    return {
      status: 'blocked',
      stateVersion: context.claim.run.stateVersion,
      state: context.claim.run.state,
    };
  },
};
const rawRun: DurableRunRecord = {
  runId: 'run-smoke',
  workloadKind: 'smoke',
  idempotencyKey: 'smoke:run-smoke',
  status: 'running',
  inputVersion: 3,
  input: { prompt: 'run the smoke' },
  stateVersion: 4,
  state: { completedSteps: 1 },
  route: {},
  actorOpenId: 'ou_actor',
  nextRunAt: '2026-07-19T01:00:00.000Z',
  expiresAt: '2026-07-20T01:00:00.000Z',
  maxAttempts: 3,
  attemptCount: 1,
  rowVersion: 2,
};
const rawClaim: DurableRunClaim = {
  run: rawRun,
  attempt: {
    attemptId: 'attempt-smoke',
    runId: rawRun.runId,
    ordinal: 1,
    workerId: 'worker-smoke',
    claimedAt: '2026-07-19T01:00:00.000Z',
    heartbeatAt: '2026-07-19T01:00:01.000Z',
    leaseExpiresAt: '2026-07-19T01:01:00.000Z',
    executionStartedAt: '2026-07-19T01:00:02.000Z',
  },
  workerId: 'worker-smoke',
  claimedRowVersion: rawRun.rowVersion,
};
const workloadContext = materializeDurableRunWorkloadContext(workload, rawRun);
const workloadClaim = materializeDurableRunWorkloadClaim(rawClaim, workloadContext);
assert.equal(inputParseCount, 1, 'input should be parsed once while materializing the workload');
assert.equal(stateParseCount, 1, 'state should be parsed once while materializing the workload');
assert.deepEqual(await workload.preflight(workloadContext), { action: 'execute' });
const workloadResult = await workload.execute(workloadClaim, new AbortController().signal);
assert.equal(workloadResult, 'parsed input:2');
assert.deepEqual(workload.reduce(workloadClaim, workloadResult).state, { completedSteps: 3 });

const interruptedAttempt: DurableRunInterruptedAttempt = {
  claim: rawClaim,
  recoveredAt: '2026-07-19T01:02:00.000Z',
  executionPhase: 'execution_started',
  operationRisk: 'external_side_effect',
};
const recoverExpiredLeases: DurableRunRepository['recoverExpiredLeases'] = async () => [
  interruptedAttempt,
];
assert.deepEqual(await recoverExpiredLeases('2026-07-19T01:02:00.000Z'), [interruptedAttempt]);
assert.equal(
  workload.recoverInterruptedAttempt(interruptedAttempt).status,
  'blocked',
  'workload recovery must receive execution phase and operation risk',
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
