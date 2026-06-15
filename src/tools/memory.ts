import { z } from 'zod';
import { appConfig } from '../config.js';
import { SYSTEM_FLUSH_CALLER } from '../identity-session.js';
import { audit } from '../audit-log.js';
import type { ToolContext } from './tool-context.js';

export function registerMemoryTools(ctx: ToolContext): void {
  const { server, memoryStore, resolveCaller, triggerProfileDistillation } = ctx;

  server.registerTool(
    'save_memory',
    {
      description:
        'Save a memory entry for cross-session recall. Only save durable, reusable facts — user preferences, communication style, key decisions, ongoing projects, resolved problems. Do NOT save pleasantries, failed attempts, ephemeral details, or conversation filler. Profile writes always save facts about the CALLER of this tool (i.e. the Feishu user whose message triggered the current turn) — you cannot save profile facts about a different user. For profile writes, pass tier="public" only for facts that are safe for anyone mentioning this user to see (job title, tech stack, team); everything else defaults to "private" (owner-only).',
      inputSchema: z.object({
        type: z
          .enum(['profile', 'chat', 'thread'])
          .describe(
            'Memory type: "profile" for facts about the caller, "chat" for conversation summary, "thread" for thread-level summary'
          ),
        content: z.string().describe('The memory content to save (concise, factual)'),
        reason: z.string().describe('Why this is worth remembering'),
        chat_id: z.string().describe('Chat ID — required; also used to resolve caller identity'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — both for server-side caller resolution (omitting it silently attributes the call to the wrong user in cronjob turns) and when type="thread".'
          ),
        tier: z
          .enum(['public', 'private'])
          .optional()
          .describe(
            'Profile tier (type="profile" only). "public": safe for others to see when they @mention this user (job title, tech stack, team). "private": owner-only (preferences, ongoing work, emotional state, etc.). Defaults to "private" when omitted — err on the side of less exposure.'
          ),
        mode: z
          .enum(['append', 'replace'])
          .optional()
          .describe(
            'Profile write mode (type="profile" only). Defaults to "append": new lines merged into the existing tier, deduped case-insensitively; existing entries are preserved. Use "replace" ONLY during distiller auto-flush when you are rewriting the full tier from a fresh read of the conversation — replace overwrites the entire file.'
          ),
      }),
    },
    async ({ type, content, reason, chat_id, thread_id, tier, mode }) => {
      const auditArgs =
        type === 'profile'
          ? { type, chat_id, thread_id, tier, mode }
          : { type, chat_id, thread_id };
      const auth = resolveCaller('save_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      if (type === 'profile' && caller === SYSTEM_FLUSH_CALLER) {
        void audit('save_memory', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'save_memory(type=profile) denied: caller is the system-flush sentinel. ' +
                'Profile writes need a real user identity. If you reached this in an ' +
                'auto-flush turn, restrict to type=chat or type=thread.',
            },
          ],
          isError: true,
        };
      }

      if (type === 'profile') {
        const effectiveTier = tier ?? 'private';
        const effectiveMode = mode ?? 'append';
        await memoryStore.saveProfile(caller, content, effectiveTier, effectiveMode);
        void audit('save_memory', caller, auditArgs, 'ok');
        return {
          content: [
            { type: 'text' as const, text: `Saved ${effectiveTier} profile for ${caller} (mode: ${effectiveMode}). Reason: ${reason}` },
          ],
        };
      }

      if (type === 'thread' && !thread_id) {
        void audit('save_memory', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: 'save_memory(type=thread) requires thread_id from the current notification metadata.',
            },
          ],
          isError: true,
        };
      }

      await memoryStore.saveEpisode(type, content, {
        chatId: chat_id,
        threadId: thread_id,
      });
      triggerProfileDistillation(caller, chat_id, thread_id);
      void audit('save_memory', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${type} episode for chat ${chat_id}. Reason: ${reason}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'save_skill',
    {
      description:
        'Save a reusable procedure as a global skill. Owner-only because skills are searchable across all users and chats. Use for repeatable workflows, deployment procedures, troubleshooting guides, etc.',
      inputSchema: z.object({
        name: z.string().describe('Short skill name (e.g., "deploy-service")'),
        description: z.string().describe('One-line description of what this skill does'),
        content: z.string().describe('The full procedure/instructions'),
        chat_id: z.string().describe('Current channel chat_id. Required to resolve caller identity server-side.'),
        thread_id: z.string().optional().describe('Current channel thread_id, when present.'),
      }),
    },
    async ({ name, description, content, chat_id, thread_id }) => {
      const auditArgs = { name, chat_id, thread_id };
      const auth = resolveCaller('save_skill', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      if (!appConfig.ownerOpenId || caller !== appConfig.ownerOpenId) {
        void audit('save_skill', caller, auditArgs, 'denied');
        return {
          content: [{ type: 'text' as const, text: 'save_skill is owner-only because skills are global across users and chats.' }],
          isError: true,
        };
      }
      try {
        await memoryStore.saveSkill(name, description, content);
        void audit('save_skill', caller, auditArgs, 'ok');
      } catch (err: any) {
        void audit('save_skill', caller, auditArgs, 'error');
        return {
          content: [{ type: 'text' as const, text: `Failed to save skill "${name}": ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Saved skill "${name}": ${description}` }],
      };
    }
  );
}
