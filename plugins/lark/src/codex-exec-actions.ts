import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import type { LarkMessage } from './channel.js';
import type { ReplyRequest, ReplyRichPart, ReplySendResult } from './reply-sender.js';
import { downloadInboundResource } from './inbound-attachment-downloader.js';
import type { IdentitySession } from './identity-session.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import type { MemoryStore } from './memory/file.js';
import { assertSafeChatId } from './prompts.js';
import {
  expandSchedule,
  formatCronDateTime,
  jobTimezone,
  normalizeJobTimezone,
  type JobFile,
} from './job-store.js';
import {
  canReadJobBody,
  createJob,
  deleteJob,
  listVisibleJobs,
  updateJob,
  upsertJob,
} from './job-service.js';
import { runConfiguredLocalCliTool } from './local-cli-tools.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';
import type { BotMessageTracker } from './channel.js';
import type { LarkTransport } from './lark-transport.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { selectQuotedMessageId } from './quoted-context-loader.js';
import { validateTrackedBotMessageScope } from './message-mutation.js';
import { createDefaultReviewJobs } from './default-review-jobs.js';
import {
  createDirectGithubIssue,
  type GithubIssueLocalCliRunner,
} from './github-issue-service.js';
import {
  createIssueFromProposal,
  createIssueProposal,
  createLowRiskPullRequestFromProposal,
  listVisibleIssueProposals,
  rejectIssueProposal,
  type IssueProposalLocalCliRunner,
} from './issue-proposal-service.js';

const SaveMemoryActionSchema = z.object({
  type: z.literal('save_memory'),
  memory_type: z.enum(['profile', 'chat', 'thread']),
  content: z.string().min(1),
  reason: z.string().min(1),
  tier: z.enum(['public', 'private']).optional(),
  mode: z.enum(['append', 'replace']).optional(),
});

const CreateJobActionSchema = z.object({
  type: z.literal('create_job'),
  name: z.string().min(1),
  job_type: z.enum(['prompt', 'message']),
  schedule: z.string().min(1),
  timezone: z.string().min(1).optional(),
  prompt: z.string().optional(),
  content: z.string().optional(),
  target_chat_id: z.string().optional(),
  model: z.string().optional(),
});

const JobReferenceShape = {
  job_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
};

const ListJobsActionSchema = z.object({
  type: z.literal('list_jobs'),
  status: z.enum(['active', 'paused', 'all']).optional(),
});

const UpdateJobActionSchema = z.object({
  type: z.literal('update_job'),
  ...JobReferenceShape,
  new_name: z.string().min(1).optional(),
  status: z.enum(['active', 'paused']).optional(),
  schedule: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  prompt: z.string().optional(),
  content: z.string().optional(),
  model: z.string().optional(),
});

const DisableJobActionSchema = z.object({
  type: z.literal('disable_job'),
  ...JobReferenceShape,
});

const DeleteJobActionSchema = z.object({
  type: z.literal('delete_job'),
  ...JobReferenceShape,
});

const UpsertJobActionSchema = z.object({
  type: z.literal('upsert_job'),
  name: z.string().min(1),
  job_type: z.enum(['prompt', 'message']),
  schedule: z.string().min(1),
  timezone: z.string().min(1).optional(),
  prompt: z.string().optional(),
  content: z.string().optional(),
  target_chat_id: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

const CreateDefaultReviewJobsActionSchema = z.object({
  type: z.literal('create_default_review_jobs'),
  target_repo: z.string().min(1),
  target_chat_id: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});

const RunLocalCliToolActionSchema = z.object({
  type: z.literal('run_local_cli_tool'),
  tool: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const SendMessageImageSourceSchema = z.enum([
  'local_path',
  'current_message:first_image',
  'quoted_message:first_image',
]);

const SendMessageImagePayloadSchema = z.object({
  kind: z.literal('image'),
  source: SendMessageImageSourceSchema,
  path: z.string().min(1).optional(),
  text: z.string().optional(),
});

const SendMessageFilePayloadSchema = z.object({
  kind: z.literal('file'),
  source: SendMessageImageSourceSchema,
  path: z.string().min(1).optional(),
  text: z.string().optional(),
});

const SendMessageRichPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    source: SendMessageImageSourceSchema,
    path: z.string().min(1).optional(),
    alt: z.string().optional(),
  }),
]);

const SendMessageRichPayloadSchema = z.object({
  kind: z.literal('rich'),
  parts: z.array(SendMessageRichPartSchema).min(1),
});

const SendMessagePayloadSchema = z.discriminatedUnion('kind', [
  SendMessageImagePayloadSchema,
  SendMessageFilePayloadSchema,
  SendMessageRichPayloadSchema,
]);

const SendMessageActionSchema = z.object({
  type: z.literal('send_message'),
  message: SendMessagePayloadSchema,
  reply_in_thread: z.boolean().optional(),
});

const IssueProposalPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const IssueProposalAutomationLevelSchema = z.enum(['discovery-only', 'low-risk-auto-pr-eligible']);
const IssueProposalStatusSchema = z.enum(['pending', 'approved', 'created', 'rejected', 'all']);

const CreateGithubIssueActionSchema = z.object({
  type: z.literal('create_github_issue'),
  title: z.string().min(1),
  body: z.string().min(1),
  target_repo: z.string().min(1),
  tool: z.string().min(1).optional(),
});

const CreateIssueProposalActionSchema = z.object({
  type: z.literal('create_issue_proposal'),
  title: z.string().min(1),
  body: z.string().min(1),
  evidence: z.array(z.string()).optional(),
  impact: z.string().optional(),
  priority: IssueProposalPrioritySchema.optional(),
  automation_level: IssueProposalAutomationLevelSchema.optional(),
  target_repo: z.string().min(1),
  target_chat_id: z.string().min(1).optional(),
});

const ListIssueProposalsActionSchema = z.object({
  type: z.literal('list_issue_proposals'),
  status: IssueProposalStatusSchema.optional(),
});

const RejectIssueProposalActionSchema = z.object({
  type: z.literal('reject_issue_proposal'),
  id: z.string().min(1),
  reason: z.string().optional(),
});

const CreateIssueFromProposalActionSchema = z.object({
  type: z.literal('create_issue_from_proposal'),
  id: z.string().min(1),
  tool: z.string().min(1).optional(),
});

const CreateLowRiskPrFromProposalActionSchema = z.object({
  type: z.literal('create_low_risk_pr_from_proposal'),
  id: z.string().min(1),
  tool: z.string().min(1).optional(),
});

const RecallMessageActionSchema = z.object({
  type: z.literal('recall_message'),
  message_id: z.string().min(1),
});

