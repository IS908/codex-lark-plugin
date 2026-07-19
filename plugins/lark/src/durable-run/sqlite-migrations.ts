import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { serializeDurableRunJson } from '../domain/durable-run.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

export const DURABLE_RUN_SCHEMA_VERSION = 10;
export const ASYNC_TASK_INPUT_VERSION = 1;
export const ASYNC_TASK_STATE_VERSION = 1;

const CONTINUATION_COMPATIBILITY_VIEWS = [
  'continuation_attempts',
  'continuation_interrupts',
  'continuation_jobs',
  'continuation_outbox',
  'continuation_tool_calls',
] as const;
const LEGACY_CONTINUATION_COMPATIBILITY_TRIGGERS = CONTINUATION_COMPATIBILITY_VIEWS.flatMap(
  (view) => ['insert', 'update', 'delete'].map((operation) => `${view}_${operation}`),
);

export function migrateSqliteToDurableV10(database: DatabaseSync): void {
  const version = scalarNumber(database, 'PRAGMA user_version');
  if (version > DURABLE_RUN_SCHEMA_VERSION && version !== 70) {
    throw new Error(
      `Unsupported durable run database schema version ${version}; expected at most ${DURABLE_RUN_SCHEMA_VERSION}.`,
    );
  }
  if (version === DURABLE_RUN_SCHEMA_VERSION) {
    hardenDurableAttemptOwnership(database);
    assertDurableSchema(database);
    return;
  }
  if (version !== 0 && version !== 70 && (version < 1 || version > 9)) {
    throw new Error(`Unsupported continuation database schema version ${version}.`);
  }

  immediateTransaction(database, () => {
    const currentVersion = scalarNumber(database, 'PRAGMA user_version');
    if (currentVersion === DURABLE_RUN_SCHEMA_VERSION) return;
    if (currentVersion === 0) {
      createDurableSchema(database);
      database.exec(`PRAGMA user_version = ${DURABLE_RUN_SCHEMA_VERSION};`);
      return;
    }
    migrateContinuationRows(database, currentVersion);
    database.exec(`PRAGMA user_version = ${DURABLE_RUN_SCHEMA_VERSION};`);
  });
  assertDurableSchema(database);
}

