import { audit } from '../audit-log.js';
import { isFeishuOpenMessageId } from '../codex-exec-error.js';
import type { ContinuationJob } from '../domain/continuation.js';
import type { LarkMessage } from '../lark-message.js';
import { extractMessageText } from '../message-content.js';
import type { ReplyRequest, ReplySendResult } from '../reply-sender.js';
import {
  ContinuationService,
  ContinuationServiceError,
} from './service.js';

export const CONTINUATION_COMMAND_DEFINITION = {
  name: 'task' as const,
  usage: '/task <list|status|cancel|retry|delete>',
  description: 'List and manage durable background tasks.',
  scope: 'user' as const,
};

const TASK_USAGE = [
  'Usage:',
  '- /task list',
  '- /task status <job_id>',
  '- /task cancel <job_id>',
  '- /task retry <job_id>',
  '- /task delete <job_id>',
].join('\n');

type TaskCommand =
  | { action: 'list' }
  | { action: 'status' | 'cancel' | 'retry' | 'delete'; jobId: string }
  | { action: 'invalid' };

type AuditFn = typeof audit;

export interface ContinuationCommandHandlerOptions {
  message: LarkMessage;
  service: ContinuationService | null;
  ownerOpenId?: string | null;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  sendDocCommentReply?: (request: {
    doc_token: string;
    comment_id: string;
    file_type: string;
    content: string;
  }) => Promise<{ replyId?: string }>;
  auditCommand?: AuditFn;
}

export async function handleContinuationCommand(
  options: ContinuationCommandHandlerOptions,
): Promise<boolean> {
  const command = parseTaskCommand(options.message);
  if (!command) return false;

  const actorOpenId = options.message.senderId;
  const auditCommand = options.auditCommand ?? audit;
  const auditArgs = {
    chat_id: options.message.chatId,
    thread_id: options.message.threadId,
    message_id: options.message.messageId,
    command: command.action,
    ...('jobId' in command ? { job_id: command.jobId } : {}),
  };

  let text: string;
  let auditResult: 'ok' | 'denied' | 'error' = 'ok';
  try {
    if (command.action === 'invalid') {
      auditResult = 'error';
      text = TASK_USAGE;
    } else if (!options.service) {
      auditResult = 'error';
      text = 'Background task runtime is unavailable.';
    } else {
      text = await executeTaskCommand(
        command,
        options.service,
        actorOpenId,
        options.ownerOpenId,
        options.message.messageId,
      );
    }
  } catch (error) {
    auditResult = error instanceof ContinuationServiceError && error.code === 'not_accessible'
      ? 'denied'
      : 'error';
    text = error instanceof Error ? error.message : 'Background task command failed.';
  }

  try {
    await sendCommandReply(options, text);
  } catch (error) {
    await auditCommand('lark_task_command', actorOpenId, auditArgs, 'error');
    throw error;
  }
  await auditCommand('lark_task_command', actorOpenId, auditArgs, auditResult);
  return true;
}

function parseTaskCommand(message: LarkMessage): TaskCommand | null {
  if (!['p2p', 'group', 'doc_comment'].includes(message.chatType)) return null;
  if (message.messageType === 'reaction' || message.reaction) return null;
  const text = taskCommandText(message);
  const normalized = stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim());
  if (!/^\/task(?:\s|$)/i.test(normalized)) return null;
  if (/^\/task\s+list\s*$/i.test(normalized)) return { action: 'list' };
  const match = normalized.match(/^\/task\s+(status|cancel|retry|delete)\s+(job_[A-Za-z0-9_-]{8,128})\s*$/i);
  if (!match) return { action: 'invalid' };
  return {
    action: match[1].toLowerCase() as 'status' | 'cancel' | 'retry' | 'delete',
    jobId: match[2],
  };
}

function taskCommandText(message: LarkMessage): string {
  const rawText = extractMessageText(message.rawContent, message.messageType);
  const normalizedRaw = stripLeadingMentions(rawText.replace(/\u00a0/g, ' ').trim());
  return /^\/task(?:\s|$)/i.test(normalizedRaw) ? rawText : message.text;
}