const CodexExecActionSchema = z.discriminatedUnion('type', [
  SaveMemoryActionSchema,
  CreateJobActionSchema,
  ListJobsActionSchema,
  UpdateJobActionSchema,
  DisableJobActionSchema,
  DeleteJobActionSchema,
  UpsertJobActionSchema,
  CreateDefaultReviewJobsActionSchema,
  RunLocalCliToolActionSchema,
  SendMessageActionSchema,
  CreateGithubIssueActionSchema,
  CreateIssueProposalActionSchema,
  ListIssueProposalsActionSchema,
  RejectIssueProposalActionSchema,
  CreateIssueFromProposalActionSchema,
  CreateLowRiskPrFromProposalActionSchema,
  RecallMessageActionSchema,
]).superRefine((action, ctx) => {
  if (
    (action.type === 'update_job' || action.type === 'disable_job' || action.type === 'delete_job') &&
    !action.job_id &&
    !action.name
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['job_id'],
      message: 'job_id or name is required',
    });
  }

  if (action.type === 'send_message') {
    if (action.message.kind !== 'rich' && action.message.source === 'local_path' && !action.message.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message', 'path'],
        message: 'path is required when source is local_path',
      });
    }
    if (action.message.kind !== 'rich' && action.message.kind === 'file' && action.message.source !== 'local_path') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message', 'source'],
        message: 'file messages only support source local_path',
      });
    }
    if (action.message.kind === 'rich') {
      action.message.parts.forEach((part, index) => {
        if (part.type === 'image' && part.source === 'local_path' && !part.path) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['message', 'parts', index, 'path'],
            message: 'path is required when image source is local_path',
          });
        }
      });
    }
  }

  const schedule =
    action.type === 'create_job' || action.type === 'upsert_job'
      ? action.schedule
      : action.type === 'update_job'
        ? action.schedule
        : undefined;
  const timezone =
    action.type === 'create_job' || action.type === 'upsert_job' || action.type === 'update_job' || action.type === 'create_default_review_jobs'
      ? action.timezone
      : undefined;
  let normalizedTimezone: string | undefined;
  if (timezone !== undefined) {
    try {
      normalizedTimezone = normalizeJobTimezone(timezone);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timezone'],
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
  if (schedule === undefined) return;
  try {
    expandSchedule(schedule, normalizedTimezone);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schedule'],
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

const CodexExecActionEnvelopeSchema = z.object({
  version: z.literal(1),
  reply: z.string().optional(),
  actions: z.array(CodexExecActionSchema).min(1).max(5),
});

export type CodexExecAction = z.infer<typeof CodexExecActionSchema>;

export interface CodexExecActionExecutionResult {
  ok: boolean;
  action: CodexExecAction['type'] | 'action_channel';
  message: string;
}

export interface CodexExecActionEnvelope {
  reply?: string;
  actions: CodexExecAction[];
}

export type CodexExecActionEnvelopeParseResult =
  | { ok: true; envelope: CodexExecActionEnvelope }
  | { ok: false; error: string };

export interface CodexExecActionDispatchRequest {
  message: LarkMessage;
  actions: CodexExecAction[];
}

export interface CodexExecActionDispatcher {
  execute(request: CodexExecActionDispatchRequest): Promise<CodexExecActionExecutionResult[]>;
}

type CodexExecActionTransport =
  & Pick<LarkTransport, 'recallMessage'>
  & Partial<Pick<LarkTransport, 'fetchMessageContext' | 'downloadResource'>>;

export interface CreateCodexExecActionDispatcherOptions {
  memoryStore: MemoryStore;
  identitySession: IdentitySession;
  localCliToolsConfigPath?: string;
  profileDistiller?: ProfileDistillationDispatcher;
  sendReply?: (request: ReplyRequest) => Promise<ReplySendResult>;
  larkTransport?: CodexExecActionTransport | (() => CodexExecActionTransport);
  botMessageTracker?: Pick<BotMessageTracker, 'get'>;
  turnObligations?: Pick<TurnObligationTracker, 'markSatisfied'>;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseCodexExecActionEnvelope(parsed: unknown): CodexExecActionEnvelopeParseResult {
  const envelope = CodexExecActionEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return { ok: false, error: formatZodError(envelope.error) };
  }
  return {
    ok: true,
    envelope: {
      ...(envelope.data.reply !== undefined ? { reply: envelope.data.reply } : {}),
      actions: envelope.data.actions,
    },
  };
}

function currentCaller(
  identitySession: IdentitySession,
  message: LarkMessage,
  action: CodexExecAction['type'],
): { caller: string } | { error: CodexExecActionExecutionResult } {
  const caller = identitySession.getCaller(message.chatId, message.threadId);
  if (!caller) {
    void audit(action, null, { chat_id: message.chatId, thread_id: message.threadId }, 'denied');
    return {
      error: {
        ok: false,
        action,
        message: `No active identity session for chat ${message.chatId}.`,
      },
    };
  }
  return { caller };
}

function isPrivateJobListing(message: LarkMessage): boolean {
  return message.chatType === 'p2p';
}

function formatJobForActionList(job: JobFile, caller: string): string {
  const modelNote = job.meta.model ? ` | model: ${job.meta.model}` : '';
  const tz = jobTimezone(job.meta);
  const lastRun = formatCronDateTime(job.runtime.last_run_at, tz);
  const lastError = job.runtime.last_error ? ` | last_error: ${job.runtime.last_error}` : '';
  const bodyValue = job.meta.type === 'prompt' ? job.meta.prompt : job.meta.content;
  const bodyLabel = job.meta.type === 'prompt' ? 'prompt' : 'content';
  const body = bodyValue
    ? `${bodyLabel}: ${canReadJobBody(job, caller) ? bodyValue : '<redacted>'}`
    : `${bodyLabel}: <empty>`;

  return [
    `job_id: ${job.meta.id}`,
    `name: ${job.meta.name}`,
    `type: ${job.meta.type}`,
    `status: ${job.meta.status}`,
    `schedule: ${job.meta.schedule_human} (${job.meta.schedule})`,
    `timezone: ${tz}`,
    `target_chat_id: ${job.meta.target_chat_id}`,
    `next_run_at: ${formatCronDateTime(job.runtime.next_run_at, tz)}`,
    `last_run_at: ${lastRun}`,
    `run_count: ${job.runtime.run_count}${modelNote}${lastError}`,
    body,
  ].join('\n');
}

async function executeSaveMemory(
  action: z.infer<typeof SaveMemoryActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'save_memory');
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const auditArgs =
    action.memory_type === 'profile'
      ? {
          type: action.memory_type,
          chat_id: message.chatId,
          thread_id: message.threadId,
          tier: action.tier,
          mode: action.mode,
        }
      : { type: action.memory_type, chat_id: message.chatId, thread_id: message.threadId };

  if (action.memory_type === 'profile' && caller === SYSTEM_FLUSH_CALLER) {
    void audit('save_memory', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'save_memory',
      message: 'save_memory(type=profile) denied: caller is the system-flush sentinel.',
    };
  }

  if (action.memory_type === 'profile') {
    const tier = action.tier ?? 'private';
    const mode = action.mode ?? 'append';
    await deps.memoryStore.saveProfile(caller, action.content, tier, mode);
    void audit('save_memory', caller, auditArgs, 'ok');
    return { ok: true, action: 'save_memory', message: `Saved ${tier} profile for ${caller} (mode: ${mode}).` };
  }

  if (action.memory_type === 'thread' && !message.threadId) {
    void audit('save_memory', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'save_memory',
      message: 'save_memory(type=thread) requires the current thread_id.',
    };
  }

  await deps.memoryStore.saveEpisode(action.memory_type, action.content, {
    chatId: message.chatId,
    threadId: message.threadId,
  });
  if (deps.profileDistiller) {
    void deps.profileDistiller
      .maybeDispatch({
        userId: caller,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        chatType: message.chatType === 'p2p' ? 'p2p' : 'group',
      })
      .then((result) => {
        if (result.status === 'error') {
          console.error(`[profile-distill] dispatch failed for ${caller}: ${result.error ?? 'unknown error'}`);
        }
      })
      .catch((err) => logSafeError('[profile-distill] dispatch failed:', err));
  }
  void audit('save_memory', caller, auditArgs, 'ok');
  return { ok: true, action: 'save_memory', message: `Saved ${action.memory_type} episode for chat ${message.chatId}.` };
}

async function executeCreateJob(
  action: z.infer<typeof CreateJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_job');
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const targetChatId = action.target_chat_id ?? message.chatId;
  const auditArgs = {
    name: action.name,
    type: action.job_type,
    schedule: action.schedule,
    timezone: action.timezone,
    target_chat_id: targetChatId,
    model: action.model,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };

  const created = await createJob({
    name: action.name,
    type: action.job_type,
    schedule: action.schedule,
    timezone: action.timezone,
    prompt: action.prompt,
    content: action.content,
    targetChatId,
    model: action.model,
    originChatId: message.chatId,
    caller,
    auditAction: 'create_job',
    auditArgs,
  });
  if (!created.ok) {
    let error = created.message;
    if (created.code === 'missing_prompt') error = 'prompt is required for job_type=prompt.';
    if (created.code === 'missing_content') error = 'content is required for job_type=message.';
    if (created.code === 'invalid_timezone') error = created.message.replace(/^Invalid timezone: /, 'Invalid schedule expression: ');
    return { ok: false, action: 'create_job', message: error };
  }

  return {
    ok: true,
    action: 'create_job',
    message: `Created job "${created.job.meta.id}" (job_id: ${created.job.meta.id}, ${created.scheduleHuman}, tz=${created.timezone}). Next run: ${formatCronDateTime(created.nextRunAt, created.timezone)}`,
  };
}

async function executeListJobs(
  action: z.infer<typeof ListJobsActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'list_jobs');
  const status = action.status ?? 'all';
  const auditArgs = { status, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const listed = await listVisibleJobs({
    caller,
    chatId: message.chatId,
    isPrivateChat: isPrivateJobListing(message),
    status,
    auditArgs,
  });
  if (!listed.ok) return { ok: false, action: 'list_jobs', message: listed.message };
  const { jobs: visible } = listed;

  if (visible.length === 0) {
    return { ok: true, action: 'list_jobs', message: 'No jobs found.' };
  }

  return {
    ok: true,
    action: 'list_jobs',
    message: visible.map((job) => formatJobForActionList(job, caller)).join('\n\n---\n\n'),
  };
}

async function executeUpdateJob(
  action: z.infer<typeof UpdateJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'update_job');
  const auditArgs = {
    job_id: action.job_id,
    name: action.name,
    new_name: action.new_name,
    status: action.status,
    schedule: action.schedule,
    timezone: action.timezone,
    model: action.model,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const updated = await updateJob({
    action: 'update_job',
    caller,
    reference: { jobId: action.job_id, name: action.name },
    updates: {
      name: action.new_name,
      status: action.status,
      schedule: action.schedule,
      timezone: action.timezone,
      prompt: action.prompt,
      content: action.content,
      model: action.model,
    },
    auditArgs,
  });
  if (!updated.ok) return { ok: false, action: 'update_job', message: updated.message };

  return {
    ok: true,
    action: 'update_job',
    message: `Updated job "${updated.job.meta.id}" (job_id: ${updated.job.meta.id}). Status: ${updated.job.meta.status}, Schedule: ${updated.job.meta.schedule_human}, TZ: ${jobTimezone(updated.job.meta)}, Next run: ${formatCronDateTime(updated.job.runtime.next_run_at, jobTimezone(updated.job.meta))}`,
  };
}

async function executeDisableJob(
  action: z.infer<typeof DisableJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'disable_job');
  const auditArgs = { job_id: action.job_id, name: action.name, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const updated = await updateJob({
    action: 'disable_job',
    caller,
    reference: { jobId: action.job_id, name: action.name },
    updates: { status: 'paused' },
    auditArgs,
  });
  if (!updated.ok) return { ok: false, action: 'disable_job', message: updated.message };

  return {
    ok: true,
    action: 'disable_job',
    message: `Updated job "${updated.job.meta.id}" (job_id: ${updated.job.meta.id}). Status: ${updated.job.meta.status}, Next run: ${formatCronDateTime(updated.job.runtime.next_run_at, jobTimezone(updated.job.meta))}`,
  };
}

async function executeDeleteJob(
  action: z.infer<typeof DeleteJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'delete_job');
  const auditArgs = { job_id: action.job_id, name: action.name, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const deleted = await deleteJob({
    caller,
    reference: { jobId: action.job_id, name: action.name },
    auditArgs,
  });
  if (!deleted.ok) return { ok: false, action: 'delete_job', message: deleted.message };

  return { ok: true, action: 'delete_job', message: `Deleted job "${deleted.jobId}".` };
}

async function executeUpsertJob(
  action: z.infer<typeof UpsertJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'upsert_job');
  const targetChatId = action.target_chat_id ?? message.chatId;
  const auditArgs = {
    name: action.name,
    type: action.job_type,
    schedule: action.schedule,
    timezone: action.timezone,
    target_chat_id: targetChatId,
    model: action.model,
    status: action.status,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const upserted = await upsertJob({
    name: action.name,
    type: action.job_type,
    schedule: action.schedule,
    timezone: action.timezone,
    prompt: action.prompt,
    content: action.content,
    targetChatId,
    model: action.model,
    status: action.status,
    originChatId: message.chatId,
    caller,
    auditArgs,
  });
  if (!upserted.ok) {
    let error = upserted.message;
    if (upserted.code === 'missing_prompt') error = 'prompt is required for job_type=prompt.';
    if (upserted.code === 'missing_content') error = 'content is required for job_type=message.';
    if (upserted.code === 'invalid_timezone') error = upserted.message.replace(/^Invalid timezone: /, 'Invalid schedule expression: ');
    return { ok: false, action: 'upsert_job', message: error };
  }

  return {
    ok: true,
    action: 'upsert_job',
    message: `Upserted job "${upserted.job.meta.id}" (job_id: ${upserted.job.meta.id}, ${upserted.scheduleHuman}, tz=${upserted.timezone}). Status: ${upserted.job.meta.status}, Next run: ${formatCronDateTime(upserted.nextRunAt, upserted.timezone)}`,
  };
}

async function executeRunLocalCliTool(
  action: z.infer<typeof RunLocalCliToolActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const result = await runConfiguredLocalCliTool({
    identitySession: deps.identitySession,
    tool: action.tool,
    args: action.args ?? [],
    chat_id: message.chatId,
    thread_id: message.threadId,
    configPath: deps.localCliToolsConfigPath,
  });
  return { ok: result.ok, action: 'run_local_cli_tool', message: result.message };
}

async function executeCreateDefaultReviewJobs(
  action: z.infer<typeof CreateDefaultReviewJobsActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_default_review_jobs');
  const targetChatId = action.target_chat_id ?? message.chatId;
  const auditArgs = {
    target_repo: action.target_repo,
    target_chat_id: targetChatId,
    timezone: action.timezone,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  try {
    assertSafeChatId(targetChatId);
  } catch (err: any) {
    return { ok: false, action: 'create_default_review_jobs', message: `Invalid target_chat_id: ${err?.message ?? targetChatId}` };
  }
  try {
    const result = await createDefaultReviewJobs({
      targetRepo: action.target_repo,
      targetChatId,
      originChatId: message.chatId,
      createdBy: caller,
      timezone: action.timezone,
    });
    void audit('create_default_review_jobs', caller, auditArgs, 'ok');
    return {
      ok: true,
      action: 'create_default_review_jobs',
      message: [
        `Created default review jobs: ${result.created.length ? result.created.join(', ') : 'none'}.`,
        result.skipped.length ? `Skipped existing jobs: ${result.skipped.join(', ')}.` : '',
        'These jobs are disabled by default (status=paused). Resume them explicitly before they run.',
      ].filter(Boolean).join('\n'),
    };
  } catch (err: any) {
    void audit('create_default_review_jobs', caller, auditArgs, 'error');
    return {
      ok: false,
      action: 'create_default_review_jobs',
      message: `Failed to create default review jobs: ${err?.message ?? String(err)}`,
    };
  }
}

function createIssueProposalLocalCliRunner(
  deps: CreateCodexExecActionDispatcherOptions,
  message: LarkMessage,
): IssueProposalLocalCliRunner {
  return (tool, args) =>
    runConfiguredLocalCliTool({
      identitySession: deps.identitySession,
      tool,
      args,
      chat_id: message.chatId,
      thread_id: message.threadId,
      configPath: deps.localCliToolsConfigPath,
    });
}

function createGithubIssueLocalCliRunner(
  deps: CreateCodexExecActionDispatcherOptions,
  message: LarkMessage,
): GithubIssueLocalCliRunner {
  return (tool, args) =>
    runConfiguredLocalCliTool({
      identitySession: deps.identitySession,
      tool,
      args,
      chat_id: message.chatId,
      thread_id: message.threadId,
      configPath: deps.localCliToolsConfigPath,
    });
}

async function executeCreateGithubIssue(
  action: z.infer<typeof CreateGithubIssueActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_github_issue');
  const tool = action.tool;
  const auditArgs = {
    title: action.title,
    target_repo: action.target_repo,
    tool: tool ?? '<builtin>',
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const result = await createDirectGithubIssue({
    title: action.title,
    body: action.body,
    targetRepo: action.target_repo,
    caller,
    tool,
    runLocalCli: createGithubIssueLocalCliRunner(deps, message),
    auditArgs,
  });
  return { ok: result.ok, action: 'create_github_issue', message: result.message };
}

async function executeCreateIssueProposal(
  action: z.infer<typeof CreateIssueProposalActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_issue_proposal');
  const auditArgs = {
    title: action.title,
    priority: action.priority,
    automation_level: action.automation_level,
    target_repo: action.target_repo,
    target_chat_id: action.target_chat_id,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const result = await createIssueProposal({
    title: action.title,
    body: action.body,
    evidence: action.evidence,
    impact: action.impact,
    priority: action.priority,
    automationLevel: action.automation_level,
    targetRepo: action.target_repo,
    targetChatId: action.target_chat_id ?? message.chatId,
    originChatId: message.chatId,
    caller,
    auditArgs,
  });
  if (!result.ok) {
    return { ok: false, action: 'create_issue_proposal', message: result.message };
  }
  return {
    ok: true,
    action: 'create_issue_proposal',
    message: `Created issue proposal "${result.proposal.meta.id}". Wait for explicit maintainer approval before filing a GitHub issue.`,
  };
}

async function executeListIssueProposals(
  action: z.infer<typeof ListIssueProposalsActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'list_issue_proposals');
  const status = action.status ?? 'pending';
  const auditArgs = { status, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const result = await listVisibleIssueProposals({
    caller,
    chatId: message.chatId,
    isPrivateChat: message.chatType === 'p2p',
    status,
    auditArgs,
  });
  if (!result.ok) return { ok: false, action: 'list_issue_proposals', message: result.message };
  return {
    ok: true,
    action: 'list_issue_proposals',
    message: result.message,
  };
}

async function executeRejectIssueProposal(
  action: z.infer<typeof RejectIssueProposalActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'reject_issue_proposal');
  const auditArgs = { id: action.id, reason: action.reason, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const result = await rejectIssueProposal({
    id: action.id,
    reason: action.reason,
    caller,
    auditArgs,
  });
  return { ok: result.ok, action: 'reject_issue_proposal', message: result.message };
}

async function executeCreateIssueFromProposal(
  action: z.infer<typeof CreateIssueFromProposalActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_issue_from_proposal');
  const tool = action.tool;
  const auditArgs = { id: action.id, tool: tool ?? '<builtin>', chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const result = await createIssueFromProposal({
    id: action.id,
    caller,
    tool,
    runLocalCli: createIssueProposalLocalCliRunner(deps, message),
    auditArgs,
  });
  return { ok: result.ok, action: 'create_issue_from_proposal', message: result.message };
}

async function executeCreateLowRiskPrFromProposal(
  action: z.infer<typeof CreateLowRiskPrFromProposalActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_low_risk_pr_from_proposal');
  const tool = action.tool ?? 'gh_low_risk_pr_create';
  const auditArgs = { id: action.id, tool, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const result = await createLowRiskPullRequestFromProposal({
    id: action.id,
    caller,
    tool,
    runLocalCli: createIssueProposalLocalCliRunner(deps, message),
    auditArgs,
  });
  return { ok: result.ok, action: 'create_low_risk_pr_from_proposal', message: result.message };
}

function resolveRecallTransport(
  transport: CreateCodexExecActionDispatcherOptions['larkTransport'],
): Pick<LarkTransport, 'recallMessage'> | undefined {
  return typeof transport === 'function' ? transport() : transport;
}

function resolveActionTransport(
  transport: CreateCodexExecActionDispatcherOptions['larkTransport'],
): CodexExecActionTransport | undefined {
  return typeof transport === 'function' ? transport() : transport;
}

function resolveSendMessageLocalPath(rawPath: string): string {
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(appConfig.codexExecCwd, rawPath);
}

function firstCurrentMessageImagePath(message: LarkMessage): string | null {
  return message.imagePath ?? message.imagePaths?.[0] ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeQuotedResourceName(value: string): string {
  return value.replace(/[\\/:\0]/g, '_').slice(0, 120) || 'quoted-image.png';
}

async function downloadQuotedMessageFirstImage(
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<{ ok: true; path: string } | { ok: false; result: CodexExecActionExecutionResult }> {
  const quotedMessageId = selectQuotedMessageId(message);
  if (!quotedMessageId) {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: 'No quoted message is available for source quoted_message:first_image.',
      },
    };
  }

  const transport = resolveActionTransport(deps.larkTransport);
  if (!transport?.fetchMessageContext || !transport.downloadResource) {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: 'quoted_message:first_image is unavailable: Lark message fetch/download transport is not configured.',
      },
    };
  }
  const fetchMessageContext = transport.fetchMessageContext.bind(transport);
  const downloadResource = transport.downloadResource.bind(transport);

  let fetched;
  try {
    fetched = await fetchMessageContext(quotedMessageId);
  } catch (err) {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: `Failed to fetch quoted message ${quotedMessageId}: ${errorMessage(err)}`,
      },
    };
  }

  const image = fetched?.attachments?.find((attachment) => attachment.fileType === 'image' && attachment.fileKey);
  if (!image) {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: `Quoted message ${quotedMessageId} has no downloadable image attachment.`,
      },
    };
  }

  const downloaded = await downloadInboundResource({ downloadResource }, {
    messageId: fetched?.messageId || quotedMessageId,
    fileKey: image.fileKey,
    resourceType: 'image',
    fileName: `${Date.now()}-${safeQuotedResourceName(image.fileKey)}-${safeQuotedResourceName(image.fileName || 'image.png')}`,
    logPrefix: '[codex-exec-send-message]',
  });
  if (!downloaded) {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: `Failed to download first image from quoted message ${quotedMessageId}.`,
      },
    };
  }
  return { ok: true, path: downloaded };
}

