import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertDurableRunTransition,
  isDurableRunTerminal,
  serializeDurableRunJson,
  type DurableRunAttempt,
  type DurableRunClaim,
  type DurableRunCreateRequest,
  type DurableRunCreateResult,
  type DurableRunDeliveryClaim,
  type DurableRunDeliveryResult,
  type DurableRunFailure,
  type DurableRunInterruptedAttempt,
  type DurableRunOperationRisk,
  type DurableRunRecord,
  type DurableRunStatus,
  type DurableRunTransition,
} from '../domain/durable-run.js';
import type {
  DurableRunClaimMutationResult,
  DurableRunRepository,
} from '../ports/durable-run.js';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  migrateSqliteToDurableV10,
} from './sqlite-migrations.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

export interface SqliteDurableRunRepositoryOptions {
  databasePath: string;
  deliveryLeaseMs?: number;
}

const DEFAULT_DELIVERY_LEASE_MS = 30_000;

export class SqliteDurableRunRepository implements DurableRunRepository {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly deliveryLeaseMs: number,
    private readonly ownsDatabase: boolean,
  ) {}

  static attach(database: DatabaseSync): SqliteDurableRunRepository {
    return new SqliteDurableRunRepository(database, DEFAULT_DELIVERY_LEASE_MS, false);
  }

  static async open(
    options: SqliteDurableRunRepositoryOptions,
  ): Promise<SqliteDurableRunRepository> {
    const databasePath = path.resolve(options.databasePath);
    await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(databasePath), 0o700);
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
    });
    try {
      await fs.chmod(databasePath, 0o600);
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
      `);
      await retrySqliteBusy(() => database.exec('PRAGMA journal_mode = WAL;'));
      const repository = new SqliteDurableRunRepository(
        database,
        positiveInteger(options.deliveryLeaseMs, DEFAULT_DELIVERY_LEASE_MS),
        true,
      );
      await repository.initialize();
      return repository;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await retrySqliteBusy(() => migrateSqliteToDurableV10(this.database));
  }

  async create(request: DurableRunCreateRequest): Promise<DurableRunCreateResult> {
    validateCreateRequest(request);
    const inputJson = serializeDurableRunJson(request.input, 'Durable Run input');
    const stateJson = serializeDurableRunJson(request.state, 'Durable Run state');
    const routeJson = serializeDurableRunJson(request.route, 'Durable Run route');
    const createdAt = new Date().toISOString();
    return this.transaction(() => {
      const existingByKey = this.readRunBy('idempotency_key = ?', request.idempotencyKey);
      if (existingByKey) return { run: existingByKey, created: false };
      const existingById = this.readRunBy('run_id = ?', request.runId);
      if (existingById) {
        throw new Error(`Durable Run ID ${request.runId} is owned by another idempotency key.`);
      }
      this.database.prepare(`
        INSERT INTO durable_runs (
          run_id, workload_kind, idempotency_key, status,
          input_version, input_json, state_version, state_json, route_json,
          actor_open_id, created_at, next_run_at, expires_at, max_attempts,
          attempt_count, row_version, retained, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)
      `).run(
        request.runId,
        request.workloadKind,
        request.idempotencyKey,
        request.inputVersion,
        inputJson,
        request.stateVersion,
        stateJson,
        routeJson,
        request.actorOpenId,
        createdAt,
        request.nextRunAt,
        request.expiresAt,
        request.maxAttempts,
        createdAt,
      );
      return { run: this.requiredRun(request.runId), created: true };
    });
  }

  async get(runId: string): Promise<DurableRunRecord | null> {
    return this.readRunBy('run_id = ?', runId);
  }

  async claimDue(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<DurableRunClaim | null> {
    if (workloadKinds.length === 0) return null;
    const kinds = uniqueStrings(workloadKinds);
    return this.transaction(() => {
      const placeholders = kinds.map(() => '?').join(', ');
      const candidate = this.database.prepare(`
        SELECT run_id FROM durable_runs
        WHERE workload_kind IN (${placeholders})
          AND status IN ('queued', 'waiting_retry', 'recovering')
          AND next_run_at <= ? AND expires_at > ?
          AND attempt_count < max_attempts
          AND deleted_at IS NULL
        ORDER BY next_run_at, created_at, run_id
        LIMIT 1
      `).get(...kinds, now, now) as SqlRow | undefined;
      if (!candidate) return null;
      const runId = requiredString(candidate, 'run_id');
      const update = this.database.prepare(`
        UPDATE durable_runs
        SET status = 'running', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
            row_version = row_version + 1, updated_at = ?
        WHERE run_id = ?
          AND status IN ('queued', 'waiting_retry', 'recovering')
          AND next_run_at <= ? AND expires_at > ?
          AND attempt_count < max_attempts AND deleted_at IS NULL
      `).run(workerId, leaseExpiresAt, now, now, runId, now, now);
      if (Number(update.changes) !== 1) return null;
      const run = this.requiredRun(runId);
      const attemptId = newAttemptId();
      this.database.prepare(`
        INSERT INTO durable_attempts (
          attempt_id, run_id, ordinal, worker_id, claimed_at,
          heartbeat_at, lease_expires_at, operation_risk, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', '{}')
      `).run(
        attemptId,
        runId,
        run.attemptCount,
        workerId,
        now,
        now,
        leaseExpiresAt,
      );
      return {
        run,
        attempt: this.requiredAttempt(attemptId),
        workerId,
        claimedRowVersion: run.rowVersion,
      };
    });
  }

  async markExecutionStarted(
    claim: DurableRunClaim,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    return this.transaction(() => {
      if (!this.hasLiveClaim(claim, now, true)) return 'stale';
      const update = this.database.prepare(`
        UPDATE durable_attempts
        SET execution_phase = 'execution_started', execution_started_at = ?
        WHERE attempt_id = ? AND run_id = ? AND worker_id = ?
          AND finished_at IS NULL AND execution_phase = 'claimed'
      `).run(now, claim.attempt.attemptId, claim.run.runId, claim.workerId);
      return Number(update.changes) === 1 ? 'committed' : 'stale';
    });
  }

  async heartbeat(
    claim: DurableRunClaim,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    return this.transaction(() => {
      if (!this.hasLiveClaim(claim, now, false)) return false;
      const run = this.database.prepare(`
        UPDATE durable_runs
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE run_id = ? AND status IN ('running', 'cancel_requested')
          AND lease_owner = ? AND row_version = ? AND lease_expires_at > ?
      `).run(
        now,
        leaseExpiresAt,
        now,
        claim.run.runId,
        claim.workerId,
        claim.claimedRowVersion,
        now,
      );
      if (Number(run.changes) !== 1) return false;
      const attempt = this.database.prepare(`
        UPDATE durable_attempts
        SET heartbeat_at = ?, lease_expires_at = ?
        WHERE attempt_id = ? AND run_id = ? AND worker_id = ? AND finished_at IS NULL
      `).run(
        now,
        leaseExpiresAt,
        claim.attempt.attemptId,
        claim.run.runId,
        claim.workerId,
      );
      if (Number(attempt.changes) !== 1) {
        throw new Error(`Durable Run heartbeat lost Attempt ${claim.attempt.attemptId}.`);
      }
      return true;
    });
  }

  async commitTransition(
    claim: DurableRunClaim,
    transition: DurableRunTransition,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    const stateJson = serializeDurableRunJson(transition.state, 'Durable Run transition state');
    const failureJson = transition.failure
      ? serializeDurableRunJson(transition.failure, 'Durable Run transition failure')
      : null;
    const deliveries = (transition.deliveries ?? []).map((delivery) => ({
      ...delivery,
      routeJson: serializeDurableRunJson(delivery.route, 'Durable Run delivery route'),
      payloadJson: serializeDurableRunJson(delivery.payload, 'Durable Run delivery payload'),
    }));
    return this.transaction(() => {
      const current = this.readClaimFence(claim);
      if (
        !current
        || requiredString(current, 'lease_owner') !== claim.workerId
        || !claimCanCommit(current, now)
      ) return 'stale';
      const currentStatus = requiredString(current, 'status') as DurableRunStatus;
      assertDurableRunTransition(currentStatus, transition);
      const completedAt = isDurableRunTerminal(transition.status) ? now : null;
      const nextRunAt = transition.nextRunAt ?? requiredString(current, 'next_run_at');
      const update = this.database.prepare(`
        UPDATE durable_runs
        SET status = ?, state_version = ?, state_json = ?, next_run_at = ?,
            completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, error_code = ?, error_summary = ?, failure_json = ?,
            row_version = row_version + 1, updated_at = ?
        WHERE run_id = ? AND row_version = ?
          AND status IN ('running', 'cancel_requested')
      `).run(
        transition.status,
        transition.stateVersion,
        stateJson,
        nextRunAt,
        completedAt,
        transition.errorCode ?? null,
        transition.errorSummary ?? null,
        failureJson,
        now,
        claim.run.runId,
        claim.claimedRowVersion,
      );
      if (Number(update.changes) !== 1) return 'stale';
      const attempt = this.database.prepare(`
        UPDATE durable_attempts
        SET finished_at = ?, outcome = ?, failure_json = ?, error_code = ?,
            error_summary = ?, recovery_pending = 0
        WHERE attempt_id = ? AND run_id = ? AND finished_at IS NULL
      `).run(
        now,
        transition.status,
        failureJson,
        transition.errorCode ?? null,
        transition.errorSummary ?? null,
        claim.attempt.attemptId,
        claim.run.runId,
      );
      if (Number(attempt.changes) !== 1) {
        throw new Error(`Durable Run transition lost Attempt ${claim.attempt.attemptId}.`);
      }
      for (const delivery of deliveries) {
        const eventKey = deliveryEventKey(delivery.kind, delivery.idempotencyKey);
        this.database.prepare(`
          INSERT INTO durable_outbox (
            outbox_id, run_id, event_key, kind, attempt_id, route_json,
            idempotency_key, payload_json, metadata_json, status,
            attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'pending', 0, ?, ?, ?)
        `).run(
          outboxId(delivery.idempotencyKey),
          claim.run.runId,
          eventKey,
          delivery.kind,
          claim.attempt.attemptId,
          delivery.routeJson,
          delivery.idempotencyKey,
          delivery.payloadJson,
          now,
          now,
          now,
        );
      }
      return 'committed';
    });
  }

  async failAttempt(
    claim: DurableRunClaim,
    failure: DurableRunFailure,
    now: string,
  ): Promise<DurableRunClaimMutationResult> {
    return this.commitTransition(claim, {
      status: 'failed',
      stateVersion: claim.run.stateVersion,
      state: claim.run.state,
      errorCode: 'durable_run_attempt_failed',
      errorSummary: failure.diagnostic,
      failure,
    }, now);
  }

  async recoverExpiredLeases(now: string): Promise<DurableRunInterruptedAttempt[]> {
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT r.run_id, r.row_version, a.attempt_id, a.worker_id,
               a.execution_phase, a.operation_risk, a.recovery_pending
        FROM durable_runs r
        JOIN durable_attempts a ON a.run_id = r.run_id
        WHERE r.status IN ('running', 'cancel_requested')
          AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at <= ?
          AND r.deleted_at IS NULL AND a.finished_at IS NULL
          AND a.ordinal = r.attempt_count
        ORDER BY r.lease_expires_at, r.run_id
      `).all(now) as SqlRow[];
      const interrupted: DurableRunInterruptedAttempt[] = [];
      for (const row of rows) {
        const runId = requiredString(row, 'run_id');
        const oldVersion = requiredNumber(row, 'row_version');
        const recoveryLeaseExpiresAt = addMilliseconds(now, DEFAULT_DELIVERY_LEASE_MS);
        const runUpdate = this.database.prepare(`
          UPDATE durable_runs
          SET lease_expires_at = ?, heartbeat_at = ?,
              row_version = row_version + 1, updated_at = ?
          WHERE run_id = ? AND row_version = ?
            AND status IN ('running', 'cancel_requested')
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `).run(recoveryLeaseExpiresAt, now, now, runId, oldVersion, now);
        if (Number(runUpdate.changes) !== 1) continue;
        const attemptId = requiredString(row, 'attempt_id');
        const attemptUpdate = this.database.prepare(`
          UPDATE durable_attempts
          SET recovery_pending = 1, recovered_at = ?, heartbeat_at = ?, lease_expires_at = ?
          WHERE attempt_id = ? AND run_id = ? AND finished_at IS NULL
            AND recovery_pending = ? AND lease_expires_at <= ?
        `).run(
          now,
          now,
          recoveryLeaseExpiresAt,
          attemptId,
          runId,
          requiredNumber(row, 'recovery_pending'),
          now,
        );
        if (Number(attemptUpdate.changes) !== 1) {
          throw new Error(`Durable Run recovery lost Attempt ${attemptId}.`);
        }
        const run = this.requiredRun(runId);
        const attempt = this.requiredAttempt(attemptId);
        interrupted.push({
          claim: {
            run,
            attempt,
            workerId: requiredString(row, 'worker_id'),
            claimedRowVersion: run.rowVersion,
          },
          recoveredAt: now,
          executionPhase: requiredString(row, 'execution_phase') as 'claimed' | 'execution_started',
          operationRisk: requiredString(row, 'operation_risk') as DurableRunOperationRisk,
        });
      }
      return interrupted;
    });
  }

  async claimDelivery(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
  ): Promise<DurableRunDeliveryClaim | null> {
    if (workloadKinds.length === 0) return null;
    const kinds = uniqueStrings(workloadKinds);
    return this.transaction(() => {
      const placeholders = kinds.map(() => '?').join(', ');
      const row = this.database.prepare(`
        SELECT o.outbox_id
        FROM durable_outbox o
        JOIN durable_runs r ON r.run_id = o.run_id
        WHERE r.workload_kind IN (${placeholders})
          AND (
            (o.status = 'pending' AND o.next_attempt_at <= ?)
            OR (o.status = 'sending' AND o.lease_expires_at IS NOT NULL AND o.lease_expires_at <= ?)
          )
        ORDER BY o.next_attempt_at, o.created_at, o.outbox_id
        LIMIT 1
      `).get(...kinds, now, now) as SqlRow | undefined;
      if (!row) return null;
      const outbox = requiredString(row, 'outbox_id');
      const leaseExpiresAt = addMilliseconds(now, this.deliveryLeaseMs);
      const update = this.database.prepare(`
        UPDATE durable_outbox
        SET status = 'sending', worker_id = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            first_attempt_at = COALESCE(first_attempt_at, ?),
            last_attempt_at = ?, updated_at = ?
        WHERE outbox_id = ? AND (
          (status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
      `).run(workerId, leaseExpiresAt, now, now, now, outbox, now, now);
      return Number(update.changes) === 1
        ? this.requiredDeliveryClaim(outbox, workerId)
        : null;
    });
  }

  async commitDelivery(
    claim: DurableRunDeliveryClaim,
    result: DurableRunDeliveryResult,
    now: string,
  ): Promise<void> {
    this.transaction(() => {
      let update;
      if (result.status === 'sent') {
        update = this.database.prepare(`
          UPDATE durable_outbox
          SET status = 'sent', message_id = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = NULL, error_summary = NULL, updated_at = ?
          WHERE outbox_id = ? AND run_id = ? AND status = 'sending' AND worker_id = ?
        `).run(result.messageId, now, claim.outboxId, claim.runId, claim.workerId);
      } else if (result.status === 'retry') {
        update = this.database.prepare(`
          UPDATE durable_outbox
          SET status = 'pending', next_attempt_at = ?, worker_id = NULL,
              lease_expires_at = NULL, error_code = ?, error_summary = ?, updated_at = ?
          WHERE outbox_id = ? AND run_id = ? AND status = 'sending' AND worker_id = ?
        `).run(
          result.retryAt ?? now,
          result.errorCode,
          result.errorSummary,
          now,
          claim.outboxId,
          claim.runId,
          claim.workerId,
        );
      } else {
        update = this.database.prepare(`
          UPDATE durable_outbox
          SET status = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = ?, error_summary = ?, updated_at = ?
          WHERE outbox_id = ? AND run_id = ? AND status = 'sending' AND worker_id = ?
        `).run(
          result.status,
          result.errorCode,
          result.errorSummary,
          now,
          claim.outboxId,
          claim.runId,
          claim.workerId,
        );
      }
      if (Number(update.changes) !== 1) {
        throw new Error(`Stale Durable Run delivery claim for ${claim.outboxId}.`);
      }
    });
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }

  private readRunBy(where: string, value: string): DurableRunRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM durable_runs WHERE ${where} LIMIT 1
    `).get(value) as SqlRow | undefined;
    return row ? mapRun(row) : null;
  }

  private requiredRun(runId: string): DurableRunRecord {
    const run = this.readRunBy('run_id = ?', runId);
    if (!run) throw new Error(`Durable Run ${runId} disappeared.`);
    return run;
  }

  private requiredAttempt(attemptId: string): DurableRunAttempt {
    const row = this.database.prepare(`
      SELECT * FROM durable_attempts WHERE attempt_id = ?
    `).get(attemptId) as SqlRow | undefined;
    if (!row) throw new Error(`Durable Run Attempt ${attemptId} disappeared.`);
    return mapAttempt(row);
  }

  private requiredDeliveryClaim(outboxId: string, workerId: string): DurableRunDeliveryClaim {
    const row = this.database.prepare(`
      SELECT o.*, r.workload_kind
      FROM durable_outbox o
      JOIN durable_runs r ON r.run_id = o.run_id
      WHERE o.outbox_id = ? AND o.status = 'sending' AND o.worker_id = ?
    `).get(outboxId, workerId) as SqlRow | undefined;
    if (!row) throw new Error(`Durable Run delivery ${outboxId} disappeared.`);
    return {
      outboxId,
      runId: requiredString(row, 'run_id'),
      workloadKind: requiredString(row, 'workload_kind'),
      kind: requiredString(row, 'kind'),
      ...(optionalString(row, 'attempt_id')
        ? { attemptId: optionalString(row, 'attempt_id') }
        : {}),
      workerId,
      route: parseBoundedJson(requiredString(row, 'route_json'), 'Durable Run delivery route'),
      idempotencyKey: requiredString(row, 'idempotency_key'),
      payload: parseBoundedJson(requiredString(row, 'payload_json'), 'Durable Run delivery payload'),
      attemptCount: requiredNumber(row, 'attempt_count'),
    };
  }

  private hasLiveClaim(claim: DurableRunClaim, now: string, requireClaimedPhase: boolean): boolean {
    const row = this.readClaimFence(claim);
    if (!row || requiredString(row, 'lease_owner') !== claim.workerId) return false;
    if (requiredString(row, 'lease_expires_at') <= now) return false;
    if (requiredNumber(row, 'recovery_pending') !== 0) return false;
    return !requireClaimedPhase || requiredString(row, 'execution_phase') === 'claimed';
  }

  private readClaimFence(claim: DurableRunClaim): SqlRow | undefined {
    return this.database.prepare(`
      SELECT r.status, r.row_version, r.next_run_at, r.lease_owner,
             r.lease_expires_at, a.attempt_id, a.worker_id,
             a.execution_phase, a.recovery_pending
      FROM durable_runs r
      JOIN durable_attempts a ON a.run_id = r.run_id
      WHERE r.run_id = ? AND r.row_version = ?
        AND r.status IN ('running', 'cancel_requested')
        AND a.attempt_id = ? AND a.worker_id = ? AND a.finished_at IS NULL
        AND a.ordinal = r.attempt_count
    `).get(
      claim.run.runId,
      claim.claimedRowVersion,
      claim.attempt.attemptId,
      claim.workerId,
    ) as SqlRow | undefined;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK;');
      } catch {
        // Preserve the operation error.
      }
      throw error;
    }
  }
}

function validateCreateRequest(request: DurableRunCreateRequest): void {
  for (const [label, value] of [
    ['runId', request.runId],
    ['workloadKind', request.workloadKind],
    ['idempotencyKey', request.idempotencyKey],
    ['actorOpenId', request.actorOpenId],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Durable Run ${label} is required.`);
    }
  }
  if (!Number.isSafeInteger(request.inputVersion) || request.inputVersion < 1) {
    throw new Error('Durable Run inputVersion must be a positive integer.');
  }
  if (!Number.isSafeInteger(request.stateVersion) || request.stateVersion < 1) {
    throw new Error('Durable Run stateVersion must be a positive integer.');
  }
  if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 20) {
    throw new Error('Durable Run maxAttempts must be an integer between 1 and 20.');
  }
  assertTimestamp(request.nextRunAt, 'nextRunAt');
  assertTimestamp(request.expiresAt, 'expiresAt');
}

