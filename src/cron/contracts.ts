import type { CronJobDiagnosticSnapshot } from '../cronjob-diagnostic-contracts.js';

export const CRON_RUN_INPUT_VERSION = 1;
export const CRON_RUN_STATE_VERSION = 1;

export interface CronRunJobSnapshot {
  id: string;
  createdAt: string;
  revision: number;
  name: string;
  type: 'prompt' | 'message';
  schedule: string;
  scheduleHuman: string;
  timezone: string;
  scheduledOccurrence?: string;
  prompt?: string;
  content?: string;
  messageType?: string;
  model?: string;
  targetChatId: string;
  originChatId: string;
  createdBy: string;
}

export interface CronRunInput {
  schemaVersion: 1;
  job: CronRunJobSnapshot;
}

export interface CronPromptExecutionInput {
  runId: string;
  job: CronRunJobSnapshot & { type: 'prompt'; prompt: string };
}

export interface CronPromptExecution {
  report: string;
  runStatus: 'success' | 'failed';
  failureReason: string | null;
  diagnostics: CronJobDiagnosticSnapshot;
  /** Set only when the executor guarantees that external execution never started. */
  retrySafe?: boolean;
}

/**
 * Implementations must return a failed result once execution may have started.
 * Throwing is reserved for retry-safe failures known to precede external work.
 */
export type CronPromptExecutor = (
  input: CronPromptExecutionInput,
  signal: AbortSignal,
) => Promise<CronPromptExecution>;

export interface CronMessageExecution {
  content: string;
  messageType: string;
  runStatus: 'success' | 'failed';
  failureReason: string | null;
}

export type CronRunCommit =
  | {
      kind: 'prompt';
      report: string;
      runStatus: 'success' | 'failed';
      reportType: 'job_result' | 'error_report';
      failureReason: string | null;
      diagnostics: CronJobDiagnosticSnapshot;
    }
  | {
      kind: 'message';
      content: string;
      messageType: string;
      runStatus: 'success' | 'failed';
      failureReason: string | null;
    };

export interface CronRunState {
  schemaVersion: 1;
  phase: 'admitted' | 'completed';
  commit?: CronRunCommit;
}

export type CronTerminalPayload =
  | {
      schemaVersion: 1;
      kind: 'report';
      jobId: string;
      jobCreatedAt: string;
      jobRevision: number;
      report: string;
      reportType: 'job_result' | 'error_report';
      runStatus: 'success' | 'failed';
      failureReason: string | null;
      diagnostics: CronJobDiagnosticSnapshot;
    }
  | {
      schemaVersion: 1;
      kind: 'message';
      jobId: string;
      jobCreatedAt: string;
      jobRevision: number;
      content: string;
      messageType: string;
      runStatus: 'success' | 'failed';
      failureReason: string | null;
    };

export function parseCronRunInput(
  value: unknown,
  version: number,
  expectedType?: CronRunJobSnapshot['type'],
): CronRunInput {
  if (version !== CRON_RUN_INPUT_VERSION) {
    throw new Error(`Unsupported Cron Run input version: ${version}`);
  }
  const root = record(value, 'Cron Run input');
  if (root.schemaVersion !== CRON_RUN_INPUT_VERSION) {
    throw new Error('Cron Run input schemaVersion must be 1.');
  }
  const rawJob = record(root.job, 'Cron Run job');
  const type = literal(rawJob.type, ['prompt', 'message'] as const, 'job.type');
  if (expectedType && type !== expectedType) {
    throw new Error(`Cron Run job type must be ${expectedType}.`);
  }
  const job: CronRunJobSnapshot = {
    id: nonEmpty(rawJob.id, 'job.id'),
    createdAt: isoTimestamp(rawJob.createdAt, 'job.createdAt'),
    revision: positiveInteger(rawJob.revision, 'job.revision'),
    name: nonEmpty(rawJob.name, 'job.name'),
    type,
    schedule: nonEmpty(rawJob.schedule, 'job.schedule'),
    scheduleHuman: stringValue(rawJob.scheduleHuman, 'job.scheduleHuman'),
    timezone: nonEmpty(rawJob.timezone, 'job.timezone'),
    ...(rawJob.scheduledOccurrence !== undefined
      ? { scheduledOccurrence: isoTimestamp(rawJob.scheduledOccurrence, 'job.scheduledOccurrence') }
      : {}),
    ...(rawJob.prompt !== undefined ? { prompt: stringValue(rawJob.prompt, 'job.prompt') } : {}),
    ...(rawJob.content !== undefined ? { content: stringValue(rawJob.content, 'job.content') } : {}),
    ...(rawJob.messageType !== undefined
      ? { messageType: nonEmpty(rawJob.messageType, 'job.messageType') }
      : {}),
    ...(rawJob.model !== undefined ? { model: nonEmpty(rawJob.model, 'job.model') } : {}),
    targetChatId: nonEmpty(rawJob.targetChatId, 'job.targetChatId'),
    originChatId: nonEmpty(rawJob.originChatId, 'job.originChatId'),
    createdBy: nonEmpty(rawJob.createdBy, 'job.createdBy'),
  };
  if (type === 'prompt' && !job.prompt?.trim()) throw new Error('Cron prompt must not be empty.');
  if (type === 'message' && !job.content?.trim()) throw new Error('Cron message content must not be empty.');
  return { schemaVersion: 1, job };
}