async function resolveSendMessageImagePath(
  source: 'local_path' | 'current_message:first_image' | 'quoted_message:first_image',
  rawPath: string | undefined,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<{ ok: true; path: string } | { ok: false; result: CodexExecActionExecutionResult }> {
  let filePath: string;
  if (source === 'quoted_message:first_image') {
    return downloadQuotedMessageFirstImage(message, deps);
  } else if (source === 'current_message:first_image') {
    const currentImagePath = firstCurrentMessageImagePath(message);
    if (!currentImagePath) {
      return {
        ok: false,
        result: {
          ok: false,
          action: 'send_message',
          message: 'No current-message image is available for source current_message:first_image.',
        },
      };
    }
    filePath = currentImagePath;
  } else {
    filePath = resolveSendMessageLocalPath(rawPath!);
  }

  try {
    await fs.access(filePath);
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        action: 'send_message',
        message: `Local image file is not readable: ${filePath}`,
      },
    };
  }
  return { ok: true, path: filePath };
}

async function resolveSendMessageRichParts(
  action: z.infer<typeof SendMessageRichPayloadSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<{ ok: true; parts: ReplyRichPart[]; imageCount: number } | { ok: false; result: CodexExecActionExecutionResult }> {
  const parts: ReplyRichPart[] = [];
  let imageCount = 0;
  for (const part of action.parts) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    const resolved = await resolveSendMessageImagePath(part.source, part.path, message, deps);
    if (!resolved.ok) return resolved;
    parts.push({ type: 'image', path: resolved.path, ...(part.alt ? { alt: part.alt } : {}) });
    imageCount++;
  }
  return { ok: true, parts, imageCount };
}

