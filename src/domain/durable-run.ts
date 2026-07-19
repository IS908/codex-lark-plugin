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
  concurrencyKey?: string;
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

export interface DurableRunWorkloadContext<Input, State> extends DurableRunRecord {
  input: Input;
  state: State;
}

export interface DurableRunWorkloadClaim<Input, State> extends DurableRunClaim {
  run: DurableRunWorkloadContext<Input, State>;
}

export interface DurableRunDeliveryRequest {
  outboxId?: string;
  eventKey?: string;
  kind: string;
  attemptId?: string | null;
  idempotencyKey: string;
  route: unknown;
  payload: unknown;
  metadata?: unknown;
  createdAt?: string;
  nextAttemptAt?: string;
}

export interface DurableRunAttemptTransition {
  outcome?: string;
  executionSessionId?: string | null;
  operationRisk?: DurableRunOperationRisk;
  errorCode?: string;
  errorSummary?: string;
  metadata?: unknown;
}

export interface DurableRunInterruptRequest {
  interruptId: string;
  attemptId: string;
  prompt: string;
  metadata?: unknown;
}

export interface DurableRunTransition {
  status: DurableRunStatus;
  stateVersion: number;
  state: unknown;
  nextRunAt?: string;
  errorCode?: string;
  errorSummary?: string;
  failure?: DurableRunFailure;
  attempt?: DurableRunAttemptTransition;
  deliveries?: readonly DurableRunDeliveryRequest[];
  interrupts?: readonly DurableRunInterruptRequest[];
  supersedeDeliveryKinds?: readonly string[];
}

export type DurableRunPreflight =
  | { action: 'execute' }
  | { action: 'transition'; transition: DurableRunTransition };

export type DurableRunExecutionPhase = 'claimed' | 'execution_started';

export interface DurableRunInterruptedAttempt {
  claim: DurableRunClaim;
  recoveredAt: string;
  executionPhase: DurableRunExecutionPhase;
  operationRisk: DurableRunOperationRisk;
}

export interface DurableRunCreateRequest {
  runId: string;
  workloadKind: string;
  idempotencyKey: string;
  concurrencyKey?: string;
  inputVersion: number;
  input: unknown;
  stateVersion: number;
  state: unknown;
  route: unknown;
  actorOpenId: string;
  createdAt?: string;
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
  eventKey: string;
  kind: string;
  attemptId?: string;
  workerId: string;
  route: unknown;
  idempotencyKey: string;
  payload: unknown;
  attemptCount: number;
  leaseExpiresAt: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorSummary?: string;
  recoveredFromExpiredLease?: boolean;
}

export type DurableRunDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'unknown'
  | 'failed'
  | 'superseded';

export interface DurableRunDeliverySnapshot {
  outboxId: string;
  runId: string;
  eventKey: string;
  kind: string;
  route: unknown;
  payload: unknown;
  status: DurableRunDeliveryStatus;
  attemptCount: number;
  updatedAt: string;
  messageId?: string;
  errorCode?: string;
  errorSummary?: string;
}

export type DurableRunDeliveryResult =
  | { status: 'sent'; messageId: string }
  | {
      status: 'retry';
      errorCode: string;
      errorSummary: string;
      retryAt?: string;
      resetAttemptCount?: boolean;
      terminalConflict?: 'unknown' | 'superseded';
    }
  | {
      status: 'unknown' | 'failed';
      errorCode: string;
      errorSummary: string;
      terminalConflict?: 'unknown' | 'superseded';
    }
  | { status: 'superseded' };

export const DURABLE_RUN_WORKLOAD_JSON_MAX_BYTES = 256 * 1024;
export const DURABLE_RUN_WORKLOAD_JSON_MAX_DEPTH = 64;
export const DURABLE_RUN_DELIVERY_MAX_COUNT = 16;

