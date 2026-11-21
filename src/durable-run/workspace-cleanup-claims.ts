import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type ManagedRunOwner, managedRunOwnerSchema } from '../domain/managed-workspace.js';
import { sameWorkspaceProject, workspaceProjectBindingSchema, type WorkspaceProjectBinding } from '../domain/workspace.js';
import type { WorkspaceCleanupEpoch } from '../workspace-cleanup-evidence.js';
import { workspacePathContains } from '../workspace-projects.js';
import { assertWorkspaceCleanupConnection, hasWorkspaceCleanupFences, initializeWorkspaceCleanupClaims,
  workspaceCleanupClaimsTable, workspaceCleanupCursorTable } from './workspace-cleanup-claim-schema.js';
import { readWorkspaceCleanupReferences, workspaceCleanupLedgerEligibility, type WorkspaceCleanupReference } from './workspace-cleanup-references.js';

const timestamp = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const claimState = z.enum(['reserved', 'isolated', 'purging', 'removed', 'held']);
const holdReason = z.enum(['identity_unverified', 'references_changed', 'quarantine_unverified', 'purge_incomplete']);
const claimSchema = z.strictObject({
  owner: managedRunOwnerSchema.refine(({ kind }) => kind !== 'foreground'),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  scratch: workspaceProjectBindingSchema,
  baseline: digest,
  lastUsedAt: timestamp,
  reservedAt: timestamp,
  updatedAt: timestamp,
  state: claimState,
  reason: holdReason.nullable(),
});
export type WorkspaceCleanupClaim = z.infer<typeof claimSchema>;
type ProtectedPaths = ReturnType<typeof readWorkspaceCleanupReferences>['paths'];
interface WorkspaceCleanupObservation {
  reference: WorkspaceCleanupReference;
  paths: ProtectedPaths;
  scope: symbol;
  revision: string;
}

export interface WorkspaceCleanupAuthorization {
  roots: { scratch: WorkspaceProjectBinding; artifacts: WorkspaceProjectBinding };
  observation: WorkspaceCleanupObservation;
  minimumAgeDays: number;
  now: string;
  epoch?: WorkspaceCleanupEpoch;
}

interface CandidateCursor {
  owner: ManagedRunOwner;
  completedAt: string;
}

export class SqliteWorkspaceCleanupClaims {
  private readonly scope = Symbol();

  constructor(private readonly database: DatabaseSync) {
    initializeWorkspaceCleanupClaims(database);
  }

  get databasePath() { return this.database.location(); }

  get(owner: ManagedRunOwner): WorkspaceCleanupClaim | undefined {
    const row = this.database.prepare(`SELECT * FROM main.${workspaceCleanupClaimsTable} WHERE workload_kind = ? AND run_id = ?`)
      .get(owner.kind, owner.runId);
    if (!row) return;
    return claimSchema.parse({
      owner: { kind: row.workload_kind, runId: row.run_id }, nonce: row.nonce,
      scratch: { directory: row.scratch_path, device: row.scratch_device, inode: row.scratch_inode },
      baseline: row.scratch_baseline, lastUsedAt: row.last_used_at, reservedAt: row.reserved_at, updatedAt: row.updated_at,
      state: row.state, reason: row.reason,
    });
  }

  observe(root: WorkspaceProjectBinding, owner: ManagedRunOwner): WorkspaceCleanupObservation | undefined {
    if (this.database.isTransaction) throw new Error('Workspace cleanup observation requires autocommit.');
    assertWorkspaceCleanupConnection(this.database);
    if (!hasWorkspaceCleanupFences(this.database)) throw new Error('Workspace cleanup claim fences are unavailable.');
    const revision = this.revision();
    const observation = readWorkspaceCleanupReferences(this.database, root, owner);
    const reference = observation.references[0];
    if (!reference || observation.invalidRows || observation.truncated || observation.references.length !== 1
      || this.revision() !== revision) return;
    return { reference, paths: observation.paths, revision, scope: this.scope };
  }

  // Caller owns the runtime instance lock and has already verified the filesystem. This transaction fences ledger changes.
  reserve(request: WorkspaceCleanupAuthorization): WorkspaceCleanupClaim | undefined {
    return this.transaction(() => {
      const eligible = this.eligible(request);
      if (!eligible) return;
      const { record, reference, baseline } = eligible;
      const now = request.now;
      const claim: WorkspaceCleanupClaim = {
        owner: reference.owner, nonce: randomBytes(16).toString('hex'), scratch: record.allocation.scratch,
        baseline, lastUsedAt: record.lastUsedAt, reservedAt: now, updatedAt: now,
        state: 'reserved', reason: null,
      };
      this.database.prepare(`INSERT INTO main.${workspaceCleanupClaimsTable}
        (workload_kind, run_id, nonce, scratch_path, scratch_device, scratch_inode, scratch_baseline, last_used_at, reserved_at, updated_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`).run(
        claim.owner.kind, claim.owner.runId, claim.nonce, claim.scratch.directory, claim.scratch.device, claim.scratch.inode,
        claim.baseline, claim.lastUsedAt, claim.reservedAt, claim.updatedAt);
      return claim;
    });
  }

