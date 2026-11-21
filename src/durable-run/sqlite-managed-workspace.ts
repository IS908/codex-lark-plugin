import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { z } from 'zod';
import {
  managedRunAllocationSchema,
  managedRunIntentSchema,
  type ManagedRunAllocation,
  type ManagedRunIntent,
  type ManagedRunOwner,
  type ManagedWorkspacePurpose,
} from '../domain/managed-workspace.js';
import { sameWorkspaceProject } from '../domain/workspace.js';
import {
  allocateManagedRunDirectories,
  managedRunDirectoryPath,
  ManagedWorkspaceStorageError,
  validateManagedRunDirectory,
  validateManagedWorkspaceRoots,
} from '../managed-workspace-storage.js';

interface AllocationRecord {
  allocation: ManagedRunAllocation;
  lastUsedAt: string;
}

type AuthorizedRoots = readonly [string, ...string[]];
type EnsureRequest = Omit<ManagedRunIntent, 'version'> & { authorizedRoots: AuthorizedRoots; usedAt?: string };

const timestamp = z.iso.datetime();

export class SqliteManagedWorkspaceStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_run_allocations (
        workload_kind TEXT NOT NULL CHECK (workload_kind IN ('foreground', 'cron_prompt', 'async_task')),
        run_id TEXT NOT NULL,
        scratch_path TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
        allocation_json TEXT CHECK (allocation_json IS NULL OR json_valid(allocation_json)),
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (workload_kind, run_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workspace_run_scratch_path ON workspace_run_allocations(scratch_path);
      CREATE INDEX IF NOT EXISTS workspace_run_artifact_path ON workspace_run_allocations(artifact_path);
    `);
  }

  get(owner: ManagedRunOwner): AllocationRecord | null {
    const row = this.database.prepare(`
      SELECT intent_json, allocation_json, last_used_at, scratch_path, artifact_path
      FROM workspace_run_allocations WHERE workload_kind = ? AND run_id = ?
    `).get(owner.kind, owner.runId);
    if (!row) return null;
    if (row.allocation_json === null) throw new ManagedWorkspaceStorageError('allocation_incomplete');
    const intent = parseStored(managedRunIntentSchema, row.intent_json);
    const allocation = parseStored(managedRunAllocationSchema, row.allocation_json);
    const lastUsedAt = timestamp.safeParse(row.last_used_at);
    if (!lastUsedAt.success || intent.owner.kind !== owner.kind || intent.owner.runId !== owner.runId
      || allocation.owner.kind !== owner.kind || allocation.owner.runId !== owner.runId
      || row.scratch_path !== allocation.scratch.directory || row.artifact_path !== allocation.artifacts.directory
      || intent.createdAt !== allocation.createdAt
      || !sameWorkspaceProject(intent.project, allocation.project)
      || !sameWorkspaceProject(intent.roots.scratch, allocation.roots.scratch)
      || !sameWorkspaceProject(intent.roots.artifacts, allocation.roots.artifacts)) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    return { allocation, lastUsedAt: lastUsedAt.data };
  }

  async ensure({ authorizedRoots, usedAt, ...input }: EnsureRequest): Promise<ManagedRunAllocation> {
    const parsed = managedRunIntentSchema.safeParse({ version: 1, ...input });
    const lastUse = timestamp.safeParse(usedAt ?? input.createdAt);
    if (!parsed.success || !lastUse.success) throw new ManagedWorkspaceStorageError('invalid_binding');
    this.requireAutocommit();
    const { owner, ...snapshot } = parsed.data;
    const lastUsedAt = new Date(lastUse.data).toISOString();
    const existing = this.get(owner);
    if (existing) return this.reuse(existing, snapshot, authorizedRoots, lastUsedAt);
    await validateManagedWorkspaceRoots(snapshot.roots, { authorizedRoots, project: snapshot.project });
    const concurrent = this.reserve(parsed.data, lastUsedAt);
    if (concurrent) return this.reuse(concurrent, snapshot, authorizedRoots, lastUsedAt);

    // A reservation is not permission to adopt an existing folder after a crash.
    const allocation = await allocateManagedRunDirectories({ ...snapshot, owner, authorizedRoots });
    this.requireAutocommit();
    const committed = this.database.prepare(`
      UPDATE workspace_run_allocations SET allocation_json = ?
      WHERE workload_kind = ? AND run_id = ? AND intent_json = ? AND allocation_json IS NULL
    `).run(JSON.stringify(allocation), owner.kind, owner.runId, JSON.stringify(parsed.data));
    if (committed.changes !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
    return allocation;
  }

  async openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: AuthorizedRoots): Promise<string> {
    const stored = this.get(owner);
    if (!stored) throw new ManagedWorkspaceStorageError('invalid_binding');
    return validateManagedRunDirectory(stored.allocation, purpose, authorizedRoots);
  }

  private async reuse(
    { allocation }: AllocationRecord, snapshot: Omit<ManagedRunIntent, 'owner'>,
    authorizedRoots: AuthorizedRoots, lastUsedAt: string,
  ): Promise<ManagedRunAllocation> {
    if (!sameWorkspaceProject(allocation.project, snapshot.project)) throw new ManagedWorkspaceStorageError('invalid_binding');
    await Promise.all([
      validateManagedRunDirectory(allocation, 'scratch', authorizedRoots),
      validateManagedRunDirectory(allocation, 'artifacts', authorizedRoots),
    ]);
    this.requireAutocommit();
    this.touch(allocation.owner, lastUsedAt);
    return allocation;
  }

  private reserve(intent: ManagedRunIntent, lastUsedAt: string): AllocationRecord | null {
    this.requireAutocommit();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(intent.owner);
      if (!existing) {
        const scratchPath = managedRunDirectoryPath(intent.roots.scratch, intent.owner);
        const artifactPath = managedRunDirectoryPath(intent.roots.artifacts, intent.owner);
        this.requireUnoccupied(scratchPath);
        this.requireUnoccupied(artifactPath);
        this.database.prepare(`
          INSERT INTO workspace_run_allocations (
            workload_kind, run_id, scratch_path, artifact_path, intent_json, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(intent.owner.kind, intent.owner.runId, scratchPath, artifactPath, JSON.stringify(intent), lastUsedAt);
      }
      this.database.exec('COMMIT');
      return existing;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireUnoccupied(candidate: string): void {
    const exact = this.database.prepare(`
      SELECT 1 FROM workspace_run_allocations WHERE scratch_path = ? OR artifact_path = ? LIMIT 1
    `);
    for (let current = candidate; ; current = path.dirname(current)) {
      if (exact.get(current, current)) throw new ManagedWorkspaceStorageError('overlapping_runs');
      if (path.dirname(current) === current) break;
    }
    // BINARY collation: the next separator code point is the exclusive bound for descendants.
    const prefix = `${candidate}${path.sep}`;
    const upper = `${candidate}${String.fromCharCode(path.sep.charCodeAt(0) + 1)}`;
    const nested = this.database.prepare(`
      SELECT 1 FROM workspace_run_allocations
      WHERE (scratch_path >= ? AND scratch_path < ?) OR (artifact_path >= ? AND artifact_path < ?)
      LIMIT 1
    `).get(prefix, upper, prefix, upper);
    if (nested) throw new ManagedWorkspaceStorageError('overlapping_runs');
  }

  private requireAutocommit(): void {
    if (this.database.isTransaction) throw new ManagedWorkspaceStorageError('allocation_transaction');
  }

  private touch(owner: ManagedRunOwner, usedAt: string): void {
    this.database.prepare(`
      UPDATE workspace_run_allocations SET last_used_at = max(last_used_at, ?)
      WHERE workload_kind = ? AND run_id = ?
    `).run(usedAt, owner.kind, owner.runId);
  }
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    if (typeof value !== 'string') throw new Error('Expected a JSON string.');
    return schema.parse(JSON.parse(value));
  } catch {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
}
