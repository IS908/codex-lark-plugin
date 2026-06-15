import { z } from 'zod';
import { appConfig } from '../config.js';
import { DOC_CHAT_ID_PREFIX } from '../identity-session.js';
import type { IdentitySession } from '../identity-session.js';
import { audit } from '../audit-log.js';
import { buildCommentElements } from '../doc-comment-api.js';
import { feishuApiCall } from '../feishu-retry.js';
import type { ConversationBuffer } from '../memory/buffer.js';
import {
  createTransportProxy,
  type LarkTransportProvider,
} from './tool-context.js';

interface DocCommentClient {
  drive: {
    fileCommentReply: {
      create: (req: {
        path: { file_token: string; comment_id: string };
        params: { file_type: string; user_id_type?: string };
        data: { content: { elements: unknown[] } };
      }) => Promise<{ data?: { reply_id?: string } }>;
    };
    fileComment: {
      create: (req: {
        path: { file_token: string };
        params: { file_type: string; user_id_type?: string };
        data: { reply_list: { replies: Array<{ content: { elements: unknown[] } }> } };
      }) => Promise<{ data?: { comment_id?: string } }>;
    };
  };
}

interface DocCommentServer {
  registerTool: (
    name: string,
    config: { description?: string; inputSchema: z.ZodTypeAny },
    handler: (args: any) => Promise<{
      isError?: boolean;
      content: { type: 'text'; text: string }[];
    }>,
  ) => unknown;
}

export interface DocCommentToolsDeps {
  server: DocCommentServer;
  client?: DocCommentClient;
  transport?: LarkTransportProvider;
  identitySession: IdentitySession;
  conversationBuffer?: ConversationBuffer;
}

function docCommentError(text: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text }] };
}

function resolveDocCommentCaller(
  identitySession: IdentitySession,
  toolName: string,
  chatId: string | undefined,
  threadId: string | undefined,
  args: Record<string, unknown>,
):
  | { caller: string }
  | { error: { isError: true; content: { type: 'text'; text: string }[] } } {
  if (!chatId) {
    void audit(toolName, null, args, 'denied');
    return { error: docCommentError('chat_id is required for this tool') };
  }
  const caller = identitySession.getCaller(chatId, threadId);
  if (!caller) {
    void audit(toolName, null, args, 'denied');
    return { error: docCommentError(`No active identity session for chat ${chatId}.`) };
  }
  return { caller };
}

function validateDocCommentScope(
  toolName: string,
  caller: string,
  args: Record<string, unknown>,
  chatId: string,
  docToken: string,
): { isError: true; content: { type: 'text'; text: string }[] } | null {
  if (!appConfig.ownerOpenId || caller !== appConfig.ownerOpenId) {
    void audit(toolName, caller, args, 'denied');
    return docCommentError(`${toolName} is owner-only.`);
  }
  if (!chatId.startsWith(DOC_CHAT_ID_PREFIX)) {
    void audit(toolName, caller, args, 'denied');
    return docCommentError(
      `${toolName} is only callable from doc-comment-triggered turns (chat_id must start with "doc:"). Got chat_id=${chatId}.`,
    );
  }
  const expectedToken = chatId.slice(DOC_CHAT_ID_PREFIX.length);
  if (docToken !== expectedToken) {
    void audit(toolName, caller, args, 'denied');
    return docCommentError(
      `doc_token mismatch: the doc-comment notification was for ${expectedToken}, but ${toolName} was called with doc_token=${docToken}.`,
    );
  }
  return null;
}