export function parseCronRunState(value: unknown, version: number): CronRunState {
  if (version !== CRON_RUN_STATE_VERSION) {
    throw new Error(`Unsupported Cron Run state version: ${version}`);
  }
  const root = record(value, 'Cron Run state');
  if (root.schemaVersion !== CRON_RUN_STATE_VERSION) {
    throw new Error('Cron Run state schemaVersion must be 1.');
  }
  const phase = literal(root.phase, ['admitted', 'completed'] as const, 'state.phase');
  if (phase === 'admitted') {
    if (root.commit !== undefined) throw new Error('Admitted Cron Run state must not contain a commit.');
    return { schemaVersion: 1, phase };
  }
  const rawCommit = record(root.commit, 'Cron Run commit');
  const kind = literal(rawCommit.kind, ['prompt', 'message'] as const, 'commit.kind');
  if (kind === 'message') {
    const runStatus = literal(rawCommit.runStatus, ['success', 'failed'] as const, 'commit.runStatus');
    const failureReason = rawCommit.failureReason === null
      ? null
      : nonEmpty(rawCommit.failureReason, 'commit.failureReason');
    if ((runStatus === 'failed') !== Boolean(failureReason)) {
      throw new Error('Cron message commit status and failureReason are inconsistent.');
    }
    return {
      schemaVersion: 1,
      phase,
      commit: {
        kind,
        content: nonEmpty(rawCommit.content, 'commit.content'),
        messageType: nonEmpty(rawCommit.messageType, 'commit.messageType'),
        runStatus,
        failureReason,
      },
    };
  }
  const runStatus = literal(rawCommit.runStatus, ['success', 'failed'] as const, 'commit.runStatus');
  const reportType = literal(rawCommit.reportType, ['job_result', 'error_report'] as const, 'commit.reportType');
  if (
    (runStatus === 'success' && reportType !== 'job_result')
    || (runStatus === 'failed' && reportType !== 'error_report')
  ) throw new Error('Cron Run commit status and report type are inconsistent.');
  const failureReason = rawCommit.failureReason === null
    ? null
    : nonEmpty(rawCommit.failureReason, 'commit.failureReason');
  if (runStatus === 'failed' && !failureReason) {
    throw new Error('Failed Cron Run commit requires failureReason.');
  }
  if (runStatus === 'success' && failureReason) {
    throw new Error('Successful Cron Run commit must not contain failureReason.');
  }
  const diagnostics = diagnosticSnapshot(rawCommit.diagnostics);
  if (diagnostics.status !== runStatus) {
    throw new Error('Cron Run commit status and diagnostics status are inconsistent.');
  }
  return {
    schemaVersion: 1,
    phase,
    commit: {
      kind,
      report: nonEmpty(rawCommit.report, 'commit.report'),
      runStatus,
      reportType,
      failureReason,
      diagnostics,
    },
  };
}

export function completedCronStatePreflight(state: CronRunState) {
  if (state.phase === 'admitted') return null;
  return {
    action: 'transition' as const,
    transition: {
      status: 'blocked' as const,
      stateVersion: CRON_RUN_STATE_VERSION,
      state,
      errorCode: 'cron_state_already_completed',
      errorSummary: 'Cron Run state is already completed and cannot be executed again.',
    },
  };
}

