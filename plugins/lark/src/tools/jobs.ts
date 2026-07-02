import { z } from 'zod';
import { appConfig } from '../config.js';
import { audit } from '../audit-log.js';
import { assertSafeChatId } from '../prompts.js';
import { createDefaultReviewJobs } from '../default-review-jobs.js';
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
  formatCronDateTime,
  jobTimezone,
  normalizeJobTimezone,
  readJob,
  writeJob,
  mutateJob,
  deleteJob as deleteJobFile,
  listAllJobs,
  jobExists,
  type JobFile,
} from '../job-store.js';
import type { ToolContext } from './tool-context.js';

export function registerJobTools(ctx: ToolContext): void {
  const { server, channel, resolveCaller } = ctx;

  server.registerTool(
    'create_default_review_jobs',
    {
      description:
        'Create built-in self-review and low-risk auto-fix cronjob presets as paused jobs. They are disabled by default and only run after the owner explicitly resumes them.',
      inputSchema: z.object({
        target_repo: z.string().describe('GitHub repository in owner/name form'),
        target_chat_id: z.string().describe('Feishu chat that receives review reports'),
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone for the preset jobs. Defaults to LARK_CRON_TIMEZONE.'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ target_repo, target_chat_id, timezone, chat_id, thread_id }) => {
      const auditArgs = { target_repo, target_chat_id, timezone, chat_id, thread_id };
      const auth = resolveCaller('create_default_review_jobs', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      try {
        assertSafeChatId(target_chat_id);
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Invalid target_chat_id: ${err?.message ?? target_chat_id}` }],
          isError: true,
        };
      }

      try {
        const result = await createDefaultReviewJobs({
          targetRepo: target_repo,
          targetChatId: target_chat_id,
          originChatId: chat_id,
          createdBy: caller,
          timezone,
        });
        void audit('create_default_review_jobs', caller, auditArgs, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Created default review jobs: ${result.created.length ? result.created.join(', ') : 'none'}.`,
                result.skipped.length ? `Skipped existing jobs: ${result.skipped.join(', ')}.` : '',
                'These jobs are disabled by default (status=paused). Resume them explicitly before they run.',
              ].filter(Boolean).join('\n'),
            },
          ],
        };
      } catch (err: any) {
        void audit('create_default_review_jobs', caller, auditArgs, 'error');
        return {
          content: [{ type: 'text' as const, text: `Failed to create default review jobs: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'create_job',
    {
      description:
        'Create a scheduled cronjob. Use type="message" for fixed content (deterministic) or type="prompt" for Codex-executed tasks (best-effort). For critical notifications use message type. The creator identity is derived from the server-side session — you cannot create a job "on behalf of" another user.',
      inputSchema: z.object({
        name: z.string().describe('Job display name (can be Chinese)'),
        type: z.enum(['prompt', 'message']).describe('Job type'),
        schedule: z
          .string()
          .describe(
            'Cron expression or alias: "0 9 * * 1-5", "every 30m", "daily at 09:00", "weekdays at 09:00", "weekly on mon at 09:00"'
          ),
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone for this job, e.g. "Asia/Shanghai", "Asia/Tokyo", or "UTC". Defaults to LARK_CRON_TIMEZONE.'),
        prompt: z
          .string()
          .optional()
          .describe('Prompt for Codex to execute (type=prompt)'),
        content: z
          .string()
          .optional()
          .describe('Fixed message content (type=message)'),
        target_chat_id: z
          .string()
          .describe('Chat ID that receives job output. Used by scheduler delivery and list_jobs visibility filter.'),
        model: z
          .string()
          .optional()
          .describe('Model override for prompt-type jobs. Use a model id supported by the current Codex environment; leave unset to use the default.'),
        chat_id: z
          .string()
          .describe('Chat ID where this create_job call was triggered — used to resolve caller identity and to populate origin_chat_id'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ name, type, schedule, timezone, prompt, content, target_chat_id, model, chat_id, thread_id }) => {
      const auditArgs = { name, type, schedule, timezone, target_chat_id, model, chat_id, thread_id };
      const auth = resolveCaller('create_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      if (type === 'prompt' && !prompt) {
        return {
          content: [{ type: 'text' as const, text: 'prompt is required for type=prompt' }],
          isError: true,
        };
      }
      if (type === 'message' && !content) {
        return {
          content: [{ type: 'text' as const, text: 'content is required for type=message' }],
          isError: true,
        };
      }
      try {
        assertSafeChatId(target_chat_id);
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid target_chat_id: ${err?.message ?? target_chat_id}`,
            },
          ],
          isError: true,
        };
      }

      let cron: string;
      let scheduleHuman: string;
      let jobTz: string;
      try {
        jobTz = normalizeJobTimezone(timezone);
        const expanded = expandSchedule(schedule, jobTz);
        cron = expanded.cron;
        scheduleHuman = expanded.human;
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid schedule expression: ${err?.message ?? schedule}`,
            },
          ],
          isError: true,
        };
      }

      const id = sanitizeJobId(name);
      if (await jobExists(id)) {
        return {
          content: [
            { type: 'text' as const, text: `Job "${id}" already exists. Use a different name or delete the existing job first.` },
          ],
          isError: true,
        };
      }

      const nextRunAt = computeNextRun(cron, jobTz);

      const job: JobFile = {
        meta: {
          id,
          name,
          type,
          schedule: cron,
          schedule_human: scheduleHuman,
          timezone: jobTz,
          ...(type === 'prompt' ? { prompt } : { content, msg_type: 'text' }),
          target_chat_id,
          ...(model ? { model } : {}),
          origin_chat_id: chat_id,
          status: 'active',
          created_by: caller,
          created_at: new Date().toISOString(),
        },
        runtime: {
          last_run_at: null,
          next_run_at: nextRunAt,
          run_count: 0,
          last_error: null,
          run_id: null,
          run_status: null,
          output_status: null,
          delivery_status: null,
          report: null,
          report_type: null,
          delivery_error: null,
        },
      };

      await writeJob(job);
      void audit('create_job', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created job "${id}" (${scheduleHuman}, tz=${jobTz}). Next run: ${formatCronDateTime(nextRunAt, jobTz)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'list_jobs',
    {
      description:
        'List cronjobs visible in the current chat. Filter follows the rendering-visibility principle: in a private chat the caller sees all jobs they created; in a group chat everyone sees jobs that deliver output to that group (with prompt bodies redacted for non-owners).',
      inputSchema: z.object({
        status: z
          .enum(['active', 'paused', 'all'])
          .optional()
          .default('all')
          .describe('Filter by status'),
        chat_id: z.string().describe('Chat ID where this list call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ status, chat_id, thread_id }) => {
      const auditArgs = { status, chat_id, thread_id };
      const auth = resolveCaller('list_jobs', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const jobs = await listAllJobs();
      const byStatus =
        status === 'all' ? jobs : jobs.filter((j) => j.meta.status === status);

      const isPrivate = channel.isPrivateChat(chat_id);
      const visible = byStatus.filter((j) => {
        if (isPrivate) return j.meta.created_by === caller;
        return j.meta.target_chat_id === chat_id;
      });

      if (visible.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No jobs found.' }],
        };
      }

      const lines = visible.map((j) => {
        const statusIcon = j.meta.status === 'active' ? '✅' : '⏸️';
        const tz = jobTimezone(j.meta);
        const lastRun = formatCronDateTime(j.runtime.last_run_at, tz);
        const error = j.runtime.last_error ? ` ⚠️ ${j.runtime.last_error}` : '';
        const isOwner = j.meta.created_by === caller;
        const runState =
          j.runtime.run_status || j.runtime.output_status || j.runtime.delivery_status
            ? ` | Run: ${j.runtime.run_status ?? '-'} / Output: ${j.runtime.output_status ?? '-'} / Delivery: ${j.runtime.delivery_status ?? '-'}`
            : '';

        if (!isPrivate && !isOwner) {
          return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   By: ${j.meta.created_by} | TZ: ${tz} | Next: ${formatCronDateTime(j.runtime.next_run_at, tz)}`;
        }
        const modelNote = j.meta.model ? ` | Model: ${j.meta.model}` : '';
        return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   TZ: ${tz} | Next: ${formatCronDateTime(j.runtime.next_run_at, tz)} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${modelNote}${runState}${error}`;
      });

      void audit('list_jobs', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Timezone: ${appConfig.cronTimezone}\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'update_job',
    {
      description:
        'Update a cronjob — change schedule, content, pause, or resume. Only the job owner can mutate a job.',
      inputSchema: z.object({
        id: z.string().describe('Job ID'),
        status: z.enum(['active', 'paused']).optional().describe('Set status'),
        schedule: z.string().optional().describe('New cron expression or alias'),
        timezone: z
          .string()
          .optional()
          .describe('New IANA timezone for this job. Recomputes next_run_at even if schedule is unchanged.'),
        prompt: z.string().optional().describe('New prompt (type=prompt)'),
        content: z.string().optional().describe('New content (type=message)'),
        name: z.string().optional().describe('New display name'),
        model: z
          .string()
          .optional()
          .describe('Model override for prompt-type jobs. Use a model id supported by the current Codex environment; pass empty string to clear.'),
        chat_id: z.string().describe('Chat ID where this update call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ id, status, schedule, timezone, prompt, content, name, model, chat_id, thread_id }) => {
      const auditArgs = { id, status, schedule, timezone, name, model, chat_id, thread_id };
      const auth = resolveCaller('update_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const job = await readJob(id);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      if (job.meta.created_by !== caller) {
        void audit('update_job', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: `You are not the owner of "${id}". Only ${job.meta.created_by} can update it.`,
            },
          ],
          isError: true,
        };
      }

      let expandedSchedule: { cron: string; human: string } | null = null;
      let requestedTimezone: string | null = null;
      try {
        requestedTimezone = timezone === undefined ? null : normalizeJobTimezone(timezone);
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timezone: ${err?.message ?? timezone}`,
            },
          ],
          isError: true,
        };
      }
      if (schedule !== undefined) {
        try {
          expandedSchedule = expandSchedule(schedule, requestedTimezone ?? jobTimezone(job.meta));
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid schedule: ${err?.message ?? schedule}`,
              },
            ],
            isError: true,
          };
        }
      }

      let ownerMismatch: string | null = null;
      const updated = await mutateJob(id, (latest) => {
        if (latest.meta.created_by !== caller) {
          ownerMismatch = latest.meta.created_by;
          return false;
        }

        if (name !== undefined) latest.meta.name = name;
        if (prompt !== undefined) latest.meta.prompt = prompt;
        if (content !== undefined) latest.meta.content = content;
        if (model !== undefined) latest.meta.model = model || undefined;
        if (requestedTimezone) latest.meta.timezone = requestedTimezone;
        if (expandedSchedule) {
          latest.meta.schedule = expandedSchedule.cron;
          latest.meta.schedule_human = expandedSchedule.human;
          latest.runtime.next_run_at = computeNextRun(expandedSchedule.cron, jobTimezone(latest.meta));
        }
        if (requestedTimezone && !expandedSchedule) {
          latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, requestedTimezone);
        }
        if (status !== undefined) {
          latest.meta.status = status;
          if (status === 'active' && !schedule && !requestedTimezone) {
            latest.runtime.next_run_at = computeNextRun(latest.meta.schedule, jobTimezone(latest.meta));
          }
        }
      });

      if (!updated) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      if (ownerMismatch) {
        void audit('update_job', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: `You are not the owner of "${id}". Only ${ownerMismatch} can update it.`,
            },
          ],
          isError: true,
        };
      }

      void audit('update_job', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated job "${id}". Status: ${updated.meta.status}, TZ: ${jobTimezone(updated.meta)}, Next run: ${formatCronDateTime(updated.runtime.next_run_at, jobTimezone(updated.meta))}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'delete_job',
    {
      description: 'Delete a cronjob permanently. Only the job owner can delete.',
      inputSchema: z.object({
        id: z.string().describe('Job ID to delete'),
        chat_id: z.string().describe('Chat ID where this delete call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ id, chat_id, thread_id }) => {
      const auditArgs = { id, chat_id, thread_id };
      const auth = resolveCaller('delete_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const existing = await readJob(id);
      if (!existing) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      if (existing.meta.created_by !== caller) {
        void audit('delete_job', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: `You are not the owner of "${id}". Only ${existing.meta.created_by} can delete it.`,
            },
          ],
          isError: true,
        };
      }

      const deleted = await deleteJobFile(id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      void audit('delete_job', caller, auditArgs, 'ok');
      return {
        content: [{ type: 'text' as const, text: `Deleted job "${id}".` }],
      };
    }
  );
}
