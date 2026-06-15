import { z } from 'zod';
import { audit } from '../audit-log.js';
import type { ToolContext } from './tool-context.js';

export function registerTransparencyTools(ctx: ToolContext): void {
  const { server, memoryStore, channel, resolveCaller } = ctx;

  // ── what_do_you_know ──
  server.registerTool(
    'what_do_you_know',
    {
      description:
        "List what the bot has stored in the caller's profile. Output is filtered by current-chat rendering visibility (path B): in a private chat both public and private tiers are rendered; in a group chat only the public tier — because the reply is visible to the whole group. Each returned line has a short hash that forget_memory uses to target the exact line.",
      inputSchema: z.object({
        chat_id: z.string().describe('Chat ID where this call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ chat_id, thread_id }) => {
      const auditArgs = { chat_id, thread_id };
      const auth = resolveCaller('what_do_you_know', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const isPrivate = channel.isPrivateChat(chat_id);
      const pub = await memoryStore.listProfileLines(caller, 'public');
      const priv = isPrivate ? await memoryStore.listProfileLines(caller, 'private') : [];

      const renderSection = (tier: string, lines: { hash: string; text: string }[]) =>
        lines.length === 0
          ? `_${tier}: (empty)_`
          : `**${tier}:**\n${lines.map((l) => `- [${l.hash}] ${l.text}`).join('\n')}`;

      const parts = [renderSection('public', pub)];
      if (isPrivate) parts.push(renderSection('private', priv));

      const footer = isPrivate
        ? '\n\n_Use `forget_memory(hash, tier)` to remove a line._'
        : '\n\n_Private tier hidden in this group. Ask in private chat to see both tiers._';

      void audit('what_do_you_know', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `What I've stored about you:\n\n${parts.join('\n\n')}${footer}`,
          },
        ],
      };
    }
  );

  // ── forget_memory ──
  server.registerTool(
    'forget_memory',
    {
      description:
        "Remove a specific line from the caller's profile. Always caller-scoped — you can only forget things about yourself. Optionally promotes the removed line into a persistent L2 rule so future distillations classify similar content as private.",
      inputSchema: z.object({
        chat_id: z.string().describe('Chat ID where this call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
        hash: z.string().describe('Short 8-char line hash obtained from what_do_you_know'),
        tier: z
          .enum(['public', 'private'])
          .default('public')
          .describe('Which tier the line lives in. Default "public" since that is where misclassifications are externally visible.'),
        promote_to_rule: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, also append the removed line's text to privacy-rules.md under '## Always private' so future distillations classify similar content as private. Use when the removal reflects a durable preference ('I never want anything like this public') rather than a one-off cleanup."
          ),
      }),
    },
    async ({ chat_id, thread_id, hash, tier, promote_to_rule }) => {
      const auditArgs = { chat_id, thread_id, hash, tier, promote_to_rule };
      const auth = resolveCaller('forget_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const lines = await memoryStore.listProfileLines(caller, tier);
      const target = lines.find((l) => l.hash === hash);
      if (!target) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No line with hash "${hash}" in ${tier} tier. Call what_do_you_know to list current lines.`,
            },
          ],
        };
      }

      const removed = await memoryStore.removeProfileLine(caller, tier, hash);
      if (!removed) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to remove line "${hash}".` }],
        };
      }

      // Line removal above is the primary effect; rule promotion is
      // a best-effort enhancement. If addL2Rule fails, don't undo the
      // removal — just report the partial outcome so the user knows.
      let tail = '';
      if (promote_to_rule) {
        try {
          const { addL2Rule } = await import('../privacy-rules.js');
          await addL2Rule(target.text, 'Always private');
          tail = ' Also appended to privacy-rules.md under "Always private" — future distillations will classify similar content accordingly.';
        } catch (err) {
          tail = ` (Warning: removal succeeded but failed to append rule to privacy-rules.md: ${err instanceof Error ? err.message : String(err)}. You can add the rule manually.)`;
        }
      }

      void audit('forget_memory', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Removed "${target.text}" from ${tier} profile.${tail}`,
          },
        ],
      };
    }
  );
}