function diagnosticSnapshot(value: unknown): CronJobDiagnosticSnapshot {
  const raw = record(value, 'commit.diagnostics');
  const status = literal(raw.status, ['started', 'success', 'failed'] as const, 'diagnostics.status');
  if (!Array.isArray(raw.stages)) throw new Error('diagnostics.stages must be an array.');
  return {
    run_id: nonEmpty(raw.run_id, 'diagnostics.run_id'),
    job_id: nonEmpty(raw.job_id, 'diagnostics.job_id'),
    job_name: nonEmpty(raw.job_name, 'diagnostics.job_name'),
    schedule: nonEmpty(raw.schedule, 'diagnostics.schedule'),
    timezone: nonEmpty(raw.timezone, 'diagnostics.timezone'),
    timeout_ms: nonNegativeNumber(raw.timeout_ms, 'diagnostics.timeout_ms'),
    started_at: isoTimestamp(raw.started_at, 'diagnostics.started_at'),
    ...(raw.ended_at !== undefined ? { ended_at: isoTimestamp(raw.ended_at, 'diagnostics.ended_at') } : {}),
    ...(raw.duration_ms !== undefined
      ? { duration_ms: nonNegativeNumber(raw.duration_ms, 'diagnostics.duration_ms') }
      : {}),
    status,
    ...(raw.model !== undefined ? { model: boundedString(raw.model, 'diagnostics.model', 200) } : {}),
    ...(raw.last_completed_stage !== undefined
      ? { last_completed_stage: boundedString(raw.last_completed_stage, 'diagnostics.last_completed_stage', 80) }
      : {}),
    ...(raw.current_stage !== undefined
      ? { current_stage: boundedString(raw.current_stage, 'diagnostics.current_stage', 80) }
      : {}),
    ...(raw.current_stage_elapsed_ms !== undefined
      ? {
          current_stage_elapsed_ms: nonNegativeNumber(
            raw.current_stage_elapsed_ms,
            'diagnostics.current_stage_elapsed_ms',
          ),
        }
      : {}),
    ...(raw.progress !== undefined ? { progress: diagnosticProgress(raw.progress) } : {}),
    stages: raw.stages.map((stage, index) => diagnosticStage(stage, index)),
    ...(raw.error !== undefined ? { error: boundedString(raw.error, 'diagnostics.error', 1000) } : {}),
    ...(raw.stdout_tail !== undefined
      ? { stdout_tail: boundedString(raw.stdout_tail, 'diagnostics.stdout_tail', 1200) }
      : {}),
    ...(raw.stderr_tail !== undefined
      ? { stderr_tail: boundedString(raw.stderr_tail, 'diagnostics.stderr_tail', 1200) }
      : {}),
  };
}

function diagnosticStage(value: unknown, index: number): CronJobDiagnosticSnapshot['stages'][number] {
  const raw = record(value, `diagnostics.stages[${index}]`);
  return {
    name: boundedString(raw.name, `diagnostics.stages[${index}].name`, 80),
    status: literal(
      raw.status,
      ['running', 'success', 'failed'] as const,
      `diagnostics.stages[${index}].status`,
    ),
    started_at: isoTimestamp(raw.started_at, `diagnostics.stages[${index}].started_at`),
    ...(raw.ended_at !== undefined
      ? { ended_at: isoTimestamp(raw.ended_at, `diagnostics.stages[${index}].ended_at`) }
      : {}),
    ...(raw.duration_ms !== undefined
      ? { duration_ms: nonNegativeNumber(raw.duration_ms, `diagnostics.stages[${index}].duration_ms`) }
      : {}),
    ...(raw.error !== undefined
      ? { error: boundedString(raw.error, `diagnostics.stages[${index}].error`, 500) }
      : {}),
  };
}

function diagnosticProgress(value: unknown): NonNullable<CronJobDiagnosticSnapshot['progress']> {
  const raw = record(value, 'diagnostics.progress');
  return {
    at: isoTimestamp(raw.at, 'diagnostics.progress.at'),
    content: boundedString(raw.content, 'diagnostics.progress.content', 500),
    bytes: nonNegativeNumber(raw.bytes, 'diagnostics.progress.bytes'),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text.trim()) throw new Error(`${label} must not be empty.`);
  return text;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  const text = nonEmpty(value, label);
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function literal<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`${label} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}