export function registerDocCommentTools(deps: DocCommentToolsDeps): void {
  const { server, client, identitySession, conversationBuffer } = deps;
  const transport = typeof deps.transport === 'function'
    ? createTransportProxy(deps.transport)
    : deps.transport;
  const fileTypeSchema = z.enum(['docx', 'doc', 'sheet', 'file', 'slides', 'bitable']);

  function recordAssistantComment(chatId: string, content: string): void {
    conversationBuffer?.record(chatId, {
      role: 'assistant',
      senderId: 'bot',
      text: content.slice(0, 500),
      timestamp: new Date().toISOString(),
    });
  }

  server.registerTool(
    'reply_doc_comment',
    {
      description:
        'Reply to a Feishu doc comment thread. Use only from doc-comment-triggered turns and pass chat_id, thread_id, doc_token, and comment_id from the current notification metadata.',
      inputSchema: z.object({
        chat_id: z.string().describe('Current doc-comment chat_id. Must start with "doc:".'),
        thread_id: z.string().optional().describe('Current doc-comment thread_id, equal to comment_id.'),
        doc_token: z.string().describe('Document token from the doc-comment notification.'),
        comment_id: z.string().describe('Comment thread id to reply under.'),
        content: z.string().describe('Plain text reply content, max 1000 characters.'),
        file_type: fileTypeSchema,
      }),
    },
    async ({ chat_id, thread_id, doc_token, comment_id, content, file_type }) => {
      const auditArgs = { chat_id, thread_id, doc_token, comment_id, content, file_type };
      const auth = resolveDocCommentCaller(identitySession, 'reply_doc_comment', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const scopeError = validateDocCommentScope('reply_doc_comment', auth.caller, auditArgs, chat_id, doc_token);
      if (scopeError) return scopeError;
      if (thread_id !== comment_id) {
        void audit('reply_doc_comment', auth.caller, auditArgs, 'denied');
        return docCommentError(
          `comment_id mismatch: reply_doc_comment must target the current doc-comment thread_id=${thread_id}, but got comment_id=${comment_id}.`,
        );
      }

      let elements: unknown[];
      try {
        elements = buildCommentElements(content);
      } catch (err: any) {
        void audit('reply_doc_comment', auth.caller, auditArgs, 'denied');
        return docCommentError(err?.message ?? String(err));
      }

      try {
        const resp = transport
          ? { data: { reply_id: (await transport.replyDocComment({
              docToken: doc_token,
              commentId: comment_id,
              content,
              fileType: file_type,
            })).replyId } }
          : await feishuApiCall(
              'reply_doc_comment.create',
              () => client!.drive.fileCommentReply.create({
                path: { file_token: doc_token, comment_id },
                params: { file_type, user_id_type: 'open_id' },
                data: { content: { elements } },
              }),
              { retryTimeout: false },
            );
        void audit('reply_doc_comment', auth.caller, auditArgs, 'ok');
        recordAssistantComment(chat_id, content);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Reply posted. reply_id=${resp?.data?.reply_id ?? '<unknown>'}`,
            },
          ],
        };
      } catch (err: any) {
        void audit('reply_doc_comment', auth.caller, auditArgs, 'error');
        const code = err?.code ?? err?.response?.data?.code ?? err?.data?.code;
        const hint =
          code === 1069302
            ? ' The document has collaborator comments disabled. Ask the doc owner to enable collaborator comments.'
            : '';
        return docCommentError(`Feishu API rejected the reply: ${err?.message ?? String(err)}.${hint}`.trim());
      }
    },
  );

  server.registerTool(
    'create_doc_comment',
    {
      description:
        'Create a new top-level Feishu doc comment in the triggering document. Use only from doc-comment-triggered turns.',
      inputSchema: z.object({
        chat_id: z.string().describe('Current doc-comment chat_id. Must start with "doc:".'),
        thread_id: z.string().optional().describe('Current doc-comment thread_id used for identity binding.'),
        doc_token: z.string().describe('Document token from the doc-comment notification.'),
        content: z.string().describe('Plain text comment content, max 1000 characters.'),
        file_type: fileTypeSchema,
      }),
    },
    async ({ chat_id, thread_id, doc_token, content, file_type }) => {
      const auditArgs = { chat_id, thread_id, doc_token, content, file_type };
      const auth = resolveDocCommentCaller(identitySession, 'create_doc_comment', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const scopeError = validateDocCommentScope('create_doc_comment', auth.caller, auditArgs, chat_id, doc_token);
      if (scopeError) return scopeError;

      let elements: unknown[];
      try {
        elements = buildCommentElements(content);
      } catch (err: any) {
        void audit('create_doc_comment', auth.caller, auditArgs, 'denied');
        return docCommentError(err?.message ?? String(err));
      }

      try {
        const resp = transport
          ? { data: { comment_id: (await transport.createDocComment({
              docToken: doc_token,
              content,
              fileType: file_type,
            })).commentId } }
          : await feishuApiCall(
              'create_doc_comment.create',
              () => client!.drive.fileComment.create({
                path: { file_token: doc_token },
                params: { file_type, user_id_type: 'open_id' },
                data: { reply_list: { replies: [{ content: { elements } }] } },
              }),
              { retryTimeout: false },
            );
        void audit('create_doc_comment', auth.caller, auditArgs, 'ok');
        recordAssistantComment(chat_id, content);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Top-level comment posted. comment_id=${resp?.data?.comment_id ?? '<unknown>'}`,
            },
          ],
        };
      } catch (err: any) {
        void audit('create_doc_comment', auth.caller, auditArgs, 'error');
        return docCommentError(`Feishu API error: ${err?.message ?? String(err)}`);
      }
    },
  );
}
