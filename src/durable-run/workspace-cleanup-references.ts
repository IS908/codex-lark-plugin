import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { managedRunOwnerSchema, type ManagedRunOwner } from '../domain/managed-workspace.js';
import type { ManagedWorkspaceRecord } from '../ports/managed-workspace.js';
import { managedRunDirectoryPath, ManagedWorkspaceStorageError } from '../managed-workspace-storage.js';
import type { WorkspaceProjectBinding } from '../domain/workspace.js';
import { parseManagedWorkspaceRecord } from './sqlite-managed-workspace.js';

export const maxCleanupPreviewRows = 100;
const maxRetryReferences = 4096;
const maxPathReferences = 1024;

export interface WorkspaceCleanupReference {
  leaf: string;
  owner: ManagedRunOwner;
  record?: ManagedWorkspaceRecord;
  allocationError?: 'allocation_incomplete' | 'allocation_invalid';
  runStatus: string | null;
  terminalAt: string | null;
  retained: boolean;
  lease: boolean;
  attemptExists: boolean;
  attemptCount: number | bigint | null;
  unsettledDelivery: boolean;
  terminalDeliverySent: boolean;
  foregroundDeliveryPending: boolean;
  retryReference: boolean;
  pendingStage: boolean;
}

export function readWorkspaceCleanupReferences(database: DatabaseSync, root: WorkspaceProjectBinding) {
  const retries = database.prepare(`SELECT json_extract(input_json, '$.job.retryOfJobId') AS source
    FROM durable_runs WHERE workload_kind = 'async_task' AND deleted_at IS NULL
      AND json_type(input_json, '$.job.retryOfJobId') = 'text' LIMIT ?`).all(maxRetryReferences + 1);
  const incomplete = retries.length > maxRetryReferences;
  const retrySource = new Set(retries.map(({ source }) => source));
  const prefix = root.directory + path.sep;
  const upper = root.directory + String.fromCharCode(path.sep.charCodeAt(0) + 1);
  const selected = database.prepare(`SELECT w.*, r.status AS run_status, r.completed_at AS terminal_at,
    r.retained AS run_retained, (r.lease_owner IS NOT NULL OR r.lease_expires_at IS NOT NULL) AS has_lease,
    r.attempt_count, EXISTS(SELECT 1 FROM durable_attempts a WHERE a.run_id = r.run_id) AS has_attempt,
    EXISTS(SELECT 1 FROM durable_outbox o WHERE o.run_id = r.run_id AND (o.status NOT IN ('sent', 'superseded')
      OR o.lease_expires_at IS NOT NULL OR o.worker_id IS NOT NULL)) AS unsettled_delivery,
    EXISTS(SELECT 1 FROM durable_outbox o WHERE o.run_id = r.run_id AND o.status = 'sent'
      AND o.kind = CASE w.workload_kind WHEN 'async_task' THEN 'terminal' WHEN 'cron_prompt' THEN 'cron_terminal' END
      AND o.message_id IS NOT NULL) AS terminal_delivery_sent,
    EXISTS(SELECT 1 FROM workspace_foreground_artifacts f WHERE w.workload_kind = 'foreground' AND f.run_id = w.run_id
      AND (json_extract(f.batch_json, '$.version') IS NOT 2 OR json_extract(f.batch_json, '$.reply.status') IS NOT 'sent'
      OR json_type(f.batch_json, '$.files') IS NOT 'array' OR EXISTS(SELECT 1 FROM json_each(f.batch_json, '$.files') part
        WHERE json_extract(part.value, '$.status') IS NOT 'sent'))) AS foreground_delivery_pending,
    (EXISTS(SELECT 1 FROM workspace_retry_artifact_stages s WHERE w.workload_kind = 'async_task' AND s.run_id = w.run_id)
      OR EXISTS(SELECT 1 FROM workspace_dependency_installs i WHERE i.workload_kind = w.workload_kind
      AND i.run_id = w.run_id AND i.receipt_json IS NULL)) AS pending_stage
    FROM workspace_run_allocations w LEFT JOIN durable_runs r ON r.run_id = w.run_id AND r.workload_kind = w.workload_kind
    WHERE w.scratch_path >= ? AND w.scratch_path < ? ORDER BY w.scratch_path LIMIT ?`).all(prefix, upper, maxCleanupPreviewRows + 1);
  const references: WorkspaceCleanupReference[] = [];
  let invalidRows = 0;
  for (const row of selected.slice(0, maxCleanupPreviewRows)) {
    const owner = managedRunOwnerSchema.safeParse({ kind: row.workload_kind, runId: row.run_id });
    if (!owner.success || row.scratch_path !== managedRunDirectoryPath(root, owner.data)) { invalidRows++; continue; }
    let record: ManagedWorkspaceRecord | undefined;
    let allocationError: WorkspaceCleanupReference['allocationError'];
    try { record = parseManagedWorkspaceRecord(owner.data, row); }
    catch (error) {
      allocationError = error instanceof ManagedWorkspaceStorageError && error.code === 'allocation_incomplete'
        ? 'allocation_incomplete' : 'allocation_invalid';
    }
    references.push({ leaf: path.basename(row.scratch_path), owner: owner.data, record, allocationError,
      runStatus: typeof row.run_status === 'string' ? row.run_status : null,
      terminalAt: typeof row.terminal_at === 'string' ? row.terminal_at : null,
      retained: row.run_retained !== 0,
      lease: row.has_lease === 1, attemptExists: row.has_attempt === 1,
      attemptCount: typeof row.attempt_count === 'number' || typeof row.attempt_count === 'bigint' ? row.attempt_count : null,
      unsettledDelivery: row.unsettled_delivery === 1, terminalDeliverySent: row.terminal_delivery_sent === 1,
      foregroundDeliveryPending: row.foreground_delivery_pending === 1,
      retryReference: incomplete || retrySource.has(owner.data.runId), pendingStage: row.pending_stage === 1 });
  }
  return { references, invalidRows, truncated: selected.length > maxCleanupPreviewRows || incomplete,
    paths: readProtectedPathReferences(database) };
}

