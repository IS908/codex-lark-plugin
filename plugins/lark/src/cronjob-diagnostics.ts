import type { JobFile } from './job-contracts.js';
import { jobTimezone } from './job-timezone.js';
import type {
  CronJobDiagnosticProgress,
  CronJobDiagnosticSnapshot,
  CronJobDiagnosticStage,
  CronJobRunStatus,
  CronJobStageStatus,
} from './cronjob-diagnostic-contracts.js';
export type {
  CronJobDiagnosticProgress,
  CronJobDiagnosticSnapshot,
  CronJobDiagnosticStage,
  CronJobRunStatus,
  CronJobStageStatus,
} from './cronjob-diagnostic-contracts.js';

interface MutableStage extends CronJobDiagnosticStage {
  startedMs: number;
}

const TEXT_LIMIT = 1000;
const TAIL_LIMIT = 1200;

export function sanitizeDiagnosticText(value: unknown, maxLen = TEXT_LIMIT): string {
  const raw = String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '');
  const sanitized = raw
    .replace(/\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{12,}\b/gi, '[redacted-token]')
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/((?:app|tenant)_access_token|authorization|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[redacted]')
    .trim();
  return sanitized.length > maxLen ? `${sanitized.slice(0, Math.max(0, maxLen - 3))}...` : sanitized;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizeStageName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function inferProgressStage(content: string): string | undefined {
  const explicit = content.match(/\b(?:stage|current_stage)\s*[:=]\s*([a-z][a-z0-9_-]{1,48})\b/i);
  if (explicit?.[1]) return normalizeStageName(explicit[1]);

  const lower = content.toLowerCase();
  if (/position|portfolio|holding|持仓|仓位/.test(lower)) return 'fetch_positions';
  if (/quote|price|ticker|行情|报价|价格|股价/.test(lower)) return 'fetch_quotes';
  if (/option|chain|greek|iv|期权|期权链/.test(lower)) return 'fetch_options';
  if (/news|filing|sec|新闻|公告|财报/.test(lower)) return 'fetch_news';
  if (/report|summary|write|draft|render|报告|总结|撰写|生成/.test(lower)) return 'generate_report';
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CronJobRunDiagnostics {
  private readonly startedMs: number;
  private endedMs: number | null = null;
  private status: CronJobRunStatus = 'started';
  private readonly stages: MutableStage[] = [];
  private lastCompletedStage: string | undefined;
  private progressStage: { name: string; atMs: number } | undefined;
  private progress: CronJobDiagnosticProgress | undefined;
  private error: string | undefined;
  private stdoutTail: string | undefined;
  private stderrTail: string | undefined;

  constructor(
    private readonly input: {
      job: JobFile;
      runId: string;
      timeoutMs: number;
      startedMs?: number;
    },
  ) {
    this.startedMs = input.startedMs ?? Date.now();
  }

  startStage(name: string, nowMs = Date.now()): void {
    this.stages.push({
      name,
      status: 'running',
      started_at: iso(nowMs),
      startedMs: nowMs,
    });
  }

  completeStage(name?: string, nowMs = Date.now()): void {
    const stage = this.findRunningStage(name);
    if (!stage) return;
    stage.status = 'success';
    stage.ended_at = iso(nowMs);
    stage.duration_ms = Math.max(0, nowMs - stage.startedMs);
    this.lastCompletedStage = stage.name;
    if (this.progressStage?.name === stage.name) this.progressStage = undefined;
  }

  failStage(name: string | undefined, err: unknown, nowMs = Date.now()): void {
    const stage = this.findRunningStage(name) ?? this.startAndReturnStage(name ?? 'unknown', nowMs);
    stage.status = 'failed';
    stage.ended_at = iso(nowMs);
    stage.duration_ms = Math.max(0, nowMs - stage.startedMs);
    stage.error = sanitizeDiagnosticText(errorMessage(err), 500);
    this.attachError(err);
  }

  recordProgress(content: string, timestampMs = Date.now(), bytes = Buffer.byteLength(content, 'utf8')): void {
    const sanitized = sanitizeDiagnosticText(content, 500);
    if (!sanitized) return;
    this.progress = {
      at: iso(timestampMs),
      content: sanitized,
      bytes,
    };
    const stage = inferProgressStage(sanitized);
    if (stage) {
      this.progressStage = { name: stage, atMs: timestampMs };
    }
    console.error(
      `[scheduler][cronjob-progress] job=${this.input.job.meta.id} run=${this.input.runId} ` +
        `stage=${stage ?? this.currentRunningStage()?.name ?? 'codex_exec'} bytes=${bytes}`,
    );
  }

  finish(status: CronJobRunStatus, err?: unknown, nowMs = Date.now()): CronJobDiagnosticSnapshot {
    this.status = status;
    this.endedMs = nowMs;
    if (err !== undefined) this.attachError(err);
    return this.snapshot();
  }

  snapshot(statusOverride?: CronJobRunStatus): CronJobDiagnosticSnapshot {
    const nowMs = this.endedMs ?? Date.now();
    const current = this.currentRunningStage();
    const currentStage = this.progressStage?.name ?? current?.name;
    const currentStartedMs = this.progressStage?.atMs ?? current?.startedMs;
    const job = this.input.job;
    return {
      run_id: this.input.runId,
      job_id: job.meta.id,
      job_name: job.meta.name,
      schedule: job.meta.schedule_human || job.meta.schedule,
      timezone: jobTimezone(job.meta),
      timeout_ms: this.input.timeoutMs,
      started_at: iso(this.startedMs),
      ...(this.endedMs !== null ? { ended_at: iso(this.endedMs) } : {}),
      duration_ms: Math.max(0, nowMs - this.startedMs),
      status: statusOverride ?? this.status,
      ...(job.meta.model ? { model: job.meta.model } : {}),
      ...(this.lastCompletedStage ? { last_completed_stage: this.lastCompletedStage } : {}),
      ...(currentStage ? { current_stage: currentStage } : {}),
      ...(currentStartedMs !== undefined ? { current_stage_elapsed_ms: Math.max(0, nowMs - currentStartedMs) } : {}),
      ...(this.progress ? { progress: this.progress } : {}),
      stages: this.stages.map(({ startedMs, ...stage }) => stage),
      ...(this.error ? { error: this.error } : {}),
      ...(this.stdoutTail ? { stdout_tail: this.stdoutTail } : {}),
      ...(this.stderrTail ? { stderr_tail: this.stderrTail } : {}),
    };
  }

  logSnapshot(status: CronJobRunStatus, err?: unknown): CronJobDiagnosticSnapshot {
    const snapshot = this.finish(status, err);
    console.error(`[scheduler][cronjob-diagnostics] ${JSON.stringify(snapshot)}`);
    return snapshot;
  }

  private currentRunningStage(): MutableStage | undefined {
    for (let i = this.stages.length - 1; i >= 0; i--) {
      if (this.stages[i].status === 'running') return this.stages[i];
    }
    return undefined;
  }

  private findRunningStage(name?: string): MutableStage | undefined {
    for (let i = this.stages.length - 1; i >= 0; i--) {
      const stage = this.stages[i];
      if (stage.status === 'running' && (!name || stage.name === name)) return stage;
    }
    return undefined;
  }

  private startAndReturnStage(name: string, nowMs: number): MutableStage {
    const stage: MutableStage = {
      name,
      status: 'running',
      started_at: iso(nowMs),
      startedMs: nowMs,
    };
    this.stages.push(stage);
    return stage;
  }

  private attachError(err: unknown): void {
    this.error = sanitizeDiagnosticText(errorMessage(err), 500);
    const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
    const stdoutTail = sanitizeDiagnosticText(record.stdoutTail, TAIL_LIMIT);
    const stderrTail = sanitizeDiagnosticText(record.stderrTail, TAIL_LIMIT);
    if (stdoutTail) this.stdoutTail = stdoutTail;
    if (stderrTail) this.stderrTail = stderrTail;
  }
}

export function formatCronJobDiagnostics(snapshot: CronJobDiagnosticSnapshot | null | undefined): string {
  if (!snapshot) return '';
  const lines = [
    'Diagnostics:',
    `run_id: ${snapshot.run_id}`,
    `job_id: ${snapshot.job_id}`,
    `schedule: ${snapshot.schedule}`,
    `timezone: ${snapshot.timezone}`,
    ...(snapshot.model ? [`model: ${snapshot.model}`] : []),
    `timeout_ms: ${snapshot.timeout_ms}`,
    `started_at: ${snapshot.started_at}`,
    ...(snapshot.ended_at ? [`ended_at: ${snapshot.ended_at}`] : []),
    `duration_ms: ${snapshot.duration_ms ?? 0}`,
    `status: ${snapshot.status}`,
    `last_completed_stage: ${snapshot.last_completed_stage ?? '(none)'}`,
    `current_stage: ${snapshot.current_stage ?? '(unknown)'}`,
    `current_stage_elapsed_ms: ${snapshot.current_stage_elapsed_ms ?? 0}`,
  ];

  if (snapshot.progress) {
    lines.push(`last_progress_at: ${snapshot.progress.at}`);
    lines.push(`last_progress: ${snapshot.progress.content}`);
  }
  if (snapshot.stages.length > 0) {
    lines.push('stages:');
    for (const stage of snapshot.stages) {
      lines.push(
        `- ${stage.name}: ${stage.status} duration_ms=${stage.duration_ms ?? 0}` +
          (stage.error ? ` error=${stage.error}` : ''),
      );
    }
  }
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  if (snapshot.stdout_tail) lines.push(`stdout_tail: ${snapshot.stdout_tail}`);
  if (snapshot.stderr_tail) lines.push(`stderr_tail: ${snapshot.stderr_tail}`);

  return lines.join('\n');
}
