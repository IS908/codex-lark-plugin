import type {
  ContinuationClaim,
  ContinuationDeliveryClaim,
  ContinuationFailure,
} from '../domain/continuation.js';
import { ContinuationExecutionError } from '../domain/continuation.js';
import { formatContinuationDiagnosticMessage } from '../diagnostic-log-format.js';
import type {
  ContinuationAudit,
  ContinuationClock,
  ContinuationExecutor,
  ContinuationRepository,
  ContinuationTerminalDelivery,
} from '../ports/continuation.js';
import { redactContinuationText } from './redaction.js';

type AbortReason = 'cancel' | 'expired' | 'lease_lost' | 'shutdown';

interface ActiveExecution {
  claim: ContinuationClaim;
  controller: AbortController;
  promise: Promise<void>;
  heartbeatTimer?: NodeJS.Timeout;
  expirationTimer?: NodeJS.Timeout;
  heartbeatInFlight: boolean;
  abortReason?: AbortReason;
}

export interface ContinuationWorkerOptions {
  repository: ContinuationRepository;
  executor: ContinuationExecutor;
  delivery: ContinuationTerminalDelivery;
  clock: ContinuationClock;
  audit?: ContinuationAudit;
  maxConcurrency: number;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  workerId?: string;
  debug?: (message: string) => void;
}

const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_DURATION_MS = 30_000;

export class ContinuationWorker {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly workerId: string;
  private readonly scanIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private scanTimer?: NodeJS.Timeout;
  private scheduledTick?: NodeJS.Timeout;
  private tickInFlight?: Promise<void>;
  private deliveryInFlight?: Promise<void>;
  private stopping = false;
  private started = false;

  constructor(private readonly options: ContinuationWorkerOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error('Continuation worker maxConcurrency must be a positive integer.');
    }
    this.workerId = options.workerId ?? 'continuation-worker';
    this.scanIntervalMs = positiveInterval(options.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS);
    this.heartbeatIntervalMs = positiveInterval(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.leaseDurationMs = positiveInterval(
      options.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
    );
  }

