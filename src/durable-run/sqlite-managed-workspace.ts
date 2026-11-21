import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { z } from 'zod';
import {
  managedRunAllocationSchema,
  foregroundArtifactBatchSchema,
  isManagedArtifactRelativePath,
  managedArtifactIdentitySchema,
  managedArtifactStageSchema,
  managedRunIntentSchema,
  unmanagedForegroundAdmissionSchema,
  type ManagedRunAllocation,
  type ForegroundArtifactBatch,
  type ManagedRunIntent,
  type ManagedRunOwner,
  type ManagedWorkspacePurpose,
  type UnmanagedForegroundAdmission,
} from '../domain/managed-workspace.js';
import { sameWorkspaceProject } from '../domain/workspace.js';
import type { ManagedArtifactStageJournal, ManagedWorkspaceAuthorizedRoots, ManagedWorkspaceRecord, ManagedWorkspaceStore } from '../ports/managed-workspace.js';
import {
  allocateManagedRunDirectories,
  directoryIdentity,
  managedRunDirectoryPath,
  ManagedWorkspaceStorageError,
  validateManagedRunDirectory,
  validateManagedWorkspaceRoots,
} from '../managed-workspace-storage.js';

const timestamp = z.iso.datetime();
const sourceRegistries = [
  ['workspace_run_allocations', 'intent_json'],
  ['workspace_unmanaged_foreground', 'admission_json'],
] as const;
const sourcePathExpr = (column: string) => `json_extract(${column}, '$.project.directory')`;
const sourceIdentityExpr = (column: string) => `(json_extract(${column}, '$.project.device') || ':' || json_extract(${column}, '$.project.inode'))`;
type RootAncestry = Awaited<ReturnType<typeof validateManagedWorkspaceRoots>>;

