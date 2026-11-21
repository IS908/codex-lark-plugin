import { audit } from './audit-log.js';
import { appConfig } from './config.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertSafeChatId } from './prompts.js';
import {
  computeNextRun,
  createInitialJobRuntime,
  deleteJob as deleteJobFile,
  expandSchedule,
  formatCronDateTime,
  jobExists,
  jobTimezone,
  listAllJobs,
  mutateJob,
  normalizeJobTimezone,
  readJob,
  sanitizeJobId,
  writeJob,
  type JobFile,
  type JobMeta,
} from './job-store.js';
import { resolveWorkspaceProject, WorkspaceProjectError } from './workspace-projects.js';

export type JobLifecycleAction =
  | 'create_job'
  | 'list_jobs'
  | 'run_job'
  | 'update_job'
  | 'disable_job'
  | 'delete_job'
  | 'upsert_job';

export type JobReference = {
  jobId?: string;
  name?: string;
};

export type JobServiceErrorCode =
  | 'missing_prompt'
  | 'missing_content'
  | 'invalid_target_chat_id'
  | 'invalid_timezone'
  | 'invalid_schedule'
  | 'invalid_workspace'
  | 'job_exists'
  | 'job_not_found'
  | 'ambiguous_reference'
  | 'owner_mismatch'
  | 'stale_job';

export type JobServiceError = {
  ok: false;
  code: JobServiceErrorCode;
  message: string;
  job?: JobFile;
  jobId?: string;
  owner?: string;
};

export type JobServiceResult<T> = ({ ok: true } & T) | JobServiceError;

type AuditArgs = Record<string, unknown>;

type JobDefinitionInput = {
  name: string;
  type: JobMeta['type'];
  schedule: string;
  timezone?: string;
  prompt?: string;
  content?: string;
  targetChatId: string;
  model?: string;
};

type NormalizedJobDefinition = {
  id: string;
  cron: string;
  scheduleHuman: string;
  timezone: string;
  nextRunAt: string;
};

type NewJobFileInput = JobDefinitionInput & {
  caller: string;
  originChatId: string;
  status?: JobMeta['status'];
  workspaceProject?: WorkspaceProjectBinding;
};

export type CreateJobInput = NewJobFileInput & {
  auditAction?: Extract<JobLifecycleAction, 'create_job' | 'upsert_job'>;
  auditArgs?: AuditArgs;
};

export type ListVisibleJobsInput = {
  caller: string;
  chatId: string;
  isPrivateChat: boolean;
  status?: JobMeta['status'] | 'all';
  auditArgs?: AuditArgs;
};

export type UpdateJobInput = {
  action: Extract<JobLifecycleAction, 'update_job' | 'disable_job' | 'upsert_job'>;
  caller: string;
  reference: JobReference;
  expectedCreatedAt?: string;
  updates: {
    name?: string;
    status?: JobMeta['status'];
    schedule?: string;
    timezone?: string;
    prompt?: string;
    content?: string;
    model?: string;
  };
  auditArgs?: AuditArgs;
};

export type DeleteJobInput = {
  caller: string;
  reference: JobReference;
  auditArgs?: AuditArgs;
};

export type UpsertJobInput = NewJobFileInput & {
  rebindWorkspaceProject?: boolean;
  auditArgs?: AuditArgs;
};

