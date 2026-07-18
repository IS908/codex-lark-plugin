export type DurableRunFailureCategory =
  | 'invalid_invocation'
  | 'transient'
  | 'authentication_required'
  | 'permission_required'
  | 'capability_unavailable'
  | 'terminal'
  | 'unknown';

export type DurableRunRetrySafety = 'safe' | 'unsafe' | 'unknown';

export type DurableRunOperationRisk =
  | 'pure'
  | 'read_only'
  | 'idempotent_write'
  | 'external_side_effect'
  | 'unknown';

export interface DurableRunFailure {
  category: DurableRunFailureCategory;
  retrySafety: DurableRunRetrySafety;
  capabilityAvailable: boolean;
  operationRisk: DurableRunOperationRisk;
  hints: string[];
  failedStep: string;
  diagnostic: string;
  fingerprint: string;
}

export interface DurableRunRecoveryBudget {
  fingerprintAttempts: number;
  totalAttempts: number;
  maxFingerprintAttempts: number;
  maxTotalAttempts: number;
}

export type DurableRunRecoveryDecision =
  | {
      action: 'retry';
      status: 'recovering';
      delaySeconds: number;
      reason: string;
    }
  | {
      action: 'wait_user';
      status: 'waiting_user';
      prompt: string;
      reason: string;
    }
  | {
      action: 'block';
      status: 'blocked';
      reason: string;
    }
  | {
      action: 'fail';
      status: 'failed';
      reason: string;
    };

export type DurableRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'waiting_user'
  | 'recovering'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export interface DurableRunRecord {
  runId: string;
  workloadKind: string;
  idempotencyKey: string;
  status: DurableRunStatus;
  inputVersion: number;
  input: unknown;
  stateVersion: number;
  state: unknown;
  route: unknown;
  actorOpenId: string;
  nextRunAt: string;
  expiresAt: string;
  maxAttempts: number;
  attemptCount: number;
  rowVersion: number;
}

export interface DurableRunAttempt {
  attemptId: string;
  runId: string;
  ordinal: number;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  executionStartedAt?: string;
}

export interface DurableRunClaim {
  run: DurableRunRecord;
  attempt: DurableRunAttempt;
  workerId: string;
  claimedRowVersion: number;
}

export interface DurableRunDeliveryRequest {
  kind: string;
  idempotencyKey: string;
  route: unknown;
  payload: unknown;
}

export interface DurableRunTransition {
  status: DurableRunStatus;
  stateVersion: number;
  state: unknown;
  nextRunAt?: string;
  errorCode?: string;
  errorSummary?: string;
  failure?: DurableRunFailure;
  deliveries?: readonly DurableRunDeliveryRequest[];
}

export type DurableRunPreflight =
  | { action: 'execute' }
  | { action: 'transition'; transition: DurableRunTransition };

export interface DurableRunInterruptedAttempt {
  claim: DurableRunClaim;
  recoveredAt: string;
  executionStarted: boolean;
}

export interface DurableRunCreateRequest {
  runId: string;
  workloadKind: string;
  idempotencyKey: string;
  inputVersion: number;
  input: unknown;
  stateVersion: number;
  state: unknown;
  route: unknown;
  actorOpenId: string;
  nextRunAt: string;
  expiresAt: string;
  maxAttempts: number;
}

export interface DurableRunCreateResult {
  run: DurableRunRecord;
  created: boolean;
}

export interface DurableRunDeliveryClaim {
  outboxId: string;
  runId: string;
  workloadKind: string;
  kind: string;
  attemptId?: string;
  workerId: string;
  route: unknown;
  idempotencyKey: string;
  payload: unknown;
  attemptCount: number;
}

export type DurableRunDeliveryResult =
  | { status: 'sent'; messageId: string }
  | { status: 'retry'; errorCode: string; errorSummary: string; retryAt?: string }
  | { status: 'unknown'; errorCode: string; errorSummary: string }
  | { status: 'failed'; errorCode: string; errorSummary: string };

