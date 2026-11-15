import { audit } from '../audit-log.js';
import type { JobFile } from '../job-contracts.js';
import {
  formatJobNextRun,
  canReadJobBody,
  jobVisibleToCaller,
  resolveJobReference,
  updateJob,
  type JobReference,
  type JobServiceResult,
  type UpdateJobInput,
} from '../job-service.js';
import { formatCronDateTime, jobTimezone } from '../job-store.js';
import type { StartJobNowResult } from '../scheduler.js';

export type CronControlCode =
  | 'paused'
  | 'already_paused'
  | 'details'
  | 'started'
  | 'job_not_found'
  | 'owner_mismatch'
  | 'stale_job'
  | 'wrong_chat'
  | 'not_visible'
  | 'runner_unavailable'
  | 'already_running'
  | 'start_failed';

export interface CronControlResult {
  ok: boolean;
  code: CronControlCode;
  message: string;
  job?: JobFile;
  runId?: string;
}

export interface CronControlTarget {
  caller: string;
  chatId: string;
  jobId: string;
  expectedCreatedAt?: string;
}

export interface CronControlService {
  pause(input: CronControlTarget): Promise<CronControlResult>;
  view(input: CronControlTarget & { isPrivateChat: boolean }): Promise<CronControlResult>;
  runNow(input: CronControlTarget): Promise<CronControlResult>;
}

export interface CronControlServiceOptions {
  resolveJob?: (
    reference: JobReference,
  ) => Promise<JobServiceResult<{ job: JobFile }>>;
  updateJob?: (
    input: UpdateJobInput,
  ) => Promise<JobServiceResult<{ job: JobFile }>>;
  startJobNow?: (job: JobFile) => Promise<
    StartJobNowResult | { started: false; reason: 'runner_unavailable' }
  >;
}

