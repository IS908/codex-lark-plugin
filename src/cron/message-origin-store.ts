import type { DatabaseSync } from 'node:sqlite';

const DEFAULT_MAX_ENTRIES = 5_000;

export interface CronMessageOrigin {
  messageId: string;
  chatId: string;
  jobId: string;
  runId: string;
  jobName: string;
  jobCreatedAt: string;
  recordedAt: string;
}

export interface CronMessageOriginStore {
  get(messageId: string): Promise<CronMessageOrigin | null>;
  recordDelivery(input: {
    messageIds: readonly string[];
    chatId: string;
    jobId: string;
    runId: string;
    jobName: string;
    jobCreatedAt: string;
    recordedAt?: string;
  }): Promise<void>;
}

export type CronMessageOriginLookup = Pick<CronMessageOriginStore, 'get'>;
export type CronMessageOriginRecorder = Pick<CronMessageOriginStore, 'recordDelivery'>;

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

export class SqliteCronMessageOriginStore implements CronMessageOriginStore {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly maxEntries: number,
  ) {}

  static attach(
    database: DatabaseSync,
    options: { maxEntries?: number } = {},
  ): SqliteCronMessageOriginStore {
    const requested = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxEntries = Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : DEFAULT_MAX_ENTRIES;
    return new SqliteCronMessageOriginStore(database, maxEntries);
  }

  async get(messageId: string): Promise<CronMessageOrigin | null> {
    if (!messageId) return null;
    const row = this.database.prepare(`
      SELECT message_id, chat_id, job_id, run_id, job_name, job_created_at, recorded_at
      FROM cron_message_origins
      WHERE message_id = ?
    `).get(messageId) as SqlRow | undefined;
    return row ? mapOrigin(row) : null;
  }

  async recordDelivery(input: {
    messageIds: readonly string[];
    chatId: string;
    jobId: string;
    runId: string;
    jobName: string;
    jobCreatedAt: string;
    recordedAt?: string;
  }): Promise<void> {
    const messageIds = [...new Set(input.messageIds.map((value) => value.trim()).filter(Boolean))];
    if (messageIds.length === 0) return;
    const recordedAt = validIso(input.recordedAt ?? new Date().toISOString(), 'recordedAt');
    const values = {
      chatId: required(input.chatId, 'chatId'),
      jobId: required(input.jobId, 'jobId'),
      runId: required(input.runId, 'runId'),
      jobName: required(input.jobName, 'jobName'),
      jobCreatedAt: validIso(input.jobCreatedAt, 'jobCreatedAt'),
    };
    const insert = this.database.prepare(`
      INSERT INTO cron_message_origins (
        message_id, chat_id, job_id, run_id, job_name, job_created_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        job_id = excluded.job_id,
        run_id = excluded.run_id,
        job_name = excluded.job_name,
        job_created_at = excluded.job_created_at,
        recorded_at = excluded.recorded_at
    `);
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      for (const messageId of messageIds) {
        insert.run(
          required(messageId, 'messageId'),
          values.chatId,
          values.jobId,
          values.runId,
          values.jobName,
          values.jobCreatedAt,
          recordedAt,
        );
      }
      this.database.prepare(`
        DELETE FROM cron_message_origins
        WHERE message_id IN (
          SELECT message_id
          FROM cron_message_origins
          ORDER BY recorded_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(this.maxEntries);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}

function mapOrigin(row: SqlRow): CronMessageOrigin {
  return {
    messageId: stringField(row, 'message_id'),
    chatId: stringField(row, 'chat_id'),
    jobId: stringField(row, 'job_id'),
    runId: stringField(row, 'run_id'),
    jobName: stringField(row, 'job_name'),
    jobCreatedAt: validIso(stringField(row, 'job_created_at'), 'jobCreatedAt'),
    recordedAt: validIso(stringField(row, 'recorded_at'), 'recordedAt'),
  };
}

function stringField(row: SqlRow, key: string): string {
  return required(row[key], key);
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error(`Cron message origin ${label} is invalid.`);
  }
  return value;
}

function validIso(value: unknown, label: string): string {
  const text = required(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Cron message origin ${label} is invalid.`);
  return new Date(text).toISOString();
}
