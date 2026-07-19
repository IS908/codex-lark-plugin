/**
 * Cron definition scanner.
 *
 * JSON files remain the definition/schedule source. Every trigger is admitted
 * into the Durable Run repository; execution and Feishu delivery are owned by
 * the shared worker and outbox.
 */
import { randomUUID } from 'node:crypto';
import { appConfig } from './config.js';
import { listAllJobs, type JobFile } from './job-store.js';
import type { CronRunAdmission, CronAdmissionResult } from './cron/run-admission.js';

export interface SchedulerRepository {
  listAllJobs: typeof listAllJobs;
}

export interface SchedulerOptions {
  admission: CronRunAdmission;
  clock?: () => Date;
  scanIntervalMs?: number;
  repository?: Partial<SchedulerRepository>;
}

export interface RunJobNowResult {
  started: boolean;
  reason?: 'already_running' | 'stale_job';
  outcome?: 'success' | 'failed';
}

export class JobScheduler {
  private readonly clock: () => Date;
  private readonly scanIntervalMs: number;
  private readonly repository: SchedulerRepository;
  private timer?: NodeJS.Timeout;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.scanIntervalMs = options.scanIntervalMs ?? appConfig.cronScanInterval * 1000;
    if (!Number.isFinite(this.scanIntervalMs) || this.scanIntervalMs <= 0) {
      throw new Error('Cron scheduler scan interval must be positive.');
    }
    this.repository = {
      listAllJobs: options.repository?.listAllJobs ?? listAllJobs,
    };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.recoverMissedJobs();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error(`[scheduler] Scan failed: ${errorMessage(error)}`);
      });
    }, this.scanIntervalMs);
    this.timer.unref();
    console.error(`[scheduler] Started (scan every ${this.scanIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    console.error('[scheduler] Stopped');
  }

  async recoverMissedJobs(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) {
      console.error('[scheduler] Tick skipped: previous tick still running');
      return this.tickInFlight;
    }
    const operation = this.scan(this.clock()).finally(() => {
      if (this.tickInFlight === operation) this.tickInFlight = null;
    });
    this.tickInFlight = operation;
    return operation;
  }

  async runJobNow(job: JobFile): Promise<RunJobNowResult> {
    const admission = await this.options.admission.admitManual(
      job,
      `manual:${randomUUID()}`,
      this.clock(),
    );
    if (!admission.admitted) return rejectedManual(admission);
    const outcome = await this.options.admission.waitForExecution(admission.runId);
    return { started: true, outcome };
  }

  private async scan(now: Date): Promise<void> {
    const jobs = await this.repository.listAllJobs();
    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      try {
        const result = await this.options.admission.admitScheduled(job, now);
        if (result.admitted && result.created) {
          console.error(
            `[scheduler] Admitted job ${job.meta.id} as run ${result.runId}`
            + (result.scheduledOccurrence ? ` occurrence=${result.scheduledOccurrence}` : ''),
          );
        }
      } catch (error) {
        console.error(`[scheduler] Failed to admit job ${job.meta.id}: ${errorMessage(error)}`);
      }
    }
  }
}

function rejectedManual(result: Exclude<CronAdmissionResult, { admitted: true }>): RunJobNowResult {
  if (result.reason === 'already_running') return { started: false, reason: 'already_running' };
  return { started: false, reason: 'stale_job', outcome: 'failed' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