function mapRun(row: SqlRow): DurableRunRecord {
  return {
    runId: requiredString(row, 'run_id'),
    workloadKind: requiredString(row, 'workload_kind'),
    idempotencyKey: requiredString(row, 'idempotency_key'),
    status: requiredString(row, 'status') as DurableRunStatus,
    inputVersion: requiredNumber(row, 'input_version'),
    input: parseBoundedJson(requiredString(row, 'input_json'), 'Durable Run input'),
    stateVersion: requiredNumber(row, 'state_version'),
    state: parseBoundedJson(requiredString(row, 'state_json'), 'Durable Run state'),
    route: parseBoundedJson(requiredString(row, 'route_json'), 'Durable Run route'),
    actorOpenId: requiredString(row, 'actor_open_id'),
    nextRunAt: requiredString(row, 'next_run_at'),
    expiresAt: requiredString(row, 'expires_at'),
    maxAttempts: requiredNumber(row, 'max_attempts'),
    attemptCount: requiredNumber(row, 'attempt_count'),
    rowVersion: requiredNumber(row, 'row_version'),
  };
}

function mapAttempt(row: SqlRow): DurableRunAttempt {
  return {
    attemptId: requiredString(row, 'attempt_id'),
    runId: requiredString(row, 'run_id'),
    ordinal: requiredNumber(row, 'ordinal'),
    workerId: requiredString(row, 'worker_id'),
    claimedAt: requiredString(row, 'claimed_at'),
    heartbeatAt: requiredString(row, 'heartbeat_at'),
    leaseExpiresAt: requiredString(row, 'lease_expires_at'),
    ...(optionalString(row, 'execution_started_at')
      ? { executionStartedAt: optionalString(row, 'execution_started_at') }
      : {}),
  };
}

