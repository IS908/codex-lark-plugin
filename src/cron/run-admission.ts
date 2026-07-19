import { createHash } from 'node:crypto';
import {
  cronManualRunIdempotencyKey,
  cronScheduledRunIdempotencyKey,
  isDurableRunTerminal,
  type DurableRunCreateRequest,
  type DurableRunDeliveryResult,
  type DurableRunDeliverySnapshot,
  type DurableRunRecord,
} from '../domain/durable-run.js';
import { computeLatestDueRun, computeNextRun, jobTimezone, mutateJob, readJob } from '../job-store.js';
import type { JobFile } from '../job-contracts.js';
import type { DurableRunRepository } from '../ports/durable-run.js';
import {
  parseCronRunInput,
  parseCronRunState,
  type CronRunInput,
  type CronRunState,
} from './contracts.js';
import { parseCronDeliveryRoute, parseCronTerminalPayload } from './delivery.js';
import {
  autoPauseCronJobForDeliveryFailure,
  projectCronDeliveryPending,
  projectCronDeliveryResult,
} from './runtime-projection.js';

export type CronAdmissionRejectionReason =
  | 'paused'
  | 'not_due'
  | 'already_running'
  | 'stale_job';

export type CronAdmissionResult =
  | {
      admitted: true;
      runId: string;
      created: boolean;
      scheduledOccurrence?: string;
    }
  | { admitted: false; reason: CronAdmissionRejectionReason };

export interface CronAdmissionJobRepository {
  readJob(id: string): Promise<JobFile | null>;
  mutateJob(
    id: string,
    mutate: (job: JobFile) => void | false | Promise<void | false>,
  ): Promise<JobFile | null>;
}

export interface CronRunAdmissionOptions {
  runRepository: DurableRunRepository;
  jobRepository?: CronAdmissionJobRepository;
  waitPollMs?: number;
}

