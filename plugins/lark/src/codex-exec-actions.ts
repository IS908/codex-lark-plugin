import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import type { LarkMessage } from './lark-message.js';
import type { ReplyRequest, ReplyRichPart, ReplySendResult } from './reply-sender.js';
import { downloadInboundResource } from './inbound-attachment-downloader.js';
import type { IdentitySession } from './identity-session.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import type { MemoryStore } from './memory/file.js';
import {
  formatCronDateTime,
  jobTimezone,
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
  resolveJobReference,
  updateJob,
  upsertJob,
} from './job-service.js';
import {
  listConfiguredLocalCliToolNames,
  runConfiguredLocalCliTool,
} from './local-cli-tools.js';
import {
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
import {
  CONTINUATION_RUNTIME_UNAVAILABLE,
  ContinuationServiceError,
  type ContinuationTaskService,
} from './continuation/service.js';
import { selectQuotedMessageId } from './quoted-context-loader.js';
import { validateTrackedBotMessageScope } from './message-mutation.js';
import { queryRunTrace } from './run-trace-query.js';
import {
  dispatchRegisteredAction,
  type ActionHandlerRegistry,
} from './codex-exec-action-registry.js';
import type {
  CodexExecAction,
  CreateContinuationAction,
  CreateJobAction,
  DeleteJobAction,
  DisableJobAction,
  GetRunTraceAction,
  ListJobsAction,
  ManageAccessControlAction,
  RecallMessageAction,
  RunJobAction,
  RunLocalCliToolAction,
  SaveMemoryAction,
  SendMessageAction,
  SendMessageRichPayload,
  UpdateJobAction,
  UpsertJobAction,
} from './codex-exec-action-schemas.js';
import type { AsyncTaskSourceInput } from './domain/continuation.js';
export { parseCodexExecActionEnvelope } from './codex-exec-action-schemas.js';
export type {
  CodexExecAction,
  CodexExecActionEnvelope,
  CodexExecActionEnvelopeParseResult,
} from './codex-exec-action-schemas.js';

export interface CodexExecActionExecutionResult {
  ok: boolean;
  action: CodexExecAction['type'] | 'action_channel';
  message: string;
  continuation?: { jobId: string; title: string };
}

export interface CodexExecActionDispatchRequest {
  message: LarkMessage;
  actions: CodexExecAction[];
  parentSessionId?: string | null;
  model?: string | null;
  continuationPermitted?: boolean;
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
  continuationService?: ContinuationTaskService;
  runJobNow?: (job: JobFile) => Promise<{
    started: boolean;
    reason?: 'already_running';
    outcome?: 'success' | 'failed';
  }>;
}

interface CodexExecActionContext {
  message: LarkMessage;
  parentSessionId?: string | null;
  model?: string | null;
  continuationPermitted?: boolean;
}

type CodexExecActionHandlerRegistry = ActionHandlerRegistry<
  CodexExecAction,
  CodexExecActionContext,
  CodexExecActionExecutionResult
>;

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
  action: SaveMemoryAction,
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
  action: CreateJobAction,
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

async function executeCreateContinuation(
  action: CreateContinuationAction,
  context: CodexExecActionContext,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  if (!deps.continuationService) {
    await audit(
      'create_continuation_job',
      context.message.senderId,
      { source_message_id: context.message.messageId },
      'error',
    );
    return {
      ok: false,
      action: 'create_continuation_job',
      message: 'Continuation runtime is unavailable. No background task was created.',
    };
  }
  try {
    const existing = await deps.continuationService.findExistingFromMessage(context.message);
    if (existing) {
      await audit(
        'create_continuation_job',
        context.message.senderId,
        {
          job_id: existing.jobId,
          source_message_id: context.message.messageId,
          replay: true,
        },
        'ok',
      );
      return {
        ok: true,
        action: 'create_continuation_job',
        message: `Background task created: ${existing.title}\nJob ID: ${existing.jobId}`,
        continuation: { jobId: existing.jobId, title: existing.title },
      };
    }
    if (context.continuationPermitted === false) {
      await audit(
        'create_continuation_job',
        context.message.senderId,
        { source_message_id: context.message.messageId, reason: 'not_permitted_for_turn' },
        'denied',
      );
      return {
        ok: false,
        action: 'create_continuation_job',
        message: 'Continuation was not permitted for this foreground turn. Complete the task now or ask the user for missing input.',
      };
    }
    const configuredHostTools = new Set(
      await listConfiguredLocalCliToolNames(deps.localCliToolsConfigPath),
    );
    const unsupportedHostTools = [...new Set(action.required_tools)]
      .filter((tool) => !configuredHostTools.has(tool))
      .sort();
    if (unsupportedHostTools.length > 0) {
      void audit(
        'create_continuation_job',
        context.message.senderId,
        { source_message_id: context.message.messageId },
        'error',
      );
      return {
        ok: false,
        action: 'create_continuation_job',
        message: [
          'Continuation job was not created:',
          `required_tools contains names that are not configured host CLI tools: ${unsupportedHostTools.join(', ')}.`,
          'Standard Codex tools must not be declared in required_tools; use an empty array unless an exact configured host tool is required.',
        ].join(' '),
      };
    }
    const resolvedInputs = await resolveContinuationSourceInputs(context.message, deps);
    let job;
    try {
      ({ job } = await deps.continuationService.createFromMessage(
        action,
        context.message,
        context.parentSessionId,
        context.model,
        resolvedInputs.inputs,
      ));
    } finally {
      await resolvedInputs.cleanup();
    }
    await audit(
      'create_continuation_job',
      context.message.senderId,
      {
        job_id: job.jobId,
        source_message_id: context.message.messageId,
        capability_profile: job.permissions.profile,
        requested_paths: job.permissions.filesystem.requestedPaths,
        network: job.permissions.network,
        external_side_effects: job.permissions.externalSideEffects,
      },
      'ok',
    );
    return {
      ok: true,
      action: 'create_continuation_job',
      message: `Background task created: ${job.title}\nJob ID: ${job.jobId}`,
      continuation: { jobId: job.jobId, title: job.title },
    };
  } catch (error) {
    void audit(
      'create_continuation_job',
      context.message.senderId,
      { source_message_id: context.message.messageId },
      'error',
    );
    return {
      ok: false,
      action: 'create_continuation_job',
      message: errorMessage(error) === CONTINUATION_RUNTIME_UNAVAILABLE
        ? CONTINUATION_RUNTIME_UNAVAILABLE
        : `Continuation job was not created: ${errorMessage(error)}`,
    };
  }
}

async function resolveContinuationSourceInputs(
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<{ inputs: AsyncTaskSourceInput[]; cleanup(): Promise<void> }> {
  const inputs: AsyncTaskSourceInput[] = [];
  const temporaryPaths: string[] = [];
  const imagePaths = [...new Set(
    [message.imagePath, ...(message.imagePaths ?? [])].filter((value): value is string => Boolean(value)),
  )];
  const descriptors = (message.attachments ?? []).filter((attachment) => attachment.fileKey);
  if (descriptors.length === 0) {
    return {
      inputs: imagePaths.map((imagePath) => ({
        sourcePath: path.resolve(imagePath),
        fileName: path.basename(imagePath),
        kind: 'message_image',
      })),
      async cleanup() {},
    };
  }
  const matchedImageDescriptors = new Set<number>();
  for (const imagePath of imagePaths) {
    const descriptorIndex = descriptors.findIndex((attachment, index) =>
      !matchedImageDescriptors.has(index)
      && attachment.fileType === 'image'
      && path.basename(imagePath).includes(`-${attachment.fileKey}-`));
    if (descriptorIndex >= 0) matchedImageDescriptors.add(descriptorIndex);
    inputs.push({
      sourcePath: path.resolve(imagePath),
      fileName: descriptorIndex >= 0
        ? safeContinuationInputName(descriptors[descriptorIndex].fileName || `image-${descriptorIndex + 1}`)
        : path.basename(imagePath),
      kind: 'message_image',
    });
  }
  const transport = resolveActionTransport(deps.larkTransport);
  if (!transport?.downloadResource) {
    throw new Error('Continuation attachment download transport is unavailable.');
  }
  const downloadResource = transport.downloadResource.bind(transport);
  try {
    for (const [index, attachment] of descriptors.entries()) {
      if (matchedImageDescriptors.has(index)) continue;
      const resourceType = attachment.fileType === 'image' ? 'image' : 'file';
      const fileName = safeContinuationInputName(
        attachment.fileName || `${resourceType}-${index + 1}`,
      );
      const downloaded = await downloadInboundResource({ downloadResource }, {
        messageId: message.messageId,
        fileKey: attachment.fileKey,
        resourceType,
        fileName: `continuation-input-${createHash('sha256')
          .update(`${message.messageId}\0${index}`)
          .digest('hex')
          .slice(0, 16)}.bin`,
        logPrefix: '[continuation-input]',
      });
      if (!downloaded) {
        throw new Error('One or more continuation attachments could not be downloaded.');
      }
      temporaryPaths.push(downloaded);
      inputs.push({
        sourcePath: path.resolve(downloaded),
        fileName,
        kind: resourceType === 'image' ? 'message_image' : 'message_attachment',
      });
    }
  } catch (error) {
    await cleanupContinuationTemporaryInputs(temporaryPaths);
    throw error;
  }
  return {
    inputs,
    async cleanup() {
      await cleanupContinuationTemporaryInputs(temporaryPaths);
    },
  };
}

async function cleanupContinuationTemporaryInputs(temporaryPaths: readonly string[]): Promise<void> {
  await Promise.allSettled(temporaryPaths.map((filePath) => fs.rm(filePath, { force: true })));
}

function safeContinuationInputName(value: string): string {
  if (
    !value
    || value.length > 120
    || value === '.'
    || value === '..'
    || value === '.manifest.json'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || path.basename(value) !== value
  ) {
    throw new Error('Continuation attachment file name is invalid.');
  }
  return value;
}

async function executeListJobs(
  action: ListJobsAction,
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

async function executeRunJob(
  action: RunJobAction,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'run_job');
  const auditArgs = {
    source_message_id: message.messageId,
    job_id: action.job_id,
    name: action.name,
    quoted_cronjob_id: message.quotedCronJobId,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const resolved = await resolveJobReference({ jobId: action.job_id, name: action.name });
  if (!resolved.ok) {
    void audit('run_job', caller, auditArgs, 'error');
    return { ok: false, action: 'run_job', message: resolved.message };
  }
  if (resolved.job.meta.created_by !== caller) {
    void audit('run_job', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'run_job',
      message: `You are not the owner of "${resolved.job.meta.id}". Only ${resolved.job.meta.created_by} can run it.`,
    };
  }
  if (!deps.runJobNow) {
    void audit('run_job', caller, auditArgs, 'error');
    return { ok: false, action: 'run_job', message: 'Cronjob runner is not available.' };
  }

  try {
    const result = await deps.runJobNow(resolved.job);
    if (!result.started) {
      void audit('run_job', caller, { ...auditArgs, reason: result.reason }, 'denied');
      return {
        ok: false,
        action: 'run_job',
        message: `Job "${resolved.job.meta.id}" is already running.`,
      };
    }
    if (result.outcome === 'failed') {
      void audit('run_job', caller, { ...auditArgs, job_id: resolved.job.meta.id }, 'error');
      return {
        ok: false,
        action: 'run_job',
        message: `Job "${resolved.job.meta.id}" rerun completed with a failed outcome; its error report was delivered through the cronjob path.`,
      };
    }
    void audit('run_job', caller, { ...auditArgs, job_id: resolved.job.meta.id }, 'ok');
    return {
      ok: true,
      action: 'run_job',
      message: `Reran job "${resolved.job.meta.id}" using its persisted definition.`,
    };
  } catch (error) {
    void audit('run_job', caller, { ...auditArgs, job_id: resolved.job.meta.id }, 'error');
    return {
      ok: false,
      action: 'run_job',
      message: `Job "${resolved.job.meta.id}" rerun failed: ${errorMessage(error)}`,
    };
  }
}

async function executeUpdateJob(
  action: UpdateJobAction,
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
  action: DisableJobAction,
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
  action: DeleteJobAction,
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
  action: UpsertJobAction,
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
  action: RunLocalCliToolAction,
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
  action: ManageAccessControlAction,
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
  action: GetRunTraceAction,
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
  action: GetRunTraceAction,
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
  action: GetRunTraceAction,
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

async function resolveContinuationTraceLogId(
  action: GetRunTraceAction,
  caller: string,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<{ ok: true; logId: string } | { ok: false; message: string; denied?: boolean }> {
  const logId = action.log_id?.trim();
  if (!logId) {
    return { ok: false, message: 'get_run_trace(source=continuation) requires log_id.' };
  }
  if (!/^job_[a-f0-9]{24}$/.test(logId)) {
    return {
      ok: false,
      denied: true,
      message: 'get_run_trace(source=continuation) requires a stable continuation job ID.',
    };
  }
  if (!deps.continuationService) {
    return { ok: false, message: CONTINUATION_RUNTIME_UNAVAILABLE };
  }
  try {
    await deps.continuationService.getForActor(logId, caller, appConfig.ownerOpenId);
    return { ok: true, logId };
  } catch (error) {
    if (error instanceof ContinuationServiceError && error.code === 'not_accessible') {
      return {
        ok: false,
        denied: true,
        message: `get_run_trace(source=continuation) denied for job ${logId}.`,
      };
    }
    return { ok: false, message: CONTINUATION_RUNTIME_UNAVAILABLE };
  }
}

async function executeGetRunTrace(
  action: GetRunTraceAction,
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
    : action.source === 'cronjob'
      ? await resolveCronJobTraceLogId(action, message, caller)
      : await resolveContinuationTraceLogId(action, caller, deps);
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
  action: SendMessageRichPayload,
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
  action: SendMessageAction,
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
  action: RecallMessageAction,
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
  const registry = createCodexExecActionHandlerRegistry(deps);
  return {
    async execute(request) {
      const results: CodexExecActionExecutionResult[] = [];
      const context: CodexExecActionContext = {
        message: request.message,
        ...(request.parentSessionId !== undefined
          ? { parentSessionId: request.parentSessionId }
          : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.continuationPermitted !== undefined
          ? { continuationPermitted: request.continuationPermitted }
          : {}),
      };
      for (const action of request.actions) {
        results.push(await dispatchRegisteredAction(registry, action, context));
      }
      return results;
    },
  };
}

function createCodexExecActionHandlerRegistry(
  deps: CreateCodexExecActionDispatcherOptions,
): CodexExecActionHandlerRegistry {
  return {
    save_memory: (action, context) => executeSaveMemory(action, context.message, deps),
    create_job: (action, context) => executeCreateJob(action, context.message, deps),
    list_jobs: (action, context) => executeListJobs(action, context.message, deps),
    run_job: (action, context) => executeRunJob(action, context.message, deps),
    update_job: (action, context) => executeUpdateJob(action, context.message, deps),
    disable_job: (action, context) => executeDisableJob(action, context.message, deps),
    delete_job: (action, context) => executeDeleteJob(action, context.message, deps),
    upsert_job: (action, context) => executeUpsertJob(action, context.message, deps),
    run_local_cli_tool: (action, context) => executeRunLocalCliTool(action, context.message, deps),
    manage_access_control: (action, context) => executeManageAccessControl(action, context.message, deps),
    get_run_trace: (action, context) => executeGetRunTrace(action, context.message, deps),
    send_message: (action, context) => executeSendMessage(action, context.message, deps),
    recall_message: (action, context) => executeRecallMessage(action, context.message, deps),
    create_continuation_job: (action, context) => executeCreateContinuation(action, context, deps),
  };
}