const DURABLE_RUN_ERROR_CODE_MAX_CHARS = 128;
const DURABLE_RUN_ERROR_SUMMARY_MAX_CHARS = 4_000;
const DURABLE_RUN_DELIVERY_KIND_MAX_CHARS = 128;
const DURABLE_RUN_DELIVERY_IDEMPOTENCY_KEY_MAX_CHARS = 512;
const DURABLE_RUN_FAILURE_HINT_MAX_COUNT = 8;
const DURABLE_RUN_FAILURE_HINT_MAX_CHARS = 500;
const DURABLE_RUN_FAILURE_STEP_MAX_CHARS = 80;
const DURABLE_RUN_FAILURE_DIAGNOSTIC_MAX_CHARS = 1_000;
const DURABLE_RUN_FAILURE_FINGERPRINT_MAX_CHARS = 128;

const FAILURE_CATEGORIES = new Set<DurableRunFailureCategory>([
  'invalid_invocation',
  'transient',
  'authentication_required',
  'permission_required',
  'capability_unavailable',
  'terminal',
  'unknown',
]);
const RETRY_SAFETY_VALUES = new Set<DurableRunRetrySafety>(['safe', 'unsafe', 'unknown']);
const OPERATION_RISKS = new Set<DurableRunOperationRisk>([
  'pure',
  'read_only',
  'idempotent_write',
  'external_side_effect',
  'unknown',
]);

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
  if (transition.nextRunAt !== undefined) {
    assertCanonicalIsoTimestamp(transition.nextRunAt, 'Durable run transition nextRunAt');
  }
  if (transition.errorCode !== undefined) {
    assertBoundedRequiredString(
      transition.errorCode,
      'Durable run transition errorCode',
      DURABLE_RUN_ERROR_CODE_MAX_CHARS,
    );
  }
  if (transition.errorSummary !== undefined) {
    assertBoundedRequiredString(
      transition.errorSummary,
      'Durable run transition errorSummary',
      DURABLE_RUN_ERROR_SUMMARY_MAX_CHARS,
    );
  }
  if (transition.failure !== undefined) assertDurableRunFailure(transition.failure);
  serializeDurableRunJson(transition.state, 'state');
  assertDurableRunDeliveryRequests(transition.deliveries, 'transition');
}

