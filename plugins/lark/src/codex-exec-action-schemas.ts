import { z } from 'zod';
import path from 'node:path';
import { CONTINUATION_LIMITS } from './domain/continuation.js';
import { expandSchedule, normalizeJobTimezone } from './job-store.js';
import { ACCESS_CONTROL_LISTS } from './runtime-access-control.js';

export const SaveMemoryActionSchema = z.object({
  type: z.literal('save_memory'),
  memory_type: z.enum(['profile', 'chat', 'thread']),
  content: z.string().min(1),
  reason: z.string().min(1),
  tier: z.enum(['public', 'private']).optional(),
  mode: z.enum(['append', 'replace']).optional(),
});
export type SaveMemoryAction = z.infer<typeof SaveMemoryActionSchema>;

export const CreateJobActionSchema = z.object({
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
export type CreateJobAction = z.infer<typeof CreateJobActionSchema>;

const JobReferenceShape = {
  job_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
};

export const ListJobsActionSchema = z.object({
  type: z.literal('list_jobs'),
  status: z.enum(['active', 'paused', 'all']).optional(),
});
export type ListJobsAction = z.infer<typeof ListJobsActionSchema>;

export const UpdateJobActionSchema = z.object({
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
export type UpdateJobAction = z.infer<typeof UpdateJobActionSchema>;

export const DisableJobActionSchema = z.object({
  type: z.literal('disable_job'),
  ...JobReferenceShape,
});
export type DisableJobAction = z.infer<typeof DisableJobActionSchema>;

export const DeleteJobActionSchema = z.object({
  type: z.literal('delete_job'),
  ...JobReferenceShape,
});
export type DeleteJobAction = z.infer<typeof DeleteJobActionSchema>;

export const UpsertJobActionSchema = z.object({
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
export type UpsertJobAction = z.infer<typeof UpsertJobActionSchema>;

export const RunLocalCliToolActionSchema = z.object({
  type: z.literal('run_local_cli_tool'),
  tool: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type RunLocalCliToolAction = z.infer<typeof RunLocalCliToolActionSchema>;

export const ManageAccessControlActionSchema = z.object({
  type: z.literal('manage_access_control'),
  action: z.enum(['list', 'add', 'remove']).default('list'),
  list: z.enum(ACCESS_CONTROL_LISTS).optional(),
  value: z.string().min(1).optional(),
});
export type ManageAccessControlAction = z.infer<typeof ManageAccessControlActionSchema>;

export const GetRunTraceActionSchema = z.object({
  type: z.literal('get_run_trace'),
  source: z.enum(['message', 'cronjob']),
  target: z.enum(['current', 'quoted']).optional(),
  log_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  within_hours: z.number().positive().max(168).optional(),
});
export type GetRunTraceAction = z.infer<typeof GetRunTraceActionSchema>;

export const SendMessageImageSourceSchema = z.enum([
  'local_path',
  'current_message:first_image',
  'quoted_message:first_image',
]);

export const SendMessageImagePayloadSchema = z.object({
  kind: z.literal('image'),
  source: SendMessageImageSourceSchema,
  path: z.string().min(1).optional(),
  text: z.string().optional(),
});

export const SendMessageFilePayloadSchema = z.object({
  kind: z.literal('file'),
  source: SendMessageImageSourceSchema,
  path: z.string().min(1).optional(),
  text: z.string().optional(),
});

export const SendMessageRichPartSchema = z.discriminatedUnion('type', [
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

export const SendMessageRichPayloadSchema = z.object({
  kind: z.literal('rich'),
  parts: z.array(SendMessageRichPartSchema).min(1),
});
export type SendMessageRichPayload = z.infer<typeof SendMessageRichPayloadSchema>;

export const SendMessagePayloadSchema = z.discriminatedUnion('kind', [
  SendMessageImagePayloadSchema,
  SendMessageFilePayloadSchema,
  SendMessageRichPayloadSchema,
]);

export const SendMessageActionSchema = z.object({
  type: z.literal('send_message'),
  message: SendMessagePayloadSchema,
  reply_in_thread: z.boolean().optional(),
});
export type SendMessageAction = z.infer<typeof SendMessageActionSchema>;

export const RecallMessageActionSchema = z.object({
  type: z.literal('recall_message'),
  message_id: z.string().min(1),
});
export type RecallMessageAction = z.infer<typeof RecallMessageActionSchema>;

const ContinuationCheckpointActionSchema = z.object({
  summary: z.string().max(CONTINUATION_LIMITS.objectiveBytes),
  completed_steps: z.array(z.string().max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  remaining_steps: z.array(z.string().max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  constraints: z.array(z.string().max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  decisions: z.array(z.string().max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  references: z.array(z.string().max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
}).strict();

const RelativeContinuationDirectorySchema = z.string().min(1).refine((value) => {
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return false;
  }
  return !value.split(/[\\/]+/).includes('..');
}, 'working_directory must be relative and remain within the configured working root');

export const CreateContinuationActionSchema = z.object({
  type: z.literal('create_continuation_job'),
  title: z.string().min(1).max(CONTINUATION_LIMITS.titleChars),
  objective: z.string().min(1).max(CONTINUATION_LIMITS.objectiveBytes),
  acceptance_criteria: z.array(z.string().min(1).max(CONTINUATION_LIMITS.objectiveBytes))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  context_snapshot: ContinuationCheckpointActionSchema,
  required_tools: z.array(z.string().min(1).max(500))
    .max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  working_directory: RelativeContinuationDirectorySchema.optional(),
}).strict();
export type CreateContinuationAction = z.infer<typeof CreateContinuationActionSchema>;

export const CodexExecActionSchema = z.discriminatedUnion('type', [
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
  CreateContinuationActionSchema,
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

export const CodexExecActionEnvelopeSchema = z.object({
  version: z.literal(1),
  reply: z.string().optional(),
  actions: z.array(CodexExecActionSchema).min(1).max(5),
}).superRefine((envelope, ctx) => {
  const continuationCount = envelope.actions.filter(
    (action) => action.type === 'create_continuation_job',
  ).length;
  if (continuationCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'Only one continuation job may be created in one foreground turn.',
    });
  }
});

export type CodexExecAction = z.infer<typeof CodexExecActionSchema>;

export interface CodexExecActionEnvelope {
  reply?: string;
  actions: CodexExecAction[];
}

export type CodexExecActionEnvelopeParseResult =
  | { ok: true; envelope: CodexExecActionEnvelope }
  | { ok: false; error: string };

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
