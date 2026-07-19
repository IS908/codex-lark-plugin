import type {
  DurableRunDeliveryRequest,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunPreflight,
  DurableRunTransition,
  DurableRunWorkloadClaim,
  DurableRunWorkloadContext,
} from '../domain/durable-run.js';
import type { DurableRunWorkload } from '../ports/durable-run.js';
import {
  CronJobRunDiagnostics,
  formatCronJobDiagnostics,
  sanitizeDiagnosticText,
} from '../cronjob-diagnostics.js';
import type { JobFile } from '../job-contracts.js';
import {
  CRON_RUN_STATE_VERSION,
  completedCronStatePreflight,
  parseCronRunInput,
  parseCronRunState,
  type CronPromptExecution,
  type CronPromptExecutor,
  type CronRunInput,
  type CronRunState,
  type CronTerminalPayload,
} from './contracts.js';

export interface CronPromptWorkloadOptions {
  executor: CronPromptExecutor;
}

export class CronPromptWorkload implements DurableRunWorkload<CronRunInput, CronRunState, CronPromptExecution> {
  readonly kind = 'cron_prompt';

  constructor(private readonly options: CronPromptWorkloadOptions) {}

  parseInput(value: unknown, version: number): CronRunInput {
    return parseCronRunInput(value, version, 'prompt');
  }

  parseState(value: unknown, version: number): CronRunState {
    return parseCronRunState(value, version);
  }

  async preflight(
    context: DurableRunWorkloadContext<CronRunInput, CronRunState>,
  ): Promise<DurableRunPreflight> {
    return completedCronStatePreflight(context.state) ?? { action: 'execute' };
  }

