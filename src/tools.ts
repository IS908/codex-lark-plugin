import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker, LarkChannel } from './channel.js';
import type { IdentitySession } from './identity-session.js';
import { DOC_CHAT_ID_PREFIX, SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { audit } from './audit-log.js';
import { writeSdkResource } from './sdk-resource.js';
import { sendFeishuReply } from './reply-sender.js';
import { revokeAckReactionWithTransport, type AckReactionTracker } from './ack-reactions.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { assertSafeChatId } from './prompts.js';
import { feishuApiCall } from './feishu-retry.js';
import { buildCommentElements } from './doc-comment-api.js';
import {
  createOpenApiLarkTransport,
  type LarkTransport,
} from './lark-transport.js';

type LarkTransportProvider = LarkTransport | (() => LarkTransport);

function createTransportProxy(resolve: () => LarkTransport): LarkTransport {
  return {
    sendMessage: (request) => resolve().sendMessage(request),
    editMessage: (request) => resolve().editMessage(request),
    updateCard: (request) => resolve().updateCard(request),
    recallMessage: (messageId) => resolve().recallMessage(messageId),
    addReaction: (messageId, emojiType) => resolve().addReaction(messageId, emojiType),
    removeReaction: (messageId, reactionId) => resolve().removeReaction(messageId, reactionId),
    removeReactionByEmoji: (messageId, emojiType) => resolve().removeReactionByEmoji(messageId, emojiType),
    downloadResource: (messageId, fileKey, resourceType) =>
      resolve().downloadResource(messageId, fileKey, resourceType),
    uploadImage: (data) => resolve().uploadImage(data),
    uploadFile: (data, fileName) => resolve().uploadFile(data, fileName),
    replyDocComment: (request) => resolve().replyDocComment(request),
    createDocComment: (request) => resolve().createDocComment(request),
    fetchMessageText: (messageId) => resolve().fetchMessageText(messageId),
  };
}
import { registerLocalCliTools } from './local-cli-tools.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';
import {
  autoPauseJobForPermanentTargetError,
  isPermanentTargetError,
  parseJobThreadId,
} from './scheduler.js';

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

/**
 * Sanitize and length-cap a Feishu attachment filename for safe local
 * storage. Path-basename strips any directory prefix, regex replaces
 * non-`\w.-` chars (including spaces, CJK, special punctuation) with
 * underscore, then the stem is capped at `maxLen - extLength` so the
 * extension always survives. Returns the sanitized + capped string.
 *
 * Exported for unit testing.
 */
export function capSanitizedFilename(raw: string, maxLen: number): string {
  const sanitized = path.basename(raw).replace(/[^\w.\-]/g, '_');
  if (sanitized.length <= maxLen) return sanitized;
  // Find the last `.` separating stem from extension. If no dot or it's
  // the leading char, treat the whole thing as a stem (no extension to
  // preserve) and just truncate.
  const dotIdx = sanitized.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === sanitized.length - 1) {
    return sanitized.slice(0, maxLen);
  }
  const ext = sanitized.slice(dotIdx); // includes leading dot
  // Cap extension itself to half of maxLen — pathological long extensions
  // shouldn't crowd out the stem entirely.
  const safeExt = ext.length > maxLen / 2 ? ext.slice(0, Math.floor(maxLen / 2)) : ext;
  const stem = sanitized.slice(0, dotIdx);
  const stemCap = maxLen - safeExt.length;
  return stem.slice(0, stemCap) + safeExt;
}
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
  readJob,
  writeJob,
  mutateJob,
  deleteJob as deleteJobFile,
  listAllJobs,
  jobExists,
  type JobFile,
} from './job-store.js';

/**
 * Register all MCP tools on the server.
 */
