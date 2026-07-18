import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { serializeDurableRunJson } from '../domain/durable-run.js';

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

export const DURABLE_RUN_SCHEMA_VERSION = 10;
export const ASYNC_TASK_INPUT_VERSION = 1;
export const ASYNC_TASK_STATE_VERSION = 1;

export function migrateSqliteToDurableV10(database: DatabaseSync): void {
  const version = scalarNumber(database, 'PRAGMA user_version');
  if (version > DURABLE_RUN_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported durable run database schema version ${version}; expected at most ${DURABLE_RUN_SCHEMA_VERSION}.`,
    );
  }
  if (version === DURABLE_RUN_SCHEMA_VERSION) {
    assertDurableSchema(database);
    return;
  }
  if (version !== 0 && (version < 1 || version > 9)) {
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
      UNIQUE(run_id, ordinal)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_attempts_active_idx
      ON durable_attempts(run_id, finished_at, ordinal DESC);

    CREATE TABLE IF NOT EXISTS durable_outbox (
      outbox_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      attempt_id TEXT REFERENCES durable_attempts(attempt_id),
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
      UNIQUE(run_id, event_key)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS durable_outbox_due_idx
      ON durable_outbox(status, next_attempt_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS durable_outbox_message_id_idx
      ON durable_outbox(message_id) WHERE message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS durable_operation_receipts (
      receipt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      attempt_id TEXT NOT NULL REFERENCES durable_attempts(attempt_id),
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
      UNIQUE(run_id, operation_key, request_hash)
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS durable_operation_receipts_running_idx
      ON durable_operation_receipts(run_id, operation_key) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS durable_interrupts (
      interrupt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
      attempt_id TEXT NOT NULL REFERENCES durable_attempts(attempt_id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
      prompt TEXT NOT NULL,
      response_text TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
      UNIQUE(run_id, attempt_id)
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
  for (const row of jobs) {
    const job = migrateContinuationJob(
      row,
      attemptCounts.get(requiredString(row, 'job_id')) ?? 0,
      interrupts,
      database,
    );
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
      optionalString(row, 'completed_at') ?? null,
      job.maxAttempts,
      job.attemptCount,
      job.rowVersion,
      optionalString(row, 'lease_owner') ?? null,
      optionalString(row, 'lease_expires_at') ?? null,
      optionalString(row, 'heartbeat_at') ?? null,
      optionalString(row, 'error_code') ?? null,
      optionalString(row, 'error_summary') ?? null,
      numberOr(row, 'retain', 0) === 1 ? 1 : 0,
      optionalString(row, 'deleted_at') ?? null,
      requiredString(row, 'updated_at'),
    );
  }

  migrateAttempts(database, attempts);
  migrateOutbox(database, version);
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

function migrateAttempts(database: DatabaseSync, rows: SqlRow[]): void {
  const insert = database.prepare(`
    INSERT INTO durable_attempts (
      attempt_id, run_id, ordinal, worker_id, execution_session_id,
      claimed_at, heartbeat_at, lease_expires_at, execution_started_at,
      finished_at, execution_phase, operation_risk, outcome, error_code,
      error_summary, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const phase = optionalString(row, 'execution_phase')
      ?? (optionalString(row, 'finished_at') ? 'claimed' : 'execution_started');
    const heartbeatAt = requiredString(row, 'heartbeat_at');
    insert.run(
      requiredString(row, 'attempt_id'),
      requiredString(row, 'job_id'),
      requiredNumber(row, 'ordinal'),
      requiredString(row, 'worker_id'),
      optionalString(row, 'execution_session_id') ?? null,
      requiredString(row, 'started_at'),
      heartbeatAt,
      attemptLeaseExpiry(database, row, heartbeatAt),
      phase === 'execution_started' ? requiredString(row, 'started_at') : null,
      optionalString(row, 'finished_at') ?? null,
      phase,
      optionalString(row, 'outcome') ?? null,
      optionalString(row, 'error_code') ?? null,
      optionalString(row, 'error_summary') ?? null,
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

function migrateOutbox(database: DatabaseSync, version: number): void {
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
    const eventKey = optionalString(row, 'event_key') ?? 'terminal';
    const kind = optionalString(row, 'kind') ?? 'terminal';
    const payload = requiredString(row, 'payload');
    insert.run(
      requiredString(row, 'outbox_id'),
      runId,
      eventKey,
      kind,
      optionalString(row, 'attempt_id') ?? null,
      normalizeJsonText(requiredString(row, 'route_json')),
      requiredString(row, 'idempotency_key'),
      serializeDurableRunJson(payload, `migrated outbox payload for ${runId}`),
      serializeDurableRunJson({ legacySchemaVersion: version }, `migrated outbox metadata for ${runId}`),
      migrateDeliveryStatus(requiredString(row, 'status')),
      requiredNumber(row, 'attempt_count'),
      requiredString(row, 'next_attempt_at'),
      optionalString(row, 'worker_id') ?? null,
      optionalString(row, 'lease_expires_at') ?? null,
      optionalString(row, 'first_attempt_at') ?? null,
      optionalString(row, 'last_attempt_at') ?? null,
      optionalString(row, 'message_id') ?? null,
      optionalString(row, 'error_code') ?? null,
      optionalString(row, 'error_summary') ?? null,
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
    const stepId = optionalString(row, 'step_id')
      ?? `legacy-step-${stepIndex}`;
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
  const rawRoute = parseRequiredJson(row.route_json, `${jobId}.route`);
  if (!isRecord(rawRoute) || typeof rawRoute.kind !== 'string') {
    throw new Error(`Continuation migration found an invalid route for ${jobId}.`);
  }
  const sourceThreadId = optionalString(row, 'source_thread_id');
  const route = rawRoute.kind === 'message_thread' && sourceThreadId
    ? { ...rawRoute, threadId: sourceThreadId }
    : rawRoute;
  const creatorOpenId = requiredString(row, 'creator_open_id');
  const sourceMessageId = requiredString(row, 'source_message_id');
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
  },
): Record<string, unknown> {
  const parsed = parseOptionalJson(row.task_contract_json);
  if (isRecord(parsed) && parsed.schemaVersion === 1 && Object.keys(parsed).length > 1) {
    return {
      ...parsed,
      title: projection.title,
      objective: projection.objective,
      initialContext: projection.contextSnapshot,
    };
  }
  return {
    schemaVersion: 1,
    title: projection.title,
    objective: projection.objective,
    deliverables: [],
    acceptanceCriteria: projection.acceptanceCriteria.map((description, index) => ({
      id: `criterion_${index + 1}_${createHash('sha256').update(description).digest('hex').slice(0, 12)}`,
      description,
      deliverableIds: [],
    })),
    verificationRequirements: [],
    initialContext: projection.contextSnapshot,
  };
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
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) throw new Error('Durable Run schema has foreign-key violations.');
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
