import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type HistoricalContinuationSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface HistoricalContinuationFixture {
  dueJobId?: string;
  terminalJobId: string;
  terminalAttemptId: string;
  operationReceiptId?: string;
  interruptId?: string;
  deliveredOutboxId?: string;
  deliveredMessageId?: string;
  expectedAttemptCount: number;
  expectedOutboxCount: number;
}

interface FixtureOptions {
  databasePath: string;
  now: string;
  version: HistoricalContinuationSchemaVersion;
  workingDirectory: string;
}

const ROUTE = (messageId: string) => JSON.stringify({
  kind: 'message_thread',
  conversationId: 'oc_legacy',
  sourceMessageId: messageId,
});
const CHECKPOINT = JSON.stringify({
  summary: 'legacy checkpoint',
  completedSteps: ['legacy step'],
  remainingSteps: [],
  constraints: [],
  decisions: [],
  references: [],
});

/**
 * Historical DDL sources:
 * - v1: f55c053 (initial SQLite continuation repository)
 * - v4: 369142fe (attempt-budget migration)
 * - v5: 30721056 (multi-event delivery outbox)
 */
export async function seedHistoricalContinuationDatabase(
  options: FixtureOptions,
): Promise<HistoricalContinuationFixture> {
  await mkdir(dirname(options.databasePath), { recursive: true });
  const database = new DatabaseSync(options.databasePath, {
    enableForeignKeyConstraints: true,
  });
  try {
    if (options.version <= 3) return seedVersionOneThroughThree(database, options);
    if (options.version <= 5) return seedVersionFourOrFive(database, options);
    return seedVersionSixThroughNine(database, options);
  } finally {
    database.close();
  }
}

function seedVersionOneThroughThree(
  database: DatabaseSync,
  options: FixtureOptions,
): HistoricalContinuationFixture {
  const fixture = seedVersionOne(database, { ...options, version: 1 });
  if (options.version === 1) return fixture;

  database.exec(toolCallSchema());
  const operationReceiptId = `call_authentic_v${options.version}`;
  database.prepare(`
    INSERT INTO continuation_tool_calls (
      call_id, job_id, step_index, attempt_id, tool_name, request_hash,
      status, result_json, started_at, completed_at, updated_at
    ) VALUES (?, ?, 0, ?, 'lark_cli', ?, 'completed', ?, ?, ?, ?)
  `).run(
    operationReceiptId,
    fixture.terminalJobId,
    fixture.terminalAttemptId,
    `hash-v${options.version}`,
    JSON.stringify({ ok: true, message: `v${options.version} tool result` }),
    options.now,
    '2026-07-17T00:00:02.000Z',
    '2026-07-17T00:00:02.000Z',
  );
  database.exec('PRAGMA user_version = 2;');
  if (options.version === 2) return { ...fixture, operationReceiptId };

  database.exec(`
    ALTER TABLE continuation_jobs ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';
  `);
  database.prepare('UPDATE continuation_jobs SET permissions_json = ?').run(JSON.stringify({
    profile: 'bounded',
    filesystem: {
      root: options.workingDirectory,
      mode: 'workspace-write',
      requestedPaths: [],
    },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  }));
  database.exec('PRAGMA user_version = 3;');
  return { ...fixture, operationReceiptId };
}

