import type {
  DurableRunClaim,
  DurableRunDeliveryClaim,
  DurableRunFailure,
  DurableRunTransition,
  DurableRunWorkloadClaim,
} from '../domain/durable-run.js';
import {
  materializeDurableRunWorkloadClaim,
  materializeDurableRunWorkloadContext,
  type DurableRunClock,
  type DurableRunDelivery,
  type DurableRunRepository,
  type DurableRunWorkload,
} from '../ports/durable-run.js';

type AbortReason = 'cancel' | 'expired' | 'lease_lost' | 'shutdown';
type RegisteredWorkload = DurableRunWorkload<unknown, unknown, unknown>;

interface ActiveExecution {
  claim: DurableRunClaim;
  workload: RegisteredWorkload;
  controller: AbortController;
  promise: Promise<void>;
  heartbeatTimer?: NodeJS.Timeout;
  leaseDeadlineTimer?: NodeJS.Timeout;
  expirationTimer?: NodeJS.Timeout;
  confirmedLeaseExpiresAt: string;
  heartbeatInFlight: boolean;
  abortReason?: AbortReason;
}

export interface DurableRunWorkerOptions {
  repository: DurableRunRepository;
  workloads: readonly DurableRunWorkload[];
  delivery: DurableRunDelivery;
  clock: DurableRunClock;
  maxConcurrencyByWorkload: Readonly<Record<string, number>>;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  workerId?: string;
  onExecutionStateError?: (claim: DurableRunClaim, error: unknown) => Promise<void> | void;
}

const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_DURATION_MS = 30_000;

export class DurableRunWorker {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly workloads = new Map<string, RegisteredWorkload>();
  private readonly workerId: string;
  private readonly scanIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private scanTimer?: NodeJS.Timeout;
  private scheduledTick?: NodeJS.Timeout;
  private executionScanInFlight?: Promise<void>;
  private deliveryPumpInFlight?: Promise<void>;
  private deliveryInFlight?: Promise<void>;
  private stopping = false;
  private started = false;