export const DURABLE_RUN_WORKLOAD_JSON_MAX_BYTES = 256 * 1024;

const TERMINAL_STATUSES = new Set<DurableRunStatus>([
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancelled',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<DurableRunStatus, ReadonlySet<DurableRunStatus>>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set([
    'waiting_retry',
    'waiting_user',
    'recovering',
    'completed',
    'partial',
    'blocked',
    'failed',
    'cancel_requested',
    'cancelled',
  ]),
  waiting_retry: new Set(['running', 'cancelled']),
  waiting_user: new Set(['queued', 'cancelled']),
  recovering: new Set([
    'running',
    'waiting_retry',
    'waiting_user',
    'blocked',
    'failed',
    'cancelled',
  ]),
  completed: new Set(),
  partial: new Set(),
  blocked: new Set(),
  failed: new Set(),
  cancel_requested: new Set(['completed', 'partial', 'blocked', 'failed', 'cancelled']),
  cancelled: new Set(),
};

export function isDurableRunTerminal(status: DurableRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function assertDurableRunTransition(
  currentStatus: DurableRunStatus,
  transition: DurableRunTransition,
): void {
  if (!ALLOWED_TRANSITIONS[currentStatus].has(transition.status)) {
    throw new Error(`Invalid durable run transition: ${currentStatus} -> ${transition.status}`);
  }
  if (!Number.isSafeInteger(transition.stateVersion) || transition.stateVersion < 1) {
    throw new Error('Durable run transition stateVersion must be a positive integer.');
  }
  if (
    (transition.status === 'waiting_retry' || transition.status === 'recovering')
    && !transition.nextRunAt?.trim()
  ) {
    throw new Error(`Durable run transition nextRunAt is required for ${transition.status}.`);
  }
  serializeDurableRunJson(transition.state, 'state');
  for (const delivery of transition.deliveries ?? []) {
    if (!delivery.kind.trim()) throw new Error('Durable run delivery kind is required.');
    if (!delivery.idempotencyKey.trim()) {
      throw new Error('Durable run delivery idempotencyKey is required.');
    }
    serializeDurableRunJson(delivery.route, 'delivery route');
    serializeDurableRunJson(delivery.payload, 'delivery payload');
  }
}

export function serializeDurableRunJson(
  value: unknown,
  label: string,
  maxBytes = DURABLE_RUN_WORKLOAD_JSON_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Durable run JSON byte limit must be a positive integer.');
  }
  try {
    assertJsonValue(value, new Set());
  } catch {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
  const serialized = JSON.stringify(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(`${label} JSON exceeds ${maxBytes} bytes.`);
  }
  return serialized;
}

export function assertKnownDurableRunWorkloadKind(
  workloadKind: string,
  knownWorkloadKinds: readonly string[],
): void {
  if (!knownWorkloadKinds.includes(workloadKind)) {
    throw new Error(`Unknown durable run workload kind: ${workloadKind}`);
  }
}

export function cronScheduledRunIdempotencyKey(
  jobId: string,
  definitionRevision: number,
  scheduledOccurrence: string,
): string {
  return `cron:${requiredIdempotencyPart(jobId, 'jobId')}:${requiredRevision(definitionRevision)}:${requiredIdempotencyPart(scheduledOccurrence, 'scheduledOccurrence')}`;
}

export function cronManualRunIdempotencyKey(
  jobId: string,
  definitionRevision: number,
  requestId: string,
): string {
  return `cron-manual:${requiredIdempotencyPart(jobId, 'jobId')}:${requiredRevision(definitionRevision)}:${requiredIdempotencyPart(requestId, 'requestId')}`;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new Error('Unsupported JSON value.');
  if (ancestors.has(value)) throw new Error('Cyclic JSON value.');

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Non-plain JSON object.');
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, ancestors);
    }
  }
  ancestors.delete(value);
}

function requiredIdempotencyPart(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Cron idempotency ${label} is required.`);
  return value;
}

function requiredRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cron definition revision must be a non-negative integer.');
  }
  return value;
}