const DEFAULT_WAIT_POLL_MS = 100;
const MAX_WAIT_POLL_MS = 1_000;
const CRON_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export class CronRunAdmission {
  private readonly jobs: CronAdmissionJobRepository;
  private readonly waitPollMs: number;
  private readonly admissionQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: CronRunAdmissionOptions) {
    this.jobs = options.jobRepository ?? { readJob, mutateJob };
    this.waitPollMs = positiveInteger(options.waitPollMs, DEFAULT_WAIT_POLL_MS);
  }

  async admitScheduled(job: JobFile, now: Date): Promise<CronAdmissionResult> {
    return this.withJobAdmissionQueue(job.meta.id, () => this.admitScheduledUnlocked(job, now));
  }

  private async admitScheduledUnlocked(job: JobFile, now: Date): Promise<CronAdmissionResult> {
    const fresh = await this.currentDefinition(job);
    if (!fresh) return { admitted: false, reason: 'stale_job' };
    if (fresh.meta.status !== 'active') return { admitted: false, reason: 'paused' };
    const occurrence = computeLatestDueRun(
      fresh.meta.schedule,
      now,
      jobTimezone(fresh.meta),
    );
    const identity = cronJobIdentity(fresh);
    const idempotencyKey = cronScheduledRunIdempotencyKey(
      identity,
      fresh.meta.revision,
      occurrence,
    );
    const runId = cronRunId(idempotencyKey);
    if (Date.parse(fresh.runtime.next_run_at) > now.getTime()) {
      if (Date.parse(job.runtime.next_run_at) > now.getTime()) {
        return { admitted: false, reason: 'not_due' };
      }
      const duplicate = await this.options.runRepository.get(runId);
      return duplicate
        ? admitted(duplicate, false, occurrence)
        : { admitted: false, reason: 'not_due' };
    }
    if (await this.hasDifferentActiveRun(fresh, runId)) {
      return { admitted: false, reason: 'already_running' };
    }
    const existing = await this.options.runRepository.get(runId);
    if (existing) {
      const nextRunAt = computeNextRun(
        fresh.meta.schedule,
        jobTimezone(fresh.meta),
        new Date(occurrence),
      );
      const latestForKey = this.options.runRepository.getLatestByConcurrencyKey;
      const latest = latestForKey
        ? await latestForKey.call(this.options.runRepository, cronConcurrencyKey(fresh))
        : null;
      if (latest && latest.runId !== existing.runId) {
        await this.projectScheduleCursor(fresh, fresh.runtime.next_run_at, nextRunAt);
      } else {
        await this.projectAdmission(fresh, existing.runId, {
          expectedCursor: fresh.runtime.next_run_at,
          nextRunAt,
        });
      }
      return admitted(existing, false, occurrence);
    }
    const created = await this.options.runRepository.create(
      cronRunCreateRequest(fresh, idempotencyKey, runId, now, occurrence),
    );
    if (created.run.runId !== runId) {
      return { admitted: false, reason: 'already_running' };
    }
    const nextRunAt = computeNextRun(
      fresh.meta.schedule,
      jobTimezone(fresh.meta),
      new Date(occurrence),
    );
    await this.projectAdmission(fresh, created.run.runId, {
      expectedCursor: fresh.runtime.next_run_at,
      nextRunAt,
    });
    return admitted(created.run, created.created, occurrence);
  }

  async admitManual(job: JobFile, requestId: string, now: Date): Promise<CronAdmissionResult> {
    return this.withJobAdmissionQueue(
      job.meta.id,
      () => this.admitManualUnlocked(job, requestId, now),
    );
  }

  async repairProjection(job: JobFile): Promise<void> {
    return this.withJobAdmissionQueue(job.meta.id, () => this.repairProjectionUnlocked(job));
  }

  private async repairProjectionUnlocked(job: JobFile): Promise<void> {
    const latestForKey = this.options.runRepository.getLatestByConcurrencyKey;
    if (!latestForKey) return;
    let fresh = await this.currentDefinition(job);
    if (!fresh) return;
    const run = await latestForKey.call(
      this.options.runRepository,
      cronConcurrencyKey(fresh),
    );
    if (!run || !isCronWorkload(run.workloadKind)) return;
    const input = parseCronRunInput(run.input, run.inputVersion, fresh.meta.type);
    if (!matchesJobSnapshot(fresh, input)) return;
    const occurrence = input.job.scheduledOccurrence;
    const shouldAdvanceCursor = occurrence !== undefined
      && Date.parse(fresh.runtime.next_run_at) <= Date.parse(occurrence);
    if (fresh.runtime.run_id !== run.runId || shouldAdvanceCursor) {
      await this.projectAdmission(
        fresh,
        run.runId,
        shouldAdvanceCursor
          ? {
              expectedCursor: fresh.runtime.next_run_at,
              nextRunAt: computeNextRun(
                fresh.meta.schedule,
                jobTimezone(fresh.meta),
                new Date(occurrence),
              ),
            }
          : undefined,
      );
      fresh = await this.currentDefinition(fresh);
      if (!fresh) return;
    }
    if (!isDurableRunTerminal(run.status)) return;
    const state = parseCronRunState(run.state, run.stateVersion);
    if (state.phase !== 'completed' || !state.commit) return;
    const readDelivery = this.options.runRepository.getDeliverySnapshot;
    if (!readDelivery) return;
    const delivery = await readDelivery.call(
      this.options.runRepository,
      run.runId,
      'cron_terminal',
    );
    if (!delivery) return;
    const route = parseCronDeliveryRoute(delivery.route);
    const payload = parseCronTerminalPayload(delivery.payload);
    if (
      route.jobId !== input.job.id
      || route.createdAt !== input.job.createdAt
      || route.revision !== input.job.revision
      || payload.jobId !== input.job.id
      || payload.jobCreatedAt !== input.job.createdAt
      || payload.jobRevision !== input.job.revision
    ) {
      throw new Error(`Cron Run ${run.runId} delivery identity is inconsistent.`);
    }
    const result = deliveryResultFromSnapshot(delivery);
    if (cronProjectionNeedsRepair(fresh, payload, result)) {
      await projectCronDeliveryPending(
        run,
        route,
        payload,
        delivery.updatedAt,
        this.jobs,
      );
      if (result) {
        await projectCronDeliveryResult(run, route, payload, result, this.jobs);
      }
    }
    if (result) {
      if (result.status === 'failed' && result.errorCode === 'cron_delivery_target_permanent') {
        await autoPauseCronJobForDeliveryFailure(
          route,
          result.errorSummary,
          this.jobs,
          run.runId,
        );
      }
    }
  }

  private async admitManualUnlocked(
    job: JobFile,
    requestId: string,
    now: Date,
  ): Promise<CronAdmissionResult> {
    const fresh = await this.currentDefinition(job);
    if (!fresh) return { admitted: false, reason: 'stale_job' };
    const identity = cronJobIdentity(fresh);
    const idempotencyKey = cronManualRunIdempotencyKey(
      identity,
      fresh.meta.revision,
      requestId,
    );
    const runId = cronRunId(idempotencyKey);
    const existing = await this.options.runRepository.get(runId);
    if (existing) return admitted(existing, false);
    if (await this.hasDifferentActiveRun(fresh, runId)) {
      return { admitted: false, reason: 'already_running' };
    }
    const created = await this.options.runRepository.create(
      cronRunCreateRequest(fresh, idempotencyKey, runId, now),
    );
    if (created.run.runId !== runId) {
      return { admitted: false, reason: 'already_running' };
    }
    await this.projectAdmission(fresh, created.run.runId);
    return admitted(created.run, created.created);
  }

  async waitForExecution(
    runId: string,
    signal?: AbortSignal,
  ): Promise<'success' | 'failed'> {
    let pollMs = this.waitPollMs;
    for (;;) {
      signal?.throwIfAborted();
      const run = await this.options.runRepository.get(runId);
      if (!run) throw new Error(`Cron Run ${runId} does not exist.`);
      if (run.status === 'completed') return 'success';
      if (isDurableRunTerminal(run.status)) return 'failed';
      await abortableDelay(pollMs, signal);
      pollMs = Math.min(MAX_WAIT_POLL_MS, pollMs * 2);
    }
  }

  private async currentDefinition(candidate: JobFile): Promise<JobFile | null> {
    const fresh = await this.jobs.readJob(candidate.meta.id);
    if (
      !fresh
      || fresh.meta.created_at !== candidate.meta.created_at
      || fresh.meta.revision !== candidate.meta.revision
    ) return null;
    return fresh;
  }

  private async hasDifferentActiveRun(job: JobFile, requestedRunId: string): Promise<boolean> {
    const active = await this.options.runRepository.getActiveByConcurrencyKey(
      cronConcurrencyKey(job),
    );
    return Boolean(active && active.runId !== requestedRunId);
  }

  private async projectAdmission(
    source: JobFile,
    runId: string,
    schedule?: { expectedCursor: string; nextRunAt: string },
  ): Promise<void> {
    await this.jobs.mutateJob(source.meta.id, (latest) => {
      if (
        latest.meta.created_at !== source.meta.created_at
        || latest.meta.revision !== source.meta.revision
        || (schedule && (
          latest.meta.status !== 'active'
          || latest.runtime.next_run_at !== schedule.expectedCursor
        ))
      ) return false;
      if (latest.runtime.run_id !== runId) {
        latest.runtime.run_id = runId;
        latest.runtime.run_status = 'started';
        latest.runtime.output_status = null;
        latest.runtime.delivery_status = null;
        latest.runtime.report = null;
        latest.runtime.report_type = null;
        latest.runtime.delivery_error = null;
        latest.runtime.last_error = null;
      }
      if (schedule) latest.runtime.next_run_at = schedule.nextRunAt;
    });
  }

  private async projectScheduleCursor(
    source: JobFile,
    expectedCursor: string,
    nextRunAt: string,
  ): Promise<void> {
    await this.jobs.mutateJob(source.meta.id, (latest) => {
      if (
        latest.meta.created_at !== source.meta.created_at
        || latest.meta.revision !== source.meta.revision
        || latest.meta.status !== 'active'
        || latest.runtime.next_run_at !== expectedCursor
      ) return false;
      latest.runtime.next_run_at = nextRunAt;
    });
  }

  private async withJobAdmissionQueue<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionQueues.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.admissionQueues.set(jobId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.admissionQueues.get(jobId) === queued) this.admissionQueues.delete(jobId);
    }
  }
}