  constructor(private readonly options: DurableRunWorkerOptions) {
    for (const workload of options.workloads) {
      if (!workload.kind.trim()) throw new Error('Durable run workload kind must not be empty.');
      if (this.workloads.has(workload.kind)) {
        throw new Error(`Duplicate durable run workload: ${workload.kind}`);
      }
      const quota = options.maxConcurrencyByWorkload[workload.kind];
      if (!Number.isInteger(quota) || quota < 1) {
        throw new Error(
          `Durable run workload concurrency for ${workload.kind} must be a positive integer.`,
        );
      }
      this.workloads.set(workload.kind, workload as RegisteredWorkload);
    }
    if (this.workloads.size === 0) {
      throw new Error('Durable run worker requires at least one workload.');
    }
    this.workerId = options.workerId ?? 'durable-run-worker';
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
    const results: PromiseSettledResult<void>[] = await Promise.allSettled([
      this.startExecutionScan(),
      this.startDeliveryPump(),
    ]);
    if (!this.stopping) {
      const followUpDelivery = await Promise.allSettled([this.startDeliveryPump()]);
      results.push(followUpDelivery[0]);
    }
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (this.scanTimer) clearInterval(this.scanTimer);
      if (this.scheduledTick) clearTimeout(this.scheduledTick);
      this.scanTimer = undefined;
      this.scheduledTick = undefined;
      for (const execution of this.active.values()) {
        this.abortExecution(execution, 'shutdown');
      }
    }
    if (this.executionScanInFlight) {
      await Promise.allSettled([this.executionScanInFlight]);
    }
    if (this.deliveryPumpInFlight) {
      await Promise.allSettled([this.deliveryPumpInFlight]);
    }
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
    if (this.deliveryInFlight) await Promise.allSettled([this.deliveryInFlight]);
  }

  private startExecutionScan(): Promise<void> {
    if (this.executionScanInFlight) return this.executionScanInFlight;
    const run = this.scanExecutions().finally(() => {
      if (this.executionScanInFlight === run) this.executionScanInFlight = undefined;
    });
    this.executionScanInFlight = run;
    return run;
  }

  private startDeliveryPump(): Promise<void> {
    if (this.deliveryPumpInFlight) return this.deliveryPumpInFlight;
    const run = this.pumpDelivery().finally(() => {
      if (this.deliveryPumpInFlight === run) this.deliveryPumpInFlight = undefined;
    });
    this.deliveryPumpInFlight = run;
    return run;
  }

  private async scanExecutions(): Promise<void> {
    const now = this.nowIso();
    const interrupted = await this.options.repository.recoverExpiredLeases(now);
    for (const attempt of interrupted) {
      const workload = this.workloadFor(attempt.claim.run.workloadKind);
      const context = materializeDurableRunWorkloadContext(workload, attempt.claim.run);
      const claim = materializeDurableRunWorkloadClaim(attempt.claim, context);
      const transition = workload.recoverInterruptedAttempt({
        ...attempt,
        claim,
      });
      await this.options.repository.commitTransition(attempt.claim, transition, now);
    }

    await this.inspectActiveExecutions();
    let remainingClaims = this.availableClaimSlots();
    while (!this.stopping && remainingClaims > 0) {
      const availableKinds = this.availableWorkloadKinds();
      if (availableKinds.length === 0) break;
      const claimedAt = this.nowIso();
      const claim = await this.options.repository.claimDue(
        availableKinds,
        this.workerId,
        claimedAt,
        addMilliseconds(claimedAt, this.leaseDurationMs),
      );
      if (!claim) break;
      if (this.stopping) break;
      if (!availableKinds.includes(claim.run.workloadKind)) {
        throw new Error(`Repository returned unavailable workload ${claim.run.workloadKind}.`);
      }
      if (this.active.has(claim.run.runId)) {
        throw new Error(`Durable run ${claim.run.runId} is already active.`);
      }
      this.startExecution(claim, this.workloadFor(claim.run.workloadKind));
      remainingClaims -= 1;
    }
  }

  private async pumpDelivery(): Promise<void> {
    if (!this.stopping && !this.deliveryInFlight) {
      const claim = await this.options.repository.claimDelivery(
        [...this.workloads.keys()],
        `${this.workerId}-delivery`,
        this.nowIso(),
      );
      if (claim && !this.stopping) this.startDelivery(claim);
    }
  }

  private startExecution(claim: DurableRunClaim, workload: RegisteredWorkload): void {
    const execution: ActiveExecution = {
      claim,
      workload,
      controller: new AbortController(),
      promise: Promise.resolve(),
      confirmedLeaseExpiresAt: claim.attempt.leaseExpiresAt,
      heartbeatInFlight: false,
    };
    this.active.set(claim.run.runId, execution);

    execution.heartbeatTimer = setInterval(() => {
      void this.maintainExecution(execution);
    }, this.heartbeatIntervalMs);
    execution.heartbeatTimer.unref();
    this.scheduleLeaseDeadline(execution);

    const remainingMs = Date.parse(claim.run.expiresAt) - this.options.clock.now().getTime();
    if (remainingMs <= 0) {
      this.abortExecution(execution, 'expired');
    } else {
      execution.expirationTimer = setTimeout(() => {
        this.abortExecution(execution, 'expired');
      }, remainingMs);
      execution.expirationTimer.unref();
    }

    execution.promise = this.runExecution(execution)
      .catch(async (error) => {
        try {
          await this.options.onExecutionStateError?.(execution.claim, error);
        } catch {
          // Observability failures never affect durable run state.
        }
      })
      .finally(() => {
        if (execution.heartbeatTimer) clearInterval(execution.heartbeatTimer);
        if (execution.leaseDeadlineTimer) clearTimeout(execution.leaseDeadlineTimer);
        if (execution.expirationTimer) clearTimeout(execution.expirationTimer);
        this.active.delete(claim.run.runId);
        this.scheduleTick();
      });
  }

  private async runExecution(execution: ActiveExecution): Promise<void> {
    let workloadClaim: DurableRunWorkloadClaim<unknown, unknown>;
    let result: unknown;
    try {
      const context = materializeDurableRunWorkloadContext(
        execution.workload,
        execution.claim.run,
      );
      workloadClaim = materializeDurableRunWorkloadClaim(execution.claim, context);
      const preflight = await execution.workload.preflight(context);
      if (preflight.action === 'transition') {
        await this.commitExecutionTransition(execution, preflight.transition);
        return;
      }
      if (await this.executionCannotCommit(execution)) {
        await this.finishAbortedExecution(execution);
        return;
      }
      await this.options.repository.markExecutionStarted(execution.claim, this.nowIso());
      result = await execution.workload.execute(workloadClaim, execution.controller.signal);
    } catch (error) {
      await this.handleExecutionError(execution, error);
      return;
    }

    const transition = execution.workload.reduce(workloadClaim, result);
    await this.commitExecutionTransition(execution, transition);
  }

  private async commitExecutionTransition(
    execution: ActiveExecution,
    transition: DurableRunTransition,
  ): Promise<void> {
    if (await this.executionCannotCommit(execution)) {
      await this.finishAbortedExecution(execution);
      return;
    }
    await this.options.repository.commitTransition(execution.claim, transition, this.nowIso());
  }

  private async executionCannotCommit(execution: ActiveExecution): Promise<boolean> {
    this.abortIfWorkerCannotOwnClaim(execution);
    if (execution.abortReason || execution.controller.signal.aborted) return true;

    const latest = await this.options.repository.get(execution.claim.run.runId);
    if (latest?.status === 'cancel_requested') this.abortExecution(execution, 'cancel');
    else if (!latest || latest.status !== 'running') this.abortExecution(execution, 'lease_lost');

    this.abortIfWorkerCannotOwnClaim(execution);
    return Boolean(execution.abortReason || execution.controller.signal.aborted);
  }

  private abortIfWorkerCannotOwnClaim(execution: ActiveExecution): void {
    if (execution.abortReason || execution.controller.signal.aborted) return;
    if (this.stopping) {
      this.abortExecution(execution, 'shutdown');
    } else if (execution.confirmedLeaseExpiresAt <= this.nowIso()) {
      this.abortExecution(execution, 'lease_lost');
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
      latest = await this.options.repository.get(execution.claim.run.runId);
    } catch {
      return;
    }
    if (latest?.status === 'cancel_requested') {
      execution.abortReason = 'cancel';
      await this.finishAbortedExecution(execution);
      return;
    }
    if (!latest || latest.status !== 'running') return;
    await this.options.repository.failAttempt(
      execution.claim,
      classifyExecutionFailure(execution.claim, error),
      this.nowIso(),
    );
  }

  private async finishAbortedExecution(execution: ActiveExecution): Promise<void> {
    if (execution.abortReason === 'cancel') {
      await this.options.repository.commitTransition(
        execution.claim,
        unchangedTransition(execution.claim, 'cancelled'),
        this.nowIso(),
      );
      return;
    }
    if (execution.abortReason === 'expired') {
      await this.options.repository.commitTransition(
        execution.claim,
        {
          ...unchangedTransition(execution.claim, 'failed'),
          errorCode: 'durable_run_expired',
          errorSummary: 'The durable run reached its maximum age.',
          failure: {
            category: 'terminal',
            retrySafety: 'unsafe',
            capabilityAvailable: true,
            operationRisk: 'unknown',
            hints: [],
            failedStep: execution.claim.run.workloadKind.slice(0, 80),
            diagnostic: 'The durable run reached its maximum age.',
            fingerprint: `expired:${execution.claim.run.workloadKind}`.slice(0, 128),
          },
        },
        this.nowIso(),
      );
    }
    // Shutdown and lost leases intentionally leave their attempts for lease recovery.
  }

  private async inspectActiveExecutions(): Promise<void> {
    await Promise.all([...this.active.values()].map(async (execution) => {
      const run = await this.options.repository.get(execution.claim.run.runId);
      if (run?.status === 'cancel_requested') this.abortExecution(execution, 'cancel');
      else if (!run || run.status !== 'running') this.abortExecution(execution, 'lease_lost');
      else if (run.expiresAt <= this.nowIso()) this.abortExecution(execution, 'expired');
      else if (execution.confirmedLeaseExpiresAt <= this.nowIso()) {
        this.abortExecution(execution, 'lease_lost');
      }
    }));
  }

  private async maintainExecution(execution: ActiveExecution): Promise<void> {
    if (execution.heartbeatInFlight || execution.controller.signal.aborted) return;
    execution.heartbeatInFlight = true;
    try {
      const run = await this.options.repository.get(execution.claim.run.runId);
      if (run?.status === 'cancel_requested') {
        this.abortExecution(execution, 'cancel');
        return;
      }
      const now = this.nowIso();
      if (!run || run.status !== 'running') {
        this.abortExecution(execution, 'lease_lost');
        return;
      }
      if (run.expiresAt <= now) {
        this.abortExecution(execution, 'expired');
        return;
      }
      if (execution.confirmedLeaseExpiresAt <= now) {
        this.abortExecution(execution, 'lease_lost');
        return;
      }
      const leaseExpiresAt = addMilliseconds(now, this.leaseDurationMs);
      const renewed = await this.options.repository.heartbeat(
        execution.claim,
        now,
        leaseExpiresAt,
      );
      if (execution.controller.signal.aborted) return;
      if (!renewed || execution.confirmedLeaseExpiresAt <= this.nowIso()) {
        this.abortExecution(execution, 'lease_lost');
        return;
      }
      execution.confirmedLeaseExpiresAt = leaseExpiresAt;
      this.scheduleLeaseDeadline(execution);
    } catch {
      // The last confirmed lease deadline remains authoritative.
    } finally {
      execution.heartbeatInFlight = false;
    }
  }

  private scheduleLeaseDeadline(execution: ActiveExecution): void {
    if (execution.leaseDeadlineTimer) clearTimeout(execution.leaseDeadlineTimer);
    const remainingMs = Date.parse(execution.confirmedLeaseExpiresAt)
      - this.options.clock.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      this.abortExecution(execution, 'lease_lost');
      return;
    }
    execution.leaseDeadlineTimer = setTimeout(() => {
      this.abortExecution(execution, 'lease_lost');
    }, remainingMs);
    execution.leaseDeadlineTimer.unref();
  }

  private abortExecution(execution: ActiveExecution, reason: AbortReason): void {
    if (execution.controller.signal.aborted) return;
    execution.abortReason = reason;
    execution.controller.abort();
  }

  private startDelivery(claim: DurableRunDeliveryClaim): void {
    const run = this.runDelivery(claim)
      .catch(() => {})
      .finally(() => {
        if (this.deliveryInFlight === run) this.deliveryInFlight = undefined;
        this.scheduleTick();
      });
    this.deliveryInFlight = run;
  }

  private async runDelivery(claim: DurableRunDeliveryClaim): Promise<void> {
    let result;
    try {
      result = await this.options.delivery.deliver(claim);
    } catch (error) {
      result = {
        status: 'retry' as const,
        errorCode: 'durable_run_delivery_failed',
        errorSummary: boundedErrorSummary(error),
      };
    }
    await this.options.repository.commitDelivery(claim, result, this.nowIso());
  }

  private availableWorkloadKinds(): string[] {
    const activeByKind = new Map<string, number>();
    for (const execution of this.active.values()) {
      const kind = execution.claim.run.workloadKind;
      activeByKind.set(kind, (activeByKind.get(kind) ?? 0) + 1);
    }
    return [...this.workloads.keys()].filter((kind) =>
      (activeByKind.get(kind) ?? 0) < this.options.maxConcurrencyByWorkload[kind]);
  }

  private availableClaimSlots(): number {
    const activeByKind = new Map<string, number>();
    for (const execution of this.active.values()) {
      const kind = execution.claim.run.workloadKind;
      activeByKind.set(kind, (activeByKind.get(kind) ?? 0) + 1);
    }
    let available = 0;
    for (const kind of this.workloads.keys()) {
      available += this.options.maxConcurrencyByWorkload[kind] - (activeByKind.get(kind) ?? 0);
    }
    return available;
  }

  private workloadFor(kind: string): RegisteredWorkload {
    const workload = this.workloads.get(kind);
    if (!workload) throw new Error(`No durable run workload registered for ${kind}.`);
    return workload;
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
}

function unchangedTransition(
  claim: DurableRunClaim,
  status: DurableRunTransition['status'],
): DurableRunTransition {
  return {
    status,
    stateVersion: claim.run.stateVersion,
    state: claim.run.state,
  };
}

function classifyExecutionFailure(claim: DurableRunClaim, error: unknown): DurableRunFailure {
  const diagnostic = boundedErrorSummary(error);
  return {
    category: 'unknown',
    retrySafety: 'unknown',
    capabilityAvailable: true,
    operationRisk: 'unknown',
    hints: [],
    failedStep: claim.run.workloadKind.slice(0, 80),
    diagnostic,
    fingerprint: `execution:${claim.run.workloadKind}:${diagnostic.slice(0, 64)}`.slice(0, 128),
  };
}

function boundedErrorSummary(error: unknown): string {
  const summary = (error instanceof Error ? error.message : String(error))
    .replace(/\r/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  if (!summary) return 'Unknown durable run execution failure.';
  return summary.length > 1_000 ? `${summary.slice(0, 997)}...` : summary;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function positiveInterval(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('Durable run worker intervals must be positive numbers.');
  }
  return resolved;
}
