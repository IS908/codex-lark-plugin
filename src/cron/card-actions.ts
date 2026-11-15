import type { CardActionEvent } from '@larksuite/channel';
import type { LarkCardActionResponse } from '../lark-message.js';
import type { CronControlService } from './control-service.js';

export interface CronJobCardActionValue {
  version: 1;
  kind: 'cron_job_control';
  action: 'pause' | 'view' | 'run_now';
  jobId: string;
  jobCreatedAt: string;
}

export interface CronCardActionHandlerOptions {
  service: CronControlService;
  isPrivateChat: (chatId: string) => boolean;
}

export function createCronCardActionHandler(
  options: CronCardActionHandlerOptions,
): (event: CardActionEvent) => Promise<LarkCardActionResponse> {
  return async (event) => {
    const parsed = parseCronJobCardAction(event.action.value);
    if (!parsed) return toast(false, '无效或已过期的任务操作。');
    const target = {
      caller: event.operator.openId,
      chatId: event.chatId,
      jobId: parsed.jobId,
      expectedCreatedAt: parsed.jobCreatedAt,
    };
    const result = parsed.action === 'pause'
      ? await options.service.pause(target)
      : parsed.action === 'run_now'
        ? await options.service.runNow(target)
        : await options.service.view({
            ...target,
            isPrivateChat: options.isPrivateChat(event.chatId),
          });
    return toast(result.ok, result.message);
  };
}

export function parseCronJobCardAction(value: unknown): CronJobCardActionValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || raw.kind !== 'cron_job_control') return null;
  if (raw.action !== 'pause' && raw.action !== 'view' && raw.action !== 'run_now') return null;
  if (typeof raw.jobId !== 'string' || !raw.jobId || raw.jobId.length > 200) return null;
  if (
    typeof raw.jobCreatedAt !== 'string'
    || raw.jobCreatedAt.length > 100
    || !Number.isFinite(Date.parse(raw.jobCreatedAt))
  ) return null;
  return {
    version: 1,
    kind: 'cron_job_control',
    action: raw.action,
    jobId: raw.jobId,
    jobCreatedAt: new Date(raw.jobCreatedAt).toISOString(),
  };
}

function toast(ok: boolean, content: string): LarkCardActionResponse {
  return {
    toast: {
      type: ok ? 'success' : 'error',
      content: content.slice(0, 1000),
    },
  };
}