function claimCanCommit(row: SqlRow, now: string): boolean {
  if (requiredNumber(row, 'recovery_pending') === 1) return true;
  return requiredString(row, 'lease_expires_at') > now;
}

function parseBoundedJson(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  serializeDurableRunJson(parsed, label);
  return parsed;
}

function requiredString(row: SqlRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== 'string') throw new Error(`Expected SQLite text field ${key}.`);
  return value;
}

function optionalString(row: SqlRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected optional SQLite text field ${key}.`);
  return value;
}

function requiredNumber(row: SqlRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Expected SQLite numeric field ${key}.`);
  }
  return Number(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Durable Run workload kinds must be non-empty strings.');
  }
  return unique;
}

function deliveryEventKey(kind: string, idempotencyKey: string): string {
  return `${kind}:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function outboxId(idempotencyKey: string): string {
  return `outbox_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

function newAttemptId(): string {
  return `attempt_${randomBytes(16).toString('hex')}`;
}

function addMilliseconds(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Durable Run timestamp is invalid.');
  return new Date(timestamp + milliseconds).toISOString();
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Durable Run ${label} is invalid.`);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive integer.');
  return value;
}

async function retrySqliteBusy<T>(operation: () => T, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() - started >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/iu.test(error.message);
}

export { DURABLE_RUN_SCHEMA_VERSION };