export function createCronControlService(
  options: CronControlServiceOptions = {},
): CronControlService {
  const resolve = options.resolveJob ?? resolveJobReference;
  const update = options.updateJob ?? updateJob;

  async function resolveTarget(
    input: CronControlTarget,
  ): Promise<{ ok: true; job: JobFile } | { ok: false; result: CronControlResult }> {
    const resolved = await resolve({ jobId: input.jobId });
    if (!resolved.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          code: resolved.code === 'job_not_found' ? 'job_not_found' : 'start_failed',
          message: resolved.message,
        },
      };
    }
    if (
      input.expectedCreatedAt !== undefined
      && resolved.job.meta.created_at !== input.expectedCreatedAt
    ) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'stale_job',
          message: '这条消息对应的任务已被删除或重建，请查看最新任务后再操作。',
        },
      };
    }
    if (resolved.job.meta.target_chat_id !== input.chatId) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'wrong_chat',
          message: '这条任务操作不属于当前会话。',
        },
      };
    }
    return { ok: true, job: resolved.job };
  }

  return {
    async pause(input) {
      const target = await resolveTarget(input);
      if (!target.ok) return target.result;
      if (target.job.meta.created_by !== input.caller) {
        void audit('disable_job', input.caller, cardAuditArgs(input), 'denied');
        return {
          ok: false,
          code: 'owner_mismatch',
          message: '只有任务创建者可以暂停该任务。',
        };
      }
      if (target.job.meta.status === 'paused') {
        return {
          ok: true,
          code: 'already_paused',
          job: target.job,
          message: `「${target.job.meta.name}」已经处于暂停状态。`,
        };
      }
      const updated = await update({
        action: 'disable_job',
        caller: input.caller,
        reference: { jobId: input.jobId },
        expectedCreatedAt: input.expectedCreatedAt,
        updates: { status: 'paused' },
        auditArgs: cardAuditArgs(input),
      });
      if (!updated.ok) return updateFailure(updated.code, updated.message);
      return {
        ok: true,
        code: 'paused',
        job: updated.job,
        message: `已暂停「${updated.job.meta.name}」。后续定时执行不会再触发；已开始的本次执行不会被取消。`,
      };
    },

    async view(input) {
      const target = await resolveTarget(input);
      if (!target.ok) return target.result;
      if (!jobVisibleToCaller(target.job, {
        caller: input.caller,
        chatId: input.chatId,
        isPrivateChat: input.isPrivateChat,
      })) {
        void audit('list_jobs', input.caller, cardAuditArgs(input), 'denied');
        return {
          ok: false,
          code: 'not_visible',
          message: '当前会话无权查看该任务。',
        };
      }
      void audit('list_jobs', input.caller, cardAuditArgs(input), 'ok');
      return {
        ok: true,
        code: 'details',
        job: target.job,
        message: formatControlDetails(target.job, input.caller),
      };
    },

    async runNow(input) {
      const target = await resolveTarget(input);
      if (!target.ok) return target.result;
      if (target.job.meta.created_by !== input.caller) {
        void audit('run_job', input.caller, cardAuditArgs(input), 'denied');
        return {
          ok: false,
          code: 'owner_mismatch',
          message: '只有任务创建者可以立即运行该任务。',
        };
      }
      if (!options.startJobNow) {
        return {
          ok: false,
          code: 'runner_unavailable',
          message: '定时任务运行器尚未就绪。',
        };
      }
      try {
        const started = await options.startJobNow(target.job);
        if (!started.started) {
          const code = started.reason === 'already_running'
            ? 'already_running'
            : started.reason === 'runner_unavailable'
              ? 'runner_unavailable'
              : 'stale_job';
          void audit('run_job', input.caller, {
            ...cardAuditArgs(input),
            reason: started.reason,
          }, 'denied');
          return {
            ok: false,
            code,
            message: code === 'already_running'
              ? `「${target.job.meta.name}」正在运行，本次没有重复启动。`
              : code === 'runner_unavailable'
                ? '定时任务运行器尚未就绪，请稍后重试。'
                : '任务在启动前已发生变化，请查看最新状态后重试。',
          };
        }
        void audit('run_job', input.caller, {
          ...cardAuditArgs(input),
          run_id: started.runId,
        }, 'ok');
        return {
          ok: true,
          code: 'started',
          job: target.job,
          runId: started.runId,
          message: `已开始运行「${target.job.meta.name}」，结果会通过该任务的正常投递路径发送。`,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void audit('run_job', input.caller, cardAuditArgs(input), 'error');
        return {
          ok: false,
          code: 'start_failed',
          message: `任务启动失败：${detail}`,
        };
      }
    },
  };
}

function updateFailure(code: string, message: string): CronControlResult {
  return {
    ok: false,
    code: code === 'owner_mismatch'
      ? 'owner_mismatch'
      : code === 'stale_job'
        ? 'stale_job'
        : code === 'job_not_found'
          ? 'job_not_found'
          : 'start_failed',
    message,
  };
}

function formatControlDetails(job: JobFile, caller: string): string {
  const timezone = jobTimezone(job.meta);
  const bodyLabel = job.meta.type === 'prompt' ? '提示词' : '内容';
  const bodyValue = job.meta.type === 'prompt' ? job.meta.prompt : job.meta.content;
  return [
    `任务：${job.meta.name}`,
    `ID：${job.meta.id}`,
    `状态：${job.meta.status === 'active' ? '运行中' : '已暂停'}`,
    `计划：${job.meta.schedule_human}`,
    `时区：${timezone}`,
    `下次执行：${formatJobNextRun(job, timezone)}`,
    `上次执行：${formatCronDateTime(job.runtime.last_run_at, timezone)}`,
    ...(canReadJobBody(job, caller)
      ? [`${bodyLabel}：${bodyValue ?? '（空）'}`]
      : []),
  ].join('\n');
}

function cardAuditArgs(input: CronControlTarget): Record<string, unknown> {
  return {
    source: 'cron_control',
    chat_id: input.chatId,
    job_id: input.jobId,
    expected_created_at: input.expectedCreatedAt,
  };
}
