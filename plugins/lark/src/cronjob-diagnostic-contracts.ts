export type CronJobRunStatus = 'started' | 'success' | 'failed';
export type CronJobStageStatus = 'running' | 'success' | 'failed';

export interface CronJobDiagnosticStage {
  name: string;
  status: CronJobStageStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  error?: string;
}

export interface CronJobDiagnosticProgress {
  at: string;
  content: string;
  bytes: number;
}

export interface CronJobDiagnosticSnapshot {
  run_id: string;
  job_id: string;
  job_name: string;
  schedule: string;
  timezone: string;
  timeout_ms: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  status: CronJobRunStatus;
  model?: string;
  last_completed_stage?: string;
  current_stage?: string;
  current_stage_elapsed_ms?: number;
  progress?: CronJobDiagnosticProgress;
  stages: CronJobDiagnosticStage[];
  error?: string;
  stdout_tail?: string;
  stderr_tail?: string;
}
