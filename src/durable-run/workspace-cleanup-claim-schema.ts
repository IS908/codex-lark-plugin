import type { DatabaseSync } from 'node:sqlite';
import type { ManagedRunOwner } from '../domain/managed-workspace.js';

export const workspaceCleanupClaimsTable = 'workspace_cleanup_claims';
const triggerName = 'workspace_cleanup_fence_claimed';
const installTriggerName = 'workspace_cleanup_fence_dependency_install';
const tableSql = `CREATE TABLE ${workspaceCleanupClaimsTable} (
  workload_kind TEXT NOT NULL CHECK (workload_kind IN ('cron_prompt', 'async_task')),
  run_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  scratch_path TEXT NOT NULL,
  scratch_device TEXT NOT NULL,
  scratch_inode TEXT NOT NULL,
  scratch_baseline TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'isolated', 'purging', 'removed', 'held')),
  reason TEXT,
  CHECK ((state = 'held') = (reason IS NOT NULL)),
  PRIMARY KEY (workload_kind, run_id),
  FOREIGN KEY (workload_kind, run_id) REFERENCES workspace_run_allocations(workload_kind, run_id)
) STRICT`;
const triggerSql = `CREATE TRIGGER ${triggerName}
  BEFORE UPDATE OF last_used_at, allocation_json, scratch_path, scratch_identity, intent_json ON workspace_run_allocations
  WHEN EXISTS (SELECT 1 FROM ${workspaceCleanupClaimsTable} c WHERE c.workload_kind = OLD.workload_kind AND c.run_id = OLD.run_id)
  BEGIN
    SELECT RAISE(ABORT, 'workspace_cleanup_claimed');
  END`;
const installTriggerSql = `CREATE TRIGGER ${installTriggerName}
  BEFORE INSERT ON workspace_dependency_installs
  WHEN EXISTS (SELECT 1 FROM ${workspaceCleanupClaimsTable} c WHERE c.workload_kind = NEW.workload_kind AND c.run_id = NEW.run_id)
  BEGIN
    SELECT RAISE(ABORT, 'workspace_cleanup_claimed');
  END`;

function sqlFor(database: DatabaseSync, type: 'table' | 'trigger', name: string) {
  return database.prepare('SELECT sql FROM main.sqlite_schema WHERE type = ? AND name = ?').get(type, name)?.sql;
}

export function assertWorkspaceCleanupConnection(database: DatabaseSync): void {
  if (database.prepare('PRAGMA database_list').all().some(({ name }) => name !== 'main' && name !== 'temp')
    || database.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) throw new Error('Workspace cleanup requires an isolated connection.');
  const sync = database.prepare('PRAGMA main.synchronous').get()?.synchronous;
  const journal = database.prepare('PRAGMA main.journal_mode').get()?.journal_mode;
  if (typeof sync !== 'number' || sync < 2 || journal !== 'wal'
    || (process.platform === 'darwin' && database.prepare('PRAGMA fullfsync').get()?.fullfsync !== 1)) {
    throw new Error('Workspace cleanup connection does not meet claim durability requirements.');
  }
}

export function hasWorkspaceCleanupFences(database: DatabaseSync): boolean {
  const matches = (actual: unknown, expected: string) =>
    typeof actual === 'string' && actual.trim().replace(/\s+/g, ' ') === expected.trim().replace(/\s+/g, ' ');
  return matches(sqlFor(database, 'table', workspaceCleanupClaimsTable), tableSql)
    && matches(sqlFor(database, 'trigger', triggerName), triggerSql)
    && matches(sqlFor(database, 'trigger', installTriggerName), installTriggerSql);
}

export function initializeWorkspaceCleanupClaims(database: DatabaseSync): void {
  assertWorkspaceCleanupConnection(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    // Do not repair a partial schema: a missing guard could have allowed an unrecorded scratch handoff.
    if (!sqlFor(database, 'table', workspaceCleanupClaimsTable) && !sqlFor(database, 'trigger', triggerName)
      && !sqlFor(database, 'trigger', installTriggerName)) {
      database.exec(`${tableSql}; ${triggerSql}; ${installTriggerSql};`);
    }
    if (!hasWorkspaceCleanupFences(database)) throw new Error('Workspace cleanup claim fences are unavailable.');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function isWorkspaceCleanupClaimed(database: DatabaseSync, owner: ManagedRunOwner): boolean {
  return !!sqlFor(database, 'table', workspaceCleanupClaimsTable)
    && !!database.prepare(`SELECT 1 FROM main.${workspaceCleanupClaimsTable} WHERE workload_kind = ? AND run_id = ?`).get(owner.kind, owner.runId);
}