function readProtectedPathReferences(database: DatabaseSync) {
  const paths = new Set<string>();
  let incomplete = false;
  let unresolvedActiveCron = false;
  const add = (value: unknown, required = false) => {
    if (value === null && !required) return;
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
      || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)
      || paths.size >= maxPathReferences) { incomplete = true; return; }
    paths.add(value);
  };
  const saved = database.prepare(`SELECT json_extract(intent_json, '$.project.directory') AS project,
    json_extract(intent_json, '$.fallbackWorkspace.directory') AS fallback, NULL AS legacy
    FROM workspace_run_allocations
    WHERE json_type(intent_json, '$.project') IS NOT NULL OR json_type(intent_json, '$.fallbackWorkspace') IS NOT NULL
    UNION ALL SELECT json_extract(admission_json, '$.project.directory'), NULL, json_extract(admission_json, '$.fallbackCwd')
    FROM workspace_unmanaged_foreground LIMIT ?`).all(maxPathReferences + 1);
  if (saved.length > maxPathReferences) incomplete = true;
  for (const { project, fallback, legacy } of saved.slice(0, maxPathReferences)) {
    if (project === null && fallback === null && legacy === null) incomplete = true;
    add(project); add(fallback); add(legacy);
  }
  const jobs = database.prepare(`SELECT workload_kind, status, input_version,
    json_extract(input_json, '$.job.workingDirectory') AS cwd,
    json_extract(input_json, '$.job.permissions.filesystem.workspaceProject.directory') AS async_project,
    json_extract(input_json, '$.job.permissions.filesystem.requestedPaths') AS requested_paths,
    json_type(input_json, '$.job.permissions.filesystem.requestedPaths') AS requested_type,
    json_extract(input_json, '$.job.workspaceProject.directory') AS cron_project,
    json_extract(input_json, '$.managedWorkspace.fallbackWorkspace.directory') AS cron_fallback
    FROM durable_runs WHERE deleted_at IS NULL AND workload_kind IN ('async_task', 'cron_prompt')
    LIMIT ?`).all(maxPathReferences + 1);
  if (jobs.length > maxPathReferences) incomplete = true;
  for (const job of jobs.slice(0, maxPathReferences)) {
    if (job.input_version !== 1) { incomplete = true; continue; }
    if (job.workload_kind === 'async_task') {
      add(job.cwd, true); add(job.async_project);
      if (job.requested_type === 'array' && typeof job.requested_paths === 'string' && job.requested_paths.length <= 64 * 1024) {
        let parsed: unknown;
        try { parsed = JSON.parse(job.requested_paths); } catch { incomplete = true; }
        if (Array.isArray(parsed) && parsed.length <= 100) for (const entry of parsed) add(entry, true);
        else incomplete = true;
      } else incomplete = true;
    } else {
      add(job.cron_project); add(job.cron_fallback);
      if (job.cron_project === null && job.cron_fallback === null && !['completed', 'partial', 'blocked', 'failed', 'cancelled'].includes(String(job.status))) {
        unresolvedActiveCron = true;
      }
    }
  }
  return { paths: [...paths], incomplete, unresolvedActiveCron };
}
