import type { DatabaseSync } from 'node:sqlite';

const triggerName = 'workspace_cleanup_forget_legacy_use';
const triggerSql = `CREATE TRIGGER ${triggerName}
  AFTER UPDATE OF last_used_at ON workspace_run_allocations
  BEGIN
    UPDATE workspace_cleanup_evidence SET host = NULL, boot = NULL
    WHERE workload_kind = NEW.workload_kind AND run_id = NEW.run_id;
  END`;

export function hasWorkspaceCleanupWitnessTrigger(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(triggerName);
  return typeof row?.sql === 'string' && row.sql.trim().replace(/\s+/g, ' ') === triggerSql.trim().replace(/\s+/g, ' ');
}

export function initializeWorkspaceCleanupWitnessTrigger(database: DatabaseSync): void {
  if (hasWorkspaceCleanupWitnessTrigger(database)) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!hasWorkspaceCleanupWitnessTrigger(database)) {
      // A missing or altered trigger leaves a gap we cannot reconstruct, even if the table survived a restore.
      database.exec(`DROP TRIGGER IF EXISTS ${triggerName};
        UPDATE workspace_cleanup_evidence SET host = NULL, boot = NULL;
        ${triggerSql};`);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
