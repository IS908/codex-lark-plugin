import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import { audit } from '../audit-log.js';
import { revokeAckReactionWithTransport } from '../ack-reactions.js';
import { validateTrackedBotMessageScope } from '../message-mutation.js';
import type { ToolContext } from './tool-context.js';

export function registerMessageMutationTools(ctx: ToolContext): void {
  const {
    server,
    transport,
    ackReactions,
    botMessageTracker,
    resolveCaller,
    resolveTurnMessageId,
    satisfyTurn,
  } = ctx;

  server.registerTool(
    'edit_message',
    {
      description:
        'Edit a previously sent bot message (text or card_markdown). Only tracked bot messages sent by this plugin in the current chat/thread can be edited.',
      inputSchema: z.object({
        message_id: z.string().describe('Tracked bot message ID to edit'),
        text: z.string().describe('New content'),
        format: z
          .enum(['text', 'card_markdown'])
          .default('text')
          .describe('Format of the content'),
        chat_id: z
          .string()
          .describe('Current channel chat_id'),
        thread_id: z
          .string()
          .optional()
          .describe('Current channel thread_id, when present'),
        reply_to: z
          .string()
          .optional()
          .describe('Current inbound message_id. Used only to satisfy the current Lark turn after the edit succeeds.'),
      }),
    },
    async ({ message_id, text, format, chat_id, thread_id, reply_to }) => {
      const auditArgs = { message_id, chat_id, thread_id, reply_to, format };
      const auth = resolveCaller('edit_message', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const tracked = validateTrackedBotMessageScope({
        toolName: 'edit_message',
        messageId: message_id,
        chatId: chat_id,
        threadId: thread_id,
        botMessageTracker,
      });
      if (!tracked.ok) {
        void audit('edit_message', caller, auditArgs, 'denied');
        return { isError: true, content: [{ type: 'text' as const, text: tracked.message }] };
      }

      let turnMessageId: string | undefined;
      try {
        turnMessageId = resolveTurnMessageId({ reply_to, chat_id, thread_id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
      try {
        if (format === 'card_markdown') {
          await transport.updateCard({
            messageId: message_id,
            card: Lark.messageCard.defaultCard({
              title: '',
              content: text,
            }),
          });
        } else {
          await transport.editMessage({ messageId: message_id, text });
        }
      } catch (err) {
        void audit('edit_message', caller, auditArgs, 'error');
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
      void audit('edit_message', caller, auditArgs, 'ok');
      satisfyTurn(turnMessageId, 'edit_message');
      revokeAckReactionWithTransport(transport, ackReactions, turnMessageId, 'edit_message');

      return {
        content: [{ type: 'text' as const, text: `Edited message ${message_id}` }],
      };
    }
  );

  server.registerTool(
    'recall_message',
    {
      description:
        'Recall a previously sent bot message. Only tracked bot messages sent by this plugin in the current chat/thread can be recalled; user messages and unknown message IDs are rejected.',
      inputSchema: z.object({
        message_id: z.string().describe('Tracked bot message ID to recall'),
        chat_id: z.string().describe('Current channel chat_id'),
        thread_id: z.string().optional().describe('Current channel thread_id, when present'),
        reply_to: z
          .string()
          .optional()
          .describe('Current inbound message_id. Used only to satisfy the current Lark turn after the recall succeeds.'),
      }),
    },
    async ({ message_id, chat_id, thread_id, reply_to }) => {
      const auditArgs = { message_id, chat_id, thread_id, reply_to };
      const auth = resolveCaller('recall_message', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const tracked = validateTrackedBotMessageScope({
        toolName: 'recall_message',
        messageId: message_id,
        chatId: chat_id,
        threadId: thread_id,
        botMessageTracker,
      });
      if (!tracked.ok) {
        void audit('recall_message', caller, auditArgs, 'denied');
        return { isError: true, content: [{ type: 'text' as const, text: tracked.message }] };
      }

      let turnMessageId: string | undefined;
      try {
        turnMessageId = resolveTurnMessageId({ reply_to, chat_id, thread_id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }

      try {
        await transport.recallMessage(message_id);
      } catch (err) {
        void audit('recall_message', caller, auditArgs, 'error');
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }

      void audit('recall_message', caller, auditArgs, 'ok');
      satisfyTurn(turnMessageId, 'recall_message');
      revokeAckReactionWithTransport(transport, ackReactions, turnMessageId, 'recall_message');

      return {
        content: [{ type: 'text' as const, text: `Recalled message ${message_id}` }],
      };
    },
  );

  server.registerTool(
    'react',
    {
      description: 'Add an emoji reaction to a message.',
      inputSchema: z.object({
        message_id: z.string().describe('The message ID to react to'),
        emoji: z.string().describe('Emoji type (e.g., "THUMBSUP", "SMILE", "HEART")'),
      }),
    },
    async ({ message_id, emoji }) => {
      await transport.addReaction(message_id, emoji);
      revokeAckReactionWithTransport(transport, ackReactions, message_id, 'react');
      satisfyTurn(message_id, 'react');

      return {
        content: [{ type: 'text' as const, text: `Added ${emoji} reaction to ${message_id}` }],
      };
    }
  );
}
