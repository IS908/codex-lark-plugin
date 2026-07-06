import { z } from 'zod';
import { appConfig } from '../config.js';
import { audit } from '../audit-log.js';
import { assertSafeChatId } from '../prompts.js';
import { createDefaultReviewJobs } from '../default-review-jobs.js';
import {
  formatCronDateTime,
  jobTimezone,
} from '../job-store.js';
import {
  createJob,
  deleteJob,
  listVisibleJobs,
  updateJob,
} from '../job-service.js';
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

      const created = await createJob({
        name,
        type,
        schedule,
        timezone,
        prompt,
        content,
        targetChatId: target_chat_id,
        model,
        originChatId: chat_id,
        caller,
        auditAction: 'create_job',
        auditArgs,
      });
      if (!created.ok) {
        let text = created.message;
        if (created.code === 'missing_prompt') text = 'prompt is required for type=prompt';
        if (created.code === 'missing_content') text = 'content is required for type=message';
        if (created.code === 'invalid_timezone') text = created.message.replace(/^Invalid timezone: /, 'Invalid schedule expression: ');
        if (created.code === 'job_exists') {
          text = `Job "${created.jobId}" already exists. Use a different name or delete the existing job first.`;
        }
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created job "${created.job.meta.id}" (${created.scheduleHuman}, tz=${created.timezone}). Next run: ${formatCronDateTime(created.nextRunAt, created.timezone)}`,
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

      const isPrivate = channel.isPrivateChat(chat_id);
      const listed = await listVisibleJobs({
        caller,
        chatId: chat_id,
        isPrivateChat: isPrivate,
        status,
        auditArgs,
      });
      if (!listed.ok) {
        return {
          content: [{ type: 'text' as const, text: listed.message }],
          isError: true,
        };
      }
      const { jobs: visible } = listed;

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

      const updated = await updateJob({
        action: 'update_job',
        caller,
        reference: { jobId: id },
        updates: { status, schedule, timezone, prompt, content, name, model },
        auditArgs,
      });
      if (!updated.ok) {
        let text = updated.message;
        if (updated.code === 'owner_mismatch') {
          text = `You are not the owner of "${id}". Only ${updated.owner} can update it.`;
        }
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated job "${id}". Status: ${updated.job.meta.status}, TZ: ${jobTimezone(updated.job.meta)}, Next run: ${formatCronDateTime(updated.job.runtime.next_run_at, jobTimezone(updated.job.meta))}`,
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

      const deleted = await deleteJob({
        caller,
        reference: { jobId: id },
        auditArgs,
      });
      if (!deleted.ok) {
        let text = deleted.message;
        if (deleted.code === 'owner_mismatch') {
          text = `You are not the owner of "${id}". Only ${deleted.owner} can delete it.`;
        }
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Deleted job "${id}".` }],
      };
    }
  );
}
