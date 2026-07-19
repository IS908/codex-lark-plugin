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
  ContinuationDelivery,
  ContinuationToolInvoker,
} from '../ports/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { ContinuationInputStore } from './input-store.js';
import { createContinuationCodexExecutor } from './codex-runner.js';
import { createLarkContinuationDelivery } from './lark-delivery.js';
import { createContinuationLocalCliToolInvoker } from './local-cli-tool-invoker.js';
import { redactContinuationText } from './redaction.js';
import {
  ContinuationService,
  type ContinuationTaskService,
  UnavailableContinuationService,
} from './service.js';
import { SqliteContinuationRepository } from './sqlite-repository.js';
import { ContinuationWorker } from './worker.js';
import { AsyncTaskKernelAdapter } from './async-task-kernel-adapter.js';
import type { DurableRunRepository } from '../ports/durable-run.js';

const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface ContinuationRuntimeOptions {
  enabled: boolean;
  databasePath: string;
  artifactsDir: string;
  allowedWorkingRoot: string;
  maxAttempts: number;
  maxRetries: number;
  maxTotalMinutes: number;
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
  delivery?: ContinuationDelivery;
  audit?: ContinuationAudit;
  debug?: (message: string) => void;
  reportError?: (error: unknown) => void;
  retentionIntervalMs?: number;
  openRepository?: (options: {
    databasePath: string;
    artifactsDir: string;
    inputsDir: string;
  }) => Promise<ContinuationRepository>;
  /** Defaults to true for compatibility. The application uses one shared worker. */
  standaloneWorker?: boolean;
}

export interface ContinuationRuntimeHealth {
  enabled: boolean;
  available: boolean;
  reason?: 'disabled' | 'initialization_failed';
}

export interface ContinuationRuntime {
  service: ContinuationTaskService;
  worker: ContinuationWorker | null;
  repository: ContinuationRepository | null;
  durableRepository: DurableRunRepository | null;
  asyncTaskAdapter: AsyncTaskKernelAdapter | null;
  health: ContinuationRuntimeHealth;
  close(): Promise<void>;
}

export async function createContinuationRuntime(
  options: ContinuationRuntimeOptions,
): Promise<ContinuationRuntime> {
  const clock = options.clock ?? { now: () => new Date() };
  let temporaryRoot: string | undefined;
  let repository: ContinuationRepository | undefined;
  try {
    const storage = options.dryRun
      ? await createDryRunStorage()
      : {
          databasePath: options.databasePath,
          artifactsDir: options.artifactsDir,
          inputsDir: path.join(path.dirname(options.artifactsDir), 'inputs'),
        };
    temporaryRoot = 'root' in storage ? storage.root : undefined;
    repository = await (options.openRepository ?? defaultOpenRepository)({
      databasePath: storage.databasePath,
      artifactsDir: storage.artifactsDir,
      inputsDir: storage.inputsDir,
    });
    await repository.healthCheck();
    if (!options.enabled) {
      let closePromise: Promise<void> | undefined;
      return {
        service: new UnavailableContinuationService(),
        worker: null,
        repository,
        durableRepository: repository.durableRuns,
        asyncTaskAdapter: null,
        health: { enabled: false, available: false, reason: 'disabled' },
        close() {
          closePromise ??= (async () => {
            try {
              repository!.close();
            } finally {
              if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
            }
          })();
          return closePromise;
        },
      };
    }
    const now = clock.now().toISOString();
    const continuationAudit = options.audit ?? defaultContinuationAudit;
    await repository.expireOverdue(now);
    await runRetentionCleanup(
      repository,
      retentionCutoff(now, options.retentionDays),
      now,
      continuationAudit,
    );

    const artifactStore = new ContinuationArtifactStore(storage.artifactsDir);
    const inputStore = new ContinuationInputStore(storage.inputsDir);
    const service = new ContinuationService({
      repository,
      allowedWorkingRoot: options.allowedWorkingRoot,
      filesystemMode: boundedContinuationSandbox(options.configuredSandbox),
      maxAttempts: options.maxAttempts,
      maxRetries: options.maxRetries,
      maxTotalMinutes: options.maxTotalMinutes,
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
      inputStore,
      configuredSandbox: options.configuredSandbox,
      currentWorkingRoot: options.allowedWorkingRoot,
      canUseTrustedPersonalWorkspace: options.canUseTrustedPersonalWorkspace,
      ...(toolInvoker ? { toolInvoker } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(options.runCodexExec ? { runCodexExec: options.runCodexExec } : {}),
    });
    const delivery = options.delivery ?? createLarkContinuationDelivery(options.getTransport, clock);
    const adapter = new AsyncTaskKernelAdapter({
      repository,
      executor,
      delivery,
      audit: continuationAudit,
      debug: options.debug,
    });
    const worker = options.standaloneWorker === false ? null : new ContinuationWorker({
      repository,
      executor,
      delivery,
      clock,
      audit: continuationAudit,
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
      retentionPromise = runRetentionCleanup(
        repository!,
        retentionCutoff(scanNow, options.retentionDays),
        scanNow,
        continuationAudit,
      )
        .catch((error) => safeReportError(options, error))
        .finally(() => { retentionPromise = undefined; });
    }, retentionInterval);
    retentionTimer?.unref();

    let closePromise: Promise<void> | undefined;
    return {
      service,
      worker,
      repository,
      durableRepository: repository.durableRuns,
      asyncTaskAdapter: adapter,
      health: { enabled: true, available: true },
      close() {
        closePromise ??= (async () => {
          if (retentionTimer) clearInterval(retentionTimer);
          await worker?.stop();
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
    repository: null,
    durableRepository: null,
    asyncTaskAdapter: null,
    health,
    async close() {},
  };
}

async function defaultOpenRepository(options: {
  databasePath: string;
  artifactsDir: string;
  inputsDir: string;
}): Promise<ContinuationRepository> {
  return SqliteContinuationRepository.open(options);
}

async function createDryRunStorage(): Promise<{
  root: string;
  databasePath: string;
  artifactsDir: string;
  inputsDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lark-continuation-dry-run-'));
  return {
    root,
    databasePath: path.join(root, 'jobs.sqlite'),
    artifactsDir: path.join(root, 'artifacts'),
    inputsDir: path.join(root, 'inputs'),
  };
}

function retentionCutoff(now: string, retentionDays: number): string {
  return new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

async function runRetentionCleanup(
  repository: ContinuationRepository,
  retainAfter: string,
  now: string,
  audit: ContinuationAudit,
): Promise<void> {
  const results = await repository.purgeExpired(retainAfter, now);
  for (const cleanup of results) {
    const detail = cleanup.result === 'cleaned'
      ? `automatic_retention status=${cleanup.status} completed_at=${cleanup.completedAt}`
      : `automatic_retention_failed status=${cleanup.status} completed_at=${cleanup.completedAt} error=${cleanup.errorSummary ?? 'unknown'}`;
    await audit.record({
      action: 'continuation.cleanup',
      actorOpenId: cleanup.creatorOpenId,
      jobId: cleanup.jobId,
      result: cleanup.result === 'cleaned' ? 'ok' : 'error',
      detail: redactContinuationText(detail),
    }).catch(() => {});
  }
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