  pending(root: WorkspaceProjectBinding, limit: number): WorkspaceCleanupClaim[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid workspace cleanup claim limit.');
    const rows = this.database.prepare(`SELECT workload_kind, run_id FROM main.${workspaceCleanupClaimsTable}
      WHERE scratch_path >= ? AND scratch_path < ? AND state IN ('reserved', 'isolated', 'purging')
      ORDER BY updated_at, reserved_at, workload_kind, run_id LIMIT ?`).all(root.directory + '/', root.directory + '0', limit);
    return rows.map((row) => this.get(managedRunOwnerSchema.parse({ kind: row.workload_kind, runId: row.run_id }))!);
  }

  candidates(root: WorkspaceProjectBinding, cutoff: string, limit: number): CandidateCursor[] {
    if (!timestamp.safeParse(cutoff).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('Invalid workspace cleanup candidate query.');
    }
    const cursor = this.database.prepare(`SELECT completion, workload_kind, run_id FROM main.${workspaceCleanupCursorTable}
      WHERE scratch_root = ? AND root_device = ? AND root_inode = ?`).get(root.directory, root.device, root.inode);
    const scan = (after?: Array<string | number | bigint | Uint8Array | null>) => this.database.prepare(`
      SELECT a.workload_kind, a.run_id, r.completed_at
      FROM main.workspace_run_allocations a JOIN main.durable_runs r
        ON r.run_id = a.run_id AND r.workload_kind = a.workload_kind
      WHERE a.scratch_path >= ? AND a.scratch_path < ? AND a.workload_kind IN ('async_task', 'cron_prompt')
        AND r.status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled')
        AND r.completed_at <= ? AND a.last_used_at <= ?
        AND r.retained = 0 AND r.lease_owner IS NULL AND r.lease_expires_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM main.${workspaceCleanupClaimsTable} j
          WHERE j.workload_kind = a.workload_kind AND j.run_id = a.run_id)
        ${after ? 'AND (r.completed_at, a.workload_kind, a.run_id) > (?, ?, ?)' : ''}
      ORDER BY r.completed_at, a.workload_kind, a.run_id LIMIT ?`)
      .all(root.directory + '/', root.directory + '0', cutoff, cutoff, ...(after ?? []), limit);
    const rows = cursor ? scan([cursor.completion, cursor.workload_kind, cursor.run_id]) : scan();
    return (cursor && !rows.length ? scan() : rows).map((row) => ({
      owner: managedRunOwnerSchema.parse({ kind: row.workload_kind, runId: row.run_id }),
      completedAt: timestamp.parse(row.completed_at),
    }));
  }

  recordCandidateScan(root: WorkspaceProjectBinding, { owner, completedAt }: CandidateCursor): void {
    this.transaction(() => {
      this.database.prepare(`INSERT INTO main.${workspaceCleanupCursorTable}
        (scratch_root, root_device, root_inode, completion, workload_kind, run_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scratch_root) DO UPDATE SET root_device=excluded.root_device, root_inode=excluded.root_inode,
          completion=excluded.completion, workload_kind=excluded.workload_kind, run_id=excluded.run_id`)
        .run(root.directory, root.device, root.inode, completedAt, owner.kind, owner.runId);
    });
  }

  postpone(expected: WorkspaceCleanupClaim, now: string): boolean {
    return this.transaction(() => {
      if (!timestamp.safeParse(now).success || Date.parse(now) <= Date.parse(expected.updatedAt)
        || !['reserved', 'isolated', 'purging'].includes(expected.state) || !this.sameClaim(expected)) return false;
      this.writeState(expected, expected.state, now, null);
      return true;
    });
  }