function cronRunCreateRequest(
  job: JobFile,
  idempotencyKey: string,
  runId: string,
  now: Date,
  scheduledOccurrence?: string,
): DurableRunCreateRequest {
  const input: CronRunInput = {
    schemaVersion: 1,
    job: {
      id: job.meta.id,
      createdAt: job.meta.created_at,
      revision: job.meta.revision,
      name: job.meta.name,
      type: job.meta.type,
      schedule: job.meta.schedule,
      scheduleHuman: job.meta.schedule_human,
      timezone: jobTimezone(job.meta),
      ...(scheduledOccurrence ? { scheduledOccurrence } : {}),
      ...(job.meta.prompt !== undefined ? { prompt: job.meta.prompt } : {}),
      ...(job.meta.content !== undefined ? { content: job.meta.content } : {}),
      ...(job.meta.msg_type !== undefined ? { messageType: job.meta.msg_type } : {}),
      ...(job.meta.model !== undefined ? { model: job.meta.model } : {}),
      targetChatId: job.meta.target_chat_id,
      originChatId: job.meta.origin_chat_id,
      createdBy: job.meta.created_by,
    },
  };
  const state: CronRunState = { schemaVersion: 1, phase: 'admitted' };
  return {
    runId,
    workloadKind: job.meta.type === 'prompt' ? 'cron_prompt' : 'cron_message',
    idempotencyKey,
    concurrencyKey: cronConcurrencyKey(job),
    inputVersion: 1,
    input,
    stateVersion: 1,
    state,
    route: {
      kind: 'cron_job',
      targetChatId: job.meta.target_chat_id,
      originChatId: job.meta.origin_chat_id,
      jobId: job.meta.id,
      createdAt: job.meta.created_at,
      revision: job.meta.revision,
    },
    actorOpenId: job.meta.created_by,
    createdAt: now.toISOString(),
    nextRunAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CRON_RUN_MAX_AGE_MS).toISOString(),
    maxAttempts: 4,
  };
}

