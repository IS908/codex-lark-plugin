import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import type { LarkMessage } from './lark-message.js';
import type { ReplyRequest, ReplyRichPart, ReplySendResult } from './reply-sender.js';
import { downloadInboundResource } from './inbound-attachment-downloader.js';
import type { IdentitySession } from './identity-session.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import type { MemoryStore } from './memory/file.js';
import {
  expandSchedule,
  formatCronDateTime,
  jobTimezone,
  normalizeJobTimezone,
  readJob,
  sanitizeJobId,
  type JobFile,
} from './job-store.js';
import {
  canReadJobBody,
  createJob,
  deleteJob,
  formatJobNextRun,
  listVisibleJobs,
  updateJob,
  upsertJob,
} from './job-service.js';
import { runConfiguredLocalCliTool } from './local-cli-tools.js';
import {
  ACCESS_CONTROL_LISTS,
  accessControlStore,
  type AccessControlAction,
  type AccessControlListName,
} from './runtime-access-control.js';
import {
  formatAccessControlMutationMessage,
  validateAccessControlMutation,
  type AccessControlValidationInput,
} from './access-control-validation.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';
import type { BotMessageTracker } from './message-trackers.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { selectQuotedMessageId } from './quoted-context-loader.js';
import { validateTrackedBotMessageScope } from './message-mutation.js';
import { queryRunTrace } from './run-trace-query.js';

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

const RunLocalCliToolActionSchema = z.object({
  type: z.literal('run_local_cli_tool'),
  tool: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const ManageAccessControlActionSchema = z.object({
  type: z.literal('manage_access_control'),
  action: z.enum(['list', 'add', 'remove']).default('list'),
  list: z.enum(ACCESS_CONTROL_LISTS).optional(),
  value: z.string().min(1).optional(),
});

const GetRunTraceActionSchema = z.object({
  type: z.literal('get_run_trace'),
  source: z.enum(['message', 'cronjob']),
  target: z.enum(['current', 'quoted']).optional(),
  log_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  within_hours: z.number().positive().max(168).optional(),
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
  RunLocalCliToolActionSchema,
  ManageAccessControlActionSchema,
  GetRunTraceActionSchema,
  SendMessageActionSchema,
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

  if (action.type === 'manage_access_control' && action.action !== 'list') {
    if (!action.list) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['list'],
        message: 'list is required for add/remove',
      });
    }
    if (!action.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value is required for add/remove',
      });
    }
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

  if (action.type === 'get_run_trace' && action.source !== 'message' && action.target) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'target is only supported when source=message',
    });
  }

  const schedule =
    action.type === 'create_job' || action.type === 'upsert_job'
      ? action.schedule
      : action.type === 'update_job'
        ? action.schedule
        : undefined;
  const timezone =
    action.type === 'create_job' || action.type === 'upsert_job' || action.type === 'update_job'
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
  validateChatAccess?: AccessControlValidationInput['validateChatAccess'];
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
    `next_run_at: ${formatJobNextRun(job, tz)}`,
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
    message: `Updated job "${updated.job.meta.id}" (job_id: ${updated.job.meta.id}). Status: ${updated.job.meta.status}, Schedule: ${updated.job.meta.schedule_human}, TZ: ${jobTimezone(updated.job.meta)}, Next run: ${formatJobNextRun(updated.job)}`,
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
    message: `Updated job "${updated.job.meta.id}" (job_id: ${updated.job.meta.id}). Status: ${updated.job.meta.status}, Next run: ${formatJobNextRun(updated.job)}`,
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
    message: `Upserted job "${upserted.job.meta.id}" (job_id: ${upserted.job.meta.id}, ${upserted.scheduleHuman}, tz=${upserted.timezone}). Status: ${upserted.job.meta.status}, Next run: ${formatJobNextRun(upserted.job, upserted.timezone)}`,
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

