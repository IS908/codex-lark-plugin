import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  installContinuationCompatibilitySchema,
  migrateSqliteToDurableV10,
} from '../durable-run/sqlite-migrations.js';

const ASYNC_TASK_FACTS_MIGRATION_VERSION = 70;

export async function openContinuationDatabase(databasePath: string): Promise<DatabaseSync> {
  const resolvedPath = path.resolve(databasePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(resolvedPath), 0o700);

  // Keep loading node:sqlite behind the explicit Node version gate used at startup.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(resolvedPath, {
    timeout: 5_000,
    enableForeignKeyConstraints: true,
  });
  try {
    await fs.chmod(resolvedPath, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function initializeContinuationDatabase(database: DatabaseSync): Promise<void> {
  const existingVersion = Number(scalar(database, 'PRAGMA user_version'));
  if (
    existingVersion > DURABLE_RUN_SCHEMA_VERSION
    && existingVersion !== ASYNC_TASK_FACTS_MIGRATION_VERSION
  ) {
    throw new Error(
      `Unsupported continuation database schema version ${existingVersion}; expected at most ${DURABLE_RUN_SCHEMA_VERSION}.`,
    );
  }
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  await retrySqliteBusy(() => database.exec('PRAGMA journal_mode = WAL;'), 5_000);
  database.exec('PRAGMA synchronous = NORMAL;');
  await retrySqliteBusy(() => {
    migrateSqliteToDurableV10(database);
    installContinuationCompatibilitySchema(database);
  }, 5_000);
  healthCheckContinuationDatabase(database);
}

export function healthCheckContinuationDatabase(database: DatabaseSync): void {
  const version = Number(scalar(database, 'PRAGMA user_version'));
  if (version !== DURABLE_RUN_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported continuation database schema version ${version}; expected ${DURABLE_RUN_SCHEMA_VERSION}.`,
    );
  }
  const row = database.prepare('PRAGMA quick_check').get();
  const value = row ? String(Object.values(row)[0]) : '';
  if (value !== 'ok') throw new Error(`Continuation database quick_check failed: ${value}`);
}

function scalar(database: DatabaseSync, sql: string): string | number | bigint | null {
  const row = database.prepare(sql).get();
  if (!row) return null;
  return Object.values(row)[0] as string | number | bigint | null;
}

async function retrySqliteBusy(operation: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      operation();
      return;
    } catch (error) {
      const sqliteError = error as Error & { errcode?: number };
      if (
        Date.now() >= deadline
        || (sqliteError.errcode !== 5 && !/database is (?:locked|busy)/i.test(sqliteError.message))
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