function cronJobIdentity(job: JobFile): string {
  return `${job.meta.id}@${job.meta.created_at}`;
}

function cronConcurrencyKey(job: JobFile): string {
  return `cron-job:${cronJobIdentity(job)}`;
}

function cronRunId(idempotencyKey: string): string {
  return `cron_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

function admitted(
  run: DurableRunRecord,
  created: boolean,
  scheduledOccurrence?: string,
): CronAdmissionResult {
  return {
    admitted: true,
    runId: run.runId,
    created,
    ...(scheduledOccurrence ? { scheduledOccurrence } : {}),
  };
}

function isCronWorkload(kind: string): kind is 'cron_prompt' | 'cron_message' {
  return kind === 'cron_prompt' || kind === 'cron_message';
}

function matchesJobSnapshot(job: JobFile, input: CronRunInput): boolean {
  return input.job.id === job.meta.id
    && input.job.createdAt === job.meta.created_at
    && input.job.revision === job.meta.revision
    && input.job.type === job.meta.type;
}

function deliveryResultFromSnapshot(
  delivery: DurableRunDeliverySnapshot,
): DurableRunDeliveryResult | null {
  if (delivery.status === 'sending') return null;
  if (delivery.status === 'pending') {
    return delivery.errorCode && delivery.errorSummary
      ? {
          status: 'retry',
          errorCode: delivery.errorCode,
          errorSummary: delivery.errorSummary,
        }
      : null;
  }
  if (delivery.status === 'sent') {
    return delivery.messageId
      ? { status: 'sent', messageId: delivery.messageId }
      : {
          status: 'unknown',
          errorCode: 'cron_delivery_confirmation_missing',
          errorSummary: 'Feishu delivery was recorded without a message ID.',
        };
  }
  if (delivery.status === 'superseded') return { status: 'superseded' };
  return {
    status: delivery.status,
    errorCode: delivery.errorCode ?? `cron_delivery_${delivery.status}`,
    errorSummary: delivery.errorSummary ?? `CronJob delivery is ${delivery.status}.`,
  };
}

function cronProjectionNeedsRepair(
  job: JobFile,
  payload: ReturnType<typeof parseCronTerminalPayload>,
  result: DurableRunDeliveryResult | null,
): boolean {
  const expectedReport = payload.kind === 'report' ? payload.report : payload.content;
  const expectedReportType = payload.kind === 'report' ? payload.reportType : 'job_message';
  const expectedDeliveryStatus = !result || result.status === 'retry'
    ? 'pending'
    : result.status === 'sent'
      ? 'sent'
      : 'failed';
  const expectedDeliveryError = !result || result.status === 'sent'
    ? null
    : result.status === 'superseded'
      ? 'CronJob delivery was superseded.'
      : result.errorSummary;
  const expectedLastError = payload.runStatus === 'failed'
    ? payload.failureReason ?? 'CronJob execution failed.'
    : null;
  return job.runtime.run_status !== payload.runStatus
    || job.runtime.output_status !== 'generated'
    || job.runtime.delivery_status !== expectedDeliveryStatus
    || job.runtime.report !== expectedReport
    || job.runtime.report_type !== expectedReportType
    || job.runtime.delivery_error !== expectedDeliveryError
    || job.runtime.last_error !== expectedLastError;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Cron execution wait aborted.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