function stripLeadingMentions(text: string): string {
  let remaining = text;
  for (let index = 0; index < 8; index += 1) {
    const next = remaining.replace(/^@\S+(?:\s+|$)/, '').trimStart();
    if (next === remaining) break;
    remaining = next;
  }
  return remaining.trim();
}

async function executeTaskCommand(
  command: Exclude<TaskCommand, { action: 'invalid' }>,
  service: ContinuationService,
  actorOpenId: string,
  ownerOpenId: string | null | undefined,
  requestId: string,
): Promise<string> {
  if (command.action === 'list') {
    return formatTaskList(await service.listForActor(actorOpenId, ownerOpenId));
  }
  if (command.action === 'status') {
    return formatTaskStatus(await service.getForActor(command.jobId, actorOpenId, ownerOpenId));
  }
  if (command.action === 'cancel') {
    const result = await service.cancelForActor(command.jobId, actorOpenId, ownerOpenId);
    if (result.result === 'cancelled') return `Task cancelled.\nJob ID: ${result.job.jobId}`;
    if (result.result === 'cancel_requested') return `Cancellation requested.\nJob ID: ${result.job.jobId}`;
    return `Task is already terminal (${result.job.status}).\nJob ID: ${result.job.jobId}`;
  }
  if (command.action === 'retry') {
    const job = await service.retryForActor(
      command.jobId,
      actorOpenId,
      ownerOpenId,
      requestId,
    );
    return `Retry task created: ${job.title}\nJob ID: ${job.jobId}`;
  }
  await service.deleteForActor(command.jobId, actorOpenId, ownerOpenId);
  return `Task deleted.\nJob ID: ${command.jobId}`;
}

function formatTaskList(jobs: ContinuationJob[]): string {
  if (jobs.length === 0) return 'No background tasks found.';
  return [
    `Background tasks (${jobs.length})`,
    ...jobs.map((job) => [
      `- ${job.status} | ${job.jobId} | ${job.title}`,
      `  Attempts: ${attemptCount(job)} | Next run: ${formatOptionalTime(job.nextRunAt)}`,
      `  Completed: ${formatOptionalTime(job.completedAt)} | Delivery: ${job.deliveryStatus ?? 'not_started'}`,
    ].join('\n')),
  ].join('\n');
}

function formatTaskStatus(job: ContinuationJob): string {
  return [
    `State: ${job.status}`,
    `Job ID: ${job.jobId}`,
    `Title: ${job.title}`,
    `Attempts: ${attemptCount(job)}`,
    `Next run: ${formatOptionalTime(job.nextRunAt)}`,
    `Completed: ${formatOptionalTime(job.completedAt)}`,
    `Delivery: ${job.deliveryStatus ?? 'not_started'}`,
    ...(job.errorCode ? [`Error code: ${job.errorCode}`] : []),
    ...(job.errorSummary ? [`Error: ${job.errorSummary}`] : []),
    ...(job.resultSummary ? [`Result: ${job.resultSummary}`] : []),
  ].join('\n');
}

function attemptCount(job: ContinuationJob): number {
  return job.attemptCount ?? job.stepCount + job.failureCount;
}

function formatOptionalTime(value?: string): string {
  return value || '-';
}

async function sendCommandReply(
  options: ContinuationCommandHandlerOptions,
  text: string,
): Promise<void> {
  const comment = options.message.docComment;
  if (options.message.chatType === 'doc_comment' && comment) {
    if (!options.sendDocCommentReply) {
      throw new Error('Document comment command replies are unavailable.');
    }
    await options.sendDocCommentReply({
      doc_token: comment.fileToken,
      comment_id: comment.commentId,
      file_type: comment.fileType,
      content: text,
    });
    return;
  }
  await options.sendReply({
    chat_id: options.message.chatId,
    text,
    ...(isFeishuOpenMessageId(options.message.messageId)
      ? { reply_to: options.message.messageId }
      : {}),
    thread_id: options.message.threadId,
  });
}