function serviceError(
  code: JobServiceErrorCode,
  message: string,
  extra: Partial<Omit<JobServiceError, 'ok' | 'code' | 'message'>> = {},
): JobServiceError {
  return { ok: false, code, message, ...extra };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function validateJobDefinition(input: JobDefinitionInput): JobServiceResult<NormalizedJobDefinition> {
  if (input.type === 'prompt' && !input.prompt) {
    return serviceError('missing_prompt', 'prompt is required for prompt jobs.');
  }
  if (input.type === 'message' && !input.content) {
    return serviceError('missing_content', 'content is required for message jobs.');
  }

  try {
    assertSafeChatId(input.targetChatId);
  } catch (err) {
    return serviceError(
      'invalid_target_chat_id',
      `Invalid target_chat_id: ${errorMessage(err, input.targetChatId)}`,
    );
  }

  let timezone: string;
  try {
    timezone = normalizeJobTimezone(input.timezone);
  } catch (err) {
    return serviceError('invalid_timezone', `Invalid timezone: ${errorMessage(err, input.timezone ?? '')}`);
  }

  try {
    const expanded = expandSchedule(input.schedule, timezone);
    const nextRunAt = computeNextRun(expanded.cron, timezone);
    return {
      ok: true,
      id: sanitizeJobId(input.name),
      cron: expanded.cron,
      scheduleHuman: expanded.human,
      timezone,
      nextRunAt,
    };
  } catch (err) {
    return serviceError(
      'invalid_schedule',
      `Invalid schedule expression: ${errorMessage(err, input.schedule)}`,
    );
  }
}

function buildJobFile(
  input: NewJobFileInput,
  normalized: NormalizedJobDefinition,
  workspaceProject?: WorkspaceProjectBinding,
): JobFile {
  return {
    meta: {
      id: normalized.id,
      revision: 1,
      name: input.name,
      type: input.type,
      schedule: normalized.cron,
      schedule_human: normalized.scheduleHuman,
      timezone: normalized.timezone,
      ...(input.type === 'prompt' ? { prompt: input.prompt } : { content: input.content, msg_type: 'text' }),
      target_chat_id: input.targetChatId,
      ...(input.model ? { model: input.model } : {}),
      ...(workspaceProject ? { workspace_project: workspaceProject } : {}),
      origin_chat_id: input.originChatId,
      status: input.status ?? 'active',
      created_by: input.caller,
      created_at: new Date().toISOString(),
    },
    runtime: createInitialJobRuntime(normalized.nextRunAt),
  };
}

async function resolveNewJobWorkspace(input: NewJobFileInput): Promise<JobServiceResult<{
  workspaceProject?: WorkspaceProjectBinding;
}>> {
  if (input.type !== 'prompt') return { ok: true };
  try {
    const workspaceProject = await resolveWorkspaceProject({
      authorizedRoot: appConfig.codexExecCwd,
      registryPath: appConfig.workspaceProjectsConfigPath,
      persisted: input.workspaceProject,
    });
    return { ok: true, workspaceProject };
  } catch (error) {
    if (!(error instanceof WorkspaceProjectError)) throw error;
    return serviceError('invalid_workspace', error.message);
  }
}

export async function createJob(input: CreateJobInput): Promise<JobServiceResult<{
  job: JobFile;
  scheduleHuman: string;
  timezone: string;
  nextRunAt: string;
}>> {
  const normalized = validateJobDefinition(input);
  if (!normalized.ok) return normalized;

  if (await jobExists(normalized.id)) {
    return serviceError('job_exists', `Job "${normalized.id}" already exists.`, { jobId: normalized.id });
  }

  const workspace = await resolveNewJobWorkspace(input);
  if (!workspace.ok) return workspace;
  const job = buildJobFile(input, normalized, workspace.workspaceProject);
  await writeJob(job);
  if (input.auditAction) {
    void audit(input.auditAction, input.caller, input.auditArgs ?? {}, 'ok');
  }
  return {
    ok: true,
    job,
    scheduleHuman: normalized.scheduleHuman,
    timezone: normalized.timezone,
    nextRunAt: normalized.nextRunAt,
  };
}

export async function listVisibleJobs(input: ListVisibleJobsInput): Promise<JobServiceResult<{ jobs: JobFile[] }>> {
  const status = input.status ?? 'all';
  const jobs = await listAllJobs();
  const byStatus = status === 'all' ? jobs : jobs.filter((job) => job.meta.status === status);
  const visible = byStatus.filter((job) => jobVisibleToCaller(job, input));

  void audit('list_jobs', input.caller, input.auditArgs ?? {}, 'ok');
  return { ok: true, jobs: visible };
}

export function jobVisibleToCaller(
  job: JobFile,
  scope: Pick<ListVisibleJobsInput, 'caller' | 'chatId' | 'isPrivateChat'>,
): boolean {
  if (scope.isPrivateChat) return job.meta.created_by === scope.caller;
  return job.meta.target_chat_id === scope.chatId;
}

export function canReadJobBody(job: JobFile, caller: string): boolean {
  return job.meta.created_by === caller || job.meta.type === 'message';
}

export function formatJobNextRun(job: JobFile, timezone = jobTimezone(job.meta)): string {
  if (job.meta.status !== 'active') return `- (${job.meta.status})`;
  return formatCronDateTime(job.runtime.next_run_at, timezone);
}

export async function resolveJobReference(reference: JobReference): Promise<JobServiceResult<{ job: JobFile }>> {
  if (reference.jobId) {
    const job = await readJob(reference.jobId);
    return job
      ? { ok: true, job }
      : serviceError('job_not_found', `Job "${reference.jobId}" not found.`, { jobId: reference.jobId });
  }

  if (!reference.name) {
    return serviceError('job_not_found', 'Job reference requires job_id or name.');
  }

  const jobs = await listAllJobs();
  const byName = jobs.filter((job) => job.meta.name === reference.name);
  if (byName.length === 1) return { ok: true, job: byName[0] };
  if (byName.length > 1) {
    return serviceError(
      'ambiguous_reference',
      `Multiple jobs are named "${reference.name}". Use the stable job_id instead.`,
    );
  }

  const fallbackId = sanitizeJobId(reference.name);
  const fallback = await readJob(fallbackId);
  return fallback
    ? { ok: true, job: fallback }
    : serviceError('job_not_found', `Job "${reference.name}" not found.`, { jobId: fallbackId });
}

function ownerMismatchError(
  action: JobLifecycleAction,
  job: JobFile,
  caller: string,
  auditArgs: AuditArgs | undefined,
): JobServiceError | null {
  if (job.meta.created_by === caller) return null;
  void audit(action, caller, auditArgs ?? {}, 'denied');
  return serviceError(
    'owner_mismatch',
    `You are not the owner of "${job.meta.id}". Only ${job.meta.created_by} can modify it.`,
    { job, jobId: job.meta.id, owner: job.meta.created_by },
  );
}

function normalizeUpdateSchedule(
  job: JobFile,
  updates: UpdateJobInput['updates'],
): JobServiceResult<{
  requestedTimezone: string | null;
  expandedSchedule: { cron: string; human: string } | null;
}> {
  let requestedTimezone: string | null = null;
  if (updates.timezone !== undefined) {
    try {
      requestedTimezone = normalizeJobTimezone(updates.timezone);
    } catch (err) {
      return serviceError('invalid_timezone', `Invalid timezone: ${errorMessage(err, updates.timezone)}`);
    }
  }

  if (updates.schedule === undefined) {
    return { ok: true, requestedTimezone, expandedSchedule: null };
  }

  try {
    return {
      ok: true,
      requestedTimezone,
      expandedSchedule: expandSchedule(updates.schedule, requestedTimezone ?? jobTimezone(job.meta)),
    };
  } catch (err) {
    return serviceError('invalid_schedule', `Invalid schedule: ${errorMessage(err, updates.schedule)}`);
  }
}

export async function updateJob(input: UpdateJobInput): Promise<JobServiceResult<{ job: JobFile }>> {
  const resolved = await resolveJobReference(input.reference);
  if (!resolved.ok) return resolved;

  if (
    input.expectedCreatedAt !== undefined
    && resolved.job.meta.created_at !== input.expectedCreatedAt
  ) {
    return serviceError(
      'stale_job',
      `Job "${resolved.job.meta.id}" was replaced after this action was created.`,
      { jobId: resolved.job.meta.id },
    );
  }

  const ownerError = ownerMismatchError(input.action, resolved.job, input.caller, input.auditArgs);
  if (ownerError) return ownerError;

  const scheduleUpdate = normalizeUpdateSchedule(resolved.job, input.updates);
  if (!scheduleUpdate.ok) return scheduleUpdate;
  const { requestedTimezone, expandedSchedule } = scheduleUpdate;

  let ownerMismatch: string | null = null;
  let staleInstance = false;
  const updated = await mutateJob(resolved.job.meta.id, (latest) => {
    if (
      input.expectedCreatedAt !== undefined
      && latest.meta.created_at !== input.expectedCreatedAt
    ) {
      staleInstance = true;
      return false;
    }
    if (latest.meta.created_by !== input.caller) {
      ownerMismatch = latest.meta.created_by;
      return false;
    }

    if (input.updates.name !== undefined) latest.meta.name = input.updates.name;
    if (input.updates.prompt !== undefined) latest.meta.prompt = input.updates.prompt;
    if (input.updates.content !== undefined) latest.meta.content = input.updates.content;
    if (input.updates.model !== undefined) latest.meta.model = input.updates.model || undefined;
    if (requestedTimezone) latest.meta.timezone = requestedTimezone;
    if (expandedSchedule) {
      latest.meta.schedule = expandedSchedule.cron;
      latest.meta.schedule_human = expandedSchedule.human;
      latest.runtime.next_run_at = computeNextRun(expandedSchedule.cron, jobTimezone(latest.meta));
    }
    if (requestedTimezone && !expandedSchedule) {
      latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, requestedTimezone);
    }
    if (input.updates.status !== undefined) {
      latest.meta.status = input.updates.status;
      if (input.updates.status === 'active' && !expandedSchedule && !requestedTimezone) {
        latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, jobTimezone(latest.meta));
      }
    }
  });

  if (staleInstance) {
    return serviceError(
      'stale_job',
      `Job "${resolved.job.meta.id}" was replaced after this action was created.`,
      { jobId: resolved.job.meta.id },
    );
  }

  if (ownerMismatch) {
    void audit(input.action, input.caller, input.auditArgs ?? {}, 'denied');
    return serviceError(
      'owner_mismatch',
      `You are not the owner of "${resolved.job.meta.id}". Only ${ownerMismatch} can modify it.`,
      { job: resolved.job, jobId: resolved.job.meta.id, owner: ownerMismatch },
    );
  }
  if (!updated) {
    return serviceError('job_not_found', `Job "${resolved.job.meta.id}" not found.`, {
      jobId: resolved.job.meta.id,
    });
  }

  void audit(input.action, input.caller, input.auditArgs ?? {}, 'ok');
  return { ok: true, job: updated };
}

