import { z } from 'zod';
import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import type { LarkMessage } from './channel.js';
import type { IdentitySession } from './identity-session.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import type { MemoryStore } from './memory/file.js';
import { assertSafeChatId } from './prompts.js';
import {
  computeNextRun,
  deleteJob as deleteJobFile,
  expandSchedule,
  formatCronDateTime,
  jobTimezone,
  jobExists,
  listAllJobs,
  mutateJob,
  normalizeJobTimezone,
  readJob,
  sanitizeJobId,
  writeJob,
  type JobFile,
} from './job-store.js';
import { findLarkDeferSentinel } from './turn-obligation.js';
import { runConfiguredLocalCliTool } from './local-cli-tools.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';
import type { BotMessageTracker } from './channel.js';
import type { LarkTransport } from './lark-transport.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { validateTrackedBotMessageScope } from './message-mutation.js';
import { createDefaultReviewJobs } from './default-review-jobs.js';
import {
  createIssueProposal,
  extractGithubIssueUrl,
  formatIssueProposalForList,
  formatIssueProposalIssueBody,
  listIssueProposals,
  markIssueProposalApproved,
  markIssueProposalCreated,
  readIssueProposal,
  rejectIssueProposal,
  type IssueProposalFile,
} from './issue-proposal-store.js';

export const CODEX_EXEC_ACTIONS_START = '<LARK_ACTIONS_JSON>';
export const CODEX_EXEC_ACTIONS_END = '</LARK_ACTIONS_JSON>';

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

const IssueProposalPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const IssueProposalAutomationLevelSchema = z.enum(['discovery-only', 'low-risk-auto-pr-eligible']);
const IssueProposalStatusSchema = z.enum(['pending', 'approved', 'created', 'rejected', 'all']);

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
  CreateIssueProposalActionSchema,
  ListIssueProposalsActionSchema,
  RejectIssueProposalActionSchema,
  CreateIssueFromProposalActionSchema,
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
  action: CodexExecAction['type'];
  message: string;
}

export type CodexExecParsedOutput =
  | { kind: 'reply'; replyText: string; actions: [] }
  | { kind: 'defer'; replyText: string; actions: [] }
  | { kind: 'actions'; replyText: string; actions: CodexExecAction[] }
  | { kind: 'invalid_actions'; replyText: string; actions: []; error: string };

export interface CodexExecActionDispatchRequest {
  message: LarkMessage;
  actions: CodexExecAction[];
}

export interface CodexExecActionDispatcher {
  execute(request: CodexExecActionDispatchRequest): Promise<CodexExecActionExecutionResult[]>;
}