  // Called only during the native helper's BEGIN IMMEDIATE handshake, over this same ledger.
  confirm(expected: WorkspaceCleanupClaim, request: WorkspaceCleanupAuthorization): boolean {
    if (this.database.isTransaction) return false;
    assertWorkspaceCleanupConnection(this.database);
    // The already-open Node connection must conflict with the helper's writer lock.
    // Filesystem-side pins independently require the same WAL and shared-memory files.
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.exec('ROLLBACK');
      return false;
    } catch (error) {
      if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) return false;
    }
    return Date.parse(request.now) >= Date.parse(expected.updatedAt)
      && hasWorkspaceCleanupFences(this.database) && this.sameClaim(expected) && !!this.eligible(request, expected);
  }

  perform(expected: WorkspaceCleanupClaim, request: WorkspaceCleanupAuthorization, next: 'isolated' | 'purging' | 'removed',
    effect?: () => boolean): WorkspaceCleanupClaim | undefined {
    const previous = { isolated: 'reserved', purging: 'isolated', removed: 'purging' } as const;
    if (expected.state !== previous[next] || (next === 'purging') !== (effect === undefined)) return;
    return this.transaction(() => {
      if (Date.parse(request.now) < Date.parse(expected.updatedAt) || !this.sameClaim(expected)) return;
      if (!this.eligible(request, expected)) return;
      // Effects here must be synchronous. Native subprocesses keep their own writer reservation.
      if (effect && effect() !== true) return;
      return this.writeState(expected, next, request.now, null);
    });
  }

  hold(expected: WorkspaceCleanupClaim, now: string, reason: z.infer<typeof holdReason>): WorkspaceCleanupClaim | undefined {
    if (!timestamp.safeParse(now).success || Date.parse(now) < Date.parse(expected.updatedAt)) return;
    if (!['reserved', 'isolated', 'purging'].includes(expected.state) || !holdReason.safeParse(reason).success) return;
    return this.transaction(() => {
      if (!this.sameClaim(expected)) return;
      return this.writeState(expected, 'held', now, reason);
    });
  }

  private eligible(request: WorkspaceCleanupAuthorization, claim?: WorkspaceCleanupClaim) {
    const { roots, observation, minimumAgeDays, now, epoch } = request;
    const { reference: expected, paths: expectedPaths } = observation;
    if (!timestamp.safeParse(now).success || !Number.isSafeInteger(minimumAgeDays) || minimumAgeDays < 1 || minimumAgeDays > 3650
      || observation.scope !== this.scope || observation.revision !== this.revision()) return;
    if (claim && (expected.owner.kind !== claim.owner.kind || expected.owner.runId !== claim.owner.runId)) return;
    const current = readWorkspaceCleanupReferences(this.database, roots.scratch, expected.owner);
    const reference = current.references[0];
    const record = reference?.record;
    const baseline = reference?.scratchBaseline;
    if (!reference || !record || !baseline || current.invalidRows || current.truncated || current.references.length !== 1
      || current.paths.incomplete || current.paths.unresolvedActiveCron || JSON.stringify(current.paths) !== JSON.stringify(expectedPaths)
      || JSON.stringify(reference) !== JSON.stringify(expected)
      || workspaceCleanupLedgerEligibility({ ...reference, cleanupClaimed: !claim && reference.cleanupClaimed },
        new Date(now), minimumAgeDays, epoch).reasons.length) return;
    const { allocation } = record;
    const fold = (directory: string) => process.platform === 'darwin' ? directory.normalize('NFD').toLowerCase() : directory;
    const scratch = fold(allocation.scratch.directory);
    if (!sameWorkspaceProject(roots.scratch, allocation.roots.scratch)
      || !sameWorkspaceProject(roots.artifacts, allocation.roots.artifacts)
      || path.dirname(allocation.scratch.directory) !== roots.scratch.directory || allocation.scratch.device !== roots.scratch.device
      || current.paths.paths.map(fold).some((saved) => workspacePathContains(saved, scratch) || workspacePathContains(scratch, saved))) return;
    if (claim && (!reference.cleanupClaimed || !sameWorkspaceProject(allocation.scratch, claim.scratch)
      || baseline !== claim.baseline || record.lastUsedAt !== claim.lastUsedAt)) return;
    return { record, reference, baseline };
  }

  private sameClaim(expected: WorkspaceCleanupClaim): boolean {
    return JSON.stringify(this.get(expected.owner)) === JSON.stringify(expected);
  }

  private writeState(expected: WorkspaceCleanupClaim, state: WorkspaceCleanupClaim['state'], now: string,
    reason: WorkspaceCleanupClaim['reason']): WorkspaceCleanupClaim {
    const result = this.database.prepare(`UPDATE main.${workspaceCleanupClaimsTable} SET state = ?, updated_at = ?, reason = ?
      WHERE workload_kind = ? AND run_id = ? AND nonce = ? AND state = ?`)
      .run(state, now, reason, expected.owner.kind, expected.owner.runId, expected.nonce, expected.state);
    if (result.changes !== 1) throw new Error('Workspace cleanup claim changed during transition.');
    return { ...expected, state, updatedAt: now, reason };
  }

  private revision() {
    // data_version detects other connections' commits. total_changes also invalidates an observation after local writes.
    const remote = this.database.prepare('PRAGMA main.data_version').get()?.data_version;
    const local = this.database.prepare('SELECT total_changes() AS changes').get()?.changes;
    if (typeof remote !== 'number' || typeof local !== 'number') throw new Error('Workspace cleanup ledger revision is unavailable.');
    return `${remote}:${local}`;
  }

  private transaction<T>(operation: () => T): T {
    assertWorkspaceCleanupConnection(this.database);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!hasWorkspaceCleanupFences(this.database)) throw new Error('Workspace cleanup claim fences are unavailable.');
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