export async function deleteJob(input: DeleteJobInput): Promise<JobServiceResult<{ jobId: string }>> {
  const resolved = await resolveJobReference(input.reference);
  if (!resolved.ok) return resolved;

  const ownerError = ownerMismatchError('delete_job', resolved.job, input.caller, input.auditArgs);
  if (ownerError) return ownerError;

  const deleted = await deleteJobFile(resolved.job.meta.id);
  if (!deleted) {
    return serviceError('job_not_found', `Job "${resolved.job.meta.id}" not found.`, {
      jobId: resolved.job.meta.id,
    });
  }

  void audit('delete_job', input.caller, input.auditArgs ?? {}, 'ok');
  return { ok: true, jobId: resolved.job.meta.id };
}

export async function upsertJob(input: UpsertJobInput): Promise<JobServiceResult<{
  job: JobFile;
  created: boolean;
  scheduleHuman: string;
  timezone: string;
  nextRunAt: string;
}>> {
  const normalized = validateJobDefinition(input);
  if (!normalized.ok) return normalized;

  const existing = await resolveJobReference({ name: input.name });
  if (existing.ok) {
    const ownerError = ownerMismatchError('upsert_job', existing.job, input.caller, input.auditArgs);
    if (ownerError) return ownerError;

    const workspace = input.rebindWorkspaceProject && input.workspaceProject
      ? await resolveNewJobWorkspace(input)
      : undefined;
    if (workspace && !workspace.ok) return workspace;

    let ownerMismatch: string | null = null;
    const updated = await mutateJob(existing.job.meta.id, (latest) => {
      if (latest.meta.created_by !== input.caller) {
        ownerMismatch = latest.meta.created_by;
        return false;
      }
      latest.meta.name = input.name;
      latest.meta.type = input.type;
      latest.meta.schedule = normalized.cron;
      latest.meta.schedule_human = normalized.scheduleHuman;
      latest.meta.timezone = normalized.timezone;
      latest.meta.target_chat_id = input.targetChatId;
      latest.meta.model = input.model || undefined;
      latest.meta.status = input.status ?? 'active';
      if (input.type === 'prompt') {
        latest.meta.prompt = input.prompt;
        if (workspace?.workspaceProject) latest.meta.workspace_project = workspace.workspaceProject;
        delete latest.meta.content;
        delete latest.meta.msg_type;
      } else {
        latest.meta.content = input.content;
        latest.meta.msg_type = 'text';
        delete latest.meta.prompt;
        delete latest.meta.workspace_project;
      }
      latest.runtime.next_run_at = computeNextRun(normalized.cron, normalized.timezone);
      latest.runtime.last_error = null;
    });

    if (ownerMismatch) {
      void audit('upsert_job', input.caller, input.auditArgs ?? {}, 'denied');
      return serviceError(
        'owner_mismatch',
        `You are not the owner of "${existing.job.meta.id}". Only ${ownerMismatch} can modify it.`,
        { job: existing.job, jobId: existing.job.meta.id, owner: ownerMismatch },
      );
    }
    if (!updated) {
      return serviceError('job_not_found', `Job "${existing.job.meta.id}" not found.`, {
        jobId: existing.job.meta.id,
      });
    }

    void audit('upsert_job', input.caller, input.auditArgs ?? {}, 'ok');
    return {
      ok: true,
      job: updated,
      created: false,
      scheduleHuman: normalized.scheduleHuman,
      timezone: normalized.timezone,
      nextRunAt: updated.runtime.next_run_at,
    };
  }

  if (existing.code !== 'job_not_found') return existing;

  const workspace = await resolveNewJobWorkspace(input);
  if (!workspace.ok) return workspace;
  const job = buildJobFile(input, normalized, workspace.workspaceProject);
  await writeJob(job);
  void audit('upsert_job', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    job,
    created: true,
    scheduleHuman: normalized.scheduleHuman,
    timezone: normalized.timezone,
    nextRunAt: normalized.nextRunAt,
  };
}