  async execute(
    claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
    signal: AbortSignal,
  ): Promise<CronPromptExecution> {
    const job = promptJob(claim.run.input);
    try {
      return await this.options.executor({ runId: claim.run.runId, job }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return failedExecution(job, claim.run.runId, error);
    }
  }

  reduce(
    claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
    execution: CronPromptExecution,
  ): DurableRunTransition {
    const normalized = normalizeExecution(claim.run.input, claim.run.runId, execution);
    const reportType: 'job_result' | 'error_report' =
      normalized.runStatus === 'success' ? 'job_result' : 'error_report';
    const commit = {
      kind: 'prompt' as const,
      report: normalized.report,
      runStatus: normalized.runStatus,
      reportType,
      failureReason: normalized.failureReason,
      diagnostics: normalized.diagnostics,
    };
    const failed = normalized.runStatus === 'failed';
    return {
      status: failed ? 'failed' : 'completed',
      stateVersion: CRON_RUN_STATE_VERSION,
      state: { schemaVersion: 1, phase: 'completed', commit } satisfies CronRunState,
      ...(failed
        ? {
            errorCode: 'cron_prompt_failed',
            errorSummary: sanitizeDiagnosticText(normalized.failureReason ?? 'CronJob prompt failed.', 1000),
          }
        : {}),
      attempt: {
        outcome: normalized.runStatus,
        operationRisk: 'unknown',
        ...(failed
          ? {
              errorCode: 'cron_prompt_failed',
              errorSummary: sanitizeDiagnosticText(normalized.failureReason ?? 'CronJob prompt failed.', 1000),
            }
          : {}),
      },
      deliveries: [promptDelivery(claim, claim.run.input, normalized, reportType)],
    };
  }

  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition {
    if (context.executionPhase !== 'execution_started') {
      return {
        status: 'recovering',
        stateVersion: context.claim.run.stateVersion,
        state: context.claim.run.state,
        nextRunAt: context.recoveredAt,
        attempt: { outcome: 'interrupted_before_execution', operationRisk: 'pure' },
      };
    }
    const input = this.parseInput(context.claim.run.input, context.claim.run.inputVersion);
    const reason = 'The CronJob execution was interrupted after Codex started, so the external outcome is unknown.';
    const execution = failedExecution(promptJob(input), context.claim.run.runId, new Error(reason));
    const failure: DurableRunFailure = {
      category: 'unknown',
      retrySafety: 'unknown',
      capabilityAvailable: true,
      operationRisk: 'unknown',
      hints: ['Confirm the prior Codex execution outcome before retrying this CronJob.'],
      failedStep: 'codex_exec',
      diagnostic: reason,
      fingerprint: `cron-interrupted:${context.claim.run.runId}`,
    };
    return {
      status: 'blocked',
      stateVersion: CRON_RUN_STATE_VERSION,
      state: {
        schemaVersion: 1,
        phase: 'completed',
        commit: {
          kind: 'prompt',
          report: execution.report,
          runStatus: 'failed',
          reportType: 'error_report',
          failureReason: reason,
          diagnostics: execution.diagnostics,
        },
      } satisfies CronRunState,
      errorCode: 'cron_execution_outcome_unknown',
      errorSummary: reason,
      failure,
      attempt: {
        outcome: 'interrupted_unknown',
        operationRisk: 'unknown',
        errorCode: 'cron_execution_outcome_unknown',
        errorSummary: reason,
      },
      deliveries: [promptDelivery(context.claim, input, execution, 'error_report')],
    };
  }
}

function normalizeExecution(
  input: CronRunInput,
  runId: string,
  execution: CronPromptExecution,
): CronPromptExecution {
  if (execution.runStatus === 'success' && !execution.report.trim()) {
    return failedExecution(promptJob(input), runId, new Error('CronJob prompt produced no visible report.'));
  }
  if (execution.runStatus === 'failed' && !execution.failureReason?.trim()) {
    return { ...execution, failureReason: 'CronJob prompt failed lifecycle validation.' };
  }
  return execution;
}

function promptDelivery(
  claim: { run: { runId: string; route: unknown }; attempt: { attemptId: string } },
  input: CronRunInput,
  execution: CronPromptExecution,
  reportType: 'job_result' | 'error_report',
): DurableRunDeliveryRequest {
  const job = input.job;
  const payload: CronTerminalPayload = {
    schemaVersion: 1,
    kind: 'report',
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    jobRevision: job.revision,
    report: execution.report,
    reportType,
    runStatus: execution.runStatus,
    failureReason: execution.failureReason,
    diagnostics: execution.diagnostics,
  };
  return {
    kind: 'cron_terminal',
    attemptId: claim.attempt.attemptId,
    idempotencyKey: `cron:${claim.run.runId}:terminal`,
    route: claim.run.route,
    payload,
  };
}

function promptJob(input: CronRunInput) {
  const job = input.job;
  if (job.type !== 'prompt' || !job.prompt?.trim()) throw new Error('Cron prompt must not be empty.');
  return { ...job, type: 'prompt' as const, prompt: job.prompt };
}

function failedExecution(
  job: ReturnType<typeof promptJob>,
  runId: string,
  error: unknown,
): CronPromptExecution {
  const reason = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 1000)
    || 'CronJob prompt execution failed.';
  const diagnostics = new CronJobRunDiagnostics({
    job: snapshotAsJobFile(job),
    runId,
    timeoutMs: 0,
  });
  diagnostics.failStage('codex_exec', error);
  const snapshot = diagnostics.finish('failed', error);
  const report = [
    `CronJob "${sanitizeDiagnosticText(job.name, 200)}" failed before a complete report could be delivered.`,
    '',
    `Job ID: ${job.id}`,
    `Reason: ${reason}`,
    '',
    formatCronJobDiagnostics(snapshot),
  ].join('\n');
  return { report, runStatus: 'failed', failureReason: reason, diagnostics: snapshot };
}

function snapshotAsJobFile(job: ReturnType<typeof promptJob>): JobFile {
  return {
    meta: {
      id: job.id,
      revision: job.revision,
      name: job.name,
      type: 'prompt',
      schedule: job.schedule,
      schedule_human: job.scheduleHuman,
      timezone: job.timezone,
      prompt: job.prompt,
      target_chat_id: job.targetChatId,
      origin_chat_id: job.originChatId,
      ...(job.model ? { model: job.model } : {}),
      status: 'active',
      created_by: job.createdBy,
      created_at: job.createdAt,
    },
    runtime: {
      last_run_at: null,
      next_run_at: job.scheduledOccurrence ?? job.createdAt,
      run_count: 0,
      last_error: null,
    },
  };
}
