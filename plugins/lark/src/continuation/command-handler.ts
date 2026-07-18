import { audit } from '../audit-log.js';
import { isFeishuOpenMessageId } from '../codex-exec-error.js';
import { splitDocCommentText } from '../doc-comment-api.js';
import type { ContinuationJob } from '../domain/continuation.js';
import type { LarkMessage } from '../lark-message.js';
import { extractMessageText } from '../message-content.js';
import type { ReplyRequest, ReplySendResult } from '../reply-sender.js';
import {
  CONTINUATION_RUNTIME_UNAVAILABLE,
  ContinuationServiceError,
  type ContinuationListStatus,
  type ContinuationTaskService,
} from './service.js';

export const CONTINUATION_COMMAND_DEFINITION = {
  name: 'task' as const,
  usage: '/task <list|status|cancel|retry|retain|delete>',
  description: 'List and manage durable background tasks.',
  scope: 'user' as const,
};

const TASK_USAGE = [
  'Usage:',
  '- /task list [--status pending,running,completed,partial,blocked,failed,cancelled]',
  '- /task status <job_id>',
  '- /task cancel <job_id>',
  '- /task retry <job_id>',
  '- /task retain <job_id> <on|off>',
  '- /task delete <job_id>',
].join('\n');

type TaskCommand =
  | { action: 'list'; statuses: ContinuationListStatus[] }
  | { action: 'status' | 'cancel' | 'retry' | 'delete'; jobId: string }
  | { action: 'retain'; jobId: string; retained: boolean }
  | { action: 'invalid' };

const LIST_STATUSES = new Set<ContinuationListStatus>([
  'pending',
  'running',
  'completed',
  'partial',
  'blocked',
  'failed',
  'cancelled',
]);

type AuditFn = typeof audit;

export interface ContinuationCommandHandlerOptions {
  message: LarkMessage;
  service: ContinuationTaskService | null;
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
    ...(command.action === 'list' && command.statuses.length > 0
      ? { status: command.statuses.join(',') }
      : {}),
    ...(command.action === 'retain' ? { retain: command.retained } : {}),
  };

  let text: string;
  let auditResult: 'ok' | 'denied' | 'error' = 'ok';
  try {
    if (command.action === 'invalid') {
      auditResult = 'error';
      text = TASK_USAGE;
    } else if (!options.service) {
      auditResult = 'error';
      text = CONTINUATION_RUNTIME_UNAVAILABLE;
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
  const listMatch = normalized.match(/^\/task\s+list(?:\s+--status\s+(.+?))?\s*$/i);
  if (listMatch) {
    const statuses = listMatch[1]
      ? [...new Set(listMatch[1].split(',').map((value) => value.trim().toLowerCase()))]
      : [];
    if (statuses.some((status) => !LIST_STATUSES.has(status as ContinuationListStatus))) {
      return { action: 'invalid' };
    }
    return { action: 'list', statuses: statuses as ContinuationListStatus[] };
  }
  const retainMatch = normalized.match(
    /^\/task\s+retain\s+(job_[A-Za-z0-9_-]{8,128})\s+(on|off)\s*$/i,
  );
  if (retainMatch) {
    return {
      action: 'retain',
      jobId: retainMatch[1],
      retained: retainMatch[2].toLowerCase() === 'on',
    };
  }
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
  service: ContinuationTaskService,
  actorOpenId: string,
  ownerOpenId: string | null | undefined,
  requestId: string,
): Promise<string> {
  if (command.action === 'list') {
    return formatTaskList(await service.listForActor(
      actorOpenId,
      ownerOpenId,
      command.statuses,
    ));
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
  if (command.action === 'retain') {
    const job = await service.setRetainedForActor(
      command.jobId,
      command.retained,
      actorOpenId,
      ownerOpenId,
    );
    return `Task retention ${job.retained ? 'enabled' : 'disabled'}.\nJob ID: ${job.jobId}`;
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
      `  Attempts: ${attemptCount(job)} / ${job.maxAttempts} | Next run: ${formatOptionalTime(job.nextRunAt)}`,
      `  Completed: ${formatOptionalTime(job.completedAt)} | Delivery: ${job.deliveryStatus ?? 'not_started'} | Retain: ${job.retained ? 'on' : 'off'}`,
    ].join('\n')),
  ].join('\n');
}

function formatTaskStatus(job: ContinuationJob): string {
  return [
    `State: ${job.status}`,
    `Job ID: ${job.jobId}`,
    `Title: ${job.title}`,
    `Attempts: ${attemptCount(job)} / ${job.maxAttempts}`,
    `Consecutive no-progress attempts: ${job.noProgressCount}`,
    ...(job.lastAttemptDelta ? [
      `Last step: ${job.lastAttemptDelta.stepId} | Material change: ${job.lastAttemptDelta.stateChanged ? 'yes' : 'no'}`,
    ] : []),
    ...(job.lastVerification ? [
      `Last verification: ${job.lastVerification.status}`,
      ...job.lastVerification.findings.slice(0, 5).map((finding) => `- ${finding}`),
      ...(job.lastVerification.findings.length > 5
        ? [`- ${job.lastVerification.findings.length - 5} more finding(s)`]
        : []),
    ] : []),
    `Next run: ${formatOptionalTime(job.nextRunAt)}`,
    `Completed: ${formatOptionalTime(job.completedAt)}`,
    `Delivery: ${job.deliveryStatus ?? 'not_started'}`,
    `Retain: ${job.retained ? 'on' : 'off'}`,
    formatDeliveryEvents(job),
    ...(job.errorCode ? [`Error code: ${job.errorCode}`] : []),
    ...(job.errorSummary ? [`Error: ${job.errorSummary}`] : []),
    ...(job.resultSummary ? [`Result: ${job.resultSummary}`] : []),
    ...(job.resultArtifacts.length > 0
      ? [`Artifacts:\n${job.resultArtifacts.map((artifact) => `- ${artifact}`).join('\n')}`]
      : []),
  ].join('\n');
}

function formatDeliveryEvents(job: ContinuationJob): string {
  const events = job.deliveryEvents ?? [];
  if (events.length === 0) return 'Delivery events: none';
  const lines = ['Delivery events:'];
  for (const event of events) {
    lines.push(event.kind === 'terminal'
      ? `- terminal | ${event.status} | attempts ${event.attemptCount}`
      : `- progress | ${event.attemptId ?? '-'} | ${event.status} | attempts ${event.attemptCount}`);
    if (event.lastErrorCode || event.lastErrorSummary) {
      const detail = [event.lastErrorCode, event.lastErrorSummary]
        .filter(Boolean)
        .join(': ');
      lines.push(`  Error: ${truncateDiagnostic(detail, 240)}`);
    }
  }
  return lines.join('\n');
}

function truncateDiagnostic(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, maxCharacters - 3).join('').trimEnd()}...`;
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
    for (const content of splitDocCommentText(text)) {
      await options.sendDocCommentReply({
        doc_token: comment.fileToken,
        comment_id: comment.commentId,
        file_type: comment.fileType,
        content,
      });
    }
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
