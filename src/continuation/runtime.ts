import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audit as writeAudit } from '../audit-log.js';
import type { CodexExecRunner, CodexExecSandbox } from '../codex-exec.js';
import type { LarkTransport } from '../lark-transport-contracts.js';
import type {
  ContinuationAudit,
  ContinuationClock,
  ContinuationExecutor,
  ContinuationRepository,
  ContinuationTerminalDelivery,
  ContinuationToolInvoker,
} from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { createContinuationCodexExecutor } from './codex-runner.js';
import { createLarkContinuationDelivery } from './lark-delivery.js';
import { createContinuationLocalCliToolInvoker } from './local-cli-tool-invoker.js';
import {
  ContinuationService,
  type ContinuationTaskService,
  UnavailableContinuationService,
} from './service.js';
import { SqliteContinuationRepository } from './sqlite-repository.js';
import { ContinuationWorker } from './worker.js';

const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface ContinuationRuntimeOptions {
  enabled: boolean;
  databasePath: string;
  artifactsDir: string;
  allowedWorkingRoot: string;
  maxSteps: number;
  maxRetries: number;
  maxAgeHours: number;
  timeoutMs: number;
  retentionDays: number;
  maxConcurrency: number;
  configuredSandbox: CodexExecSandbox;
  canUseTrustedPersonalWorkspace?: (actorOpenId: string) => boolean;
  command?: string;
  localCliToolsConfigPath?: string;
  getTransport: () => LarkTransport;
  clock?: ContinuationClock;
  dryRun?: boolean;
  runCodexExec?: CodexExecRunner;
  executor?: ContinuationExecutor;
  toolInvoker?: ContinuationToolInvoker;
  delivery?: ContinuationTerminalDelivery;
  audit?: ContinuationAudit;
  debug?: (message: string) => void;
  reportError?: (error: unknown) => void;
  retentionIntervalMs?: number;
  openRepository?: (options: {
    databasePath: string;
    artifactsDir: string;
  }) => Promise<ContinuationRepository>;
}

export interface ContinuationRuntimeHealth {
  enabled: boolean;
  available: boolean;
  reason?: 'disabled' | 'initialization_failed';
}

export interface ContinuationRuntime {
  service: ContinuationTaskService;
  worker: ContinuationWorker | null;
  health: ContinuationRuntimeHealth;
  close(): Promise<void>;
}

