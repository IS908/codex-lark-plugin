import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { z } from 'zod';
import {
  managedRunAllocationSchema,
  foregroundArtifactBatchSchema,
  isManagedArtifactRelativePath,
  managedArtifactIdentitySchema,
  managedArtifactStageSchema,
  managedGitSelectionSchema,
  managedRunIntentSchema,
  sameManagedGitSelection,
  unmanagedForegroundAdmissionSchema,
  type ManagedRunAllocation,
  type ManagedGitSelection,
  type ForegroundArtifactBatch,
  type ManagedRunIntent,
  type ManagedRunOwner,
  type ManagedWorkspacePurpose,
  type UnmanagedForegroundAdmission,
} from '../domain/managed-workspace.js';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from '../domain/workspace.js';
import { sameWorkspaceDependencySelections, workspaceDependencyInstallLeaf, workspaceDependencyInstallNonceSchema,
  workspaceDependencyInstallReceiptSchema, workspaceDependencyOutputName, type WorkspaceDependencyEcosystem,
  type WorkspaceDependencyInstallReceipt, type WorkspaceDependencyInstallRecord } from '../domain/workspace-dependency.js';
import type { ManagedArtifactStageJournal, ManagedWorkspaceAuthorizedRoots, ManagedWorkspaceRecord, ManagedWorkspaceStore } from '../ports/managed-workspace.js';
import {
  allocateManagedRunDirectories,
  directoryIdentity,
  managedRunDirectoryPath,
  ManagedWorkspaceStorageError,
  validateManagedRunDirectory,
  validateManagedWorkspaceRoots,
} from '../managed-workspace-storage.js';
import { MANAGED_GIT_CHECKOUT_LEAF } from '../managed-workspace-mkdir.js';
import { readWorkspaceMountTable, workspaceBackingAliases } from '../managed-workspace-ancestry.js';
import { managedWorkspaceConfigPath } from '../runtime-paths.js';
import { assertWorkspaceDependencySelectionAuthorized, assertWorkspaceDependencyWriteIsolation } from '../workspace-dependency-registry.js';
import { validateWorkspaceProject } from '../workspace-projects.js';
import { assertWorkspaceGitCacheIdentity, assertWorkspaceGitCheckoutMounts, createWorkspaceGitCheckout, gitSnapshotKey,
  validateWorkspaceGitCheckout } from '../workspace-git-snapshot.js';

