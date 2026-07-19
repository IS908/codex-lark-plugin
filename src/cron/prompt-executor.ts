import { appConfig } from '../config.js';
import {
  deliverMessageViaCodexExec,
  type CodexExecDeliveryOptions,
  type CodexExecSessionHealthRecorder,
} from '../codex-exec-delivery.js';
import type { CodexExecActionDispatcher } from '../codex-exec-actions.js';
import type { CodexExecRunner } from '../codex-exec.js';
import {
  isRetrySafeCodexExecPreStartError,
} from '../codex-exec.js';
import type { CodexExecSessionStore } from '../codex-session-store.js';
import { CronJobRunDiagnostics, formatCronJobDiagnostics, sanitizeDiagnosticText } from '../cronjob-diagnostics.js';
import type { IdentitySession } from '../identity-session.js';
import type { JobFile } from '../job-contracts.js';
import { JOB_THREAD_PREFIX, jobCreatedAtHash } from '../job-thread.js';
import type { LarkMessage } from '../lark-message.js';
import { cronJobPrompt } from '../prompts.js';
import type {
  CronPromptExecution,
  CronPromptExecutionInput,
  CronPromptExecutor,
} from './contracts.js';

const CRON_PROMPT_BLOCKED_ACTION_TYPES = [
  'send_message',
  'recall_message',
  'create_job',
  'run_job',
  'update_job',
  'disable_job',
  'delete_job',
  'upsert_job',
  'create_continuation_job',
] as const;

export interface CronPromptExecutorOptions {
  identitySession: IdentitySession;
  sessionStore: CodexExecSessionStore;
  sessionHealth?: CodexExecSessionHealthRecorder;
  actionDispatcher?: CodexExecActionDispatcher;
  deliver?: (options: CodexExecDeliveryOptions) => Promise<void>;
  timeoutMs?: number;
  runCodexExec?: CodexExecRunner;
  useCodexSessions?: boolean;
  progressBaseDir?: string;
  actionBaseDir?: string;
}

export function createCronPromptExecutor(options: CronPromptExecutorOptions): CronPromptExecutor {
  const deliver = options.deliver ?? deliverMessageViaCodexExec;
  return async (input: CronPromptExecutionInput, signal: AbortSignal): Promise<CronPromptExecution> => {
    signal.throwIfAborted();
    const job = snapshotAsJobFile(input);
    const diagnostics = new CronJobRunDiagnostics({
      job,
      runId: input.runId,
      timeoutMs: options.timeoutMs ?? appConfig.codexExecTimeoutMs,
    });
    const threadId = `${JOB_THREAD_PREFIX}${input.job.id}-${jobCreatedAtHash(input.job.createdAt)}-${input.runId}`;
    options.identitySession.setCaller(input.job.targetChatId, threadId, input.job.createdBy);
    options.identitySession.beginChannelTurn(
      input.job.targetChatId,
      threadId,
      appConfig.replyObligationTimeoutMs,
    );

    try {
      diagnostics.startStage('prepare_prompt');
      const promptContent = cronJobPrompt(
        input.job.name,
        input.job.targetChatId,
        input.job.prompt,
      );
      diagnostics.completeStage('prepare_prompt');
      const message: LarkMessage = {
        messageId: threadId,
        chatId: input.job.targetChatId,
        chatType: 'cronjob',
        senderId: input.job.createdBy,
        senderName: `CronJob ${input.job.name}`,
        text: promptContent,
        messageType: 'cronjob',
        rawContent: promptContent,
        threadId,
      };
      let report = '';
      let lifecycleGuardReason: string | null = null;
      let actionFailureReason: string | null = null;
      diagnostics.startStage('codex_exec');
      await deliver({
        message,
        displayLabel: `CronJob · ${input.job.name}`,
        modelOverride: input.job.model,
        sessionStore: options.sessionStore,
        sessionHealth: options.sessionHealth,
        actionDispatcher: options.actionDispatcher,
        traceLogId: input.job.id,
        traceRunId: input.runId,
        progressVisible: false,
        abortSignal: signal,
        actionPolicy: {
          blockedActionTypes: CRON_PROMPT_BLOCKED_ACTION_TYPES,
          reason: 'Cron generation cannot mutate Feishu messages or create, rerun, update, or schedule background work. Return the report in final stdout for durable delivery.',
        },
        runCodexExec: options.runCodexExec,
        useCodexSessions: options.useCodexSessions,
        progressBaseDir: options.progressBaseDir,
        actionBaseDir: options.actionBaseDir,
        deliverySink: async (output) => {
          report = output.text;
        },
        onProgress: (event) => {
          diagnostics.recordProgress(event.content, event.timestampMs, event.bytes);
        },
        onLifecycleGuard: (reason) => {
          lifecycleGuardReason = reason;
        },
        onActionResults: (results) => {
          const failure = results.find((result) => !result.ok);
          if (failure) actionFailureReason = failure.message;
        },
      });
      if (!report.trim()) throw new Error('CronJob prompt produced no visible report.');
      if (lifecycleGuardReason || actionFailureReason) {
        const reason = lifecycleGuardReason
          ? `Lifecycle guard blocked output: ${lifecycleGuardReason}`
          : actionFailureReason!;
        diagnostics.failStage('codex_exec', new Error(reason));
        return {
          report,
          runStatus: 'failed',
          failureReason: reason,
          diagnostics: diagnostics.finish('failed', new Error(reason)),
        };
      }
      diagnostics.completeStage('codex_exec');
      return {
        report,
        runStatus: 'success',
        failureReason: null,
        diagnostics: diagnostics.finish('success'),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (isRetrySafeCodexExecPreStartError(error)) throw error;
      diagnostics.failStage(undefined, error);
      const snapshot = diagnostics.finish('failed', error);
      const reason = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 1000)
        || 'CronJob prompt execution failed.';
      const report = [
        `CronJob "${sanitizeDiagnosticText(input.job.name, 200)}" failed before a complete report could be delivered.`,
        '',
        `Job ID: ${input.job.id}`,
        `Reason: ${reason}`,
        '',
        formatCronJobDiagnostics(snapshot),
      ].join('\n');
      return { report, runStatus: 'failed', failureReason: reason, diagnostics: snapshot };
    } finally {
      options.identitySession.endChannelTurn(input.job.targetChatId, threadId);
    }
  };
}


function snapshotAsJobFile(input: CronPromptExecutionInput): JobFile {
  const job = input.job;
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