export function registerTools(
  server: McpServer,
  client: Lark.Client,
  memoryStore: MemoryStore,
  identitySession: IdentitySession,
  channel: LarkChannel,
  conversationBuffer?: ConversationBuffer,
  ackReactions?: AckReactionTracker,
  botMessageTracker?: BotMessageTracker,
  latestMessageTracker?: LatestMessageTracker,
  turnObligations?: TurnObligationTracker,
  profileDistiller?: ProfileDistillationDispatcher,
  larkTransport?: LarkTransportProvider
): void {
  const fallbackTransport = createOpenApiLarkTransport(client);
  const resolveTransport =
    typeof larkTransport === 'function'
      ? larkTransport
      : () => larkTransport ?? fallbackTransport;
  const transport = createTransportProxy(resolveTransport);
  /**
   * Resolve the true caller for a sensitive tool invocation via the server-side
   * IdentitySession. Returns either `{ caller }` on success or `{ error }` —
   * an MCP tool result to return directly — on failure. This deliberately
   * ignores any Codex-declared identity parameters.
   *
   * Denials are audit-logged here so callers only need to log 'ok' in their
   * success path.
   */
  function resolveCaller(
    toolName: string,
    chat_id: string | undefined,
    thread_id: string | undefined,
    args: Record<string, unknown>,
  ):
    | { caller: string }
    | { error: { isError: true; content: { type: 'text'; text: string }[] } } {
    if (!chat_id) {
      void audit(toolName, null, args, 'denied');
      return {
        error: {
          isError: true,
          content: [{ type: 'text' as const, text: 'chat_id is required for this tool' }],
        },
      };
    }
    const caller = identitySession.getCaller(chat_id, thread_id);
    if (!caller) {
      void audit(toolName, null, args, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No active identity session for chat ${chat_id}. This tool requires an inbound Feishu message to establish caller identity, or a terminal invocation with LARK_OWNER_OPEN_ID set.`,
            },
          ],
        },
      };
    }
    // SYSTEM_FLUSH_CALLER is bound by buffer.setFlushHandler (#66) to let
    // save_memory persist chat-level distillations without a real user
    // identity. It must NOT authorize anything else — a sentinel-attributed
    // `create_job` would produce a job with `created_by=__system_flush__`
    // that no real operator could update/delete (owner mismatch); a
    // sentinel-attributed `forget_memory` couldn't address any user's
    // profile. The save_memory handler itself further restricts the
    // sentinel to type=chat|thread (rejecting type=profile).
    //
    // The sentinel binding can outlive the flush turn (sticky in
    // IdentitySession until the next real user message overwrites it),
    // so this guard is also defense against any later tool call that
    // happens to land on the leftover entry.
    if (caller === SYSTEM_FLUSH_CALLER && toolName !== 'save_memory') {
      void audit(toolName, caller, args, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${toolName} is not authorized for the system-flush caller. Only save_memory can authorize under this caller (and save_memory itself further restricts to type=chat|thread). The sentinel exists to let buffer flushes persist chat episodes without a real user — not to act on behalf of one.`,
            },
          ],
        },
      };
    }
    return { caller };
  }

  function triggerProfileDistillation(
    caller: string,
    chatId: string,
    threadId: string | undefined,
  ): void {
    if (!profileDistiller) return;
    void profileDistiller
      .maybeDispatch({
        userId: caller,
        chatId,
        ...(threadId ? { threadId } : {}),
        chatType: channel.isPrivateChat(chatId) ? 'p2p' : 'group',
      })
      .then((result) => {
        if (result.status === 'error') {
          console.error(`[profile-distill] dispatch failed for ${caller}: ${result.error ?? 'unknown error'}`);
        }
      })
      .catch((err) => logSafeError('[profile-distill] dispatch failed:', err));
  }

  async function maybeAutoPauseCronJobReplyFailure(
    thread_id: string | undefined,
    err: unknown,
  ): Promise<void> {
    const parsed = parseJobThreadId(thread_id);
    if (!parsed?.createdAtHash || !isPermanentTargetError(err)) return;
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const paused = await autoPauseJobForPermanentTargetError(parsed.jobId, reason, {
        createdAtHash: parsed.createdAtHash,
      });
      if (paused) {
        console.error(`[tools] Auto-paused cronjob ${parsed.jobId} after permanent reply failure: ${reason}`);
      }
    } catch (pauseErr) {
      console.error(
        `[tools] Failed to auto-pause cronjob ${parsed.jobId} after permanent reply failure:`,
        pauseErr,
      );
    }
  }

  function resolveTurnMessageId(args: {
    reply_to?: string;
    chat_id?: string;
    thread_id?: string;
    fallback_message_id?: string;
  }): string | undefined {
    if (args.reply_to) return args.reply_to;
    const fallback = turnObligations?.resolveFallback(args.chat_id, args.thread_id);
    if (fallback?.status === 'ambiguous') {
      throw new Error(
        `reply_to is required: ${fallback.count} pending Lark turns match chat=${args.chat_id} thread=${args.thread_id ?? '(none)'}.`,
      );
    }
    if (fallback?.status === 'active' || fallback?.status === 'single-pending') {
      return fallback.messageId;
    }
    if (args.chat_id && latestMessageTracker) {
      return latestMessageTracker.getLatest(args.chat_id, args.thread_id)?.messageId;
    }
    return args.fallback_message_id;
  }

  function satisfyTurn(messageId: string | undefined, source: Parameters<TurnObligationTracker['markSatisfied']>[1]): void {
    turnObligations?.markSatisfied(messageId, source);
  }

  registerDocCommentTools({ server, transport, identitySession, conversationBuffer });
  registerLocalCliTools({ server, identitySession });

  // ── 1. reply ──
  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a Feishu chat. Prefer plain text. Use Feishu cards sparingly, only when structure clearly improves readability. Long or markdown-rich content may auto-render as a card; pass "card" param with raw Schema 2.0 JSON only for pre-built cards.',
      inputSchema: z.object({
        chat_id: z.string().describe('The chat ID to reply in'),
        text: z.string().describe('The text content to send (ignored when card is provided)'),
        card: z
          .string()
          .optional()
          .describe(
            'Raw Feishu Schema 2.0 card JSON string. When provided, sends the card directly without buildCards conversion. Use this for pre-built cards from scripts/skills.'
          ),
        reply_to: z.string().optional().describe('Message ID to reply to (quoted reply)'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the <channel> meta. Pass this when replying to a threaded message — the plugin will auto-fill reply_to if you omit it, ensuring the reply lands in the correct thread.'
          ),
        format: z
          .enum(['text', 'card'])
          .optional()
          .describe(
            'Output format. Prefer "text" unless a card makes structured content significantly easier to scan. Omit for heuristic auto-detection; set to "card" only for structured summaries, tables, code blocks, dense lists, or multi-section content.'
          ),
        footer: z
          .string()
          .optional()
          .describe(
            'Optional small footnote appended at the bottom of the card (e.g. token usage, duration). Ignored when sending as plain text.'
          ),
        files: z
          .array(
            z.object({
              path: z.string().describe('Local file path'),
              type: z.enum(['image', 'file']).describe('Attachment type'),
            })
          )
          .optional()
          .describe('Optional attachments (ignored when card is provided)'),
      }),
    },
    async ({ chat_id, text, card, reply_to, thread_id, format, footer, files }) => {
      let result;
      try {
        result = await sendFeishuReply(
          {
            client,
            transport,
            conversationBuffer,
            ackReactions,
            botMessageTracker,
            latestMessageTracker,
            turnObligations,
          },
          { chat_id, text, card, reply_to, thread_id, format, footer, files },
        );
      } catch (err) {
        await maybeAutoPauseCronJobReplyFailure(thread_id, err);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: msg }],
          isError: true,
        };
      }

      if (result.isError) {
        await maybeAutoPauseCronJobReplyFailure(thread_id, result.errorText ?? result.statusText);
        return {
          content: [{ type: 'text' as const, text: result.errorText ?? result.statusText }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: result.statusText }],
      };

    }
  );

  function validateTrackedBotMessage(
    toolName: 'edit_message' | 'recall_message',
    messageId: string,
    chatId: string,
    threadId: string | undefined,
  ):
    | { tracked: NonNullable<ReturnType<BotMessageTracker['get']>> }
    | { error: { isError: true; content: { type: 'text'; text: string }[] } } {
    const tracked = botMessageTracker?.get(messageId);
    if (!tracked) {
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${toolName} denied: ${messageId} is not a tracked bot message.`,
            },
          ],
        },
      };
    }
    const trackedThread = tracked.threadId ?? '';
    const requestedThread = threadId ?? '';
    if (tracked.chatId !== chatId || trackedThread !== requestedThread) {
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `${toolName} denied: ${messageId} belongs to chat=${tracked.chatId ?? '(unknown)'}` +
                ` thread=${tracked.threadId ?? '(none)'}, does not belong to chat=${chatId}` +
                ` thread=${threadId ?? '(none)'}.`,
            },
          ],
        },
      };
    }
    return { tracked };
  }

  // ── 2. edit_message ──
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
      const tracked = validateTrackedBotMessage('edit_message', message_id, chat_id, thread_id);
      if ('error' in tracked) {
        void audit('edit_message', caller, auditArgs, 'denied');
        return tracked.error;
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

  // ── 3. recall_message ──
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
      const tracked = validateTrackedBotMessage('recall_message', message_id, chat_id, thread_id);
      if ('error' in tracked) {
        void audit('recall_message', caller, auditArgs, 'denied');
        return tracked.error;
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

  // ── 4. react ──
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

  // ── 4. download_attachment ──
  server.registerTool(
    'download_attachment',
    {
      description:
        'Download an attachment (image, file, audio, video) from a message to local inbox. Pass file_name from the inbound notification\'s meta.attachment_name so the saved file keeps its original extension — Codex Read needs the extension to infer MIME type for PDF/text.',
      inputSchema: z.object({
        message_id: z.string().describe('The message ID containing the attachment'),
        file_key: z.string().describe('The file key of the attachment'),
        file_name: z
          .string()
          .optional()
          .describe(
            'Original filename from meta.attachment_name (e.g. "report.pdf"). When provided, the extension is preserved in the saved path so Codex Read can infer MIME. Falls back to file_key alone if omitted.',
          ),
      }),
    },
    async ({ message_id, file_key, file_name }) => {
      const inboxDir = appConfig.inboxDir;
      await fs.mkdir(inboxDir, { recursive: true });

      // Route type by key prefix: img_* → image, otherwise → file.
      // (Feishu's messageResource.get only accepts 'image' | 'file'; audio
      //  and video are routed via 'file'.)
      const resourceType = file_key.startsWith('img_') ? 'image' : 'file';

      // Saved filename: prefer <file_key>-<original_name> when caller
      // provides file_name — preserves the extension while keeping the
      // file_key visible for traceability. Sanitize original name to
      // avoid path traversal / unexpected separators, and cap length
      // to leave room for the file_key prefix within NAME_MAX (255B on
      // macOS/ext4). 200 bytes leaves slack for any future file_key
      // format change without revisiting this cap.
      //
      // Extension preservation: cap the STEM, then reattach the ext.
      // Required because the whole point of accepting file_name is to
      // keep the extension so Codex `Read` can infer MIME — a naive
      // slice(0, 200) would chop the ext off pathological-length names.
      const sanitizedName = file_name ? capSanitizedFilename(file_name, 200) : '';
      const savedName = sanitizedName ? `${file_key}-${sanitizedName}` : file_key;
      const filePath = path.join(inboxDir, savedName);

      try {
        // Always use messageResource.get for user-uploaded resources.
        // image.get only works for images the bot itself uploaded.
        const data: unknown = await transport.downloadResource(message_id, file_key, resourceType);
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Feishu returned empty response for file_key=${file_key} (type=${resourceType})`,
              },
            ],
            isError: true,
          };
        }
        await writeSdkResource(data, filePath, {
          maxBytes: appConfig.downloadMaxBytes,
          timeoutMs: appConfig.downloadTimeoutMs,
        });
        revokeAckReactionWithTransport(transport, ackReactions, message_id, 'download_attachment');
        satisfyTurn(message_id, 'download_attachment');
        return { content: [{ type: 'text' as const, text: `Downloaded to ${filePath}` }] };
      } catch (err: any) {
        const apiError = err?.response?.data ?? err?.data;
        if (apiError?.code && apiError?.msg) {
          console.error(`[tools] download failed [${apiError.code}]: ${apiError.msg}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Feishu API [${apiError.code}]: ${apiError.msg} (file_key=${file_key}, type=${resourceType})`,
              },
            ],
            isError: true,
          };
        }
        const msg = err?.message ?? String(err);
        console.error(`[tools] download failed:`, msg);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Download failed for file_key=${file_key} (type=${resourceType}): ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── 5. defer_reply ──
  server.registerTool(
    'defer_reply',
    {
      description:
        'Explicitly mark the current Lark turn as intentionally deferred or no-reply. This does not send a Feishu message; it only satisfies the reply obligation and revokes the ack reaction.',
      inputSchema: z.object({
        chat_id: z.string().describe('The current channel chat_id'),
        reply_to: z
          .string()
          .optional()
          .describe('Current inbound message_id. Pass meta.message_id when available.'),
        thread_id: z
          .string()
          .optional()
          .describe('Current channel thread_id, when present.'),
        marker: z
          .enum(['LARK_DEFER', 'LARK_NO_REPLY'])
          .default('LARK_DEFER')
          .describe('Use LARK_DEFER for delayed handling, LARK_NO_REPLY when no Feishu reply is intended.'),
        reason: z.string().optional().describe('Short operator-facing reason.'),
      }),
    },
    async ({ chat_id, reply_to, thread_id, marker, reason }) => {
      let messageId: string | undefined;
      try {
        messageId = resolveTurnMessageId({ reply_to, chat_id, thread_id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
      const marked = turnObligations?.markDeferred(messageId, 'defer_tool', marker, reason) ?? false;
      revokeAckReactionWithTransport(transport, ackReactions, messageId, 'defer_reply');
      return {
        content: [
          {
            type: 'text' as const,
            text: marked
              ? `[${marker}] ${reason ?? 'Lark turn intentionally deferred.'}`
              : `[${marker}] No pending Lark turn matched this defer request.`,
          },
        ],
        ...(marked ? {} : { isError: true }),
      };
    }
  );

  // ── 6. save_memory ──
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
      // Only include profile-specific params in audit args when they're
      // actually applied — keeps chat/thread audit lines clean and avoids
      // implying a tier/mode was honored when type !== 'profile'.
      const auditArgs =
        type === 'profile'
          ? { type, chat_id, thread_id, tier, mode }
          : { type, chat_id, thread_id };
      const auth = resolveCaller('save_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      // Defense in depth (#66): the auto-flush turn binds SYSTEM_FLUSH_CALLER
      // as the caller so save_memory(type=chat|thread) can persist
      // chat-level distillations without a real user identity. That sentinel
      // MUST NOT be allowed to write profile tiers — profiles are
      // user-scoped (saveProfile writes to profiles/<callerId>/...), and a
      // sentinel "writer" has no user identity to legitimately own
      // private-tier data. The flush prompt already forbids type=profile,
      // this is the server-side guard against Codex going off-script.
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

  // ── 7. save_skill ──
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

  // ── create_job ──
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
    async ({ name, type, schedule, prompt, content, target_chat_id, model, chat_id, thread_id }) => {
      const auditArgs = { name, type, schedule, target_chat_id, model, chat_id, thread_id };
      const auth = resolveCaller('create_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      // Validate type-specific fields
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

      // Expand schedule alias and validate
      let cron: string;
      let scheduleHuman: string;
      try {
        const expanded = expandSchedule(schedule);
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

      // Generate ID
      const id = sanitizeJobId(name);
      if (await jobExists(id)) {
        return {
          content: [
            { type: 'text' as const, text: `Job "${id}" already exists. Use a different name or delete the existing job first.` },
          ],
          isError: true,
        };
      }

      const nextRunAt = computeNextRun(cron);

      const job: JobFile = {
        meta: {
          id,
          name,
          type,
          schedule: cron,
          schedule_human: scheduleHuman,
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
        },
      };

      await writeJob(job);
      void audit('create_job', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created job "${id}" (${scheduleHuman}, tz=${appConfig.cronTimezone}). Next run: ${nextRunAt}`,
          },
        ],
      };
    }
  );

  // ── list_jobs ──
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
        const lastRun = j.runtime.last_run_at
          ? new Date(j.runtime.last_run_at).toLocaleString()
          : 'never';
        const error = j.runtime.last_error ? ` ⚠️ ${j.runtime.last_error}` : '';
        const isOwner = j.meta.created_by === caller;

        // Group audit view — redact free-form content for non-owners.
        // Keep created_by and schedule so the group retains accountability.
        if (!isPrivate && !isOwner) {
          return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   By: ${j.meta.created_by} | Next: ${j.runtime.next_run_at}`;
        }
        const modelNote = j.meta.model ? ` | Model: ${j.meta.model}` : '';
        return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   Next: ${j.runtime.next_run_at} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${modelNote}${error}`;
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

  // ── update_job ──
  server.registerTool(
    'update_job',
    {
      description:
        'Update a cronjob — change schedule, content, pause, or resume. Only the job owner can mutate a job.',
      inputSchema: z.object({
        id: z.string().describe('Job ID'),
        status: z.enum(['active', 'paused']).optional().describe('Set status'),
        schedule: z.string().optional().describe('New cron expression or alias'),
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
    async ({ id, status, schedule, prompt, content, name, model, chat_id, thread_id }) => {
      const auditArgs = { id, status, schedule, name, model, chat_id, thread_id };
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

      // Validate schedule first (before mutating any fields) so a bad
      // schedule returns an error with the job left untouched.
      let expandedSchedule: { cron: string; human: string } | null = null;
      if (schedule !== undefined) {
        try {
          expandedSchedule = expandSchedule(schedule);
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

        // All inputs validated — apply updates against the latest on-disk job
        if (name !== undefined) latest.meta.name = name;
        if (prompt !== undefined) latest.meta.prompt = prompt;
        if (content !== undefined) latest.meta.content = content;
        if (model !== undefined) latest.meta.model = model || undefined; // empty string clears
        if (expandedSchedule) {
          latest.meta.schedule = expandedSchedule.cron;
          latest.meta.schedule_human = expandedSchedule.human;
          latest.runtime.next_run_at = computeNextRun(expandedSchedule.cron);
        }
        if (status !== undefined) {
          latest.meta.status = status;
          if (status === 'active' && !schedule) {
            // Recompute next_run_at when resuming
            latest.runtime.next_run_at = computeNextRun(latest.meta.schedule);
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
            text: `Updated job "${id}". Status: ${updated.meta.status}, Next run: ${updated.runtime.next_run_at} (tz=${appConfig.cronTimezone})`,
          },
        ],
      };
    }
  );

  // ── delete_job ──
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
          const { addL2Rule } = await import('./privacy-rules.js');
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
