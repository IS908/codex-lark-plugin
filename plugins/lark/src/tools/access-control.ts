import { z } from 'zod';
import { appConfig } from '../config.js';
import { audit } from '../audit-log.js';
import {
  ACCESS_CONTROL_LISTS,
  accessControlStore,
  type AccessControlAction,
  type AccessControlListName,
} from '../runtime-access-control.js';
import {
  formatAccessControlMutationMessage,
  validateAccessControlMutation,
  validateFeishuChatAccess,
} from '../access-control-validation.js';
import type { ToolContext } from './tool-context.js';

function textResult(text: string, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

function formatSnapshot(): string {
  return JSON.stringify(accessControlStore.snapshot(), null, 2);
}

export function registerAccessControlTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    'manage_access_control',
    {
      description:
        'Owner-only runtime access control management for this Lark bridge. Supports list/add/remove for allowed users, allowed chats, and trusted no-mention chats. Pass chat_id/thread_id from current channel metadata.',
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'remove']).default('list'),
        list: z.enum(ACCESS_CONTROL_LISTS).optional(),
        value: z.string().optional(),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id for server-side caller resolution'),
      }),
    },
    async ({ action = 'list', list, value, chat_id, thread_id }) => {
      const auditArgs = { action, list, value, chat_id, thread_id };
      const auth = ctx.resolveCaller('manage_access_control', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      if (!appConfig.ownerOpenId || caller !== appConfig.ownerOpenId) {
        await audit('manage_access_control', caller, auditArgs, 'denied');
        return textResult('manage_access_control is owner-only. Set LARK_OWNER_OPEN_ID and call from that owner identity.', true);
      }

      if (action === 'list') {
        await audit('manage_access_control', caller, auditArgs, 'ok');
        return textResult(formatSnapshot());
      }

      if (!list) {
        await audit('manage_access_control', caller, auditArgs, 'denied');
        return textResult('list is required for add/remove.', true);
      }
      if (!value) {
        await audit('manage_access_control', caller, auditArgs, 'denied');
        return textResult('value is required for add/remove.', true);
      }

      try {
        const validated = await validateAccessControlMutation({
          action: action as AccessControlAction,
          list: list as AccessControlListName,
          value,
          currentChatId: chat_id,
          currentChatType: ctx.channel.isPrivateChat(chat_id) ? 'p2p' : 'group',
          validateChatAccess: (chatId) => validateFeishuChatAccess(ctx.client, chatId),
        });
        const result = await accessControlStore.mutate({
          action: validated.action,
          list: validated.list,
          value: validated.value,
          updatedBy: caller,
        });
        await audit('manage_access_control', caller, auditArgs, 'ok');
        return textResult(
          formatAccessControlMutationMessage(
            result.changed,
            validated.action,
            validated.list,
            validated.value,
          ),
        );
      } catch (err) {
        await audit('manage_access_control', caller, auditArgs, 'error');
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  );
}
