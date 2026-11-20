import type { JobFile } from '../job-contracts.js';
import { formatJobNextRun } from '../job-service.js';
import { jobTimezone } from '../job-store.js';
import type { LarkMessage } from '../lark-message.js';
import { selectQuotedMessageId } from '../quoted-context-loader.js';
import type { ReplyRequest, ReplySendResult } from '../reply-sender.js';
import type { CronControlService } from './control-service.js';

type CronInboundAction = 'pause' | 'view' | 'run_now' | 'skip_once';
type ParsedCronInboundCommand = {
  action: CronInboundAction;
  explicitReference?: string;
};

export interface CronInboundCommandOptions {
  message: LarkMessage;
  service: CronControlService;
  listVisibleJobs: (scope: {
    caller: string;
    chatId: string;
    isPrivateChat: boolean;
  }) => Promise<{ ok: true; jobs: JobFile[] } | { ok: false; message: string }>;
  isPrivateChat: (chatId: string) => boolean;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
}

export async function handleCronInboundCommand(
  options: CronInboundCommandOptions,
): Promise<boolean> {
  const { message } = options;
  const parsed = parseCronInboundCommand(message.currentUserText ?? message.text);
  if (!parsed) return false;
  const quotedMessageId = selectQuotedMessageId(message);
  if (!quotedMessageId && !parsed.explicitReference) return false;
  const { action } = parsed;

  if (action === 'skip_once') {
    if (!quotedMessageId) return false;
    await reply(
      options,
      '“跳过本次”不会暂停整个周期任务，也不会取消已开始的执行。当前版本尚不支持取消单次未开始运行；如需停止后续调度，请使用“暂停任务”。',
    );
    return true;
  }

  const { explicitReference } = parsed;
  let jobId = explicitReference ? undefined : message.quotedCronJobId;
  let expectedCreatedAt = explicitReference ? undefined : message.quotedCronJobOrigin?.jobCreatedAt;
  if (!jobId) {
    const listed = await options.listVisibleJobs({
      caller: message.senderId,
      chatId: message.chatId,
      isPrivateChat: options.isPrivateChat(message.chatId),
    });
    const visibleJobs = listed.ok ? listed.jobs : [];
    const matches = explicitReference
      ? matchVisibleJobs(visibleJobs, explicitReference)
      : [];
    if (matches.length === 1) {
      jobId = matches[0].meta.id;
      expectedCreatedAt = matches[0].meta.created_at;
    }
    if (!jobId) {
      const pool = matches.length > 1 ? matches : visibleJobs;
      const candidates = pool.slice(0, 5);
      const candidateText = candidates.length === 0
        ? '当前会话没有可见的定时任务。'
        : [
            '可见任务：',
            ...candidates.map((job) => {
              const timezone = jobTimezone(job.meta);
              return `- ${job.meta.name} · ${job.meta.id} · ${job.meta.status} · ${formatJobNextRun(job, timezone)} · ${timezone}`;
            }),
            ...(pool.length > candidates.length
              ? [`- 另有 ${pool.length - candidates.length} 个任务，请使用稳定 ID 指定。`]
              : []),
          ].join('\n');
      await reply(
        options,
        `${explicitReference ? '无法唯一确认指定的任务' : '无法确认引用消息对应的任务'}，因此未执行任何操作。请引用带来源标记的新消息，或使用稳定任务 ID。\n\n${candidateText}`,
      );
      return true;
    }
  }

  const target = {
    caller: message.senderId,
    chatId: message.chatId,
    jobId,
    ...(expectedCreatedAt
      ? { expectedCreatedAt }
      : {}),
  };
  const result = action === 'pause'
    ? await options.service.pause(target)
    : action === 'run_now'
      ? await options.service.runNow(target)
      : await options.service.view({
          ...target,
          isPrivateChat: options.isPrivateChat(message.chatId),
        });
  await reply(options, result.message);
  return true;
}

function parseCronInboundCommand(value: string): ParsedCronInboundCommand | null {
  const text = value.normalize('NFKC').trim();
  if (!text || text.length > 200) return null;
  if (
    /^(?:跳过|略过)(?:这|本)?(?:一)?次(?:执行|运行|任务)?[。.!！]?$/i.test(text)
    || /^(?:skip)(?: this)? run[.!]?$/i.test(text)
  ) return { action: 'skip_once' };
  if (
    /^(?:暂停|停止|停用)(?:(?:这个|该|此|它)(?:定时|周期)?(?:任务)?|(?:定时|周期)?任务)[。.!！]?$/i.test(text)
    || /^(?:pause|stop|disable)(?: this| the)?(?:(?: cron)? job)?[.!]?$/i.test(text)
  ) return { action: 'pause' };
  if (
    /^(?:查看|显示)(?:(?:这个|该|此|它)(?:任务)?|任务)(?:详情|信息)?[。.!！]?$/i.test(text)
    || /^(?:view|show)(?: this| the)?(?: job)?(?: details)?[.!]?$/i.test(text)
  ) return { action: 'view' };
  if (
    /^(?:立即|马上|现在)?(?:运行|执行|重跑)(?:(?:这个|该|此|它)(?:任务)?|任务)(?:一次)?[。.!！]?$/i.test(text)
    || /^(?:再|重新)(?:运行|执行|跑)(?:(?:这个|该|此|它)(?:任务)?|任务)?(?:一次)?[。.!！]?$/i.test(text)
    || /^(?:run|rerun)(?: this| the)?(?: job)?(?: now)?[.!]?$/i.test(text)
  ) return { action: 'run_now' };
  const namedPatterns: Array<[CronInboundAction, RegExp]> = [
    ['pause', /^(?:暂停|停止|停用)(?:任务)?[\s:：]+(.+?)[。.!！]?$/i],
    ['pause', /^(?:pause|stop|disable)(?: job)?[\s:]+(.+?)[.!]?$/i],
    ['view', /^(?:查看|显示)(?:任务)?[\s:：]+(.+?)(?:详情|信息)?[。.!！]?$/i],
    ['view', /^(?:view|show)(?: job)?[\s:]+(.+?)(?: details)?[.!]?$/i],
    ['run_now', /^(?:立即|马上|现在)?(?:运行|执行|重跑)(?:任务)?[\s:：]+(.+?)[。.!！]?$/i],
    ['run_now', /^(?:run|rerun)(?: job)?[\s:]+(.+?)(?: now)?[.!]?$/i],
  ];
  for (const [action, pattern] of namedPatterns) {
    const match = text.match(pattern);
    const reference = match?.[1] ? normalizeReference(match[1]) : '';
    if (reference) return { action, explicitReference: reference };
  }
  return null;
}

function normalizeReference(value: string): string {
  return value.trim().replace(/^[「『"']+|[」』"']+$/g, '').trim();
}

function matchVisibleJobs(jobs: JobFile[], reference: string): JobFile[] {
  const normalized = reference.normalize('NFKC').toLowerCase();
  const byId = jobs.filter((job) => job.meta.id.toLowerCase() === normalized);
  return byId.length > 0
    ? byId
    : jobs.filter((job) => job.meta.name.normalize('NFKC').toLowerCase() === normalized);
}

async function reply(options: CronInboundCommandOptions, text: string): Promise<void> {
  await options.sendReply({
    chat_id: options.message.chatId,
    text,
    reply_to: options.message.messageId,
    thread_id: options.message.threadId,
  });
}