export interface CreateCodexExecActionDispatcherOptions {
  memoryStore: MemoryStore;
  identitySession: IdentitySession;
  localCliToolsConfigPath?: string;
  profileDistiller?: ProfileDistillationDispatcher;
  larkTransport?: Pick<LarkTransport, 'recallMessage'> | (() => Pick<LarkTransport, 'recallMessage'>);
  botMessageTracker?: Pick<BotMessageTracker, 'get'>;
  turnObligations?: Pick<TurnObligationTracker, 'markSatisfied'>;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseCodexExecActionOutput(text: string): CodexExecParsedOutput {
  const firstStart = text.indexOf(CODEX_EXEC_ACTIONS_START);
  if (firstStart < 0) {
    return findLarkDeferSentinel(text)
      ? { kind: 'defer', replyText: text.trim(), actions: [] }
      : { kind: 'reply', replyText: text.trim(), actions: [] };
  }

  const secondStart = text.indexOf(CODEX_EXEC_ACTIONS_START, firstStart + CODEX_EXEC_ACTIONS_START.length);
  if (secondStart >= 0) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'multiple Lark action blocks are not allowed',
    };
  }

  const end = text.indexOf(CODEX_EXEC_ACTIONS_END, firstStart + CODEX_EXEC_ACTIONS_START.length);
  if (end < 0) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'missing closing Lark action block marker',
    };
  }

  const trailing = text.slice(end + CODEX_EXEC_ACTIONS_END.length).trim();
  if (trailing) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'text after the Lark action block is not allowed',
    };
  }

  const rawJson = text.slice(firstStart + CODEX_EXEC_ACTIONS_START.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const envelope = CodexExecActionEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: formatZodError(envelope.error),
    };
  }

  return {
    kind: 'actions',
    replyText: text.slice(0, firstStart).trim() || envelope.data.reply?.trim() || '',
    actions: envelope.data.actions,
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

type JobReferenceAction =
  | z.infer<typeof UpdateJobActionSchema>
  | z.infer<typeof DisableJobActionSchema>
  | z.infer<typeof DeleteJobActionSchema>;

function isPrivateJobListing(message: LarkMessage): boolean {
  return message.chatType === 'p2p';
}

function jobVisibleToCaller(job: JobFile, message: LarkMessage, caller: string): boolean {
  if (isPrivateJobListing(message)) return job.meta.created_by === caller;
  return job.meta.target_chat_id === message.chatId;
}

function formatJobForActionList(job: JobFile, caller: string): string {
  const modelNote = job.meta.model ? ` | model: ${job.meta.model}` : '';
  const tz = jobTimezone(job.meta);
  const lastRun = formatCronDateTime(job.runtime.last_run_at, tz);
  const lastError = job.runtime.last_error ? ` | last_error: ${job.runtime.last_error}` : '';
  const bodyValue = job.meta.type === 'prompt' ? job.meta.prompt : job.meta.content;
  const bodyLabel = job.meta.type === 'prompt' ? 'prompt' : 'content';
  const canSeeBody = job.meta.created_by === caller || job.meta.type === 'message';
  const body = bodyValue
    ? `${bodyLabel}: ${canSeeBody ? bodyValue : '<redacted>'}`
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

async function resolveJobReference(
  action: JobReferenceAction,
): Promise<{ job: JobFile } | { error: string }> {
  if (action.job_id) {
    const job = await readJob(action.job_id);
    return job ? { job } : { error: `Job "${action.job_id}" not found.` };
  }

  const name = action.name!;
  const jobs = await listAllJobs();
  const byName = jobs.filter((job) => job.meta.name === name);
  if (byName.length === 1) return { job: byName[0] };
  if (byName.length > 1) {
    return { error: `Multiple jobs are named "${name}". Use the stable job_id instead.` };
  }

  const fallbackId = sanitizeJobId(name);
  const fallback = await readJob(fallbackId);
  return fallback ? { job: fallback } : { error: `Job "${name}" not found.` };
}

function requireJobOwner(
  actionType: CodexExecAction['type'],
  job: JobFile,
  caller: string,
  auditArgs: Record<string, unknown>,
): CodexExecActionExecutionResult | null {
  if (job.meta.created_by === caller) return null;
  void audit(actionType, caller, auditArgs, 'denied');
  return {
    ok: false,
    action: actionType,
    message: `You are not the owner of "${job.meta.id}". Only ${job.meta.created_by} can modify it.`,
  };
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

  if (action.job_type === 'prompt' && !action.prompt) {
    return { ok: false, action: 'create_job', message: 'prompt is required for job_type=prompt.' };
  }
  if (action.job_type === 'message' && !action.content) {
    return { ok: false, action: 'create_job', message: 'content is required for job_type=message.' };
  }
  try {
    assertSafeChatId(targetChatId);
  } catch (err: any) {
    return { ok: false, action: 'create_job', message: `Invalid target_chat_id: ${err?.message ?? targetChatId}` };
  }

  let cron: string;
  let scheduleHuman: string;
  let jobTz: string;
  try {
    jobTz = normalizeJobTimezone(action.timezone);
    const expanded = expandSchedule(action.schedule, jobTz);
    cron = expanded.cron;
    scheduleHuman = expanded.human;
  } catch (err: any) {
    return { ok: false, action: 'create_job', message: `Invalid schedule expression: ${err?.message ?? action.schedule}` };
  }

  const id = sanitizeJobId(action.name);
  if (await jobExists(id)) {
    return { ok: false, action: 'create_job', message: `Job "${id}" already exists.` };
  }

  const nextRunAt = computeNextRun(cron, jobTz);
  const job: JobFile = {
    meta: {
      id,
      name: action.name,
      type: action.job_type,
      schedule: cron,
      schedule_human: scheduleHuman,
      timezone: jobTz,
      ...(action.job_type === 'prompt' ? { prompt: action.prompt } : { content: action.content, msg_type: 'text' }),
      target_chat_id: targetChatId,
      ...(action.model ? { model: action.model } : {}),
      origin_chat_id: message.chatId,
      status: 'active',
      created_by: caller,
      created_at: new Date().toISOString(),
    },
    runtime: {
      last_run_at: null,
      next_run_at: nextRunAt,
      run_count: 0,
      last_error: null,
    },
  };

  await writeJob(job);
  void audit('create_job', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'create_job',
    message: `Created job "${id}" (job_id: ${id}, ${scheduleHuman}, tz=${jobTz}). Next run: ${formatCronDateTime(nextRunAt, jobTz)}`,
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

  const jobs = await listAllJobs();
  const byStatus = status === 'all' ? jobs : jobs.filter((job) => job.meta.status === status);
  const visible = byStatus.filter((job) => jobVisibleToCaller(job, message, caller));

  void audit('list_jobs', caller, auditArgs, 'ok');
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

  const resolved = await resolveJobReference(action);
  if ('error' in resolved) return { ok: false, action: 'update_job', message: resolved.error };
  const ownerError = requireJobOwner('update_job', resolved.job, caller, auditArgs);
  if (ownerError) return ownerError;

  let expandedSchedule: { cron: string; human: string } | null = null;
  let requestedTimezone: string | null = null;
  try {
    requestedTimezone = action.timezone === undefined ? null : normalizeJobTimezone(action.timezone);
  } catch (err: any) {
    return {
      ok: false,
      action: 'update_job',
      message: `Invalid timezone: ${err?.message ?? action.timezone}`,
    };
  }
  if (action.schedule !== undefined) {
    try {
      expandedSchedule = expandSchedule(action.schedule, requestedTimezone ?? jobTimezone(resolved.job.meta));
    } catch (err: any) {
      return {
        ok: false,
        action: 'update_job',
        message: `Invalid schedule: ${err?.message ?? action.schedule}`,
      };
    }
  }

  let ownerMismatch: string | null = null;
  const updated = await mutateJob(resolved.job.meta.id, (latest) => {
    if (latest.meta.created_by !== caller) {
      ownerMismatch = latest.meta.created_by;
      return false;
    }

    if (action.new_name !== undefined) latest.meta.name = action.new_name;
    if (action.prompt !== undefined) latest.meta.prompt = action.prompt;
    if (action.content !== undefined) latest.meta.content = action.content;
    if (action.model !== undefined) latest.meta.model = action.model || undefined;
    if (requestedTimezone) latest.meta.timezone = requestedTimezone;
    if (expandedSchedule) {
      latest.meta.schedule = expandedSchedule.cron;
      latest.meta.schedule_human = expandedSchedule.human;
      latest.runtime.next_run_at = computeNextRun(expandedSchedule.cron, jobTimezone(latest.meta));
    }
    if (requestedTimezone && !expandedSchedule) {
      latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, requestedTimezone);
    }
    if (action.status !== undefined) {
      latest.meta.status = action.status;
      if (action.status === 'active' && !expandedSchedule && !requestedTimezone) {
        latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, jobTimezone(latest.meta));
      }
    }
  });

  if (ownerMismatch) {
    void audit('update_job', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'update_job',
      message: `You are not the owner of "${resolved.job.meta.id}". Only ${ownerMismatch} can modify it.`,
    };
  }
  if (!updated) return { ok: false, action: 'update_job', message: `Job "${resolved.job.meta.id}" not found.` };

  void audit('update_job', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'update_job',
    message: `Updated job "${updated.meta.id}" (job_id: ${updated.meta.id}). Status: ${updated.meta.status}, Schedule: ${updated.meta.schedule_human}, TZ: ${jobTimezone(updated.meta)}, Next run: ${formatCronDateTime(updated.runtime.next_run_at, jobTimezone(updated.meta))}`,
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

  const resolved = await resolveJobReference(action);
  if ('error' in resolved) return { ok: false, action: 'disable_job', message: resolved.error };
  const ownerError = requireJobOwner('disable_job', resolved.job, caller, auditArgs);
  if (ownerError) return ownerError;

  let ownerMismatch: string | null = null;
  const updated = await mutateJob(resolved.job.meta.id, (latest) => {
    if (latest.meta.created_by !== caller) {
      ownerMismatch = latest.meta.created_by;
      return false;
    }
    latest.meta.status = 'paused';
  });

  if (ownerMismatch) {
    void audit('disable_job', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'disable_job',
      message: `You are not the owner of "${resolved.job.meta.id}". Only ${ownerMismatch} can modify it.`,
    };
  }
  if (!updated) return { ok: false, action: 'disable_job', message: `Job "${resolved.job.meta.id}" not found.` };

  void audit('disable_job', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'disable_job',
    message: `Updated job "${updated.meta.id}" (job_id: ${updated.meta.id}). Status: ${updated.meta.status}, Next run: ${formatCronDateTime(updated.runtime.next_run_at, jobTimezone(updated.meta))}`,
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

  const resolved = await resolveJobReference(action);
  if ('error' in resolved) return { ok: false, action: 'delete_job', message: resolved.error };
  const ownerError = requireJobOwner('delete_job', resolved.job, caller, auditArgs);
  if (ownerError) return ownerError;

  const deleted = await deleteJobFile(resolved.job.meta.id);
  if (!deleted) return { ok: false, action: 'delete_job', message: `Job "${resolved.job.meta.id}" not found.` };

  void audit('delete_job', caller, auditArgs, 'ok');
  return { ok: true, action: 'delete_job', message: `Deleted job "${resolved.job.meta.id}".` };
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

  if (action.job_type === 'prompt' && !action.prompt) {
    return { ok: false, action: 'upsert_job', message: 'prompt is required for job_type=prompt.' };
  }
  if (action.job_type === 'message' && !action.content) {
    return { ok: false, action: 'upsert_job', message: 'content is required for job_type=message.' };
  }
  try {
    assertSafeChatId(targetChatId);
  } catch (err: any) {
    return { ok: false, action: 'upsert_job', message: `Invalid target_chat_id: ${err?.message ?? targetChatId}` };
  }

  let cron: string;
  let scheduleHuman: string;
  let jobTz: string;
  try {
    jobTz = normalizeJobTimezone(action.timezone);
    const expanded = expandSchedule(action.schedule, jobTz);
    cron = expanded.cron;
    scheduleHuman = expanded.human;
  } catch (err: any) {
    return { ok: false, action: 'upsert_job', message: `Invalid schedule expression: ${err?.message ?? action.schedule}` };
  }

  const existing = await resolveJobReference({ type: 'update_job', name: action.name });
  if ('job' in existing) {
    const ownerError = requireJobOwner('upsert_job', existing.job, caller, auditArgs);
    if (ownerError) return ownerError;

    let ownerMismatch: string | null = null;
    const updated = await mutateJob(existing.job.meta.id, (latest) => {
      if (latest.meta.created_by !== caller) {
        ownerMismatch = latest.meta.created_by;
        return false;
      }
      latest.meta.name = action.name;
      latest.meta.type = action.job_type;
      latest.meta.schedule = cron;
      latest.meta.schedule_human = scheduleHuman;
      latest.meta.timezone = jobTz;
      latest.meta.target_chat_id = targetChatId;
      latest.meta.model = action.model || undefined;
      latest.meta.status = action.status ?? 'active';
      if (action.job_type === 'prompt') {
        latest.meta.prompt = action.prompt;
        delete latest.meta.content;
        delete latest.meta.msg_type;
      } else {
        latest.meta.content = action.content;
        latest.meta.msg_type = 'text';
        delete latest.meta.prompt;
      }
      latest.runtime.next_run_at = computeNextRun(cron, jobTz);
      latest.runtime.last_error = null;
    });

    if (ownerMismatch) {
      void audit('upsert_job', caller, auditArgs, 'denied');
      return {
        ok: false,
        action: 'upsert_job',
        message: `You are not the owner of "${existing.job.meta.id}". Only ${ownerMismatch} can modify it.`,
      };
    }
    if (!updated) return { ok: false, action: 'upsert_job', message: `Job "${existing.job.meta.id}" not found.` };

    void audit('upsert_job', caller, auditArgs, 'ok');
    return {
      ok: true,
      action: 'upsert_job',
      message: `Upserted job "${updated.meta.id}" (job_id: ${updated.meta.id}, ${scheduleHuman}, tz=${jobTz}). Status: ${updated.meta.status}, Next run: ${formatCronDateTime(updated.runtime.next_run_at, jobTz)}`,
    };
  }

  if (existing.error && !/not found/i.test(existing.error)) {
    return { ok: false, action: 'upsert_job', message: existing.error };
  }

  const id = sanitizeJobId(action.name);
  const nextRunAt = computeNextRun(cron, jobTz);
  const job: JobFile = {
    meta: {
      id,
      name: action.name,
      type: action.job_type,
      schedule: cron,
      schedule_human: scheduleHuman,
      timezone: jobTz,
      ...(action.job_type === 'prompt' ? { prompt: action.prompt } : { content: action.content, msg_type: 'text' }),
      target_chat_id: targetChatId,
      ...(action.model ? { model: action.model } : {}),
      origin_chat_id: message.chatId,
      status: action.status ?? 'active',
      created_by: caller,
      created_at: new Date().toISOString(),
    },
    runtime: {
      last_run_at: null,
      next_run_at: nextRunAt,
      run_count: 0,
      last_error: null,
    },
  };

  await writeJob(job);
  void audit('upsert_job', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'upsert_job',
    message: `Upserted job "${id}" (job_id: ${id}, ${scheduleHuman}, tz=${jobTz}). Status: ${job.meta.status}, Next run: ${formatCronDateTime(nextRunAt, jobTz)}`,
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

function canMutateIssueProposal(proposal: IssueProposalFile, caller: string): boolean {
  return proposal.meta.created_by === caller || (!!appConfig.ownerOpenId && appConfig.ownerOpenId === caller);
}

function issueProposalLocalCliArgs(proposal: IssueProposalFile): string[] {
  return [
    `--repo=${proposal.meta.target_repo}`,
    `--title=${proposal.meta.title}`,
    `--body=${formatIssueProposalIssueBody(proposal)}`,
  ];
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

  try {
    const proposal = await createIssueProposal({
      title: action.title,
      body: action.body,
      evidence: action.evidence,
      impact: action.impact,
      priority: action.priority,
      automationLevel: action.automation_level,
      targetRepo: action.target_repo,
      targetChatId: action.target_chat_id ?? message.chatId,
      originChatId: message.chatId,
      createdBy: caller,
    });
    void audit('create_issue_proposal', caller, auditArgs, 'ok');
    return {
      ok: true,
      action: 'create_issue_proposal',
      message: `Created issue proposal "${proposal.meta.id}". Wait for explicit maintainer approval before filing a GitHub issue.`,
    };
  } catch (err: any) {
    void audit('create_issue_proposal', caller, auditArgs, 'error');
    return {
      ok: false,
      action: 'create_issue_proposal',
      message: `Failed to create issue proposal: ${err?.message ?? String(err)}`,
    };
  }
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
  const proposals = await listIssueProposals({
    status,
    ...(message.chatType === 'p2p' ? { createdBy: caller } : { targetChatId: message.chatId }),
  });
  void audit('list_issue_proposals', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'list_issue_proposals',
    message: proposals.length ? proposals.map(formatIssueProposalForList).join('\n\n') : 'No issue proposals found.',
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
  const proposal = await readIssueProposal(action.id);
  if (!proposal) return { ok: false, action: 'reject_issue_proposal', message: `Issue proposal "${action.id}" not found.` };
  if (!canMutateIssueProposal(proposal, caller)) {
    void audit('reject_issue_proposal', caller, auditArgs, 'denied');
    return { ok: false, action: 'reject_issue_proposal', message: `You are not authorized to reject issue proposal "${action.id}".` };
  }
  const rejected = await rejectIssueProposal(action.id, { rejectedBy: caller, reason: action.reason });
  void audit('reject_issue_proposal', caller, auditArgs, 'ok');
  return { ok: true, action: 'reject_issue_proposal', message: `Rejected issue proposal "${rejected?.meta.id ?? action.id}".` };
}

async function executeCreateIssueFromProposal(
  action: z.infer<typeof CreateIssueFromProposalActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_issue_from_proposal');
  const tool = action.tool ?? 'gh_issue_create';
  const auditArgs = { id: action.id, tool, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const proposal = await readIssueProposal(action.id);
  if (!proposal) return { ok: false, action: 'create_issue_from_proposal', message: `Issue proposal "${action.id}" not found.` };
  if (!canMutateIssueProposal(proposal, caller)) {
    void audit('create_issue_from_proposal', caller, auditArgs, 'denied');
    return { ok: false, action: 'create_issue_from_proposal', message: `You are not authorized to create an issue from proposal "${action.id}".` };
  }
  if (proposal.meta.status === 'created' && proposal.meta.github_issue_url) {
    return {
      ok: true,
      action: 'create_issue_from_proposal',
      message: `Issue already created for proposal ${proposal.meta.id}: ${proposal.meta.github_issue_url}`,
    };
  }
  if (proposal.meta.status === 'rejected') {
    return {
      ok: false,
      action: 'create_issue_from_proposal',
      message: `Issue proposal "${proposal.meta.id}" was rejected and cannot be filed.`,
    };
  }

  const approved = await markIssueProposalApproved(proposal.meta.id, { approvedBy: caller });
  if (!approved) return { ok: false, action: 'create_issue_from_proposal', message: `Issue proposal "${proposal.meta.id}" not found.` };

  const result = await runConfiguredLocalCliTool({
    identitySession: deps.identitySession,
    tool,
    args: issueProposalLocalCliArgs(approved),
    chat_id: message.chatId,
    thread_id: message.threadId,
    configPath: deps.localCliToolsConfigPath,
  });
  if (!result.ok) {
    await markIssueProposalApproved(proposal.meta.id, { approvedBy: caller, lastError: result.message });
    return {
      ok: false,
      action: 'create_issue_from_proposal',
      message: `Failed to create GitHub issue for proposal "${proposal.meta.id}": ${result.message}`,
    };
  }

  const issueUrl = extractGithubIssueUrl(result.message);
  if (!issueUrl) {
    await markIssueProposalApproved(proposal.meta.id, {
      approvedBy: caller,
      lastError: 'Local CLI completed but did not return a GitHub issue URL.',
    });
    return {
      ok: false,
      action: 'create_issue_from_proposal',
      message: `Local CLI completed but did not return a GitHub issue URL for proposal "${proposal.meta.id}".`,
    };
  }
  const created = await markIssueProposalCreated(proposal.meta.id, { approvedBy: caller, githubIssueUrl: issueUrl });
  void audit('create_issue_from_proposal', caller, auditArgs, 'ok');
  return {
    ok: true,
    action: 'create_issue_from_proposal',
    message: `Created GitHub issue for proposal "${proposal.meta.id}": ${created?.meta.github_issue_url ?? issueUrl}`,
  };
}

function resolveRecallTransport(
  transport: CreateCodexExecActionDispatcherOptions['larkTransport'],
): Pick<LarkTransport, 'recallMessage'> | undefined {
  return typeof transport === 'function' ? transport() : transport;
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
        } else if (action.type === 'create_issue_proposal') {
          results.push(await executeCreateIssueProposal(action, request.message, deps));
        } else if (action.type === 'list_issue_proposals') {
          results.push(await executeListIssueProposals(action, request.message, deps));
        } else if (action.type === 'reject_issue_proposal') {
          results.push(await executeRejectIssueProposal(action, request.message, deps));
        } else if (action.type === 'create_issue_from_proposal') {
          results.push(await executeCreateIssueFromProposal(action, request.message, deps));
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