async function executeSendMessage(
  action: z.infer<typeof SendMessageActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  if (!deps.sendReply) {
    return {
      ok: false,
      action: 'send_message',
      message: 'send_message is unavailable: reply sender is not configured.',
    };
  }
  if (message.chatType === 'doc_comment') {
    return {
      ok: false,
      action: 'send_message',
      message: 'send_message is not supported for Feishu document comments.',
    };
  }

  if (action.message.kind === 'rich') {
    const resolved = await resolveSendMessageRichParts(action.message, message, deps);
    if (!resolved.ok) return resolved.result;
    let result: ReplySendResult;
    try {
      result = await deps.sendReply({
        chat_id: message.chatId,
        text: '',
        reply_to: message.messageId,
        ...(action.reply_in_thread === false ? {} : message.threadId ? { thread_id: message.threadId } : {}),
        richParts: resolved.parts,
      });
    } catch (err) {
      return {
        ok: false,
        action: 'send_message',
        message: `send_message delivery failed: ${errorMessage(err)}`,
      };
    }
    if (result.isError) {
      return {
        ok: false,
        action: 'send_message',
        message: result.errorText ?? result.statusText,
      };
    }
    if (result.sentCount < 1) {
      return {
        ok: false,
        action: 'send_message',
        message: `Rich message was not delivered: ${result.statusText}`,
      };
    }
    if (resolved.imageCount > 0 && (result.fileSentCount ?? 0) < resolved.imageCount) {
      return {
        ok: false,
        action: 'send_message',
        message: `Not all rich message images were delivered: ${result.statusText}`,
      };
    }
    return {
      ok: true,
      action: 'send_message',
      message: `Sent rich message via ${result.richDeliveryMode ?? 'reply'} (${result.statusText}).`,
    };
  }

  let filePath: string;
  if (action.message.kind === 'image') {
    const resolved = await resolveSendMessageImagePath(action.message.source, action.message.path, message, deps);
    if (!resolved.ok) return resolved.result;
    filePath = resolved.path;
  } else {
    filePath = resolveSendMessageLocalPath(action.message.path!);
    try {
      await fs.access(filePath);
    } catch {
      return {
        ok: false,
        action: 'send_message',
        message: `Local ${action.message.kind} file is not readable: ${filePath}`,
      };
    }
  }

  let result: ReplySendResult;
  try {
    result = await deps.sendReply({
      chat_id: message.chatId,
      text: action.message.text ?? '',
      reply_to: message.messageId,
      ...(action.reply_in_thread === false ? {} : message.threadId ? { thread_id: message.threadId } : {}),
      files: [{ path: filePath, type: action.message.kind }],
    });
  } catch (err) {
    return {
      ok: false,
      action: 'send_message',
      message: `send_message delivery failed: ${errorMessage(err)}`,
    };
  }
  if (result.isError) {
    return {
      ok: false,
      action: 'send_message',
      message: result.errorText ?? result.statusText,
    };
  }
  if ((result.fileSentCount ?? 0) < 1) {
    return {
      ok: false,
      action: 'send_message',
      message: `Media was not delivered: ${result.statusText}`,
    };
  }
  return {
    ok: true,
    action: 'send_message',
    message: `Sent ${action.message.kind} via plugin reply path (${result.statusText}).`,
  };
}