export async function createContinuationRuntime(
  options: ContinuationRuntimeOptions,
): Promise<ContinuationRuntime> {
  if (!options.enabled) return unavailableRuntime({ enabled: false, available: false, reason: 'disabled' });

  const clock = options.clock ?? { now: () => new Date() };
  let temporaryRoot: string | undefined;
  let repository: ContinuationRepository | undefined;
  try {
    const storage = options.dryRun
      ? await createDryRunStorage()
      : { databasePath: options.databasePath, artifactsDir: options.artifactsDir };
    temporaryRoot = 'root' in storage ? storage.root : undefined;
    repository = await (options.openRepository ?? defaultOpenRepository)({
      databasePath: storage.databasePath,
      artifactsDir: storage.artifactsDir,
    });
    await repository.healthCheck();
    const now = clock.now().toISOString();
    await repository.recoverExpiredLeases(now);
    await repository.expireOverdue(now);
    await repository.purgeExpired(retentionCutoff(now, options.retentionDays), now);

    const artifactStore = new ContinuationArtifactStore(storage.artifactsDir);
    const service = new ContinuationService({
      repository,
      allowedWorkingRoot: options.allowedWorkingRoot,
      filesystemMode: boundedContinuationSandbox(options.configuredSandbox),
      maxSteps: options.maxSteps,
      maxRetries: options.maxRetries,
      maxAgeHours: options.maxAgeHours,
      timeoutMs: options.timeoutMs,
      canUseTrustedPersonalWorkspace: options.canUseTrustedPersonalWorkspace,
      clock,
    });
    const toolInvoker = options.toolInvoker ?? (options.localCliToolsConfigPath
      ? createContinuationLocalCliToolInvoker({
          repository,
          configPath: options.localCliToolsConfigPath,
          now: () => clock.now(),
        })
      : undefined);
    const executor = options.executor ?? createContinuationCodexExecutor({
      artifactStore,
      configuredSandbox: options.configuredSandbox,
      currentWorkingRoot: options.allowedWorkingRoot,
      canUseTrustedPersonalWorkspace: options.canUseTrustedPersonalWorkspace,
      ...(toolInvoker ? { toolInvoker } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(options.runCodexExec ? { runCodexExec: options.runCodexExec } : {}),
    });
    const delivery = options.delivery ?? createLarkContinuationDelivery(options.getTransport, clock);
    const worker = new ContinuationWorker({
      repository,
      executor,
      delivery,
      clock,
      audit: options.audit ?? defaultContinuationAudit,
      maxConcurrency: options.maxConcurrency,
      debug: options.debug,
    });
    const retentionInterval = options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    if (!Number.isFinite(retentionInterval) || retentionInterval <= 0) {
      throw new Error('Continuation retention interval must be a positive number.');
    }
    let retentionPromise: Promise<void> | undefined;
    const retentionTimer = options.dryRun ? undefined : setInterval(() => {
      if (retentionPromise) return;
      const scanNow = clock.now().toISOString();
      retentionPromise = repository!.purgeExpired(retentionCutoff(scanNow, options.retentionDays), scanNow)
        .then(() => undefined)
        .catch((error) => safeReportError(options, error))
        .finally(() => { retentionPromise = undefined; });
    }, retentionInterval);
    retentionTimer?.unref();

    let closePromise: Promise<void> | undefined;
    return {
      service,
      worker,
      health: { enabled: true, available: true },
      close() {
        closePromise ??= (async () => {
          if (retentionTimer) clearInterval(retentionTimer);
          await worker.stop();
          if (retentionPromise) await retentionPromise;
          try {
            repository!.close();
          } finally {
            if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try { repository?.close(); } catch {}
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    safeReportError(options, error);
    safeDebug(options, '[continuation] event=runtime_unavailable job_id=- attempt_id=- state=initialization_failed');
    return unavailableRuntime({ enabled: true, available: false, reason: 'initialization_failed' });
  }
}

function boundedContinuationSandbox(
  configured: CodexExecSandbox,
): Extract<CodexExecSandbox, 'read-only' | 'workspace-write'> {
  return configured === 'read-only' ? 'read-only' : 'workspace-write';
}

function unavailableRuntime(health: ContinuationRuntimeHealth): ContinuationRuntime {
  return {
    service: new UnavailableContinuationService(),
    worker: null,
    health,
    async close() {},
  };
}

async function defaultOpenRepository(options: {
  databasePath: string;
  artifactsDir: string;
}): Promise<ContinuationRepository> {
  return SqliteContinuationRepository.open(options);
}

async function createDryRunStorage(): Promise<{
  root: string;
  databasePath: string;
  artifactsDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lark-continuation-dry-run-'));
  return {
    root,
    databasePath: path.join(root, 'jobs.sqlite'),
    artifactsDir: path.join(root, 'artifacts'),
  };
}

function retentionCutoff(now: string, retentionDays: number): string {
  return new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

function safeReportError(options: ContinuationRuntimeOptions, error: unknown): void {
  try { options.reportError?.(error); } catch {}
}

function safeDebug(options: ContinuationRuntimeOptions, message: string): void {
  try { options.debug?.(message); } catch {}
}

const defaultContinuationAudit: ContinuationAudit = {
  async record(event) {
    await writeAudit(
      event.action,
      event.actorOpenId ?? null,
      {
        job_id: event.jobId,
        attempt_id: event.attemptId,
        detail: event.detail,
      },
      event.result,
    );
  },
};