function seedVersionOne(
  database: DatabaseSync,
  options: FixtureOptions,
): HistoricalContinuationFixture {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE continuation_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      retry_of_job_id TEXT REFERENCES continuation_jobs(job_id),
      creator_open_id TEXT NOT NULL,
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('message_thread', 'comment_thread')),
      route_json TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_thread_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      context_snapshot_json TEXT NOT NULL,
      required_tools_json TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      model TEXT,
      parent_session_id TEXT,
      max_steps INTEGER NOT NULL,
      max_retries INTEGER NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      row_version INTEGER NOT NULL CHECK(row_version >= 1),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'waiting_retry', 'cancel_requested',
        'completed', 'failed', 'cancelled'
      )),
      execution_session_id TEXT,
      checkpoint_json TEXT,
      step_count INTEGER NOT NULL CHECK(step_count >= 0),
      failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
      next_run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      result_summary TEXT,
      result_artifacts_json TEXT NOT NULL,
      error_code TEXT,
      error_summary TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    ) STRICT;
    CREATE INDEX continuation_jobs_due_idx
      ON continuation_jobs(status, next_run_at, created_at)
      WHERE deleted_at IS NULL;
    CREATE INDEX continuation_jobs_creator_idx
      ON continuation_jobs(creator_open_id, created_at DESC)
      WHERE deleted_at IS NULL;
    CREATE TABLE continuation_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      ordinal INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      execution_session_id TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN (
        'continue', 'completed', 'failed', 'blocked', 'error', 'cancelled'
      )),
      error_code TEXT,
      error_summary TEXT,
      UNIQUE(job_id, ordinal)
    ) STRICT;
    CREATE TABLE continuation_outbox (
      outbox_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES continuation_jobs(job_id),
      route_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'sending', 'delivered', 'delivery_unknown', 'failed'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      worker_id TEXT,
      lease_expires_at TEXT,
      first_attempt_at TEXT,
      last_attempt_at TEXT,
      message_id TEXT,
      error_code TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX continuation_outbox_due_idx
      ON continuation_outbox(status, next_attempt_at, created_at);
    PRAGMA user_version = 1;
  `);

  insertVersionOneJob(database, options, {
    jobId: 'job_authentic_v1_due',
    messageId: 'om_legacy_v1_due',
    status: 'waiting_retry',
    maxSteps: 24,
    resultSummary: null,
  });
  insertVersionOneJob(database, options, {
    jobId: 'job_authentic_v1_done',
    messageId: 'om_legacy_v1_done',
    status: 'completed',
    maxSteps: 2,
    resultSummary: 'legacy v1 terminal',
  });
  database.prepare(`
    INSERT INTO continuation_attempts (
      attempt_id, job_id, ordinal, worker_id, execution_session_id,
      started_at, heartbeat_at, finished_at, outcome
    ) VALUES (?, ?, 1, 'worker-v1', ?, ?, ?, ?, ?)
  `).run(
    'attempt_authentic_v1_due',
    'job_authentic_v1_due',
    'session-v1-due',
    options.now,
    options.now,
    options.now,
    'continue',
  );
  database.prepare(`
    INSERT INTO continuation_attempts (
      attempt_id, job_id, ordinal, worker_id, execution_session_id,
      started_at, heartbeat_at, finished_at, outcome
    ) VALUES (?, ?, 1, 'worker-v1', ?, ?, ?, ?, ?)
  `).run(
    'attempt_authentic_v1_done',
    'job_authentic_v1_done',
    'session-v1-done',
    options.now,
    options.now,
    '2026-07-17T00:00:03.000Z',
    'completed',
  );
  database.prepare(`
    INSERT INTO continuation_outbox (
      outbox_id, job_id, route_json, idempotency_key, payload, status,
      attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    'outbox_authentic_v1',
    'job_authentic_v1_done',
    ROUTE('om_legacy_v1_done'),
    'continuation:job_authentic_v1_done:terminal',
    'legacy v1 terminal payload',
    options.now,
    options.now,
    options.now,
  );
  return {
    dueJobId: 'job_authentic_v1_due',
    terminalJobId: 'job_authentic_v1_done',
    terminalAttemptId: 'attempt_authentic_v1_done',
    expectedAttemptCount: 2,
    expectedOutboxCount: 1,
  };
}

function insertVersionOneJob(
  database: DatabaseSync,
  options: FixtureOptions,
  job: {
    jobId: string;
    maxSteps: number;
    messageId: string;
    resultSummary: string | null;
    status: 'completed' | 'waiting_retry';
  },
): void {
  database.prepare(`
    INSERT INTO continuation_jobs (
      job_id, idempotency_key, creator_open_id, origin_kind, route_json,
      source_message_id, title, objective, acceptance_criteria_json,
      context_snapshot_json, required_tools_json, working_directory, max_steps,
      max_retries, timeout_seconds, created_at, expires_at, row_version, status,
      execution_session_id, checkpoint_json, step_count, failure_count,
      next_run_at, result_summary, result_artifacts_json, started_at,
      updated_at, completed_at
    ) VALUES (
      ?, ?, 'ou_creator', 'message_thread', ?, ?, ?, ?, '["terminal result is persisted"]',
      ?, '["lark_cli"]', ?, ?, 3, 600, ?, '2026-07-18T00:00:00.000Z',
      2, ?, ?, ?, 1, 0, ?, ?, '[]', ?, ?, ?
    )
  `).run(
    job.jobId,
    `idem-${job.jobId}`,
    ROUTE(job.messageId),
    job.messageId,
    `Legacy ${job.jobId}`,
    `Migrate ${job.jobId}`,
    CHECKPOINT,
    options.workingDirectory,
    job.maxSteps,
    options.now,
    job.status,
    `session-${job.jobId}`,
    CHECKPOINT,
    options.now,
    job.resultSummary,
    options.now,
    options.now,
    job.status === 'completed' ? '2026-07-17T00:00:03.000Z' : null,
  );
}