  get activeCount(): number {
    return this.active.size;
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.scanTimer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.scanIntervalMs);
    this.scanTimer.unref();
    this.scheduleTick();
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.tickInFlight) return this.tickInFlight;
    const run = this.scan();
    this.tickInFlight = run;
    try {
      await run;
    } finally {
      if (this.tickInFlight === run) this.tickInFlight = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
      if (this.deliveryInFlight) await Promise.allSettled([this.deliveryInFlight]);
      return;
    }
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.scheduledTick) clearTimeout(this.scheduledTick);
    this.scanTimer = undefined;
    this.scheduledTick = undefined;
    for (const execution of this.active.values()) {
      this.abortExecution(execution, 'shutdown');
    }
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
    if (this.deliveryInFlight) await Promise.allSettled([this.deliveryInFlight]);
  }

  private async scan(): Promise<void> {
    const now = this.nowIso();
    await this.options.repository.recoverExpiredLeases(now);
    await this.options.repository.expireOverdue(now);
    await this.inspectActiveExecutions();

    while (!this.stopping && this.active.size < this.options.maxConcurrency) {
      const claimedAt = this.nowIso();
      const claim = await this.options.repository.claimDue(
        this.workerId,
        claimedAt,
        addMilliseconds(claimedAt, this.leaseDurationMs),
      );
      if (!claim) break;
      this.startExecution(claim);
    }

    if (!this.stopping && !this.deliveryInFlight) {
      const claim = await this.options.repository.claimPendingDelivery(
        `${this.workerId}-delivery`,
        this.nowIso(),
      );
      if (claim) this.startDelivery(claim);
    }
  }

  private startExecution(claim: ContinuationClaim): void {
    const execution: ActiveExecution = {
      claim,
      controller: new AbortController(),
      promise: Promise.resolve(),
      heartbeatInFlight: false,
    };
    this.active.set(claim.job.jobId, execution);
    this.debug('claimed', claim, 'running');

    execution.heartbeatTimer = setInterval(() => {
      void this.maintainExecution(execution);
    }, this.heartbeatIntervalMs);
    execution.heartbeatTimer.unref();

    const remainingMs = Date.parse(claim.job.expiresAt) - this.options.clock.now().getTime();
    if (remainingMs <= 0) {
      this.abortExecution(execution, 'expired');
    } else {
      execution.expirationTimer = setTimeout(() => {
        this.abortExecution(execution, 'expired');
      }, remainingMs);
      execution.expirationTimer.unref();
    }

    execution.promise = this.runExecution(execution)
      .catch(async () => {
        await this.audit(
          'continuation.execute',
          execution.claim,
          'error',
          'worker_state_error',
        );
        this.debug('worker_state_error', execution.claim, 'running');
      })
      .finally(() => {
        if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
        if (execution.expirationTimer) clearTimeout(execution.expirationTimer);
        this.active.delete(claim.job.jobId);
        this.scheduleTick();
      });
  }

  private async runExecution(execution: ActiveExecution): Promise<void> {
    let result;
    try {
      await this.audit(
        'continuation.execute.start',
        execution.claim,
        'ok',
        permissionAuditDetail(execution.claim),
      );
      result = await this.options.executor.execute(
        execution.claim,
        execution.controller.signal,
      );
    } catch (error) {
      await this.handleExecutionError(execution, error);
      return;
    }

    if (execution.abortReason) {
      await this.finishAbortedExecution(execution);
      return;
    }

    const latest = await this.options.repository.get(execution.claim.job.jobId);
    if (latest?.status === 'cancel_requested') {
      execution.abortReason = 'cancel';
      await this.finishAbortedExecution(execution);
      return;
    }
    if (!latest || latest.status !== 'running') return;

    try {
      await this.options.repository.completeStep(execution.claim, result, this.nowIso());
      await this.audit('continuation.execute', execution.claim, 'ok');
      this.debug('step_committed', execution.claim, result.outcome.outcome);
    } catch {
      const afterFailure = await this.options.repository.get(execution.claim.job.jobId).catch(() => null);
      if (afterFailure?.status === 'cancel_requested') {
        execution.abortReason = 'cancel';
        await this.finishAbortedExecution(execution);
        return;
      }
      await this.audit(
        'continuation.execute',
        execution.claim,
        'error',
        'state_commit_failed',
      );
      this.debug('state_commit_failed', execution.claim, 'running');
    }
  }

  private async handleExecutionError(
    execution: ActiveExecution,
    error: unknown,
  ): Promise<void> {
    if (execution.abortReason || execution.controller.signal.aborted) {
      await this.finishAbortedExecution(execution);
      return;
    }
    let latest;
    try {
      latest = await this.options.repository.get(execution.claim.job.jobId);
    } catch {
      // Keep the lease intact; recovery will decide after the repository is healthy again.
      return;
    }
    if (latest?.status === 'cancel_requested') {
      execution.abortReason = 'cancel';
      await this.finishAbortedExecution(execution);
      return;
    }
    if (!latest || latest.status !== 'running') return;
    const failure = classifyExecutionFailure(error);
    try {
      await this.options.repository.failAttempt(execution.claim, failure, this.nowIso());
    } finally {
      await this.audit(
        'continuation.execute',
        execution.claim,
        'error',
        'attempt_failed',
      );
      this.debug('attempt_failed', execution.claim, 'failed');
    }
  }

  private async finishAbortedExecution(execution: ActiveExecution): Promise<void> {
    if (execution.abortReason === 'cancel') {
      await this.options.repository.completeCancellation(execution.claim, this.nowIso());
      await this.audit('continuation.cancel', execution.claim, 'ok');
      this.debug('cancelled', execution.claim, 'cancelled');
      return;
    }
    if (execution.abortReason === 'expired') {
      await this.options.repository.failAttempt(
        execution.claim,
        {
          errorCode: 'continuation_expired',
          errorSummary: 'The continuation reached its maximum age.',
          retryable: false,
        },
        this.nowIso(),
      );
      await this.audit('continuation.execute', execution.claim, 'error', 'continuation_expired');
      this.debug('expired', execution.claim, 'failed');
    }
    // Shutdown and lost leases intentionally leave the active attempt to lease recovery.
  }

  private async inspectActiveExecutions(): Promise<void> {
    await Promise.all([...this.active.values()].map(async (execution) => {
      const job = await this.options.repository.get(execution.claim.job.jobId);
      if (job?.status === 'cancel_requested') this.abortExecution(execution, 'cancel');
      else if (!job || job.status !== 'running') this.abortExecution(execution, 'lease_lost');
      else if (job.expiresAt <= this.nowIso()) this.abortExecution(execution, 'expired');
    }));
  }

  private async maintainExecution(execution: ActiveExecution): Promise<void> {
    if (execution.heartbeatInFlight || execution.controller.signal.aborted) return;
    execution.heartbeatInFlight = true;
    try {
      const job = await this.options.repository.get(execution.claim.job.jobId);
      if (job?.status === 'cancel_requested') {
        this.abortExecution(execution, 'cancel');
        return;
      }
      const now = this.nowIso();
      if (!job || job.status !== 'running') {
        this.abortExecution(execution, 'lease_lost');
        return;
      }
      if (job.expiresAt <= now) {
        this.abortExecution(execution, 'expired');
        return;
      }
      const renewed = await this.options.repository.heartbeat(
        execution.claim.job.jobId,
        execution.claim.workerId,
        now,
        addMilliseconds(now, this.leaseDurationMs),
      );
      if (!renewed) this.abortExecution(execution, 'lease_lost');
    } catch {
      // A transient database error is retried on the next heartbeat; the lease remains bounded.
    } finally {
      execution.heartbeatInFlight = false;
    }
  }

  private abortExecution(execution: ActiveExecution, reason: AbortReason): void {
    if (execution.controller.signal.aborted) return;
    execution.abortReason = reason;
    execution.controller.abort();
  }

  private startDelivery(claim: ContinuationDeliveryClaim): void {
    const run = this.runDelivery(claim)
      .catch(async () => {
        // Leave the sending lease intact; outbox recovery will reclaim it deterministically.
        await this.auditDelivery(claim, 'error', 'delivery_state_persist_failed');
      })
      .finally(() => {
        if (this.deliveryInFlight === run) this.deliveryInFlight = undefined;
        this.scheduleTick();
      });
    this.deliveryInFlight = run;
  }

  private async runDelivery(claim: ContinuationDeliveryClaim): Promise<void> {
    let result;
    try {
      result = await this.options.delivery.deliver(claim);
    } catch (error) {
      const summary = errorSummary(error);
      await this.options.repository.markDeliveryResult(
        claim,
        {
          status: 'retry',
          errorCode: 'terminal_delivery_failed',
          errorSummary: summary,
        },
        this.nowIso(),
      );
      await this.auditDelivery(claim, 'error', 'terminal_delivery_failed');
      return;
    }
    await this.options.repository.markDeliveryResult(claim, result, this.nowIso());
    await this.auditDelivery(claim, result.status === 'delivered' ? 'ok' : 'error', result.status);
    this.emitDebug(formatContinuationDiagnosticMessage({
      event: 'delivery_committed',
      jobId: claim.jobId,
      state: result.status,
    }));
  }

  private scheduleTick(): void {
    if (this.stopping || this.scheduledTick) return;
    this.scheduledTick = setTimeout(() => {
      this.scheduledTick = undefined;
      void this.tick().catch(() => {});
    }, 0);
    this.scheduledTick.unref();
  }

  private nowIso(): string {
    return this.options.clock.now().toISOString();
  }

  private async audit(
    action: string,
    claim: ContinuationClaim,
    result: 'ok' | 'denied' | 'error',
    detail?: string,
  ): Promise<void> {
    await this.options.audit?.record({
      action,
      actorOpenId: claim.job.creatorOpenId,
      jobId: claim.job.jobId,
      attemptId: claim.attempt.attemptId,
      result,
      ...(detail ? { detail: sanitizeText(detail) } : {}),
    }).catch(() => {});
  }

  private async auditDelivery(
    claim: ContinuationDeliveryClaim,
    result: 'ok' | 'error',
    detail: string,
  ): Promise<void> {
    await this.options.audit?.record({
      action: 'continuation.deliver',
      jobId: claim.jobId,
      result,
      detail,
    }).catch(() => {});
  }

  private debug(
    event: string,
    claim: ContinuationClaim,
    state?: string,
  ): void {
    try {
      this.emitDebug(formatContinuationDiagnosticMessage({
        event,
        jobId: claim.job.jobId,
        attemptId: claim.attempt.attemptId,
        ...(state ? { state } : {}),
      }));
    } catch {
      // Diagnostics never affect continuation state.
    }
  }

  private emitDebug(message: string): void {
    try {
      this.options.debug?.(message);
    } catch {
      // Diagnostics never affect continuation state.
    }
  }
}

function classifyExecutionFailure(error: unknown): ContinuationFailure {
  if (error instanceof ContinuationExecutionError) {
    return {
      errorCode: error.errorCode,
      errorSummary: sanitizeText(error.errorSummary),
      retryable: error.retryable,
    };
  }
  return {
    errorCode: 'continuation_execution_failed',
    errorSummary: errorSummary(error),
    retryable: true,
  };
}

function errorSummary(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}

function sanitizeText(value: string): string {
  const sanitized = value
    .replace(/\r/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  const redacted = redactContinuationText(sanitized);
  return redacted.length > 1_000 ? `${redacted.slice(0, 997)}...` : redacted;
}

function permissionAuditDetail(claim: ContinuationClaim): string {
  const permissions = claim.job.permissions;
  return [
    `profile=${permissions.profile}`,
    `network=${permissions.network}`,
    `external_side_effects=${permissions.externalSideEffects}`,
    `requested_paths=${permissions.filesystem.requestedPaths.join(',') || '-'}`,
  ].join(' ');
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function positiveInterval(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('Continuation worker intervals must be positive numbers.');
  }
  return resolved;
}
