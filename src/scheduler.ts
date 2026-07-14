/**
 * Job Scheduler — periodic scan + execution + crash recovery.
 *
 * Runs as a setInterval in the MCP server process. On each tick,
 * reads all active jobs and executes any whose next_run_at has passed.
 * On startup, recovers missed jobs (at most one execution per job).
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { appConfig } from './config.js';
import { cronJobPrompt } from './prompts.js';
import type { IdentitySession } from './identity-session.js';
import type { BotMessageTracker } from './message-trackers.js';
import {
  listAllJobs,
  readJob,
  mutateJob,
  computeNextRun,
  computeLatestDueRun,
  jobTimezone,
  type JobFile,
} from './job-store.js';
import { feishuApiCall } from './feishu-retry.js';
import { logSafeError } from './safe-log.js';
import {
  createOpenApiLarkTransport,
} from './lark-transport.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import {
  CronJobRunDiagnostics,
  formatCronJobDiagnostics,
  type CronJobDiagnosticSnapshot,
} from './cronjob-diagnostics.js';

/**
 * Prefix for synthetic `thread_id` values used by cronjob prompt executions.
 * Used only for IdentitySession isolation per cronjob run —
 * NOT a real Feishu thread. Consumers that route messages to Feishu threads
 * (e.g. the `reply` tool) must exclude thread_ids with this prefix.
 */
export const JOB_THREAD_PREFIX = 'job-';

export interface ParsedJobThreadId {
  jobId: string;
  createdAtHash?: string;
  runId?: string;
}

export function jobCreatedAtHash(createdAt: string): string {
  return createHash('sha256').update(createdAt).digest('hex').slice(0, 12);
}

export function parseJobThreadId(threadId: string | undefined): ParsedJobThreadId | null {
  if (!threadId?.startsWith(JOB_THREAD_PREFIX)) return null;
  const rest = threadId.slice(JOB_THREAD_PREFIX.length);
  const current = rest.match(/^(.+)-([a-f0-9]{12})-(\d{10,})$/);
  if (current) return { jobId: current[1], createdAtHash: current[2], runId: current[3] };
  const legacy = rest.match(/^(.+)-(\d{10,})$/);
  return legacy ? { jobId: legacy[1] } : null;
}

export function parseJobIdFromThreadId(threadId: string | undefined): string | null {
  return parseJobThreadId(threadId)?.jobId ?? null;
}

export interface SchedulerOptions {
  client: Lark.Client;
  transport?: LarkTransport;
  identitySession: IdentitySession;
  botMessageTracker?: BotMessageTracker;
  promptRunner?: PromptJobRunner;
}

export interface PromptJobRunnerInput {
  job: JobFile;
  jobThreadId: string;
  runId: string;
  promptContent: string;
  diagnostics: CronJobRunDiagnostics;
}

export interface PromptJobRunnerResult {
  report: string;
}

export type PromptJobRunner = (input: PromptJobRunnerInput) => Promise<PromptJobRunnerResult>;

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

interface JobExecutionOutcome {
  runStatus: 'started' | 'success' | 'failed';
  outputStatus: 'empty' | 'generated';
  deliveryStatus: 'pending' | 'sent' | 'failed';
  report: string | null;
  reportType: string | null;
  deliveryError: string | null;
  lastError: string | null;
  autoPause: boolean;
  completed: boolean;
  diagnostics?: CronJobDiagnosticSnapshot | null;
}

interface CronJobReportDeliveryFailure extends Error {
  cronJobReport?: {
    report: string;
    reportType: string;
    deliveryError: string;
    diagnostics?: CronJobDiagnosticSnapshot | null;
  };
}

function outputStatusFor(text: string | null | undefined): 'empty' | 'generated' {
  return text?.trim() ? 'generated' : 'empty';
}

function buildCronJobErrorReport(
  job: JobFile,
  reason: string,
  diagnostics?: CronJobDiagnosticSnapshot | null,
): string {
  const base = [
    `CronJob "${job.meta.name}" failed before a complete report could be delivered.`,
    '',
    `Job ID: ${job.meta.id}`,
    `Reason: ${reason}`,
  ];
  const diagnosticText = formatCronJobDiagnostics(diagnostics);
  return diagnosticText ? [...base, '', diagnosticText].join('\n') : base.join('\n');
}

