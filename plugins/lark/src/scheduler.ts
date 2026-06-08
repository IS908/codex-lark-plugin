/**
 * Job Scheduler — periodic scan + execution + crash recovery.
 *
 * Runs as a setInterval in the MCP server process. On each tick,
 * reads all active jobs and executes any whose next_run_at has passed.
 * On startup, recovers missed jobs (at most one execution per job).
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createHash } from 'node:crypto';
import { appConfig } from './config.js';
import { cronJobPrompt } from './prompts.js';
import type { IdentitySession } from './identity-session.js';
import {
  listAllJobs,
  readJob,
  mutateJob,
  computeNextRun,
  computeLatestDueRun,
  type JobFile,
} from './job-store.js';
import { feishuApiCall } from './feishu-retry.js';

/**
 * Prefix for synthetic `thread_id` values injected into cronjob channel
 * notifications. Used only for IdentitySession isolation per cronjob run —
 * NOT a real Feishu thread. Consumers that route messages to Feishu threads
 * (e.g. the `reply` tool) must exclude thread_ids with this prefix.
 */
export const JOB_THREAD_PREFIX = 'job-';

export interface ParsedJobThreadId {
  jobId: string;
  createdAtHash?: string;
}

export function jobCreatedAtHash(createdAt: string): string {
  return createHash('sha256').update(createdAt).digest('hex').slice(0, 12);
}

export function parseJobThreadId(threadId: string | undefined): ParsedJobThreadId | null {
  if (!threadId?.startsWith(JOB_THREAD_PREFIX)) return null;
  const rest = threadId.slice(JOB_THREAD_PREFIX.length);
  const current = rest.match(/^(.+)-([a-f0-9]{12})-(\d{10,})$/);
  if (current) return { jobId: current[1], createdAtHash: current[2] };
  const legacy = rest.match(/^(.+)-(\d{10,})$/);
  return legacy ? { jobId: legacy[1] } : null;
}

export function parseJobIdFromThreadId(threadId: string | undefined): string | null {
  return parseJobThreadId(threadId)?.jobId ?? null;
}

export interface SchedulerOptions {
  server: Server;
  client: Lark.Client;
  identitySession: IdentitySession;
}

// ─── Retry Logic ────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [30_000, 60_000, 120_000]; // 30s, 60s, 120s

/** Network/transient error codes that warrant a retry. */
const RETRYABLE_NETWORK_ERRORS = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
]);

/** HTTP status codes that warrant a retry. */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);
const PERMANENT_TARGET_HTTP_CODES = new Set([403, 404]);
const PERMANENT_TARGET_API_CODES = new Set([
  99991672, // permission denied / target inaccessible
]);

export function isRetryableError(err: any): boolean {
  // Network-level errors (Node.js syscall errors)
  if (err?.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true;
  if (err?.cause?.code && RETRYABLE_NETWORK_ERRORS.has(err.cause.code)) return true;

  // HTTP status from Feishu SDK (wrapped in response)
  const status = err?.response?.status ?? err?.status ?? err?.cause?.response?.status ?? err?.cause?.status;
  if (status && RETRYABLE_HTTP_CODES.has(status)) return true;

  // Feishu API error codes — permission/param errors are NOT retryable
  const apiCode = Number(
    err?.response?.data?.code ?? err?.data?.code ?? err?.cause?.response?.data?.code ?? err?.cause?.data?.code,
  );
  if (Number.isFinite(apiCode)) {
    // Known non-retryable Feishu codes
    // 99991672 = permission denied, 230001 = param error
    if (apiCode === 99991672 || apiCode === 230001) return false;
    return false;
  }

  // Error message heuristics
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('enotfound') || msg.includes('econnreset')) {
    return true;
  }

  return false;
}

