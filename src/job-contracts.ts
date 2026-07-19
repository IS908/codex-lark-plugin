import type { CronJobDiagnosticSnapshot } from './cronjob-diagnostic-contracts.js';

export interface JobMeta {
  id: string;
  /** Monotonic semantic-definition revision. Runtime projection never changes it. */
  revision: number;
  name: string;
  type: 'prompt' | 'message';
  schedule: string;
  schedule_human: string;
  /** IANA timezone used to evaluate this job's cron expression. */
  timezone?: string;
  prompt?: string;
  content?: string;
  msg_type?: string;
  /** Chat that receives the job output. Used by scheduler delivery + list_jobs visibility filter. */
  target_chat_id: string;
  /** Where the job was created (debug/audit). For legacy jobs, backfilled from target_chat_id. */
  origin_chat_id: string;
  /** Optional model override for prompt-type jobs. Passed in notification meta so Codex can dispatch with a supported model id. */
  model?: string;
  status: 'active' | 'paused';
  created_by: string;
  created_at: string;
}

export interface JobRuntime {
  last_run_at: string | null;
  next_run_at: string;
  run_count: number;
  last_error: string | null;
  /** Latest scheduler run id, derived from the scheduler fire timestamp. */
  run_id?: string | null;
  /** Latest run lifecycle status. */
  run_status?: 'started' | 'success' | 'failed' | null;
  /** Whether the latest run produced user-visible output/report text. */
  output_status?: 'empty' | 'generated' | null;
  /** Latest Feishu delivery status for the generated output/report. */
  delivery_status?: 'pending' | 'sent' | 'failed' | null;
  /** Latest report or error-report payload for operator debugging. */
  report?: string | null;
  /** Latest report category, e.g. job_result or error_report. */
  report_type?: string | null;
  /** Latest delivery error, kept separate from execution last_error. */
  delivery_error?: string | null;
  /** Latest structured cronjob execution diagnostics. */
  diagnostics?: CronJobDiagnosticSnapshot | null;
}

export interface JobFile {
  meta: JobMeta;
  runtime: JobRuntime;
}