export function installContinuationCompatibilitySchema(database: DatabaseSync): void {
  immediateTransaction(database, () => {
    database.exec([
      ...LEGACY_CONTINUATION_COMPATIBILITY_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`),
      ...CONTINUATION_COMPATIBILITY_VIEWS.map((name) => `DROP VIEW IF EXISTS ${name};`),
    ].join('\n'));

    database.exec(`
    CREATE VIEW continuation_jobs AS
    SELECT
      r.run_id AS job_id,
      r.idempotency_key,
      json_extract(r.state_json, '$.job.retryOfJobId') AS retry_of_job_id,
      r.actor_open_id AS creator_open_id,
      json_extract(r.route_json, '$.kind') AS origin_kind,
      r.route_json,
      json_extract(r.state_json, '$.job.sourceMessageId') AS source_message_id,
      json_extract(r.state_json, '$.job.sourceThreadId') AS source_thread_id,
      json_extract(r.state_json, '$.job.title') AS title,
      json_extract(r.state_json, '$.job.objective') AS objective,
      json_extract(r.state_json, '$.job.acceptanceCriteria') AS acceptance_criteria_json,
      json_extract(r.state_json, '$.job.contextSnapshot') AS context_snapshot_json,
      json_extract(r.state_json, '$.job.sourceFacts') AS source_facts_json,
      json_extract(r.state_json, '$.job.taskContract') AS task_contract_json,
      json_extract(r.state_json, '$.job.requiredTools') AS required_tools_json,
      json_extract(r.state_json, '$.job.workingDirectory') AS working_directory,
      json_extract(r.state_json, '$.job.permissions') AS permissions_json,
      json_extract(r.state_json, '$.job.model') AS model,
      json_extract(r.state_json, '$.job.parentSessionId') AS parent_session_id,
      r.max_attempts,
      json_extract(r.state_json, '$.job.maxRetries') AS max_retries,
      json_extract(r.state_json, '$.job.timeoutSeconds') AS timeout_seconds,
      r.created_at,
      r.expires_at,
      r.row_version,
      r.status,
      json_extract(r.state_json, '$.job.executionSessionId') AS execution_session_id,
      json_extract(r.state_json, '$.job.checkpoint') AS checkpoint_json,
      COALESCE(json_extract(r.state_json, '$.job.noProgressCount'), 0) AS no_progress_count,
      json_extract(r.state_json, '$.job.recovery') AS recovery_json,
      COALESCE(json_extract(r.state_json, '$.job.recoveryTotalCount'), 0) AS recovery_total_count,
      COALESCE(json_extract(r.state_json, '$.job.recoveryFingerprintCounts'), '{}')
        AS recovery_fingerprint_counts_json,
      COALESCE(json_extract(r.state_json, '$.job.stepCount'), 0) AS step_count,
      COALESCE(json_extract(r.state_json, '$.job.failureCount'), 0) AS failure_count,
      r.next_run_at,
      r.lease_owner,
      r.lease_expires_at,
      r.heartbeat_at,
      json_extract(r.state_json, '$.job.resultSummary') AS result_summary,
      COALESCE(json_extract(r.state_json, '$.job.resultArtifacts'), '[]') AS result_artifacts_json,
      r.error_code,
      r.error_summary,
      json_extract(r.state_json, '$.job.startedAt') AS started_at,
      r.updated_at,
      r.completed_at,
      r.deleted_at,
      r.retained AS retain
    FROM durable_runs r
    WHERE r.workload_kind = 'async_task';

    `);
    installContinuationAttemptView(database);
    installContinuationOutboxView(database);
    installContinuationOperationReceiptView(database);
    installContinuationInterruptView(database);
    assertContinuationCompatibilitySchema(database);
  });
}

function installContinuationAttemptView(database: DatabaseSync): void {
  database.exec(`
    CREATE VIEW continuation_attempts AS
    SELECT
      a.attempt_id,
      a.run_id AS job_id,
      a.ordinal,
      a.worker_id,
      a.execution_session_id,
      a.claimed_at AS started_at,
      a.heartbeat_at,
      a.finished_at,
      a.outcome,
      a.error_code,
      a.error_summary,
      a.execution_phase,
      json_extract(a.metadata_json, '$.recovery') AS recovery_json,
      json_extract(a.metadata_json, '$.stepId') AS step_id,
      json_extract(a.metadata_json, '$.delta') AS delta_json,
      json_extract(a.metadata_json, '$.verification') AS verification_json
    FROM durable_attempts a
    JOIN durable_runs r ON r.run_id = a.run_id
    WHERE r.workload_kind = 'async_task';
  `);
}

function installContinuationOutboxView(database: DatabaseSync): void {
  database.exec(`
    CREATE VIEW continuation_outbox AS
    SELECT
      o.outbox_id,
      o.run_id AS job_id,
      o.event_key,
      o.kind,
      o.attempt_id,
      o.route_json,
      o.idempotency_key,
      json_extract(o.payload_json, '$') AS payload,
      CASE o.status WHEN 'sent' THEN 'delivered' WHEN 'unknown' THEN 'delivery_unknown'
        ELSE o.status END AS status,
      o.attempt_count,
      o.next_attempt_at,
      o.worker_id,
      o.lease_expires_at,
      o.first_attempt_at,
      o.last_attempt_at,
      o.message_id,
      o.error_code,
      o.error_summary,
      o.created_at,
      o.updated_at
    FROM durable_outbox o
    JOIN durable_runs r ON r.run_id = o.run_id
    WHERE r.workload_kind = 'async_task';
  `);
}

function installContinuationOperationReceiptView(database: DatabaseSync): void {
  database.exec(`
    CREATE VIEW continuation_tool_calls AS
    SELECT
      receipt.receipt_id AS call_id,
      receipt.run_id AS job_id,
      COALESCE(json_extract(receipt.metadata_json, '$.stepIndex'), 0) AS step_index,
      COALESCE(json_extract(receipt.metadata_json, '$.stepId'), receipt.operation_key) AS step_id,
      receipt.attempt_id,
      receipt.operation_name AS tool_name,
      receipt.request_hash,
      receipt.status,
      receipt.result_json,
      receipt.started_at,
      receipt.completed_at,
      receipt.updated_at
    FROM durable_operation_receipts receipt
    JOIN durable_runs r ON r.run_id = receipt.run_id
    WHERE r.workload_kind = 'async_task';
  `);
}

function installContinuationInterruptView(database: DatabaseSync): void {
  database.exec(`
    CREATE VIEW continuation_interrupts AS
    SELECT
      i.interrupt_id,
      i.run_id AS job_id,
      i.attempt_id,
      i.status,
      i.prompt,
      i.response_text,
      i.created_at,
      i.resolved_at
    FROM durable_interrupts i
    JOIN durable_runs r ON r.run_id = i.run_id
    WHERE r.workload_kind = 'async_task';
  `);
}

export function createDurableSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_runs (
      run_id TEXT PRIMARY KEY,
      workload_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'waiting_retry', 'waiting_user', 'recovering',
        'completed', 'partial', 'blocked', 'failed', 'cancel_requested', 'cancelled'
      )),
      input_version INTEGER NOT NULL CHECK(input_version >= 1),
      input_json TEXT NOT NULL CHECK(json_valid(input_json)),
      state_version INTEGER NOT NULL CHECK(state_version >= 1),
      state_json TEXT NOT NULL CHECK(json_valid(state_json)),
      route_json TEXT NOT NULL CHECK(json_valid(route_json)),
      actor_open_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      row_version INTEGER NOT NULL CHECK(row_version >= 1),
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      error_code TEXT,
      error_summary TEXT,
      failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
      retained INTEGER NOT NULL DEFAULT 0 CHECK(retained IN (0, 1)),
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_runs_due_idx
      ON durable_runs(workload_kind, status, next_run_at, created_at)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS durable_runs_actor_idx
      ON durable_runs(actor_open_id, created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS durable_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      worker_id TEXT NOT NULL,
      execution_session_id TEXT,
      claimed_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      execution_started_at TEXT,
      finished_at TEXT,
      execution_phase TEXT NOT NULL DEFAULT 'claimed'
        CHECK(execution_phase IN ('claimed', 'execution_started')),
      operation_risk TEXT NOT NULL DEFAULT 'unknown'
        CHECK(operation_risk IN (
          'pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown'
        )),
      outcome TEXT,
      failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
      error_code TEXT,
      error_summary TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      recovery_pending INTEGER NOT NULL DEFAULT 0 CHECK(recovery_pending IN (0, 1)),
      recovered_at TEXT,
      UNIQUE(run_id, ordinal),
      UNIQUE(run_id, attempt_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_attempts_active_idx
      ON durable_attempts(run_id, finished_at, ordinal DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS durable_attempts_run_attempt_idx
      ON durable_attempts(run_id, attempt_id);

    CREATE TABLE IF NOT EXISTS durable_outbox (
      outbox_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      attempt_id TEXT,
      route_json TEXT NOT NULL CHECK(json_valid(route_json)),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'sending', 'sent', 'unknown', 'failed', 'superseded'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      worker_id TEXT,
      lease_expires_at TEXT,
      first_attempt_at TEXT,
      last_attempt_at TEXT,
      message_id TEXT,
      error_code TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, event_key),
      FOREIGN KEY(run_id, attempt_id)
        REFERENCES durable_attempts(run_id, attempt_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_outbox_due_idx
      ON durable_outbox(status, next_attempt_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS durable_outbox_message_id_idx
      ON durable_outbox(message_id) WHERE message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS durable_operation_receipts (
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      attempt_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      operation_risk TEXT NOT NULL DEFAULT 'unknown'
        CHECK(operation_risk IN (
          'pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown'
        )),
      status TEXT NOT NULL CHECK(status IN ('running', 'completed')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      UNIQUE(run_id, operation_key, request_hash),
      FOREIGN KEY(run_id, attempt_id)
        REFERENCES durable_attempts(run_id, attempt_id)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS durable_operation_receipts_running_idx
      ON durable_operation_receipts(run_id, operation_key) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS durable_interrupts (
      interrupt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      attempt_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
      prompt TEXT NOT NULL,
      response_text TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      UNIQUE(run_id, attempt_id),
      FOREIGN KEY(run_id, attempt_id)
        REFERENCES durable_attempts(run_id, attempt_id)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS durable_interrupts_active_run_idx
      ON durable_interrupts(run_id) WHERE status = 'pending';
  `);
}

function migrateContinuationRows(database: DatabaseSync, version: number): void {
  const legacyCounts = {
    runs: tableCount(database, 'continuation_jobs'),
    attempts: tableCount(database, 'continuation_attempts'),
    outbox: tableCount(database, 'continuation_outbox'),
    receipts: tableCount(database, 'continuation_tool_calls'),
    interrupts: tableCount(database, 'continuation_interrupts'),
  };
  createDurableSchema(database);
  if (tableCount(database, 'durable_runs') !== 0) {
    throw new Error('Durable Run v10 migration requires empty target tables.');
  }

  const jobs = database.prepare('SELECT * FROM continuation_jobs ORDER BY job_id').all() as SqlRow[];
  const attemptCounts = countAttempts(database);
  const interrupts = readRows(database, 'continuation_interrupts');
  const attempts = readRows(database, 'continuation_attempts');
  const attemptById = new Map(attempts.map((row) => [requiredString(row, 'attempt_id'), row]));

  const insertRun = database.prepare(`
    INSERT INTO durable_runs (
      run_id, workload_kind, idempotency_key, status,
      input_version, input_json, state_version, state_json, route_json,
      actor_open_id, created_at, next_run_at, expires_at, completed_at,
      max_attempts, attempt_count, row_version, lease_owner, lease_expires_at,
      heartbeat_at, error_code, error_summary, retained, deleted_at, updated_at
    ) VALUES (
      ?, 'async_task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const invalidRunIds = new Set<string>();
  for (const row of jobs) {
    const jobId = requiredString(row, 'job_id');
    let invalidRun = false;
    let job: ReturnType<typeof migrateContinuationJob>;
    try {
      job = migrateContinuationJob(
        row,
        attemptCounts.get(jobId) ?? 0,
        interrupts,
        database,
      );
    } catch {
      invalidRunIds.add(jobId);
      invalidRun = true;
      job = corruptContinuationTombstone(row, attemptCounts.get(jobId) ?? 0);
    }
    const inputJson = serializeDurableRunJson(
      { schemaVersion: 1, job },
      `migrated Async Task input for ${job.jobId}`,
    );
    const stateJson = serializeDurableRunJson(
      { schemaVersion: 1, job },
      `migrated Async Task state for ${job.jobId}`,
    );
    insertRun.run(
      job.jobId,
      job.idempotencyKey,
      job.status,
      ASYNC_TASK_INPUT_VERSION,
      inputJson,
      ASYNC_TASK_STATE_VERSION,
      stateJson,
      serializeDurableRunJson(job.route, `migrated route for ${job.jobId}`),
      job.creatorOpenId,
      job.createdAt,
      job.nextRunAt,
      job.expiresAt,
      optionalString(row, 'completed_at')
        ?? (invalidRun ? requiredString(row, 'updated_at') : null),
      job.maxAttempts,
      job.attemptCount,
      job.rowVersion,
      invalidRun ? null : optionalString(row, 'lease_owner') ?? null,
      invalidRun ? null : optionalString(row, 'lease_expires_at') ?? null,
      invalidRun ? null : optionalString(row, 'heartbeat_at') ?? null,
      invalidRun
        ? 'continuation_persisted_state_invalid'
        : optionalString(row, 'error_code') ?? null,
      invalidRun
        ? 'Stored task state failed integrity validation.'
        : optionalString(row, 'error_summary') ?? null,
      invalidRun ? 0 : numberOr(row, 'retain', 0) === 1 ? 1 : 0,
      optionalString(row, 'deleted_at') ?? null,
      requiredString(row, 'updated_at'),
    );
  }

  migrateAttempts(database, attempts, invalidRunIds);
  migrateOutbox(database, version, invalidRunIds);
  migrateOperationReceipts(database, attemptById);
  migrateInterrupts(database);

  assertCount(database, 'durable_runs', legacyCounts.runs);
  assertCount(database, 'durable_attempts', legacyCounts.attempts);
  assertCount(database, 'durable_outbox', legacyCounts.outbox);
  assertCount(database, 'durable_operation_receipts', legacyCounts.receipts);
  assertCount(database, 'durable_interrupts', legacyCounts.interrupts);
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error('Durable Run v10 migration failed foreign-key validation.');
  }

  database.exec(`
    DROP TABLE IF EXISTS continuation_interrupts;
    DROP TABLE IF EXISTS continuation_outbox;
    DROP TABLE IF EXISTS continuation_tool_calls;
    DROP TABLE IF EXISTS continuation_attempts;
    DROP TABLE IF EXISTS continuation_jobs;
  `);
}

function migrateAttempts(
  database: DatabaseSync,
  rows: SqlRow[],
  invalidRunIds: ReadonlySet<string>,
): void {
  const insert = database.prepare(`
    INSERT INTO durable_attempts (
      attempt_id, run_id, ordinal, worker_id, execution_session_id,
      claimed_at, heartbeat_at, lease_expires_at, execution_started_at,
      finished_at, execution_phase, operation_risk, outcome, error_code,
      error_summary, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const runId = requiredString(row, 'job_id');
    const invalidRun = invalidRunIds.has(runId);
    const phase = optionalString(row, 'execution_phase')
      ?? (optionalString(row, 'finished_at') ? 'claimed' : 'execution_started');
    const heartbeatAt = requiredString(row, 'heartbeat_at');
    const finishedAt = optionalString(row, 'finished_at')
      ?? (invalidRun ? heartbeatAt : null);
    insert.run(
      requiredString(row, 'attempt_id'),
      runId,
      requiredNumber(row, 'ordinal'),
      requiredString(row, 'worker_id'),
      optionalString(row, 'execution_session_id') ?? null,
      requiredString(row, 'started_at'),
      heartbeatAt,
      attemptLeaseExpiry(database, row, heartbeatAt),
      phase === 'execution_started' ? requiredString(row, 'started_at') : null,
      finishedAt,
      phase,
      invalidRun ? 'error' : optionalString(row, 'outcome') ?? null,
      invalidRun
        ? 'continuation_persisted_state_invalid'
        : optionalString(row, 'error_code') ?? null,
      invalidRun
        ? 'Stored task state failed integrity validation.'
        : optionalString(row, 'error_summary') ?? null,
      serializeDurableRunJson({
        stepIndex: numberOr(row, 'step_index', requiredNumber(row, 'ordinal') - 1),
        stepId: optionalString(row, 'step_id') ?? null,
        delta: parseOptionalJson(row.delta_json),
        verification: parseOptionalJson(row.verification_json),
        recovery: parseOptionalJson(row.recovery_json),
      }, `migrated Attempt metadata for ${requiredString(row, 'attempt_id')}`),
    );
  }
}

function migrateOutbox(
  database: DatabaseSync,
  version: number,
  invalidRunIds: ReadonlySet<string>,
): void {
  const rows = readRows(database, 'continuation_outbox');
  const insert = database.prepare(`
    INSERT INTO durable_outbox (
      outbox_id, run_id, event_key, kind, attempt_id, route_json,
      idempotency_key, payload_json, metadata_json, status, attempt_count,
      next_attempt_at, worker_id, lease_expires_at, first_attempt_at,
      last_attempt_at, message_id, error_code, error_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const runId = requiredString(row, 'job_id');
    const migratedRun = database.prepare(`
      SELECT route_json FROM durable_runs WHERE run_id = ? AND workload_kind = 'async_task'
    `).get(runId) as SqlRow | undefined;
    if (!migratedRun) throw new Error(`Migrated Async Task run ${runId} is missing.`);
    const eventKey = optionalString(row, 'event_key') ?? 'terminal';
    const kind = optionalString(row, 'kind') ?? 'terminal';
    const invalidRun = invalidRunIds.has(runId);
    const legacyStatus = requiredString(row, 'status');
    const legacyRouteJson = normalizeJsonText(requiredString(row, 'route_json'));
    const runRouteJson = requiredString(migratedRun, 'route_json');
    const routeMatches = continuationRoutesMatch(legacyRouteJson, runRouteJson);
    const payload = invalidRun ? '' : requiredString(row, 'payload');
    const status = invalidRun || !routeMatches
      ? invalidMigrationDeliveryStatus(legacyStatus)
      : migrateDeliveryStatus(legacyStatus);
    insert.run(
      requiredString(row, 'outbox_id'),
      runId,
      eventKey,
      kind,
      optionalString(row, 'attempt_id') ?? null,
      routeMatches ? runRouteJson : legacyRouteJson,
      requiredString(row, 'idempotency_key'),
      serializeDurableRunJson(payload, `migrated outbox payload for ${runId}`),
      serializeDurableRunJson({ legacySchemaVersion: version }, `migrated outbox metadata for ${runId}`),
      status,
      requiredNumber(row, 'attempt_count'),
      requiredString(row, 'next_attempt_at'),
      optionalString(row, 'worker_id') ?? null,
      optionalString(row, 'lease_expires_at') ?? null,
      optionalString(row, 'first_attempt_at') ?? null,
      optionalString(row, 'last_attempt_at') ?? null,
      optionalString(row, 'message_id') ?? null,
      (invalidRun || !routeMatches) && status !== 'sent'
        ? invalidRun
          ? 'continuation_persisted_state_invalid'
          : 'continuation_delivery_route_mismatch'
        : optionalString(row, 'error_code') ?? null,
      (invalidRun || !routeMatches) && status !== 'sent'
        ? invalidRun
          ? 'Stored task state failed integrity validation.'
          : 'Legacy delivery route does not match its Async Task route.'
        : optionalString(row, 'error_summary') ?? null,
      requiredString(row, 'created_at'),
      requiredString(row, 'updated_at'),
    );
  }
}

function migrateOperationReceipts(
  database: DatabaseSync,
  attemptById: ReadonlyMap<string, SqlRow>,
): void {
  const rows = readRows(database, 'continuation_tool_calls');
  const insert = database.prepare(`
    INSERT INTO durable_operation_receipts (
      receipt_id, run_id, attempt_id, operation_key, operation_name,
      request_hash, operation_risk, status, result_json, started_at,
      completed_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const attemptId = requiredString(row, 'attempt_id');
    const stepIndex = requiredNumber(row, 'step_index');
    const stepId = migratedOperationStepId(database, row, stepIndex);
    const result = parseOptionalJson(row.result_json);
    insert.run(
      requiredString(row, 'call_id'),
      requiredString(row, 'job_id'),
      attemptId,
      stepId,
      requiredString(row, 'tool_name'),
      requiredString(row, 'request_hash'),
      inferOperationRisk(result, attemptById.get(attemptId)),
      requiredString(row, 'status'),
      result === null ? null : serializeDurableRunJson(result, `migrated operation receipt ${attemptId}`),
      requiredString(row, 'started_at'),
      optionalString(row, 'completed_at') ?? null,
      requiredString(row, 'updated_at'),
      serializeDurableRunJson({ stepIndex, stepId }, `migrated operation metadata ${attemptId}`),
    );
  }
}

function migratedOperationStepId(database: DatabaseSync, row: SqlRow, stepIndex: number): string {
  const explicit = optionalString(row, 'step_id');
  if (explicit && !/^initial-step$|^legacy-step-\d+$/u.test(explicit)) return explicit;

  const runId = requiredString(row, 'job_id');
  const run = database.prepare(`
    SELECT state_json, status FROM durable_runs
    WHERE run_id = ? AND workload_kind = 'async_task'
  `).get(runId) as SqlRow | undefined;
  const envelope = parseOptionalJson(run?.state_json);
  const job = isRecord(envelope) && isRecord(envelope.job) ? envelope.job : undefined;
  if (job) {
    const checkpointValue = isRecord(job.checkpoint) ? job.checkpoint : undefined;
    const stepCount = typeof job.stepCount === 'number' ? job.stepCount : undefined;
    if (checkpointValue && stepIndex === stepCount) {
      const nextAction = isRecord(checkpointValue.nextAction) ? checkpointValue.nextAction : undefined;
      const current = typeof nextAction?.id === 'string'
        ? nextAction.id
        : typeof checkpointValue.currentStepId === 'string'
          ? checkpointValue.currentStepId
          : undefined;
      if (current && current !== 'initial-step') return current;
    }

    const context = isRecord(job.contextSnapshot) ? job.contextSnapshot : undefined;
    const completed = context && Array.isArray(context.completedSteps)
      ? context.completedSteps.filter((value): value is string => typeof value === 'string')
      : [];
    if (completed[stepIndex]) return legacyOperationStepId(stepIndex, completed[stepIndex]);
    const remaining = context && Array.isArray(context.remainingSteps)
      ? context.remainingSteps.filter((value): value is string => typeof value === 'string')
      : [];
    const remainingIndex = stepIndex - completed.length;
    if (remainingIndex >= 0 && remaining[remainingIndex]) {
      return legacyOperationStepId(stepIndex, remaining[remainingIndex]);
    }
    if (
      stepIndex === 0
      && stepCount === 0
      && !checkpointValue
      && completed.length === 0
      && remaining.length === 0
    ) return 'initial-step';
  }

  const identity = [
    runId,
    String(stepIndex),
    requiredString(row, 'call_id'),
    requiredString(row, 'tool_name'),
    requiredString(row, 'request_hash'),
  ].join('\0');
  const status = optionalString(run, 'status');
  if (status && !isMigratedTerminalStatus(status)) {
    throw new Error(
      `Durable Run migration cannot map operation receipt ${requiredString(row, 'call_id')} `
      + `for active run ${runId}.`,
    );
  }
  return `legacy-unmapped-step-${stepIndex + 1}-${stableHash(identity)}`;
}

function isMigratedTerminalStatus(status: string): boolean {
  return ['completed', 'partial', 'blocked', 'failed', 'cancelled'].includes(status);
}

function legacyOperationStepId(stepIndex: number, description: string): string {
  return `legacy-step-${stepIndex + 1}-${stableHash(description)}`;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function migrateInterrupts(database: DatabaseSync): void {
  const rows = readRows(database, 'continuation_interrupts');
  const insert = database.prepare(`
    INSERT INTO durable_interrupts (
      interrupt_id, run_id, attempt_id, status, prompt, response_text,
      created_at, resolved_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `);
  for (const row of rows) {
    insert.run(
      requiredString(row, 'interrupt_id'),
      requiredString(row, 'job_id'),
      requiredString(row, 'attempt_id'),
      requiredString(row, 'status'),
      requiredString(row, 'prompt'),
      optionalString(row, 'response_text') ?? null,
      requiredString(row, 'created_at'),
      optionalString(row, 'resolved_at') ?? null,
    );
  }
}

function migrateContinuationJob(
  row: SqlRow,
  attemptCount: number,
  interruptRows: SqlRow[],
  database: DatabaseSync,
): Record<string, unknown> & {
  jobId: string;
  idempotencyKey: string;
  creatorOpenId: string;
  route: unknown;
  status: string;
  createdAt: string;
  nextRunAt: string;
  expiresAt: string;
  maxAttempts: number;
  attemptCount: number;
  rowVersion: number;
} {
  const jobId = requiredString(row, 'job_id');
  const sourceThreadId = optionalString(row, 'source_thread_id');
  const sourceMessageId = requiredString(row, 'source_message_id');
  const route = migrateContinuationRoute(row, jobId, sourceMessageId, sourceThreadId);
  const creatorOpenId = requiredString(row, 'creator_open_id');
  const title = requiredString(row, 'title');
  const objective = requiredString(row, 'objective');
  const acceptanceCriteria = stringArray(
    parseRequiredJson(row.acceptance_criteria_json, `${jobId}.acceptanceCriteria`),
  );
  const contextSnapshot = checkpoint(
    parseRequiredJson(row.context_snapshot_json, `${jobId}.contextSnapshot`),
  );
  const workingDirectory = requiredString(row, 'working_directory');
  const requiredTools = stringArray(
    parseRequiredJson(row.required_tools_json, `${jobId}.requiredTools`),
  );
  const permissions = persistedPermissions(row, workingDirectory, requiredTools);
  const model = optionalString(row, 'model');
  const sourceFacts = persistedSourceFacts(row, {
    route,
    creatorOpenId,
    sourceMessageId,
    sourceThreadId,
    workingDirectory,
    model,
    permissions,
  });
  const taskContract = persistedTaskContract(row, {
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    legacyUnavailable: sourceFacts.provenance === 'legacy_unavailable',
  });
  const checkpointValue = parseOptionalJson(row.checkpoint_json);
  const checkpointV2 = checkpointValue === null
    ? undefined
    : migrateCheckpointV2(checkpointValue);
  const latestAttempt = latestAttemptRow(database, jobId);
  const interrupt = latestInterrupt(jobId, interruptRows, database);
  const maxAttempts = 'max_attempts' in row
    ? clampInteger(requiredNumber(row, 'max_attempts'), 1, 20)
    : clampInteger(requiredNumber(row, 'max_steps'), 1, 5);
  const recovery = parseOptionalJson(row.recovery_json);
  const recoveryCounts = parseOptionalJson(row.recovery_fingerprint_counts_json) ?? {};
  const job: Record<string, unknown> = {
    jobId,
    idempotencyKey: requiredString(row, 'idempotency_key'),
    creatorOpenId,
    route,
    sourceMessageId,
    title,
    objective,
    acceptanceCriteria,
    contextSnapshot,
    sourceFacts,
    taskContract,
    requiredTools,
    workingDirectory,
    permissions,
    maxAttempts,
    maxRetries: requiredNumber(row, 'max_retries'),
    timeoutSeconds: requiredNumber(row, 'timeout_seconds'),
    createdAt: requiredString(row, 'created_at'),
    expiresAt: requiredString(row, 'expires_at'),
    rowVersion: requiredNumber(row, 'row_version'),
    status: requiredString(row, 'status'),
    recoveryTotalCount: numberOr(row, 'recovery_total_count', 0),
    recoveryFingerprintCounts: isRecord(recoveryCounts) ? recoveryCounts : {},
    noProgressCount: numberOr(row, 'no_progress_count', 0),
    attemptCount,
    stepCount: requiredNumber(row, 'step_count'),
    failureCount: requiredNumber(row, 'failure_count'),
    nextRunAt: requiredString(row, 'next_run_at'),
    resultArtifacts: stringArray(
      parseRequiredJson(row.result_artifacts_json, `${jobId}.resultArtifacts`),
    ),
    updatedAt: requiredString(row, 'updated_at'),
    retained: numberOr(row, 'retain', 0) === 1,
  };
  assignOptional(job, 'retryOfJobId', optionalString(row, 'retry_of_job_id'));
  assignOptional(job, 'sourceThreadId', sourceThreadId);
  assignOptional(job, 'model', model);
  assignOptional(job, 'parentSessionId', optionalString(row, 'parent_session_id'));
  assignOptional(job, 'executionSessionId', optionalString(row, 'execution_session_id'));
  assignOptional(job, 'checkpoint', checkpointV2);
  assignOptional(job, 'lastAttemptDelta', parseOptionalJson(latestAttempt?.delta_json));
  assignOptional(job, 'lastVerification', parseOptionalJson(latestAttempt?.verification_json));
  assignOptional(job, 'recovery', recovery ?? undefined);
  assignOptional(job, 'currentInterrupt', interrupt);
  assignOptional(job, 'leaseOwner', optionalString(row, 'lease_owner'));
  assignOptional(job, 'leaseExpiresAt', optionalString(row, 'lease_expires_at'));
  assignOptional(job, 'heartbeatAt', optionalString(row, 'heartbeat_at'));
  assignOptional(job, 'resultSummary', optionalString(row, 'result_summary'));
  assignOptional(job, 'errorCode', optionalString(row, 'error_code'));
  assignOptional(job, 'errorSummary', optionalString(row, 'error_summary'));
  assignOptional(job, 'startedAt', optionalString(row, 'started_at'));
  assignOptional(job, 'completedAt', optionalString(row, 'completed_at'));
  assignOptional(job, 'deletedAt', optionalString(row, 'deleted_at'));
  return job as ReturnType<typeof migrateContinuationJob>;
}

function migrateContinuationRoute(
  row: SqlRow,
  jobId: string,
  sourceMessageId: string,
  sourceThreadId: string | undefined,
): Record<string, unknown> {
  const raw = parseRequiredJson(row.route_json, `${jobId}.route`);
  if (!isRecord(raw) || requiredString(row, 'origin_kind') !== raw.kind) {
    throw new Error(`Continuation migration found an invalid route for ${jobId}.`);
  }
  if (raw.kind === 'message_thread') {
    if (
      typeof raw.conversationId !== 'string'
      || raw.conversationId.length === 0
      || raw.sourceMessageId !== sourceMessageId
      || (raw.threadId !== undefined && typeof raw.threadId !== 'string')
      || (raw.threadId !== undefined && sourceThreadId !== undefined && raw.threadId !== sourceThreadId)
    ) {
      throw new Error(`Continuation migration found an invalid message route for ${jobId}.`);
    }
    return sourceThreadId ? { ...raw, threadId: sourceThreadId } : raw;
  }
  if (
    raw.kind !== 'comment_thread'
    || typeof raw.documentToken !== 'string'
    || raw.documentToken.length === 0
    || typeof raw.commentId !== 'string'
    || raw.commentId.length === 0
    || typeof raw.fileType !== 'string'
    || raw.fileType.length === 0
    || (sourceThreadId !== undefined && raw.commentId !== sourceThreadId)
  ) {
    throw new Error(`Continuation migration found an invalid comment route for ${jobId}.`);
  }
  return raw;
}

function corruptContinuationTombstone(
  row: SqlRow,
  attemptCount: number,
): ReturnType<typeof migrateContinuationJob> {
  const emptyRoute = {
    kind: 'message_thread',
    conversationId: '',
    sourceMessageId: '',
  };
  const emptyCheckpoint = {
    summary: '',
    completedSteps: [],
    remainingSteps: [],
    constraints: [],
    decisions: [],
    references: [],
  };
  const emptyPermissions = {
    profile: 'bounded',
    filesystem: { root: '', mode: 'read-only', requestedPaths: [] },
    hostTools: [],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  };
  const title = 'Unavailable task state';
  const objective = 'Stored task state failed integrity validation.';
  const sourceFacts = {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: requiredString(row, 'creator_open_id'),
    chatId: '',
    chatType: '',
    route: emptyRoute,
    sourceMessageId: '',
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: '',
    model: null,
    permissions: emptyPermissions,
  };
  const taskContract = {
    schemaVersion: 1,
    title,
    objective,
    deliverables: [],
    acceptanceCriteria: [],
    verificationRequirements: [],
    initialContext: emptyCheckpoint,
  };
  return {
    jobId: requiredString(row, 'job_id'),
    idempotencyKey: requiredString(row, 'idempotency_key'),
    creatorOpenId: requiredString(row, 'creator_open_id'),
    route: emptyRoute,
    sourceMessageId: '',
    title,
    objective,
    acceptanceCriteria: [],
    contextSnapshot: emptyCheckpoint,
    sourceFacts,
    taskContract,
    requiredTools: [],
    workingDirectory: '',
    permissions: emptyPermissions,
    maxAttempts: clampInteger(numberOr(row, 'max_attempts', numberOr(row, 'max_steps', 1)), 1, 20),
    maxRetries: Math.max(0, numberOr(row, 'max_retries', 0)),
    timeoutSeconds: Math.max(1, numberOr(row, 'timeout_seconds', 1)),
    createdAt: requiredString(row, 'created_at'),
    expiresAt: requiredString(row, 'expires_at'),
    rowVersion: Math.max(1, requiredNumber(row, 'row_version') + 1),
    status: 'failed',
    recoveryTotalCount: 0,
    recoveryFingerprintCounts: {},
    noProgressCount: 0,
    attemptCount,
    stepCount: Math.max(0, numberOr(row, 'step_count', 0)),
    failureCount: Math.max(0, numberOr(row, 'failure_count', 0)),
    nextRunAt: requiredString(row, 'next_run_at'),
    resultArtifacts: [],
    errorCode: 'continuation_persisted_state_invalid',
    errorSummary: objective,
    updatedAt: requiredString(row, 'updated_at'),
    completedAt: optionalString(row, 'completed_at') ?? requiredString(row, 'updated_at'),
    retained: false,
  } as ReturnType<typeof migrateContinuationJob>;
}

function persistedPermissions(
  row: SqlRow,
  workingDirectory: string,
  requiredTools: string[],
): Record<string, unknown> {
  const parsed = parseOptionalJson(row.permissions_json);
  if (isRecord(parsed) && Object.keys(parsed).length > 0) return parsed;
  return {
    profile: 'bounded',
    filesystem: {
      root: workingDirectory,
      mode: 'workspace-write',
      requestedPaths: [],
    },
    hostTools: requiredTools,
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  };
}

function persistedSourceFacts(
  row: SqlRow,
  projection: {
    route: unknown;
    creatorOpenId: string;
    sourceMessageId: string;
    sourceThreadId?: string;
    workingDirectory: string;
    model?: string;
    permissions: Record<string, unknown>;
  },
): Record<string, unknown> {
  const parsed = parseOptionalJson(row.source_facts_json);
  if (isRecord(parsed) && parsed.schemaVersion === 1 && Object.keys(parsed).length > 1) {
    return {
      ...parsed,
      route: projection.route,
      creatorOpenId: projection.creatorOpenId,
      sourceMessageId: projection.sourceMessageId,
      ...(projection.sourceThreadId ? { sourceThreadId: projection.sourceThreadId } : {}),
      chatId: isRecord(projection.route) && projection.route.kind === 'message_thread'
        ? projection.route.conversationId
        : `doc:${isRecord(projection.route) ? String(projection.route.documentToken ?? '') : ''}`,
      workingDirectory: projection.workingDirectory,
      model: projection.model ?? null,
      permissions: projection.permissions,
    };
  }
  const route = projection.route;
  return {
    schemaVersion: 1,
    provenance: 'legacy_unavailable',
    originalUserText: null,
    sourceContextText: null,
    quotedMessageText: null,
    creatorOpenId: projection.creatorOpenId,
    chatId: isRecord(route) && route.kind === 'message_thread'
      ? route.conversationId
      : `doc:${isRecord(route) ? String(route.documentToken ?? '') : ''}`,
    chatType: isRecord(route) && route.kind === 'comment_thread' ? 'doc_comment' : '',
    route,
    sourceMessageId: projection.sourceMessageId,
    ...(projection.sourceThreadId ? { sourceThreadId: projection.sourceThreadId } : {}),
    sourceMessageType: null,
    sourceTimestamp: null,
    inputs: [],
    workingDirectory: projection.workingDirectory,
    model: projection.model ?? null,
    permissions: projection.permissions,
  };
}

function persistedTaskContract(
  row: SqlRow,
  projection: {
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    contextSnapshot: Record<string, unknown>;
    legacyUnavailable: boolean;
  },
): Record<string, unknown> {
  const parsed = parseOptionalJson(row.task_contract_json);
  if (isRecord(parsed) && parsed.schemaVersion === 1 && Object.keys(parsed).length > 1) {
    const persistedCriteria = Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria
      : [];
    const persistedDescriptions = persistedCriteria.map((criterion) => (
      isRecord(criterion) && typeof criterion.description === 'string'
        ? criterion.description
        : null
    ));
    const acceptanceCriteria = projection.legacyUnavailable
      && (
        persistedDescriptions.length !== projection.acceptanceCriteria.length
        || persistedDescriptions.some((description, index) => (
          description !== projection.acceptanceCriteria[index]
        ))
      )
      ? legacyAcceptanceCriteria(projection.acceptanceCriteria)
      : parsed.acceptanceCriteria;
    return {
      ...parsed,
      title: projection.title,
      objective: projection.objective,
      acceptanceCriteria,
      initialContext: projection.contextSnapshot,
    };
  }
  return {
    schemaVersion: 1,
    title: projection.title,
    objective: projection.objective,
    deliverables: [],
    acceptanceCriteria: legacyAcceptanceCriteria(projection.acceptanceCriteria),
    verificationRequirements: [],
    initialContext: projection.contextSnapshot,
  };
}

function legacyAcceptanceCriteria(descriptions: readonly string[]): Array<Record<string, unknown>> {
  return descriptions.map((description, index) => ({
    id: `criterion_${index + 1}_${createHash('sha256').update(description).digest('hex').slice(0, 12)}`,
    description,
    deliverableIds: [],
  }));
}

function checkpoint(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Continuation checkpoint is invalid during migration.');
  return {
    summary: stringOr(value.summary, ''),
    completedSteps: stringArray(value.completedSteps),
    remainingSteps: stringArray(value.remainingSteps),
    constraints: stringArray(value.constraints),
    decisions: stringArray(value.decisions),
    references: stringArray(value.references),
  };
}

function migrateCheckpointV2(value: unknown): Record<string, unknown> {
  if (isRecord(value) && value.schemaVersion === 2) return value;
  const legacy = checkpoint(value);
  const completedSteps = stringArray(legacy.completedSteps);
  const remainingSteps = stringArray(legacy.remainingSteps);
  const currentStepId = remainingSteps[0]
    ? legacyStepId(remainingSteps[0], 0)
    : completedSteps.at(-1)
      ? legacyStepId(completedSteps.at(-1)!, Math.max(0, completedSteps.length - 1))
      : 'initial-step';
  const remaining = remainingSteps.map((description, index) => ({
    id: legacyStepId(description, completedSteps.length + index),
    description,
  }));
  return {
    schemaVersion: 2,
    summary: stringOr(legacy.summary, ''),
    currentStepId,
    completedStepIds: completedSteps.map(legacyStepId),
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps: remaining,
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: stringArray(legacy.constraints),
    decisions: stringArray(legacy.decisions),
    nextAction: remaining[0] ?? null,
    stopReason: 'Migrated legacy checkpoint.',
  };
}

function latestInterrupt(
  jobId: string,
  rows: SqlRow[],
  database: DatabaseSync,
): Record<string, unknown> | undefined {
  const row = rows
    .filter((candidate) => requiredString(candidate, 'job_id') === jobId)
    .sort((left, right) => requiredString(right, 'created_at').localeCompare(requiredString(left, 'created_at')))[0];
  if (!row) return undefined;
  const interruptId = requiredString(row, 'interrupt_id');
  const delivery = tableExists(database, 'continuation_outbox')
    ? database.prepare(`
        SELECT message_id, updated_at FROM continuation_outbox
        WHERE job_id = ? AND event_key = ? LIMIT 1
      `).get(jobId, `interrupt:${interruptId}`) as SqlRow | undefined
    : undefined;
  const messageId = delivery ? optionalString(delivery, 'message_id') : undefined;
  return {
    interruptId,
    jobId,
    attemptId: requiredString(row, 'attempt_id'),
    status: requiredString(row, 'status') === 'resolved'
      ? 'resolved'
      : messageId
        ? 'delivered'
        : 'pending',
    prompt: requiredString(row, 'prompt'),
    ...(messageId ? { deliveredMessageId: messageId } : {}),
    ...(optionalString(row, 'response_text')
      ? { responseText: optionalString(row, 'response_text') }
      : {}),
    createdAt: requiredString(row, 'created_at'),
    ...(messageId && delivery ? { deliveredAt: requiredString(delivery, 'updated_at') } : {}),
    ...(optionalString(row, 'resolved_at')
      ? { resolvedAt: optionalString(row, 'resolved_at') }
      : {}),
  };
}

function latestAttemptRow(database: DatabaseSync, jobId: string): SqlRow | undefined {
  if (!tableExists(database, 'continuation_attempts')) return undefined;
  return database.prepare(`
    SELECT * FROM continuation_attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1
  `).get(jobId) as SqlRow | undefined;
}

function attemptLeaseExpiry(database: DatabaseSync, row: SqlRow, fallback: string): string {
  const job = database.prepare(`
    SELECT lease_expires_at FROM continuation_jobs WHERE job_id = ?
  `).get(requiredString(row, 'job_id')) as SqlRow | undefined;
  return optionalString(job, 'lease_expires_at') ?? fallback;
}

function countAttempts(database: DatabaseSync): Map<string, number> {
  if (!tableExists(database, 'continuation_attempts')) return new Map();
  const rows = database.prepare(`
    SELECT job_id, COUNT(*) AS count FROM continuation_attempts GROUP BY job_id
  `).all() as SqlRow[];
  return new Map(rows.map((row) => [requiredString(row, 'job_id'), requiredNumber(row, 'count')]));
}

function inferOperationRisk(result: unknown, attempt: SqlRow | undefined): string {
  if (isRecord(result) && typeof result.operationRisk === 'string') {
    return operationRisk(result.operationRisk);
  }
  const recovery = parseOptionalJson(attempt?.recovery_json);
  if (isRecord(recovery) && isRecord(recovery.failure) && typeof recovery.failure.operationRisk === 'string') {
    return operationRisk(recovery.failure.operationRisk);
  }
  return 'unknown';
}

function operationRisk(value: string): string {
  return ['pure', 'read_only', 'idempotent_write', 'external_side_effect', 'unknown'].includes(value)
    ? value
    : 'unknown';
}

function migrateDeliveryStatus(status: string): string {
  if (status === 'delivered') return 'sent';
  if (status === 'delivery_unknown') return 'unknown';
  return status;
}

function invalidMigrationDeliveryStatus(status: string): string {
  if (status === 'delivered') return 'sent';
  if (status === 'sending' || status === 'delivery_unknown') return 'unknown';
  return 'failed';
}

function continuationRoutesMatch(legacyJson: string, runJson: string): boolean {
  const legacy = parseRequiredJson(legacyJson, 'legacy outbox route');
  const run = parseRequiredJson(runJson, 'migrated Async Task route');
  if (!isRecord(legacy) || !isRecord(run) || legacy.kind !== run.kind) return false;
  if (legacy.kind === 'message_thread') {
    return legacy.conversationId === run.conversationId
      && legacy.sourceMessageId === run.sourceMessageId
      && (legacy.threadId === undefined || legacy.threadId === run.threadId);
  }
  if (legacy.kind === 'comment_thread') {
    return legacy.documentToken === run.documentToken
      && legacy.commentId === run.commentId
      && legacy.fileType === run.fileType;
  }
  return false;
}

function normalizeJsonText(value: string): string {
  return serializeDurableRunJson(parseRequiredJson(value, 'migrated JSON'), 'migrated JSON');
}

function readRows(database: DatabaseSync, table: string): SqlRow[] {
  if (!tableExists(database, table)) return [];
  return database.prepare(`SELECT * FROM ${table}`).all() as SqlRow[];
}

function tableCount(database: DatabaseSync, table: string): number {
  if (!tableExists(database, table)) return 0;
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as SqlRow).count);
}

function assertCount(database: DatabaseSync, table: string, expected: number): void {
  const actual = tableCount(database, table);
  if (actual !== expected) {
    throw new Error(`Durable Run v10 migration count mismatch for ${table}: ${actual} !== ${expected}.`);
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as SqlRow | undefined;
  return row !== undefined;
}

function hardenDurableAttemptOwnership(database: DatabaseSync): void {
  const childTables = [
    {
      table: 'durable_outbox',
      indexes: ['durable_outbox_due_idx', 'durable_outbox_message_id_idx'],
      columns: [
        'outbox_id', 'run_id', 'event_key', 'kind', 'attempt_id', 'route_json',
        'idempotency_key', 'payload_json', 'metadata_json', 'status', 'attempt_count',
        'next_attempt_at', 'worker_id', 'lease_expires_at', 'first_attempt_at',
        'last_attempt_at', 'message_id', 'error_code', 'error_summary', 'created_at',
        'updated_at',
      ],
    },
    {
      table: 'durable_operation_receipts',
      indexes: ['durable_operation_receipts_running_idx'],
      columns: [
        'receipt_id', 'run_id', 'attempt_id', 'operation_key', 'operation_name',
        'request_hash', 'operation_risk', 'status', 'result_json', 'started_at',
        'completed_at', 'updated_at', 'metadata_json',
      ],
    },
    {
      table: 'durable_interrupts',
      indexes: ['durable_interrupts_active_run_idx'],
      columns: [
        'interrupt_id', 'run_id', 'attempt_id', 'status', 'prompt', 'response_text',
        'created_at', 'resolved_at', 'metadata_json',
      ],
    },
  ] as const;
  const needsRebuild = childTables.filter(
    ({ table }) => tableExists(database, table) && !hasCompositeAttemptForeignKey(database, table),
  );
  if (needsRebuild.length === 0) return;

  immediateTransaction(database, () => {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS durable_attempts_run_attempt_idx
        ON durable_attempts(run_id, attempt_id);
    `);
    for (const { table } of needsRebuild) {
      const invalid = database.prepare(`
        SELECT child.run_id, child.attempt_id
        FROM ${table} child
        LEFT JOIN durable_attempts attempt
          ON attempt.run_id = child.run_id AND attempt.attempt_id = child.attempt_id
        WHERE child.attempt_id IS NOT NULL AND attempt.attempt_id IS NULL
        LIMIT 1
      `).get() as SqlRow | undefined;
      if (invalid) {
        throw new Error(
          `Durable Run schema cannot fence ${table}: Attempt does not belong to Run.`,
        );
      }
    }

    for (const { table, indexes } of needsRebuild) {
      for (const index of indexes) database.exec(`DROP INDEX IF EXISTS ${index};`);
      database.exec(`ALTER TABLE ${table} RENAME TO ${table}_unfenced_v10;`);
    }
    createDurableSchema(database);
    for (const { table, columns } of needsRebuild) {
      const projection = columns.join(', ');
      database.exec(`
        INSERT INTO ${table} (${projection})
        SELECT ${projection} FROM ${table}_unfenced_v10;
        DROP TABLE ${table}_unfenced_v10;
      `);
    }
  });
}

function hasCompositeAttemptForeignKey(database: DatabaseSync, table: string): boolean {
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as SqlRow[];
  const byConstraint = new Map<number, Array<{ from: string; to: string }>>();
  for (const row of rows) {
    if (row.table !== 'durable_attempts') continue;
    const id = requiredNumber(row, 'id');
    const entries = byConstraint.get(id) ?? [];
    entries.push({ from: requiredString(row, 'from'), to: requiredString(row, 'to') });
    byConstraint.set(id, entries);
  }
  return [...byConstraint.values()].some((entries) =>
    entries.length === 2
    && entries.some((entry) => entry.from === 'run_id' && entry.to === 'run_id')
    && entries.some((entry) => entry.from === 'attempt_id' && entry.to === 'attempt_id'));
}

function assertDurableSchema(database: DatabaseSync): void {
  for (const table of [
    'durable_runs',
    'durable_attempts',
    'durable_outbox',
    'durable_operation_receipts',
    'durable_interrupts',
  ]) {
    if (!tableExists(database, table)) {
      throw new Error(`Durable Run schema is missing ${table}.`);
    }
  }
  for (const table of [
    'durable_outbox',
    'durable_operation_receipts',
    'durable_interrupts',
  ]) {
    if (!hasCompositeAttemptForeignKey(database, table)) {
      throw new Error(`Durable Run schema is missing composite Attempt ownership for ${table}.`);
    }
  }
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) throw new Error('Durable Run schema has foreign-key violations.');
}

function assertContinuationCompatibilitySchema(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type IN ('view', 'trigger') AND name LIKE 'continuation_%'
  `).all() as SqlRow[];
  const objects = new Map(rows.map((row) => [String(row.name), String(row.type)]));
  for (const view of CONTINUATION_COMPATIBILITY_VIEWS) {
    if (objects.get(view) !== 'view') {
      throw new Error(`Continuation compatibility schema is missing view ${view}.`);
    }
  }
  for (const [name, type] of objects) {
    if (type === 'trigger') {
      throw new Error(`Continuation compatibility schema must be read-only; found trigger ${name}.`);
    }
  }
}

function immediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  }
}

function scalarNumber(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as SqlRow | undefined;
  if (!row) throw new Error(`SQLite scalar query returned no row: ${sql}`);
  const value = Object.values(row)[0];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`SQLite scalar query returned a non-number: ${sql}`);
  }
  return Number(value);
}

function parseRequiredJson(value: SqlRow[string] | undefined, label: string): unknown {
  if (typeof value !== 'string') throw new Error(`${label} must be persisted JSON.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
}

function parseOptionalJson(value: SqlRow[string] | undefined): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Optional persisted JSON must be text.');
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Optional persisted JSON is malformed.');
  }
}

function requiredString(row: SqlRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== 'string') throw new Error(`Expected SQLite text field ${key}.`);
  return value;
}

function optionalString(row: SqlRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  if (value === undefined || value === null) return undefined;
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

function numberOr(row: SqlRow | undefined, key: string, fallback: number): number {
  const value = row?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Expected optional SQLite numeric field ${key}.`);
  }
  return Number(value);
}

function assignOptional(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error('Expected a persisted string array during migration.');
  }
  return [...value];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Expected a safe integer during migration.');
  return Math.min(maximum, Math.max(minimum, value));
}

function legacyStepId(description: string, index: number): string {
  return `legacy-step-${index + 1}-${createHash('sha256').update(description).digest('hex').slice(0, 12)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
