import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type ManagedRunOwner, managedRunOwnerSchema } from '../domain/managed-workspace.js';
import { sameWorkspaceProject, workspaceProjectBindingSchema, type WorkspaceProjectBinding } from '../domain/workspace.js';
import type { WorkspaceCleanupEpoch } from '../workspace-cleanup-evidence.js';
import { workspacePathContains } from '../workspace-projects.js';
import { assertWorkspaceCleanupConnection, hasWorkspaceCleanupFences, initializeWorkspaceCleanupClaims,
  workspaceCleanupClaimsTable } from './workspace-cleanup-claim-schema.js';
import { readWorkspaceCleanupReferences, workspaceCleanupLedgerEligibility, type WorkspaceCleanupReference } from './workspace-cleanup-references.js';

const timestamp = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const claimState = z.enum(['reserved', 'isolated', 'removed', 'held']);
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

interface ReserveRequest {
  roots: { scratch: WorkspaceProjectBinding; artifacts: WorkspaceProjectBinding };
  observation: WorkspaceCleanupObservation;
  minimumAgeDays: number;
  now: string;
  epoch?: WorkspaceCleanupEpoch;
}

export class SqliteWorkspaceCleanupClaims {
  private readonly scope = Symbol();

  constructor(private readonly database: DatabaseSync) {
    initializeWorkspaceCleanupClaims(database);
  }

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
  reserve(request: ReserveRequest): WorkspaceCleanupClaim | undefined {
    const { roots, observation, minimumAgeDays, now, epoch } = request;
    const { reference: expected, paths: expectedPaths } = observation;
    if (!timestamp.safeParse(now).success || !Number.isSafeInteger(minimumAgeDays) || minimumAgeDays < 1 || minimumAgeDays > 3650) return;
    return this.transaction(() => {
      if (observation.scope !== this.scope || observation.revision !== this.revision()) return;
      const current = readWorkspaceCleanupReferences(this.database, roots.scratch, expected.owner);
      const reference = current.references[0];
      const record = reference?.record;
      if (!reference || !record || current.invalidRows || current.truncated || current.references.length !== 1
        || current.paths.incomplete || current.paths.unresolvedActiveCron || JSON.stringify(current.paths) !== JSON.stringify(expectedPaths)
        || JSON.stringify(reference) !== JSON.stringify(expected)
        || !reference.scratchBaseline || workspaceCleanupLedgerEligibility(reference, new Date(now), minimumAgeDays, epoch).reasons.length) return;
      const { allocation } = record;
      const fold = (directory: string) => process.platform === 'darwin' ? directory.normalize('NFD').toLowerCase() : directory;
      const scratch = fold(allocation.scratch.directory);
      if (
        !sameWorkspaceProject(roots.scratch, allocation.roots.scratch)
        || !sameWorkspaceProject(roots.artifacts, allocation.roots.artifacts)
        || path.dirname(allocation.scratch.directory) !== roots.scratch.directory || allocation.scratch.device !== roots.scratch.device
        || current.paths.paths.map(fold).some((saved) => workspacePathContains(saved, scratch) || workspacePathContains(scratch, saved))) return;

      const claim: WorkspaceCleanupClaim = {
        owner: reference.owner, nonce: randomBytes(16).toString('hex'), scratch: allocation.scratch,
        baseline: reference.scratchBaseline, lastUsedAt: record.lastUsedAt, reservedAt: now, updatedAt: now,
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

  advance(expected: WorkspaceCleanupClaim, next: 'isolated' | 'removed' | 'held', now: string,
    reason?: z.infer<typeof holdReason>): WorkspaceCleanupClaim | undefined {
    if (!timestamp.safeParse(now).success || Date.parse(now) < Date.parse(expected.updatedAt)) return;
    if (!(next === 'isolated' && expected.state === 'reserved' || next === 'removed' && expected.state === 'isolated'
      || next === 'held' && ['reserved', 'isolated'].includes(expected.state))) return;
    if (next === 'held' ? !holdReason.safeParse(reason).success : reason !== undefined) return;
    return this.transaction(() => {
      if (JSON.stringify(this.get(expected.owner)) !== JSON.stringify(expected)) return;
      this.database.prepare(`UPDATE main.${workspaceCleanupClaimsTable} SET state = ?, updated_at = ?, reason = ?
        WHERE workload_kind = ? AND run_id = ? AND nonce = ? AND state = ?`)
        .run(next, now, reason ?? null, expected.owner.kind, expected.owner.runId, expected.nonce, expected.state);
      return { ...expected, state: next, updatedAt: now, reason: reason ?? null };
    });
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