async function executeRecallMessage(
  action: z.infer<typeof RecallMessageActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'recall_message');
  const auditArgs = { message_id: action.message_id, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const tracked = validateTrackedBotMessageScope({
    toolName: 'recall_message',
    messageId: action.message_id,
    chatId: message.chatId,
    threadId: message.threadId,
    botMessageTracker: deps.botMessageTracker,
  });
  if (!tracked.ok) {
    void audit('recall_message', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'recall_message',
      message: tracked.message,
    };
  }

  const transport = resolveRecallTransport(deps.larkTransport);
  if (!transport?.recallMessage) {
    void audit('recall_message', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'recall_message',
      message: 'recall_message is not configured for this runtime.',
    };
  }

  try {
    await transport.recallMessage(action.message_id);
  } catch (err) {
    void audit('recall_message', caller, auditArgs, 'error');
    return {
      ok: false,
      action: 'recall_message',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  deps.turnObligations?.markSatisfied(message.messageId, 'recall_message');
  void audit('recall_message', caller, auditArgs, 'ok');
  return { ok: true, action: 'recall_message', message: `Recalled message ${action.message_id}.` };
}

export function formatCodexExecActionResults(results: CodexExecActionExecutionResult[]): string {
  return results
    .map((result) => `${result.ok ? 'OK' : 'ERROR'} ${result.action}: ${result.message}`)
    .join('\n');
}

export function createCodexExecActionDispatcher(
  deps: CreateCodexExecActionDispatcherOptions,
): CodexExecActionDispatcher {
  return {
    async execute(request) {
      const results: CodexExecActionExecutionResult[] = [];
      for (const action of request.actions) {
        if (action.type === 'save_memory') {
          results.push(await executeSaveMemory(action, request.message, deps));
        } else if (action.type === 'create_job') {
          results.push(await executeCreateJob(action, request.message, deps));
        } else if (action.type === 'list_jobs') {
          results.push(await executeListJobs(action, request.message, deps));
        } else if (action.type === 'update_job') {
          results.push(await executeUpdateJob(action, request.message, deps));
        } else if (action.type === 'disable_job') {
          results.push(await executeDisableJob(action, request.message, deps));
        } else if (action.type === 'delete_job') {
          results.push(await executeDeleteJob(action, request.message, deps));
        } else if (action.type === 'upsert_job') {
          results.push(await executeUpsertJob(action, request.message, deps));
        } else if (action.type === 'create_default_review_jobs') {
          results.push(await executeCreateDefaultReviewJobs(action, request.message, deps));
        } else if (action.type === 'create_github_issue') {
          results.push(await executeCreateGithubIssue(action, request.message, deps));
        } else if (action.type === 'create_issue_proposal') {
          results.push(await executeCreateIssueProposal(action, request.message, deps));
        } else if (action.type === 'list_issue_proposals') {
          results.push(await executeListIssueProposals(action, request.message, deps));
        } else if (action.type === 'reject_issue_proposal') {
          results.push(await executeRejectIssueProposal(action, request.message, deps));
        } else if (action.type === 'create_issue_from_proposal') {
          results.push(await executeCreateIssueFromProposal(action, request.message, deps));
        } else if (action.type === 'create_low_risk_pr_from_proposal') {
          results.push(await executeCreateLowRiskPrFromProposal(action, request.message, deps));
        } else if (action.type === 'send_message') {
          results.push(await executeSendMessage(action, request.message, deps));
        } else if (action.type === 'recall_message') {
          results.push(await executeRecallMessage(action, request.message, deps));
        } else {
          results.push(await executeRunLocalCliTool(action, request.message, deps));
        }
      }
      return results;
    },
  };
}
