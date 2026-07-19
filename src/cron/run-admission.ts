import { createHash } from 'node:crypto';
import {
  cronManualRunIdempotencyKey,
  cronScheduledRunIdempotencyKey,
  isDurableRunTerminal,
  type DurableRunCreateRequest,
  type DurableRunRecord,
} from '../domain/durable-run.js';
import { computeLatestDueRun, computeNextRun, jobTimezone, mutateJob, readJob } from '../job-store.js';
import type { JobFile } from '../job-contracts.js';
import type { DurableRunRepository } from '../ports/durable-run.js';
import type { CronRunInput, CronRunState } from './contracts.js';

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

const DEFAULT_WAIT_POLL_MS = 50;
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
    const existing = await this.options.runRepository.get(runId);
    if (existing) {
      const nextRunAt = computeNextRun(
        fresh.meta.schedule,
        jobTimezone(fresh.meta),
        new Date(occurrence),
      );
      await this.projectAdmission(fresh, existing.runId, {
        expectedCursor: fresh.runtime.next_run_at,
        nextRunAt,
      });
      return admitted(existing, false, occurrence);
    }
    if (Date.parse(fresh.runtime.next_run_at) > now.getTime()) {
      return { admitted: false, reason: 'not_due' };
    }
    if (await this.hasDifferentActiveRun(fresh, runId)) {
      return { admitted: false, reason: 'already_running' };
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
    for (;;) {
      signal?.throwIfAborted();
      const run = await this.options.runRepository.get(runId);
      if (!run) throw new Error(`Cron Run ${runId} does not exist.`);
      if (run.status === 'completed') return 'success';
      if (isDurableRunTerminal(run.status)) return 'failed';
      await abortableDelay(this.waitPollMs, signal);
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
      latest.runtime.run_id = runId;
      latest.runtime.run_status = 'started';
      latest.runtime.output_status = null;
      latest.runtime.delivery_status = null;
      latest.runtime.report = null;
      latest.runtime.report_type = null;
      latest.runtime.delivery_error = null;
      latest.runtime.last_error = null;
      if (schedule) latest.runtime.next_run_at = schedule.nextRunAt;
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