function seedVersionFourOrFive(
  database: DatabaseSync,
  options: FixtureOptions,
): HistoricalContinuationFixture {
  if (options.version !== 4 && options.version !== 5) {
    throw new Error(`Expected a v4/v5 fixture, received v${options.version}.`);
  }
  database.exec(`
    PRAGMA foreign_keys = ON;
    ${versionFourJobAndAttemptSchema()}
    ${toolCallSchema()}
    ${options.version === 4 ? versionFourOutboxSchema() : versionFiveOutboxSchema()}
    PRAGMA user_version = ${options.version};
  `);
  const jobId = `job_authentic_v${options.version}`;
  const attemptId = `attempt_authentic_v${options.version}`;
  const permissions = JSON.stringify({
    profile: 'bounded',
    filesystem: {
      root: options.workingDirectory,
      mode: 'workspace-write',
      requestedPaths: [],
    },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  });
  database.prepare(`
    INSERT INTO continuation_jobs (
      job_id, idempotency_key, creator_open_id, origin_kind, route_json,
      source_message_id, source_thread_id, title, objective,
      acceptance_criteria_json, context_snapshot_json, required_tools_json,
      working_directory, permissions_json, max_attempts, max_retries,
      timeout_seconds, created_at, expires_at, row_version, status,
      execution_session_id, checkpoint_json, step_count, failure_count,
      next_run_at, result_summary, result_artifacts_json, started_at,
      updated_at, completed_at
    ) VALUES (
      ?, ?, 'ou_creator', 'message_thread', ?, ?, 'omt_legacy', ?, ?,
      '["terminal result is persisted"]', ?, '["lark_cli"]', ?, ?, 5, 3,
      600, ?, '2026-07-18T00:00:00.000Z', 3, 'completed', ?, ?, 1, 0,
      ?, ?, '[]', ?, '2026-07-17T00:00:03.000Z',
      '2026-07-17T00:00:03.000Z'
    )
  `).run(
    jobId,
    `idem-authentic-v${options.version}`,
    ROUTE(`om_legacy_v${options.version}`),
    `om_legacy_v${options.version}`,
    `Legacy v${options.version}`,
    `Migrate v${options.version}`,
    CHECKPOINT,
    options.workingDirectory,
    permissions,
    options.now,
    `session-v${options.version}`,
    CHECKPOINT,
    options.now,
    `v${options.version} result`,
    options.now,
  );
  database.prepare(`
    INSERT INTO continuation_attempts (
      attempt_id, job_id, ordinal, worker_id, execution_session_id,
      started_at, heartbeat_at, finished_at, outcome
    ) VALUES (?, ?, 1, ?, ?, ?, ?, '2026-07-17T00:00:03.000Z', 'completed')
  `).run(
    attemptId,
    jobId,
    `worker-v${options.version}`,
    `session-v${options.version}`,
    options.now,
    options.now,
  );
  database.prepare(`
    INSERT INTO continuation_tool_calls (
      call_id, job_id, step_index, attempt_id, tool_name, request_hash,
      status, result_json, started_at, completed_at, updated_at
    ) VALUES (?, ?, 0, ?, 'lark_cli', ?, 'completed', ?, ?, ?, ?)
  `).run(
    `call_authentic_v${options.version}`,
    jobId,
    attemptId,
    `hash-v${options.version}`,
    JSON.stringify({ ok: true, message: `v${options.version} tool result` }),
    options.now,
    '2026-07-17T00:00:02.000Z',
    '2026-07-17T00:00:02.000Z',
  );
  if (options.version === 4) {
    database.prepare(`
      INSERT INTO continuation_outbox (
        outbox_id, job_id, route_json, idempotency_key, payload, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      'outbox_authentic_v4',
      jobId,
      ROUTE('om_legacy_v4'),
      `continuation:${jobId}:terminal`,
      'v4 terminal payload',
      options.now,
      options.now,
      options.now,
    );
  } else {
    const insert = database.prepare(`
      INSERT INTO continuation_outbox (
        outbox_id, job_id, event_key, kind, attempt_id, route_json,
        idempotency_key, payload, status, attempt_count, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'outbox_authentic_v5_progress',
      jobId,
      `progress:${attemptId}`,
      'progress',
      attemptId,
      ROUTE('om_legacy_v5'),
      `continuation:${jobId}:progress:${attemptId}`,
      'v5 progress payload',
      'delivered',
      1,
      options.now,
      options.now,
      options.now,
    );
    insert.run(
      'outbox_authentic_v5_terminal',
      jobId,
      'terminal',
      'terminal',
      null,
      ROUTE('om_legacy_v5'),
      `continuation:${jobId}:terminal`,
      'v5 terminal payload',
      'pending',
      0,
      options.now,
      options.now,
      options.now,
    );
    database.prepare(`
      UPDATE continuation_outbox
      SET message_id = 'om_delivered_v5_progress'
      WHERE outbox_id = 'outbox_authentic_v5_progress'
    `).run();
  }
  return {
    terminalJobId: jobId,
    terminalAttemptId: attemptId,
    operationReceiptId: `call_authentic_v${options.version}`,
    ...(options.version === 5
      ? {
          deliveredOutboxId: 'outbox_authentic_v5_progress',
          deliveredMessageId: 'om_delivered_v5_progress',
        }
      : {}),
    expectedAttemptCount: 1,
    expectedOutboxCount: options.version === 4 ? 1 : 2,
  };
}

function seedVersionSixThroughNine(
  database: DatabaseSync,
  options: FixtureOptions,
): HistoricalContinuationFixture {
  if (options.version < 6) {
    throw new Error(`Expected a v6-v9 fixture, received v${options.version}.`);
  }
  const fixture = seedVersionFourOrFive(database, { ...options, version: 5 });
  const deliveredMessageId = `om_delivered_v${options.version}_progress`;
  database.prepare(`
    UPDATE continuation_outbox
    SET message_id = ?, updated_at = ?
    WHERE outbox_id = 'outbox_authentic_v5_progress'
  `).run(deliveredMessageId, options.now);
  database.exec(`
    ALTER TABLE continuation_jobs ADD COLUMN retain INTEGER NOT NULL DEFAULT 0
      CHECK(retain IN (0, 1));
    UPDATE continuation_jobs SET retain = 1;
    PRAGMA user_version = 6;
  `);
  if (options.version === 6) {
    return { ...fixture, deliveredMessageId };
  }

  const route = JSON.parse(ROUTE('om_legacy_v5')) as Record<string, unknown>;
  const permissions = {
    profile: 'bounded',
    filesystem: {
      root: options.workingDirectory,
      mode: 'workspace-write',
      requestedPaths: [],
    },
    hostTools: ['lark_cli'],
    network: 'none',
    externalSideEffects: 'denied',
    approval: { mode: 'never' },
  };
  database.exec(`
    ALTER TABLE continuation_jobs ADD COLUMN source_facts_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE continuation_jobs ADD COLUMN task_contract_json TEXT NOT NULL DEFAULT '{}';
  `);
  database.prepare(`
    UPDATE continuation_jobs SET source_facts_json = ?, task_contract_json = ?
  `).run(
    JSON.stringify({
      schemaVersion: 1,
      provenance: 'legacy_unavailable',
      originalUserText: null,
      sourceContextText: null,
      quotedMessageText: null,
      creatorOpenId: 'ou_creator',
      chatId: 'oc_legacy',
      chatType: '',
      route,
      sourceMessageId: 'om_legacy_v5',
      sourceThreadId: 'omt_legacy',
      sourceMessageType: null,
      sourceTimestamp: null,
      inputs: [],
      workingDirectory: options.workingDirectory,
      model: null,
      permissions,
    }),
    JSON.stringify({
      schemaVersion: 1,
      title: 'Legacy v5',
      objective: 'Migrate v5',
      deliverables: [],
      acceptanceCriteria: [],
      verificationRequirements: [],
      initialContext: JSON.parse(CHECKPOINT),
    }),
  );
  database.exec('PRAGMA user_version = 7;');
  if (options.version === 7) {
    return { ...fixture, deliveredMessageId };
  }

  database.exec(`
    ALTER TABLE continuation_jobs ADD COLUMN no_progress_count INTEGER NOT NULL DEFAULT 0
      CHECK(no_progress_count >= 0);
    ALTER TABLE continuation_attempts ADD COLUMN step_id TEXT;
    ALTER TABLE continuation_attempts ADD COLUMN delta_json TEXT;
    ALTER TABLE continuation_attempts ADD COLUMN verification_json TEXT;
    PRAGMA user_version = 8;
  `);
  if (options.version === 8) {
    return { ...fixture, deliveredMessageId };
  }

  const interruptId = 'interrupt_authentic_v9';
  database.exec(`
    ALTER TABLE continuation_jobs ADD COLUMN recovery_json TEXT;
    ALTER TABLE continuation_jobs ADD COLUMN recovery_total_count INTEGER NOT NULL DEFAULT 0
      CHECK(recovery_total_count >= 0);
    ALTER TABLE continuation_jobs ADD COLUMN recovery_fingerprint_counts_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE continuation_attempts ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'claimed'
      CHECK(execution_phase IN ('claimed', 'execution_started'));
    ALTER TABLE continuation_attempts ADD COLUMN recovery_json TEXT;
    UPDATE continuation_attempts SET execution_phase = 'execution_started';
    CREATE TABLE continuation_interrupts (
      interrupt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      attempt_id TEXT NOT NULL REFERENCES continuation_attempts(attempt_id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
      prompt TEXT NOT NULL,
      response_text TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(job_id, attempt_id)
    ) STRICT;
    CREATE UNIQUE INDEX continuation_interrupts_active_job_idx
      ON continuation_interrupts(job_id) WHERE status = 'pending';
    CREATE UNIQUE INDEX continuation_outbox_message_id_idx
      ON continuation_outbox(message_id) WHERE message_id IS NOT NULL;
    PRAGMA user_version = 9;
  `);
  database.prepare(`
    INSERT INTO continuation_interrupts (
      interrupt_id, job_id, attempt_id, status, prompt, response_text, created_at, resolved_at
    ) VALUES (?, ?, ?, 'resolved', 'Confirm the historical result.', 'confirmed', ?, ?)
  `).run(
    interruptId,
    fixture.terminalJobId,
    fixture.terminalAttemptId,
    options.now,
    '2026-07-17T00:00:04.000Z',
  );
  return { ...fixture, interruptId, deliveredMessageId };
}

function versionFourJobAndAttemptSchema(): string {
  return `
    CREATE TABLE continuation_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      retry_of_job_id TEXT REFERENCES continuation_jobs(job_id),
      creator_open_id TEXT NOT NULL,
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('message_thread', 'comment_thread')),
      route_json TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_thread_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      context_snapshot_json TEXT NOT NULL,
      required_tools_json TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      model TEXT,
      parent_session_id TEXT,
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 20),
      max_retries INTEGER NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      row_version INTEGER NOT NULL CHECK(row_version >= 1),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'waiting_retry', 'cancel_requested',
        'completed', 'partial', 'blocked', 'failed', 'cancelled'
      )),
      execution_session_id TEXT,
      checkpoint_json TEXT,
      step_count INTEGER NOT NULL CHECK(step_count >= 0),
      failure_count INTEGER NOT NULL CHECK(failure_count >= 0),
      next_run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      result_summary TEXT,
      result_artifacts_json TEXT NOT NULL,
      error_code TEXT,
      error_summary TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    ) STRICT;
    CREATE INDEX continuation_jobs_due_idx
      ON continuation_jobs(status, next_run_at, created_at) WHERE deleted_at IS NULL;
    CREATE INDEX continuation_jobs_creator_idx
      ON continuation_jobs(creator_open_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE TABLE continuation_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      ordinal INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      execution_session_id TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN (
        'continue', 'completed', 'partial', 'failed', 'blocked', 'error', 'cancelled'
      )),
      error_code TEXT,
      error_summary TEXT,
      UNIQUE(job_id, ordinal)
    ) STRICT;
  `;
}

function toolCallSchema(): string {
  return `
    CREATE TABLE continuation_tool_calls (
      call_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      step_index INTEGER NOT NULL CHECK(step_index >= 0),
      attempt_id TEXT NOT NULL REFERENCES continuation_attempts(attempt_id),
      tool_name TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed')),
      result_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, step_index)
    ) STRICT;
  `;
}

function versionFourOutboxSchema(): string {
  return `
    CREATE TABLE continuation_outbox (
      outbox_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES continuation_jobs(job_id),
      route_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'sending', 'delivered', 'delivery_unknown', 'failed'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      worker_id TEXT,
      lease_expires_at TEXT,
      first_attempt_at TEXT,
      last_attempt_at TEXT,
      message_id TEXT,
      error_code TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX continuation_outbox_due_idx
      ON continuation_outbox(status, next_attempt_at, created_at);
  `;
}

function versionFiveOutboxSchema(): string {
  return `
    CREATE TABLE continuation_outbox (
      outbox_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES continuation_jobs(job_id),
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('progress', 'terminal')),
      attempt_id TEXT REFERENCES continuation_attempts(attempt_id),
      route_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'sending', 'delivered', 'delivery_unknown', 'failed', 'superseded'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
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
      UNIQUE(job_id, event_key),
      CHECK(
        (kind = 'terminal' AND event_key = 'terminal' AND attempt_id IS NULL)
        OR
        (kind = 'progress' AND event_key = 'progress:' || attempt_id AND attempt_id IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX continuation_outbox_due_idx
      ON continuation_outbox(status, kind, next_attempt_at, created_at);
  `;
}