export function isPermanentTargetError(err: any): boolean {
  if (isRetryableError(err)) return false;

  const status = err?.response?.status ?? err?.status ?? err?.cause?.response?.status ?? err?.cause?.status;
  if (PERMANENT_TARGET_HTTP_CODES.has(status)) return true;

  const apiCode = Number(
    err?.response?.data?.code ?? err?.data?.code ?? err?.cause?.response?.data?.code ?? err?.cause?.data?.code,
  );
  return PERMANENT_TARGET_API_CODES.has(apiCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function autoPauseJobForPermanentTargetError(
  jobId: string,
  reason: string,
  opts: { createdAtHash?: string } = {},
): Promise<boolean> {
  const lastError = `${reason} (auto-paused: permanent target error)`;
  let replaced = false;
  const updated = await mutateJob(jobId, (job) => {
    if (opts.createdAtHash && jobCreatedAtHash(job.meta.created_at) !== opts.createdAtHash) {
      replaced = true;
      return false;
    }
    job.meta.status = 'paused';
    job.runtime.last_run_at = new Date().toISOString();
    job.runtime.last_error = lastError;
  });
  if (replaced) {
    console.error(`[scheduler] Job ${jobId} was replaced before reply-failure auto-pause; skipping stale pause`);
    return false;
  }
  return updated !== null;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private server: Server;
  private client: Lark.Client;
  private identitySession: IdentitySession;
  private running = false;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.server = opts.server;
    this.client = opts.client;
    this.identitySession = opts.identitySession;
  }

  /**
   * Start the scheduler: run crash recovery, then begin periodic ticks.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Crash recovery — execute missed jobs once
    await this.recoverMissedJobs();

    // Start periodic scan
    const intervalMs = appConfig.cronScanInterval * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduler] Tick error:', err);
      });
    }, intervalMs);

    console.error(`[scheduler] Started (scan every ${appConfig.cronScanInterval}s)`);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.error('[scheduler] Stopped');
  }

  /**
   * On startup, find active jobs whose next_run_at is in the past
   * and execute them once (most recent missed execution only).
   */
  private async recoverMissedJobs(): Promise<void> {
    const jobs = await listAllJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      if (!job.runtime.next_run_at) continue;

      const nextRun = new Date(job.runtime.next_run_at).getTime();
      if (nextRun < now) {
        console.error(`[scheduler] Recovering missed job: ${job.meta.id}`);
        await this.executeJob(job);
      }
    }
  }

  /**
   * Periodic tick: scan all active jobs and execute due ones.
   * Also piggybacks a cleanup pass over the identity session to drop
   * stale entries so the in-memory map does not grow unboundedly.
   */
  private async tick(): Promise<void> {
    if (this.ticking) {
      console.error('[scheduler] Tick skipped: previous tick still running');
      return;
    }
    this.ticking = true;

    try {
      this.identitySession.cleanup();

      const jobs = await listAllJobs();
      const now = Date.now();

      for (const job of jobs) {
        if (job.meta.status !== 'active') continue;
        if (!job.runtime.next_run_at) continue;

        const nextRun = new Date(job.runtime.next_run_at).getTime();
        if (nextRun <= now) {
          try {
            await this.executeJob(job);
          } catch (err) {
            console.error(`[scheduler] Failed to execute job ${job.meta.id}:`, err);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Execute a single job with retry logic for transient failures.
   *
   * Retry strategy:
   * - Up to 3 retries with delays: 30s, 60s, 120s
   * - Only retries transient errors (network, 5xx, rate-limit)
   * - Permanent errors (permission denied, invalid params) fail immediately
   * - On final failure, records last_error and advances next_run_at
   */
  private async executeJob(job: JobFile): Promise<void> {
    const startTime = Date.now();
    const runKey = this.computeRunKey(job, new Date(startTime));
    let lastErr: any = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const refreshed = await this.refreshRunnableJob(job, attempt);
      if (!refreshed) return;
      if (refreshed !== job) {
        job.meta = refreshed.meta;
        job.runtime = refreshed.runtime;
      }

      try {
        if (job.meta.type === 'message') {
          await this.executeMessageJob(job, runKey);
        } else if (job.meta.type === 'prompt') {
          await this.executePromptJob(job);
        }

        const updated = await this.persistJobRuntime(job, {
          startedAt: new Date(startTime),
          incrementRunCount: true,
          lastError: null,
          autoPause: false,
        });

        if (!updated) {
          console.error(
            `[scheduler] Job ${job.meta.id} delivered, but runtime update was skipped because the job disappeared or was replaced`,
          );
          return;
        }
        if (attempt > 0) {
          console.error(`[scheduler] Job ${job.meta.id} succeeded on retry #${attempt} (run #${job.runtime.run_count})`);
        } else {
          console.error(`[scheduler] Job ${job.meta.id} executed successfully (run #${job.runtime.run_count})`);
        }

        return;
      } catch (err: any) {
        lastErr = err;

        // Check if the error is retryable
        if (!isRetryableError(err) || attempt >= MAX_RETRIES) {
          break; // permanent error or exhausted retries
        }

        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.error(
          `[scheduler] Job ${job.meta.id} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), ` +
          `retrying in ${delay / 1000}s: ${err?.message ?? err}`
        );
        await sleep(delay);
      }
    }

    const autoPause = isPermanentTargetError(lastErr);
    const lastError =
      `${lastErr?.message ?? String(lastErr)}${autoPause ? ' (auto-paused: permanent target error)' : ''}`;
    const updated = await this.persistJobRuntime(job, {
      startedAt: new Date(startTime),
      incrementRunCount: false,
      lastError,
      autoPause,
    });

    const retryNote = isRetryableError(lastErr)
      ? ` (exhausted ${MAX_RETRIES} retries)`
      : ' (non-retryable)';
    const pauseNote = autoPause ? '; auto-paused' : '';
    if (!updated) {
      console.error(
        `[scheduler] Job ${job.meta.id} failed${retryNote}, but runtime update was skipped because the job disappeared or was replaced: ${lastError}`,
      );
      return;
    }
    console.error(`[scheduler] Job ${job.meta.id} failed${retryNote}${pauseNote}: ${job.runtime.last_error}`);
  }

  private computeRunKey(job: JobFile, now: Date): string {
    const fallback = job.runtime.next_run_at ?? now.toISOString();
    const nextRun = new Date(fallback).getTime();
    if (!Number.isFinite(nextRun) || nextRun > now.getTime()) {
      return fallback;
    }
    try {
      return computeLatestDueRun(job.meta.schedule, now);
    } catch {
      return fallback;
    }
  }

  private async refreshRunnableJob(job: JobFile, attempt: number): Promise<JobFile | null> {
    const latest = await readJob(job.meta.id);
    const label = attempt > 0 ? 'retry' : 'execution';
    if (!latest) {
      console.error(`[scheduler] Job ${job.meta.id} was deleted before ${label}; skipping`);
      return null;
    }
    if (latest.meta.created_at !== job.meta.created_at) {
      console.error(`[scheduler] Job ${job.meta.id} was replaced before ${label}; skipping stale run`);
      return null;
    }
    if (latest.meta.status !== 'active') {
      console.error(`[scheduler] Job ${job.meta.id} is ${latest.meta.status} before ${label}; skipping`);
      return null;
    }
    return latest;
  }

  private async persistJobRuntime(
    job: JobFile,
    result: {
      startedAt: Date;
      incrementRunCount: boolean;
      lastError: string | null;
      autoPause: boolean;
    },
  ): Promise<JobFile | null> {
    let replaced = false;
    const updated = await mutateJob(job.meta.id, (latest) => {
      if (latest.meta.created_at !== job.meta.created_at) {
        replaced = true;
        return false;
      }
      latest.runtime.last_run_at = result.startedAt.toISOString();
      latest.runtime.next_run_at = computeNextRun(latest.meta.schedule);
      if (result.incrementRunCount) latest.runtime.run_count += 1;
      latest.runtime.last_error = result.lastError;
      if (result.autoPause) latest.meta.status = 'paused';
    });

    if (replaced) {
      console.error(`[scheduler] Job ${job.meta.id} was replaced during execution; skipping stale runtime update`);
      return null;
    }
    if (updated) {
      job.meta = updated.meta;
      job.runtime = updated.runtime;
    }
    return updated;
  }

  /**
   * message type: send fixed content via Feishu IM API.
   */
  private async executeMessageJob(job: JobFile, runKey: string): Promise<void> {
    const content = job.meta.content ?? '';
    const msgType = job.meta.msg_type ?? 'text';
    const uuid = createHash('sha256')
      .update(`scheduler:${job.meta.id}:${runKey}`)
      .digest('hex')
      .slice(0, 32);

    await feishuApiCall('scheduler.message.create', () =>
      this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: job.meta.target_chat_id,
          content: JSON.stringify(msgType === 'text' ? { text: content } : { content }),
          msg_type: msgType,
          uuid,
        },
      }),
      { attempts: 1, retryTimeout: false },
    );
  }

  /**
   * prompt type: inject prompt into Codex's channel via MCP notification.
   *
   * Each execution runs under a unique thread_id so its IdentitySession entry
   * does not clobber concurrent inbound human messages in the same chat.
   */
  private async executePromptJob(job: JobFile): Promise<void> {
    const jobThreadId = `${JOB_THREAD_PREFIX}${job.meta.id}-${jobCreatedAtHash(job.meta.created_at)}-${Date.now()}`;

    // Bind the job owner as caller so tools invoked from this Codex turn
    // (e.g. save_memory, list_jobs) resolve to the job creator, not to any
    // human who happened to send a message to the same chat.
    this.identitySession.setCaller(job.meta.target_chat_id, jobThreadId, job.meta.created_by);

    const promptContent = cronJobPrompt(
      job.meta.name,
      job.meta.target_chat_id,
      job.meta.prompt ?? ''
    );

    try {
      await this.server.notification({
        method: 'notifications/Codex/channel',
        params: {
          content: promptContent,
          meta: {
            chat_id: job.meta.target_chat_id,
            thread_id: jobThreadId,
            source: 'cronjob',
            job_id: job.meta.id,
            job_name: job.meta.name,
            ...(job.meta.model ? { model: job.meta.model } : {}),
          },
        },
      });
    } catch (err: any) {
      const wrapped = new Error(
        `[LARK_DEFER] CronJob prompt delivery failed before Codex accepted the turn: ${err?.message ?? err}`,
      );
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }
}