async function executeManageAccessControl(
  action: z.infer<typeof ManageAccessControlActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'manage_access_control');
  const auditArgs = {
    action: action.action,
    list: action.list,
    value: action.value,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  if (!appConfig.ownerOpenId || caller !== appConfig.ownerOpenId) {
    await audit('manage_access_control', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'manage_access_control',
      message: 'manage_access_control is owner-only. Set LARK_OWNER_OPEN_ID and call from that owner identity.',
    };
  }

  if (action.action === 'list') {
    await audit('manage_access_control', caller, auditArgs, 'ok');
    return {
      ok: true,
      action: 'manage_access_control',
      message: JSON.stringify(accessControlStore.snapshot(), null, 2),
    };
  }

  try {
    const validated = await validateAccessControlMutation({
      action: action.action as AccessControlAction,
      list: action.list as AccessControlListName,
      value: action.value!,
      currentChatId: message.chatId,
      currentChatType: message.chatType,
      validateChatAccess: deps.validateChatAccess,
    });
    const result = await accessControlStore.mutate({
      action: validated.action,
      list: validated.list,
      value: validated.value,
      updatedBy: caller,
    });
    await audit('manage_access_control', caller, auditArgs, 'ok');
    return {
      ok: true,
      action: 'manage_access_control',
      message: formatAccessControlMutationMessage(
        result.changed,
        validated.action,
        validated.list,
        validated.value,
      ),
    };
  } catch (err) {
    await audit('manage_access_control', caller, auditArgs, 'error');
    return {
      ok: false,
      action: 'manage_access_control',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseCronJobIdFromThreadId(threadId: string | undefined): string | null {
  if (!threadId?.startsWith('job-')) return null;
  const rest = threadId.slice('job-'.length);
  const current = rest.match(/^(.+)-[a-f0-9]{12}-\d{10,}$/);
  if (current?.[1]) return current[1];
  const legacy = rest.match(/^(.+)-\d{10,}$/);
  return legacy?.[1] ?? null;
}

function normalizeTraceWithinHours(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 12;
  return Math.max(1, Math.min(168, Math.floor(value)));
}

function formatGetRunTraceFailure(
  action: z.infer<typeof GetRunTraceActionSchema>,
  status: 'invalid_request' | 'not_found' | 'unauthorized',
  message: string,
): string {
  return JSON.stringify({
    status,
    log_id: action.log_id?.trim() || '-',
    ...(action.run_id ? { run_id: action.run_id } : {}),
    within_hours: normalizeTraceWithinHours(action.within_hours),
    tools: [],
    truncated: false,
    message,
  }, null, 2);
}

function resolveMessageTraceLogId(
  action: z.infer<typeof GetRunTraceActionSchema>,
  message: LarkMessage,
): { ok: true; logId: string } | { ok: false; message: string; denied?: boolean } {
  const quotedMessageId = selectQuotedMessageId(message);
  const allowedLogIds = new Set([message.messageId, quotedMessageId].filter((value): value is string => !!value));
  let logId = action.log_id?.trim();
  if (!logId) {
    logId = action.target === 'quoted' ? quotedMessageId : message.messageId;
  }
  if (!logId) {
    return { ok: false, message: 'No quoted message is available for get_run_trace target=quoted.' };
  }
  if (!allowedLogIds.has(logId)) {
    return {
      ok: false,
      denied: true,
      message: 'get_run_trace(source=message) can only read the current message trace or the quoted message trace.',
    };
  }
  return { ok: true, logId };
}

async function resolveCronJobTraceLogId(
  action: z.infer<typeof GetRunTraceActionSchema>,
  message: LarkMessage,
  caller: string,
): Promise<{ ok: true; logId: string } | { ok: false; message: string; denied?: boolean }> {
  const logId = action.log_id?.trim() || parseCronJobIdFromThreadId(message.threadId) || undefined;
  if (!logId) {
    return {
      ok: false,
      message: 'get_run_trace(source=cronjob) requires log_id unless the current turn is a cronjob execution.',
    };
  }
  if (sanitizeJobId(logId) !== logId) {
    return {
      ok: false,
      denied: true,
      message: 'get_run_trace(source=cronjob) requires a stable job_id, not a path, display name, or arbitrary log id.',
    };
  }

  const job = await readJob(logId);
  if (!job) {
    return { ok: false, message: `Cronjob ${logId} was not found.` };
  }

  const canRead =
    caller === job.meta.created_by ||
    (!!appConfig.ownerOpenId && caller === appConfig.ownerOpenId) ||
    message.chatId === job.meta.target_chat_id;
  if (!canRead) {
    return {
      ok: false,
      denied: true,
      message: `get_run_trace(source=cronjob) denied for job ${logId}.`,
    };
  }
  return { ok: true, logId };
}

async function executeGetRunTrace(
  action: z.infer<typeof GetRunTraceActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'get_run_trace');
  const auditArgs = {
    source: action.source,
    target: action.target,
    log_id: action.log_id,
    run_id: action.run_id,
    within_hours: action.within_hours,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const resolved = action.source === 'message'
    ? resolveMessageTraceLogId(action, message)
    : await resolveCronJobTraceLogId(action, message, caller);
  if (!resolved.ok) {
    void audit('get_run_trace', caller, auditArgs, resolved.denied ? 'denied' : 'error');
    const status = resolved.denied
      ? 'unauthorized'
      : /not found/i.test(resolved.message)
        ? 'not_found'
        : 'invalid_request';
    return {
      ok: false,
      action: 'get_run_trace',
      message: formatGetRunTraceFailure(action, status, resolved.message),
    };
  }

  const result = await queryRunTrace({
    logId: resolved.logId,
    runId: action.run_id,
    withinHours: action.within_hours,
  });
  void audit(
    'get_run_trace',
    caller,
    { ...auditArgs, log_id: resolved.logId, status: result.status, tool_calls: result.tools.length },
    result.status === 'ok' ? 'ok' : result.status === 'disabled' ? 'denied' : 'error',
  );

  return {
    ok: result.status === 'ok',
    action: 'get_run_trace',
    message: JSON.stringify(result, null, 2),
  };
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
        } else if (action.type === 'manage_access_control') {
          results.push(await executeManageAccessControl(action, request.message, deps));
        } else if (action.type === 'get_run_trace') {
          results.push(await executeGetRunTrace(action, request.message, deps));
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