function buildCronJobReportDeliveryFailure(
  report: string,
  deliveryErr: unknown,
  diagnostics?: CronJobDiagnosticSnapshot | null,
): CronJobReportDeliveryFailure {
  const deliveryError = deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr);
  const err = new Error(`CronJob error report delivery failed: ${deliveryError}`) as CronJobReportDeliveryFailure & {
    cause?: unknown;
  };
  err.cause = deliveryErr;
  err.cronJobReport = {
    report,
    reportType: 'error_report',
    deliveryError,
    diagnostics,
  };
  return err;
}

function finalizeStoredDiagnostics(
  diagnostics: CronJobDiagnosticSnapshot | null | undefined,
  status: 'success' | 'failed',
  opts: { currentStage?: string } = {},
): CronJobDiagnosticSnapshot | null {
  if (!diagnostics) return null;
  const endedAt = new Date();
  const startedMs = new Date(diagnostics.started_at).getTime();
  const durationMs = Number.isFinite(startedMs) ? Math.max(0, endedAt.getTime() - startedMs) : diagnostics.duration_ms;
  return {
    ...diagnostics,
    status,
    ended_at: endedAt.toISOString(),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(opts.currentStage && !diagnostics.current_stage ? { current_stage: opts.currentStage } : {}),
  };
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

export async function recordCronJobReportDelivery(
  threadId: string | undefined,
  input: {
    runStatus: 'success' | 'failed';
    deliveryStatus: 'sent' | 'failed';
    report: string;
    reportType?: string;
    runError?: string | null;
    deliveryError?: string | null;
  },
): Promise<boolean> {
  const parsed = parseJobThreadId(threadId);
  if (!parsed?.createdAtHash || !parsed.runId) return false;

  let replaced = false;
  let staleRun = false;
  const updated = await mutateJob(parsed.jobId, (job) => {
    if (jobCreatedAtHash(job.meta.created_at) !== parsed.createdAtHash) {
      replaced = true;
      return false;
    }
    if (job.runtime.run_id && job.runtime.run_id !== parsed.runId) {
      staleRun = true;
      return false;
    }
    job.runtime.run_id = parsed.runId;
    job.runtime.run_status = input.runStatus;
    job.runtime.output_status = outputStatusFor(input.report);
    job.runtime.delivery_status = input.deliveryStatus;
    job.runtime.report = input.report;
    job.runtime.report_type = input.reportType ?? (input.runStatus === 'success' ? 'job_result' : 'error_report');
    job.runtime.delivery_error =
      input.deliveryStatus === 'sent'
        ? null
        : input.deliveryError ?? input.runError ?? 'CronJob report delivery failed.';
    job.runtime.last_error = input.runStatus === 'success'
      ? null
      : job.runtime.last_error?.includes('auto-paused')
        ? job.runtime.last_error
        : input.runError ?? job.runtime.delivery_error ?? 'CronJob run failed.';
    job.runtime.diagnostics = finalizeStoredDiagnostics(
      job.runtime.diagnostics,
      input.runStatus,
      input.runStatus === 'failed' ? { currentStage: 'await_lark_reply' } : {},
    );
  });

  if (replaced) {
    console.error(`[scheduler] Cronjob report delivery for ${parsed.jobId} ignored because the job was replaced`);
    return false;
  }
  if (staleRun) {
    console.error(`[scheduler] Cronjob report delivery for ${parsed.jobId} ignored because run ${parsed.runId} is stale`);
    return false;
  }
  return updated !== null;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private client: Lark.Client;
  private transport: LarkTransport;
  private identitySession: IdentitySession;
  private botMessageTracker?: BotMessageTracker;
  private promptRunner?: PromptJobRunner;
  private running = false;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.client = opts.client;
    this.transport = opts.transport ?? createOpenApiLarkTransport(opts.client, {
      outboundMessageContextCache: opts.botMessageTracker,
    });
    this.identitySession = opts.identitySession;
    this.botMessageTracker = opts.botMessageTracker;
    this.promptRunner = opts.promptRunner;
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
        logSafeError('[scheduler] Tick error:', err);
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
            logSafeError(`[scheduler] Failed to execute job ${job.meta.id}:`, err);
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
    const startedAt = new Date(startTime);
    const runId = String(startTime);
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
        let outcome: JobExecutionOutcome;
        if (job.meta.type === 'message') {
          await this.executeMessageJob(job, runKey);
          const report = job.meta.content ?? '';
          outcome = {
            runStatus: 'success',
            outputStatus: outputStatusFor(report),
            deliveryStatus: 'sent',
            report,
            reportType: 'job_result',
            deliveryError: null,
            lastError: null,
            autoPause: false,
            completed: true,
          };
        } else if (job.meta.type === 'prompt') {
          outcome = await this.executePromptJob(job, runId);
        } else {
          throw new Error(`unsupported job type: ${(job.meta as { type?: unknown }).type}`);
        }

        const updated = await this.persistJobRuntime(job, {
          startedAt,
          incrementRunCount: true,
          runId,
          outcome,
        });

        if (!updated) {
          console.error(
            `[scheduler] Job ${job.meta.id} delivered, but runtime update was skipped because the job disappeared or was replaced`,
          );
          return;
        }
        const persistedRunStatus = updated.runtime.run_status ?? outcome.runStatus;
        const persistedCompleted = updated.runtime.delivery_status !== 'pending' && persistedRunStatus !== 'started';
        if (persistedRunStatus === 'failed') {
          console.error(`[scheduler] Job ${job.meta.id} recorded failed run (run #${updated.runtime.run_count}): ${updated.runtime.last_error}`);
        } else if (attempt > 0) {
          console.error(`[scheduler] Job ${job.meta.id} ${persistedCompleted ? 'succeeded' : 'started'} on retry #${attempt} (run #${updated.runtime.run_count})`);
        } else {
          console.error(`[scheduler] Job ${job.meta.id} ${persistedCompleted ? 'executed successfully' : 'started'} (run #${updated.runtime.run_count})`);
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
    const cronJobReport = (lastErr as CronJobReportDeliveryFailure | null)?.cronJobReport;
    const updated = await this.persistJobRuntime(job, {
      startedAt,
      incrementRunCount: false,
      runId,
      outcome: {
        runStatus: 'failed',
        outputStatus: cronJobReport ? 'generated' : outputStatusFor(job.meta.type === 'message' ? job.meta.content : null),
        deliveryStatus: 'failed',
        report: cronJobReport?.report ?? (job.meta.type === 'message' ? job.meta.content ?? null : null),
        reportType: cronJobReport?.reportType ?? 'error_report',
        deliveryError: cronJobReport?.deliveryError ?? lastError,
        lastError,
        autoPause,
        completed: true,
        diagnostics: cronJobReport?.diagnostics ?? null,
      },
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
      return computeLatestDueRun(job.meta.schedule, now, jobTimezone(job.meta));
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
      runId: string;
      outcome: JobExecutionOutcome;
    },
  ): Promise<JobFile | null> {
    let replaced = false;
    const updated = await mutateJob(job.meta.id, (latest) => {
      if (latest.meta.created_at !== job.meta.created_at) {
        replaced = true;
        return false;
      }
      latest.runtime.last_run_at = result.startedAt.toISOString();
      latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, jobTimezone(latest.meta));
      if (result.incrementRunCount) latest.runtime.run_count += 1;
      const alreadyRecordedDelivery =
        !result.outcome.completed &&
        latest.runtime.run_id === result.runId &&
        (latest.runtime.delivery_status === 'sent' || latest.runtime.delivery_status === 'failed');
      if (!alreadyRecordedDelivery) {
        latest.runtime.last_error = result.outcome.lastError;
        latest.runtime.run_id = result.runId;
        latest.runtime.run_status = result.outcome.runStatus;
        latest.runtime.output_status = result.outcome.outputStatus;
        latest.runtime.delivery_status = result.outcome.deliveryStatus;
        latest.runtime.report = result.outcome.report;
        latest.runtime.report_type = result.outcome.reportType;
        latest.runtime.delivery_error = result.outcome.deliveryError;
        latest.runtime.diagnostics = result.outcome.diagnostics ?? null;
      }
      if (result.outcome.autoPause) latest.meta.status = 'paused';
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

    const sent = await this.transport.sendMessage({
      chatId: job.meta.target_chat_id,
      input: {
        raw: {
          msgType,
          content: JSON.stringify(msgType === 'text' ? { text: content } : { content }),
        },
      },
      uuid,
      retry: { attempts: 1, retryTimeout: false },
    });
    const messageId = sent.messageId;
    if (messageId) {
      this.botMessageTracker?.add(messageId, { chatId: job.meta.target_chat_id });
    }
  }

  /**
   * prompt type: run Codex under a synthetic per-run thread.
   *
   * Each execution runs under a unique thread_id so its IdentitySession entry
   * does not clobber concurrent inbound human messages in the same chat.
   * Prompt jobs use the same codex exec delivery path as live chat turns.
   */
  private async executePromptJob(job: JobFile, runId: string): Promise<JobExecutionOutcome> {
    const diagnostics = new CronJobRunDiagnostics({
      job,
      runId,
      timeoutMs: appConfig.codexExecTimeoutMs,
    });
    const jobThreadId = `${JOB_THREAD_PREFIX}${job.meta.id}-${jobCreatedAtHash(job.meta.created_at)}-${runId}`;

    // Bind the job owner as caller so tools invoked from this Codex turn
    // (e.g. save_memory, list_jobs) resolve to the job creator, not to any
    // human who happened to send a message to the same chat.
    this.identitySession.setCaller(job.meta.target_chat_id, jobThreadId, job.meta.created_by);
    this.identitySession.beginChannelTurn(job.meta.target_chat_id, jobThreadId, appConfig.replyObligationTimeoutMs);

    diagnostics.startStage('prepare_prompt');
    const promptContent = cronJobPrompt(
      job.meta.name,
      job.meta.target_chat_id,
      job.meta.prompt ?? ''
    );
    diagnostics.completeStage('prepare_prompt');

    try {
      diagnostics.startStage('codex_exec');
      if (!this.promptRunner) {
        throw new Error('CronJob prompt runner is not configured.');
      }
      const result = await this.promptRunner({
        job,
        jobThreadId,
        runId,
        promptContent,
        diagnostics,
      });
      diagnostics.completeStage('codex_exec');
      if (!result.report.trim()) {
        throw new Error('CronJob prompt produced no visible report.');
      }
      const snapshot = diagnostics.logSnapshot('success');
      return {
        runStatus: 'success',
        outputStatus: 'generated',
        deliveryStatus: 'sent',
        report: result.report,
        reportType: 'job_result',
        deliveryError: null,
        lastError: null,
        autoPause: false,
        completed: true,
        diagnostics: snapshot,
      };
    } catch (err: any) {
      diagnostics.failStage(undefined, err);
      const reportSnapshot = diagnostics.snapshot('failed');
      const lastError = `[LARK_DEFER] CronJob prompt execution failed before a complete report could be delivered: ${err?.message ?? err}`;
      const report = buildCronJobErrorReport(job, lastError, reportSnapshot);
      try {
        diagnostics.startStage('send_lark_error_report');
        await this.transport.sendMessage({
          chatId: job.meta.target_chat_id,
          input: { text: report },
          retry: { attempts: 1, retryTimeout: false },
        });
        diagnostics.completeStage('send_lark_error_report');
        const finalSnapshot = diagnostics.logSnapshot('failed', err);
        return {
          runStatus: 'failed',
          outputStatus: 'generated',
          deliveryStatus: 'sent',
          report,
          reportType: 'error_report',
          deliveryError: null,
          lastError,
          autoPause: false,
          completed: true,
          diagnostics: finalSnapshot,
        };
      } catch (deliveryErr: any) {
        diagnostics.failStage('send_lark_error_report', deliveryErr);
        throw buildCronJobReportDeliveryFailure(report, deliveryErr, diagnostics.logSnapshot('failed', deliveryErr));
      }
    } finally {
      this.identitySession.endChannelTurn(job.meta.target_chat_id, jobThreadId);
    }
  }
}