const timestamp = z.iso.datetime();
const sourceRegistries = [
  ['workspace_run_allocations', 'intent_json'],
  ['workspace_unmanaged_foreground', 'admission_json'],
] as const;
const bindingFields = ['roots.scratch', 'roots.artifacts', 'git.cache'] as const;
const bindingPathExpr = (column: string, field = 'project') => `json_extract(${column}, '$.${field}.directory')`;
const bindingIdentityExpr = (column: string, field = 'project') =>
  `(json_extract(${column}, '$.${field}.device') || ':' || json_extract(${column}, '$.${field}.inode'))`;
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
      CREATE TABLE IF NOT EXISTS workspace_git_caches (
        cache_key TEXT PRIMARY KEY,
        cache_path TEXT NOT NULL UNIQUE,
        cache_identity TEXT NOT NULL UNIQUE,
        selection_json TEXT NOT NULL CHECK (json_valid(selection_json))
      ) STRICT;
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
      CREATE TABLE IF NOT EXISTS workspace_dependency_installs (
        workload_kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm', 'pip')),
        compatibility_key TEXT NOT NULL,
        nonce TEXT NOT NULL,
        receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
        PRIMARY KEY (workload_kind, run_id, ecosystem),
        FOREIGN KEY (workload_kind, run_id) REFERENCES workspace_run_allocations(workload_kind, run_id)
      ) STRICT;
      ${sourceRegistries.map(([table, json]) => `
        CREATE INDEX IF NOT EXISTS ${table}_project_path ON ${table}(${bindingPathExpr(json)});
        CREATE INDEX IF NOT EXISTS ${table}_project_identity ON ${table}(${bindingIdentityExpr(json)});
      `).join('')}
      ${bindingFields.map((field) => `
        CREATE INDEX IF NOT EXISTS workspace_run_${field.replace('.', '_')}_path
          ON workspace_run_allocations(${bindingPathExpr('intent_json', field)});
        CREATE INDEX IF NOT EXISTS workspace_run_${field.replace('.', '_')}_identity
          ON workspace_run_allocations(${bindingIdentityExpr('intent_json', field)});
      `).join('')}
    `);
  }

  getDependencyInstall(owner: ManagedRunOwner, ecosystem: WorkspaceDependencyEcosystem): WorkspaceDependencyInstallRecord | null {
    const row = this.database.prepare(`SELECT compatibility_key, nonce, receipt_json FROM workspace_dependency_installs
      WHERE workload_kind = ? AND run_id = ? AND ecosystem = ?`).get(owner.kind, owner.runId, ecosystem);
    if (!row) return null;
    const { scratch, key } = this.dependencyInstallAllocation(owner, ecosystem);
    const nonce = workspaceDependencyInstallNonceSchema.safeParse(row.nonce);
    if (!nonce.success || row.compatibility_key !== key) throw new ManagedWorkspaceStorageError('invalid_binding');
    if (row.receipt_json === null) return { nonce: nonce.data };
    const receipt = parseStored(workspaceDependencyInstallReceiptSchema, row.receipt_json);
    assertDependencyReceiptBinding(scratch, ecosystem, nonce.data, receipt);
    return { nonce: nonce.data, receipt };
  }

  reserveDependencyInstall(owner: ManagedRunOwner, ecosystem: WorkspaceDependencyEcosystem, nonce: string): void {
    this.requireAutocommit();
    const { key } = this.dependencyInstallAllocation(owner, ecosystem);
    if (!workspaceDependencyInstallNonceSchema.safeParse(nonce).success) throw new ManagedWorkspaceStorageError('invalid_binding');
    const result = this.database.prepare(`INSERT INTO workspace_dependency_installs
      (workload_kind, run_id, ecosystem, compatibility_key, nonce) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workload_kind, run_id, ecosystem) DO NOTHING`).run(owner.kind, owner.runId, ecosystem, key, nonce);
    if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('dependency_install_incomplete');
  }

  completeDependencyInstall(owner: ManagedRunOwner, ecosystem: WorkspaceDependencyEcosystem, nonce: string, receipt: WorkspaceDependencyInstallReceipt): void {
    this.requireAutocommit();
    const { scratch, key } = this.dependencyInstallAllocation(owner, ecosystem);
    const parsed = workspaceDependencyInstallReceiptSchema.safeParse(receipt);
    if (!parsed.success || !workspaceDependencyInstallNonceSchema.safeParse(nonce).success) throw new ManagedWorkspaceStorageError('invalid_binding');
    assertDependencyReceiptBinding(scratch, ecosystem, nonce, parsed.data);
    const result = this.database.prepare(`UPDATE workspace_dependency_installs SET receipt_json = ?
      WHERE workload_kind = ? AND run_id = ? AND ecosystem = ? AND compatibility_key = ? AND nonce = ? AND receipt_json IS NULL`)
      .run(JSON.stringify(parsed.data), owner.kind, owner.runId, ecosystem, key, nonce);
    if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
  }

  private dependencyInstallAllocation(owner: ManagedRunOwner, ecosystem: WorkspaceDependencyEcosystem) {
    const allocation = this.get(owner)?.allocation;
    const selection = allocation?.dependencySelections?.find(({ identity }) => identity.ecosystem === ecosystem);
    if (!allocation?.gitCheckout || !selection) throw new ManagedWorkspaceStorageError('invalid_binding');
    return { scratch: allocation.scratch, key: selection.identity.key };
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

  listPendingForegroundRuns(afterRunId: string): string[] {
    return this.database.prepare(`SELECT run_id FROM workspace_foreground_artifacts
      WHERE run_id > ? AND json_extract(batch_json, '$.version') = 2
        AND (json_extract(batch_json, '$.reply.status') = 'pending' OR (
          json_extract(batch_json, '$.reply.status') = 'sent' AND EXISTS (
            SELECT 1 FROM json_each(batch_json, '$.files') WHERE json_extract(value, '$.status') = 'pending'
          )
        )) ORDER BY run_id LIMIT 50`).all(afterRunId).map((row) => z.string().parse(row.run_id));
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
    if (!parsed.success || parsed.data.reply.status !== 'pending' || parsed.data.files.some((file) => file.status !== 'pending')
      || this.get({ kind: 'foreground', runId })?.allocation.foregroundSessionKey !== parsed.data.sessionKey) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    const result = this.database.prepare(`INSERT INTO workspace_foreground_artifacts (run_id, batch_json)
      VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING`).run(runId, JSON.stringify(parsed.data));
    if (Number(result.changes) !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
  }

  transitionForegroundArtifact(
    runId: string, part: number | 'reply', expected: 'pending' | 'sending',
    status: Exclude<ForegroundArtifactBatch['files'][number]['status'], 'pending'>, messageId?: string,
  ): boolean {
    this.requireAutocommit();
    if ((part !== 'reply' && (!Number.isSafeInteger(part) || part < 0))
      || (expected === 'pending' && status !== 'sending' && status !== 'failed')
      || (expected === 'sending' && status === 'sending') || (status === 'sent') !== Boolean(messageId)
      || (messageId !== undefined && !/^om_/.test(messageId))) throw new ManagedWorkspaceStorageError('invalid_binding');
    const entry = part === 'reply' ? '$.reply' : `$.files[${part}]`;
    const values = messageId ? [entry + '.messageId', messageId] : [];
    return Number(this.database.prepare(`UPDATE workspace_foreground_artifacts
      SET batch_json = json_set(batch_json, ?, ?${messageId ? ', ?, ?' : ''})
      WHERE run_id = ? AND json_extract(batch_json, ?) = ?
        ${part === 'reply' ? '' : "AND json_extract(batch_json, '$.reply.status') = 'sent'"}`)
      .run(entry + '.status', status, ...values, runId, entry + '.status', expected).changes) === 1;
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
        if ('project' in admission) {
          this.requireUnoccupied(admission.project.directory);
          this.requireProtectedPathsDisjoint([admission.project], new Set([directoryIdentity(admission.project)]), 'caches');
        }
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
      || !sameWorkspaceProject(intent.fallbackWorkspace, allocation.fallbackWorkspace)
      || !sameManagedGitSelection(intent.git, allocation.git)
      || !sameWorkspaceDependencySelections(intent.dependencySelections, allocation.dependencySelections)
      || !validGitAllocation(allocation)
      || !sameWorkspaceProject(intent.roots.scratch, allocation.roots.scratch)
      || !sameWorkspaceProject(intent.roots.artifacts, allocation.roots.artifacts)) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    if (allocation.git && !this.recordedGitCacheMatches(allocation.git, 'read')) throw new ManagedWorkspaceStorageError('invalid_binding');
    return { allocation, lastUsedAt: lastUsedAt.data };
  }

  async ensure({ authorizedRoots, usedAt, sourceRegistryPath, sourceRegistryRoot, dependencyRegistryConfigPath = managedWorkspaceConfigPath,
    ...input }: Parameters<ManagedWorkspaceStore['ensure']>[0]): Promise<ManagedRunAllocation> {
    const parsed = managedRunIntentSchema.safeParse({ version: 1, ...input });
    const lastUse = timestamp.safeParse(usedAt ?? input.createdAt);
    if (!parsed.success || !lastUse.success) throw new ManagedWorkspaceStorageError('invalid_binding');
    this.requireAutocommit();
    const { owner, ...snapshot } = parsed.data;
    if (snapshot.git && (!snapshot.project || snapshot.git.key !== gitSnapshotKey(snapshot.git))) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    await assertWorkspaceDependencyWriteIsolation(dependencyRegistryConfigPath, [snapshot.roots.scratch.directory, snapshot.roots.artifacts.directory]);
    await assertWorkspaceDependencySelectionAuthorized(dependencyRegistryConfigPath, snapshot.project, snapshot.git, snapshot.dependencySelections);
    for (const { cache } of snapshot.dependencySelections ?? []) await validateWorkspaceProject(authorizedRoots, cache);
    const lastUsedAt = new Date(lastUse.data).toISOString();
    const policy = { authorizedRoots, sourceRegistryPath, sourceRegistryRoot };
    const existing = this.get(owner);
    if (existing) return this.reuse(existing, snapshot, policy, lastUsedAt);
    const placement = { ...policy, project: snapshot.project, fallbackWorkspace: snapshot.fallbackWorkspace, gitCache: snapshot.git?.cache };
    const ancestry = await validateManagedWorkspaceRoots(snapshot.roots, placement);
    if (snapshot.git && snapshot.project) {
      await assertWorkspaceGitCheckoutMounts([snapshot.roots.scratch, snapshot.roots.artifacts, snapshot.project, snapshot.git.cache]);
      await assertWorkspaceGitCacheIdentity(snapshot.git, authorizedRoots);
    }
    const concurrent = this.reserve(parsed.data, lastUsedAt, ancestry);
    if (concurrent) return this.reuse(concurrent, snapshot, policy, lastUsedAt);

    // A reservation is not permission to adopt an existing folder after a crash.
    const basic = await allocateManagedRunDirectories({ ...snapshot, owner, ...placement });
    const selection = checkoutSelection({ ...basic, git: snapshot.git }, authorizedRoots);
    const allocation = selection ? await createWorkspaceGitCheckout(selection).then(({ checkout, gitDirectory }) => ({
      ...basic, git: snapshot.git, gitCheckout: { checkout, gitDirectory },
    })) : basic;
    this.completeAllocation(parsed.data, allocation);
    return allocation;
  }

  async openDirectory(owner: ManagedRunOwner, purpose: ManagedWorkspacePurpose, authorizedRoots: ManagedWorkspaceAuthorizedRoots): Promise<string> {
    const stored = this.get(owner);
    if (!stored) throw new ManagedWorkspaceStorageError('invalid_binding');
    return validateManagedRunDirectory(stored.allocation, purpose, authorizedRoots);
  }

  private completeAllocation(intent: ManagedRunIntent, allocation: ManagedRunAllocation): void {
    this.requireAutocommit();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Only a fully verified checkout can claim a cache key. An incomplete intent protects paths, not key ownership.
      if (allocation.git) this.recordedGitCacheMatches(allocation.git, 'register');
      const committed = this.database.prepare(`
        UPDATE workspace_run_allocations SET allocation_json = ?, scratch_identity = ?, artifact_identity = ?
        WHERE workload_kind = ? AND run_id = ? AND intent_json = ? AND allocation_json IS NULL
      `).run(JSON.stringify(allocation), directoryIdentity(allocation.scratch), directoryIdentity(allocation.artifacts),
        intent.owner.kind, intent.owner.runId, JSON.stringify(intent));
      if (committed.changes !== 1) throw new ManagedWorkspaceStorageError('invalid_binding');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private async reuse(
    { allocation }: ManagedWorkspaceRecord, snapshot: Omit<ManagedRunIntent, 'owner'>,
    policy: Pick<Parameters<ManagedWorkspaceStore['ensure']>[0], 'authorizedRoots' | 'sourceRegistryPath' | 'sourceRegistryRoot'>,
    lastUsedAt: string,
  ): Promise<ManagedRunAllocation> {
    if (!sameWorkspaceProject(allocation.project, snapshot.project)
      || !sameWorkspaceProject(allocation.fallbackWorkspace, snapshot.fallbackWorkspace)
      || !sameManagedGitSelection(allocation.git, snapshot.git)
      || !sameWorkspaceDependencySelections(allocation.dependencySelections, snapshot.dependencySelections)
      || allocation.foregroundSessionKey !== snapshot.foregroundSessionKey || allocation.createdAt !== snapshot.createdAt
      || !sameWorkspaceProject(allocation.roots.scratch, snapshot.roots.scratch)
      || !sameWorkspaceProject(allocation.roots.artifacts, snapshot.roots.artifacts)) {
      throw new ManagedWorkspaceStorageError('invalid_binding');
    }
    const [ancestry] = await Promise.all([
      validateManagedWorkspaceRoots(allocation.roots, { ...policy, project: allocation.project, fallbackWorkspace: allocation.fallbackWorkspace,
        gitCache: allocation.git?.cache }),
      validateManagedRunDirectory(allocation, 'scratch', policy.authorizedRoots),
      validateManagedRunDirectory(allocation, 'artifacts', policy.authorizedRoots),
    ]);
    const selection = checkoutSelection(allocation, policy.authorizedRoots);
    if (selection && allocation.gitCheckout) await validateWorkspaceGitCheckout(selection, allocation.gitCheckout);
    this.requireAutocommit();
    this.requireProtectedPathsDisjoint([allocation.roots.scratch, allocation.roots.artifacts], ancestry.storage);
    if (allocation.git && ancestry.cache) this.requireProtectedPathsDisjoint([allocation.git.cache], ancestry.cache, 'cache-placement');
    if (allocation.project && ancestry.project) this.requireProtectedPathsDisjoint([allocation.project], ancestry.project, 'caches');
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
        this.requireProtectedPathsDisjoint([intent.roots.scratch, intent.roots.artifacts], ancestry.storage);
        if (intent.git && ancestry.cache) {
          this.requireUnoccupied(intent.git.cache.directory);
          this.requireProtectedPathsDisjoint([intent.git.cache], ancestry.cache, 'cache-placement');
          this.recordedGitCacheMatches(intent.git, 'check');
        }
        const scratchPath = managedRunDirectoryPath(intent.roots.scratch, intent.owner);
        const artifactPath = managedRunDirectoryPath(intent.roots.artifacts, intent.owner);
        if (intent.project) this.requireUnoccupied(intent.project.directory);
        if (intent.project && ancestry.project) this.requireProtectedPathsDisjoint([intent.project], ancestry.project, 'caches');
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

  private recordedGitCacheMatches(git: ManagedGitSelection, mode: 'read' | 'check' | 'register'): boolean {
    const identity = directoryIdentity(git.cache);
    const rows = this.database.prepare(`SELECT cache_key, cache_path, cache_identity, selection_json FROM workspace_git_caches
      WHERE cache_key = ? OR cache_path = ? OR cache_identity = ?`).all(git.key, git.cache.directory, identity);
    if (!rows.length && mode === 'register') {
      this.database.prepare(`INSERT INTO workspace_git_caches (cache_key, cache_path, cache_identity, selection_json)
        VALUES (?, ?, ?, ?)`).run(git.key, git.cache.directory, identity, JSON.stringify(git));
      return true;
    }
    const [row] = rows;
    const matches = rows.length === 1 && row.cache_key === git.key && row.cache_path === git.cache.directory
      && row.cache_identity === identity && sameManagedGitSelection(parseStored(managedGitSelectionSchema, row.selection_json), git);
    if (!matches && rows.length && mode !== 'read') throw new ManagedWorkspaceStorageError('git_cache_conflict');
    return matches;
  }

  private requireProtectedPathsDisjoint(paths: WorkspaceProjectBinding[], storageAncestry: Set<string>, mode: 'all' | 'cache-placement' | 'caches' = 'all'): void {
    const intentPath = (field: typeof bindingFields[number], error: 'overlapping_git_cache' | 'overlapping_runs') =>
      ['workspace_run_allocations', bindingPathExpr('intent_json', field), bindingIdentityExpr('intent_json', field), error] as const;
    const registries = [
      ...(mode !== 'caches' ? sourceRegistries.map(([table, column]) =>
        [table, bindingPathExpr(column), bindingIdentityExpr(column), 'overlapping_source'] as const) : []),
      ...(mode === 'cache-placement' ? [intentPath('roots.scratch', 'overlapping_runs'), intentPath('roots.artifacts', 'overlapping_runs')]
        : [['workspace_git_caches', 'cache_path', 'cache_identity', 'overlapping_git_cache'] as const, intentPath('git.cache', 'overlapping_git_cache')]),
    ];
    let mounts: ReturnType<typeof readWorkspaceMountTable> | undefined;
    for (const [table, expr, identityExpr, error] of registries) {
      const gitRelated = mode === 'cache-placement' || error === 'overlapping_git_cache';
      if (gitRelated && !this.database.prepare(`SELECT 1 FROM ${table} WHERE ${expr} IS NOT NULL LIMIT 1`).get()) continue;
      if (gitRelated) mounts ??= readWorkspaceMountTable();
      const byIdentity = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${identityExpr} = ? LIMIT 1`);
      for (const identity of storageAncestry) {
        if (byIdentity.get(identity)) throw new ManagedWorkspaceStorageError(error);
      }
      const exact = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${expr} = ? LIMIT 1`);
      const nested = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${expr} >= ? AND ${expr} < ? LIMIT 1`);
      for (const { directory: requested } of paths) {
        const aliases = gitRelated ? workspaceBackingAliases(requested, mounts ?? []) : [requested];
        for (const directory of aliases) {
          for (let current = directory; ; current = path.dirname(current)) {
            if (exact.get(current)) throw new ManagedWorkspaceStorageError(error);
            if (path.dirname(current) === current) break;
          }
          const prefix = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
          const upper = `${prefix.slice(0, -1)}${String.fromCharCode(path.sep.charCodeAt(0) + 1)}`;
          if (nested.get(prefix, upper)) throw new ManagedWorkspaceStorageError(error);
        }
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

function assertDependencyReceiptBinding(scratch: WorkspaceProjectBinding, ecosystem: WorkspaceDependencyEcosystem, nonce: string,
  receipt: WorkspaceDependencyInstallReceipt): void {
  if (receipt.output.device !== scratch.device || receipt.output.directory !== path.join(scratch.directory,
    workspaceDependencyInstallLeaf(nonce), workspaceDependencyOutputName(ecosystem))) throw new ManagedWorkspaceStorageError('invalid_binding');
}

function validGitAllocation({ git, gitCheckout, project, fallbackWorkspace, scratch }: ManagedRunAllocation): boolean {
  if (!git) return gitCheckout === undefined;
  return !!project && !fallbackWorkspace && !!gitCheckout && git.key === gitSnapshotKey(git)
    && gitCheckout.checkout.directory === path.join(scratch.directory, MANAGED_GIT_CHECKOUT_LEAF)
    && gitCheckout.gitDirectory.directory === path.join(gitCheckout.checkout.directory, '.git');
}

function checkoutSelection(allocation: ManagedRunAllocation, authorizedRoots: ManagedWorkspaceAuthorizedRoots) {
  const { git, project, scratch } = allocation;
  if (!git) return undefined;
  if (!project) throw new ManagedWorkspaceStorageError('invalid_binding');
  return {
    cache: { gitDirectory: git.cache, repositoryId: git.repositoryId, scope: git.scope, commit: git.commit, authorizedRoots },
    expected: git, source: project, scratch, protectedRoots: [allocation.roots.scratch, allocation.roots.artifacts],
  };
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    if (typeof value !== 'string') throw new Error('Expected a JSON string.');
    return schema.parse(JSON.parse(value));
  } catch {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
}