export class SqliteManagedWorkspaceStore implements ManagedWorkspaceStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_run_allocations (
        workload_kind TEXT NOT NULL CHECK (workload_kind IN ('foreground', 'cron_prompt', 'async_task')),
        run_id TEXT NOT NULL,
        scratch_path TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        scratch_identity TEXT,
        artifact_identity TEXT,
        intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
        allocation_json TEXT CHECK (allocation_json IS NULL OR json_valid(allocation_json)),
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (workload_kind, run_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS workspace_run_scratch_path ON workspace_run_allocations(scratch_path);
      CREATE INDEX IF NOT EXISTS workspace_run_artifact_path ON workspace_run_allocations(artifact_path);
      CREATE INDEX IF NOT EXISTS workspace_run_scratch_identity ON workspace_run_allocations(scratch_identity);
      CREATE INDEX IF NOT EXISTS workspace_run_artifact_identity ON workspace_run_allocations(artifact_identity);
      CREATE TABLE IF NOT EXISTS workspace_unmanaged_foreground (
        run_id TEXT PRIMARY KEY,
        admission_json TEXT NOT NULL CHECK (json_valid(admission_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspace_foreground_artifacts (
        run_id TEXT PRIMARY KEY,
        batch_json TEXT NOT NULL CHECK (json_valid(batch_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workspace_retry_artifact_stages (
        run_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
        PRIMARY KEY (run_id, relative_path)
      ) STRICT;
      ${sourceRegistries.map(([table, json]) => `
        CREATE INDEX IF NOT EXISTS ${table}_project_path ON ${table}(${sourcePathExpr(json)});
        CREATE INDEX IF NOT EXISTS ${table}_project_identity ON ${table}(${sourceIdentityExpr(json)});
      `).join('')}
    `);
  }

  getUnmanagedForeground(runId: string): UnmanagedForegroundAdmission | null {
    const row = this.database.prepare('SELECT admission_json FROM workspace_unmanaged_foreground WHERE run_id = ?').get(runId);
    return row ? parseStored(unmanagedForegroundAdmissionSchema, row.admission_json) : null;
  }

  getForegroundArtifacts(runId: string): ForegroundArtifactBatch | null {
    const row = this.database.prepare('SELECT batch_json FROM workspace_foreground_artifacts WHERE run_id = ?').get(runId);
    if (!row) return null;
    const batch = parseStored(foregroundArtifactBatchSchema, row.batch_json);
    if (this.get({ kind: 'foreground', runId })?.allocation.foregroundSessionKey !== batch.sessionKey) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    return batch;
  }

  retryArtifactStages(owner: ManagedRunOwner): ManagedArtifactStageJournal {
    if (owner.kind !== 'async_task' || !this.get(owner)) throw new ManagedWorkspaceStorageError('invalid_binding');
    const runId = owner.runId;
    return {
      get: (relativePath) => {
        const row = this.database.prepare(`SELECT nonce, sha256, identity_json FROM workspace_retry_artifact_stages
          WHERE run_id = ? AND relative_path = ?`).get(runId, relativePath);
        return row ? managedArtifactStageSchema.parse({ nonce: row.nonce, sha256: row.sha256,
          ...(row.identity_json === null ? {} : { identity: parseStored(managedArtifactIdentitySchema, row.identity_json) }),
        }) : null;
      },
      reserve: (relativePath, stage) => {
        this.requireAutocommit();
        if (!isManagedArtifactRelativePath(relativePath) || stage.identity || !managedArtifactStageSchema.safeParse(stage).success) {
          throw new ManagedWorkspaceStorageError('invalid_binding');
        }
        this.database.prepare(`INSERT INTO workspace_retry_artifact_stages (run_id, relative_path, nonce, sha256)
          VALUES (?, ?, ?, ?)`).run(runId, relativePath, stage.nonce, stage.sha256);
      },
      pin: (relativePath, nonce, identity) => {
        this.requireAutocommit();
        const value = managedArtifactIdentitySchema.parse(identity);
        const result = this.database.prepare(`UPDATE workspace_retry_artifact_stages SET identity_json = ?
          WHERE run_id = ? AND relative_path = ? AND nonce = ? AND identity_json IS NULL`)
          .run(JSON.stringify(value), runId, relativePath, nonce);
        if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
      },
      release: (relativePath, nonce) => {
        this.requireAutocommit();
        const result = this.database.prepare(`DELETE FROM workspace_retry_artifact_stages
          WHERE run_id = ? AND relative_path = ? AND nonce = ?`).run(runId, relativePath, nonce);
        if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
      },
    };
  }

  rememberForegroundArtifacts(runId: string, batch: ForegroundArtifactBatch): void {
    this.requireAutocommit();
    const parsed = foregroundArtifactBatchSchema.safeParse(batch);
    if (!parsed.success || parsed.data.files.some((file) => file.status !== 'pending')
      || this.get({ kind: 'foreground', runId })?.allocation.foregroundSessionKey !== parsed.data.sessionKey) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    const result = this.database.prepare(`INSERT INTO workspace_foreground_artifacts (run_id, batch_json)
      VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING`).run(runId, JSON.stringify(parsed.data));
    if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
  }

  transitionForegroundArtifact(
    runId: string, index: number, expected: 'pending' | 'sending',
    status: Exclude<ForegroundArtifactBatch['files'][number]['status'], 'pending'>, messageId?: string,
  ): boolean {
    this.requireAutocommit();
    if (!Number.isSafeInteger(index) || index < 0 || (expected === 'pending' && status !== 'sending' && status !== 'failed')
      || (expected === 'sending' && status === 'sending') || (status === 'sent') !== Boolean(messageId)
      || (messageId !== undefined && !/^om_/.test(messageId))) throw new ManagedWorkspaceStorageError('invalid_binding');
    const file = `$.files[${index}]`;
    const values = messageId ? [file + '.messageId', messageId] : [];
    return Number(this.database.prepare(`UPDATE workspace_foreground_artifacts
      SET batch_json = json_set(batch_json, ?, ?${messageId ? ', ?, ?' : ''})
      WHERE run_id = ? AND json_extract(batch_json, ?) = ?`)
      .run(file + '.status', status, ...values, runId, file + '.status', expected).changes) === 1;
  }

  rememberUnmanagedForeground(runId: string, admission: UnmanagedForegroundAdmission): void {
    this.requireAutocommit();
    const parsed = unmanagedForegroundAdmissionSchema.safeParse(admission);
    if (!parsed.success) throw new ManagedWorkspaceStorageError('invalid_binding');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.get({ kind: 'foreground', runId })) throw new ManagedWorkspaceStorageError('invalid_binding');
      const prior = this.getUnmanagedForeground(runId);
      if (prior) {
        const matches = 'project' in prior
          ? 'project' in admission && sameWorkspaceProject(prior.project, admission.project)
          : 'fallbackCwd' in admission && prior.fallbackCwd === admission.fallbackCwd;
        if (prior.sessionKey !== admission.sessionKey || !matches) throw new ManagedWorkspaceStorageError('invalid_binding');
      } else {
        if ('project' in admission) this.requireUnoccupied(admission.project.directory);
        this.database.prepare('INSERT INTO workspace_unmanaged_foreground (run_id, admission_json) VALUES (?, ?)')
          .run(runId, JSON.stringify(parsed.data));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(owner: ManagedRunOwner): ManagedWorkspaceRecord | null {
    const row = this.database.prepare(`
      SELECT intent_json, allocation_json, last_used_at, scratch_path, artifact_path, scratch_identity, artifact_identity
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
      || row.scratch_identity !== directoryIdentity(allocation.scratch) || row.artifact_identity !== directoryIdentity(allocation.artifacts)
      || intent.createdAt !== allocation.createdAt
      || intent.foregroundSessionKey !== allocation.foregroundSessionKey
      || !sameWorkspaceProject(intent.project, allocation.project)
      || !sameWorkspaceProject(intent.roots.scratch, allocation.roots.scratch)
      || !sameWorkspaceProject(intent.roots.artifacts, allocation.roots.artifacts)) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    return { allocation, lastUsedAt: lastUsedAt.data };
  }

  async ensure({ authorizedRoots, usedAt, sourceRegistryPath, sourceRegistryRoot, ...input }: Parameters<ManagedWorkspaceStore['ensure']>[0]): Promise<ManagedRunAllocation> {
    const parsed = managedRunIntentSchema.safeParse({ version: 1, ...input });
    const lastUse = timestamp.safeParse(usedAt ?? input.createdAt);
    if (!parsed.success || !lastUse.success) throw new ManagedWorkspaceStorageError('invalid_binding');
    this.requireAutocommit();
    const { owner, ...snapshot } = parsed.data;
    const lastUsedAt = new Date(lastUse.data).toISOString();
    const policy = { authorizedRoots, sourceRegistryPath, sourceRegistryRoot };
    const existing = this.get(owner);
    if (existing) return this.reuse(existing, snapshot, policy, lastUsedAt);
    const ancestry = await validateManagedWorkspaceRoots(snapshot.roots, { ...policy, project: snapshot.project });
    const concurrent = this.reserve(parsed.data, lastUsedAt, ancestry);
    if (concurrent) return this.reuse(concurrent, snapshot, policy, lastUsedAt);

    // A reservation is not permission to adopt an existing folder after a crash.
    const allocation = await allocateManagedRunDirectories({ ...snapshot, owner, ...policy });
    this.requireAutocommit();
    const committed = this.database.prepare(`
      UPDATE workspace_run_allocations SET allocation_json = ?, scratch_identity = ?, artifact_identity = ?
      WHERE workload_kind = ? AND run_id = ? AND intent_json = ? AND allocation_json IS NULL
    `).run(JSON.stringify(allocation), directoryIdentity(allocation.scratch), directoryIdentity(allocation.artifacts),
      owner.kind, owner.runId, JSON.stringify(parsed.data));
    if (committed.changes !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
    return allocation;
  }

  async openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: ManagedWorkspaceAuthorizedRoots): Promise<string> {
    const stored = this.get(owner);
    if (!stored) throw new ManagedWorkspaceStorageError('invalid_binding');
    return validateManagedRunDirectory(stored.allocation, purpose, authorizedRoots);
  }

  private async reuse(
    { allocation }: ManagedWorkspaceRecord, snapshot: Omit<ManagedRunIntent, 'owner'>,
    policy: Pick<Parameters<ManagedWorkspaceStore['ensure']>[0], 'authorizedRoots' | 'sourceRegistryPath' | 'sourceRegistryRoot'>,
    lastUsedAt: string,
  ): Promise<ManagedRunAllocation> {
    if (!sameWorkspaceProject(allocation.project, snapshot.project)
      || allocation.foregroundSessionKey !== snapshot.foregroundSessionKey) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    const [ancestry] = await Promise.all([
      validateManagedWorkspaceRoots(allocation.roots, { ...policy, project: allocation.project }),
      validateManagedRunDirectory(allocation, 'scratch', policy.authorizedRoots),
      validateManagedRunDirectory(allocation, 'artifacts', policy.authorizedRoots),
    ]);
    this.requireAutocommit();
    this.requireSourceDisjoint(allocation.roots, ancestry.storage);
    this.touch(allocation.owner, lastUsedAt);
    return allocation;
  }

  private reserve(intent: ManagedRunIntent, lastUsedAt: string, ancestry: RootAncestry): ManagedWorkspaceRecord | null {
    this.requireAutocommit();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (intent.owner.kind === 'foreground' && this.getUnmanagedForeground(intent.owner.runId)) {
        throw new ManagedWorkspaceStorageError('invalid_binding');
      }
      const existing = this.get(intent.owner);
      if (!existing) {
        this.requireSourceDisjoint(intent.roots, ancestry.storage);
        const scratchPath = managedRunDirectoryPath(intent.roots.scratch, intent.owner);
        const artifactPath = managedRunDirectoryPath(intent.roots.artifacts, intent.owner);
        if (intent.project) this.requireUnoccupied(intent.project.directory);
        this.requireUnoccupied(scratchPath);
        this.requireUnoccupied(artifactPath);
        const byIdentity = this.database.prepare(`
          SELECT 1 FROM workspace_run_allocations WHERE scratch_identity = ? OR artifact_identity = ? LIMIT 1
        `);
        for (const identity of ancestry.all) {
          if (byIdentity.get(identity, identity)) throw new ManagedWorkspaceStorageError('overlapping_runs');
        }
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

  private requireSourceDisjoint(roots: ManagedRunIntent['roots'], storageAncestry: Set<string>): void {
    for (const [table, json] of sourceRegistries) {
      const byIdentity = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${sourceIdentityExpr(json)} = ? LIMIT 1`);
      for (const identity of storageAncestry) {
        if (byIdentity.get(identity)) throw new ManagedWorkspaceStorageError('overlapping_source');
      }
      const expr = sourcePathExpr(json);
      const exact = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${expr} = ? LIMIT 1`);
      const nested = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${expr} >= ? AND ${expr} < ? LIMIT 1`);
      for (const { directory } of [roots.scratch, roots.artifacts]) {
        for (let current = directory; ; current = path.dirname(current)) {
          if (exact.get(current)) throw new ManagedWorkspaceStorageError('overlapping_source');
          if (path.dirname(current) === current) break;
        }
        const prefix = `${directory}${path.sep}`;
        const upper = `${directory}${String.fromCharCode(path.sep.charCodeAt(0) + 1)}`;
        if (nested.get(prefix, upper)) throw new ManagedWorkspaceStorageError('overlapping_source');
      }
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