export function assertDurableRunDeliveryRequests(
  deliveriesInput: readonly DurableRunDeliveryRequest[] | undefined,
  context: string,
): void {
  if (deliveriesInput !== undefined && !Array.isArray(deliveriesInput)) {
    throw new Error(`Durable run ${context} deliveries must be an array.`);
  }
  const deliveries = deliveriesInput ?? [];
  if (deliveries.length > DURABLE_RUN_DELIVERY_MAX_COUNT) {
    throw new Error(
      `Durable run ${context} deliveries exceeds ${DURABLE_RUN_DELIVERY_MAX_COUNT} entries.`,
    );
  }
  const deliveryKeys = new Set<string>();
  for (const delivery of deliveries) {
    if (typeof delivery !== 'object' || delivery === null) {
      throw new Error('Durable run delivery must be an object.');
    }
    assertBoundedRequiredString(
      delivery.kind,
      'Durable run delivery kind',
      DURABLE_RUN_DELIVERY_KIND_MAX_CHARS,
    );
    assertBoundedRequiredString(
      delivery.idempotencyKey,
      'Durable run delivery idempotencyKey',
      DURABLE_RUN_DELIVERY_IDEMPOTENCY_KEY_MAX_CHARS,
    );
    if (deliveryKeys.has(delivery.idempotencyKey)) {
      throw new Error(
        `Durable run ${context} has duplicate delivery idempotencyKey: ${delivery.idempotencyKey}`,
      );
    }
    deliveryKeys.add(delivery.idempotencyKey);
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
  let snapshot: JsonValue;
  try {
    snapshot = snapshotJsonValue(value, new Set(), 0);
  } catch {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
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
  const canonicalOccurrence = canonicalScheduledOccurrence(scheduledOccurrence);
  return `cron:${canonicalIdempotencyPart(jobId, 'jobId')}:${requiredRevision(definitionRevision)}:${canonicalIdempotencyPart(canonicalOccurrence, 'scheduledOccurrence')}`;
}

export function cronManualRunIdempotencyKey(
  jobId: string,
  definitionRevision: number,
  requestId: string,
): string {
  return `cron-manual:${canonicalIdempotencyPart(jobId, 'jobId')}:${requiredRevision(definitionRevision)}:${canonicalIdempotencyPart(requestId, 'requestId')}`;
}

type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };

function snapshotJsonValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): JsonValue {
  if (depth > DURABLE_RUN_WORKLOAD_JSON_MAX_DEPTH) throw new Error('JSON depth exceeded.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number.');
    return value;
  }
  if (typeof value !== 'object') throw new Error('Unsupported JSON value.');
  if (ancestors.has(value)) throw new Error('Cyclic JSON value.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error('Non-plain JSON array.');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !('value' in lengthDescriptor)) {
        throw new Error('Invalid JSON array length.');
      }
      const length = lengthDescriptor.value as unknown;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        throw new Error('Invalid JSON array length.');
      }
      const snapshot: JsonValue[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Sparse or accessor JSON array.');
        }
        snapshot.push(snapshotJsonValue(descriptor.value, ancestors, depth + 1));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) continue;
        if (typeof key !== 'string' || !isCanonicalArrayIndex(key, length as number)) {
          throw new Error('Unsupported JSON array property.');
        }
      }
      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Non-plain JSON object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const snapshot: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable) continue;
      if (typeof key !== 'string' || !('value' in descriptor)) {
        throw new Error('Unsupported JSON property.');
      }
      snapshot[key] = snapshotJsonValue(descriptor.value, ancestors, depth + 1);
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function isCanonicalArrayIndex(value: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function canonicalIdempotencyPart(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cron idempotency ${label} is required.`);
  }
  try {
    return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
  } catch {
    throw new Error(`Cron idempotency ${label} must contain valid Unicode.`);
  }
}

function requiredRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Cron definition revision must be a non-negative integer.');
  }
  return value;
}

function canonicalScheduledOccurrence(value: string): string {
  if (typeof value !== 'string' || !isValidIsoTimestamp(value)) {
    throw new Error('Cron idempotency scheduledOccurrence must be a valid timestamp.');
  }
  return new Date(value).toISOString();
}

function assertCanonicalIsoTimestamp(value: string, label: string): void {
  if (!isValidIsoTimestamp(value) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
}

function isValidIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function assertDurableRunFailure(failure: DurableRunFailure): void {
  if (typeof failure !== 'object' || failure === null) {
    throw new Error('Durable run failure must be an object.');
  }
  if (!FAILURE_CATEGORIES.has(failure.category)) {
    throw new Error('Durable run failure category is invalid.');
  }
  if (!RETRY_SAFETY_VALUES.has(failure.retrySafety)) {
    throw new Error('Durable run failure retrySafety is invalid.');
  }
  if (typeof failure.capabilityAvailable !== 'boolean') {
    throw new Error('Durable run failure capabilityAvailable must be boolean.');
  }
  if (!OPERATION_RISKS.has(failure.operationRisk)) {
    throw new Error('Durable run failure operationRisk is invalid.');
  }
  if (!Array.isArray(failure.hints)) {
    throw new Error('Durable run failure hints must be an array.');
  }
  if (failure.hints.length > DURABLE_RUN_FAILURE_HINT_MAX_COUNT) {
    throw new Error(
      `Durable run failure hints exceeds ${DURABLE_RUN_FAILURE_HINT_MAX_COUNT} entries.`,
    );
  }
  for (const hint of failure.hints) {
    assertBoundedRequiredString(
      hint,
      'Durable run failure hint',
      DURABLE_RUN_FAILURE_HINT_MAX_CHARS,
    );
  }
  assertBoundedRequiredString(
    failure.failedStep,
    'Durable run failure failedStep',
    DURABLE_RUN_FAILURE_STEP_MAX_CHARS,
  );
  assertBoundedRequiredString(
    failure.diagnostic,
    'Durable run failure diagnostic',
    DURABLE_RUN_FAILURE_DIAGNOSTIC_MAX_CHARS,
  );
  assertBoundedRequiredString(
    failure.fingerprint,
    'Durable run failure fingerprint',
    DURABLE_RUN_FAILURE_FINGERPRINT_MAX_CHARS,
  );
}

function assertBoundedRequiredString(value: string, label: string, maxChars: number): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (Array.from(value).length > maxChars) {
    throw new Error(`${label} exceeds ${maxChars} characters.`);
  }
}
