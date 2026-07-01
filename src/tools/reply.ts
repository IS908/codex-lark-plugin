import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';
import { writeSdkResource } from '../sdk-resource.js';
import { sendFeishuReply } from '../reply-sender.js';
import { revokeAckReactionWithTransport } from '../ack-reactions.js';
import {
  autoPauseJobForPermanentTargetError,
  isPermanentTargetError,
  parseJobThreadId,
} from '../scheduler.js';
import type { ToolContext } from './tool-context.js';

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

async function maybeAutoPauseCronJobReplyFailure(
  threadId: string | undefined,
  err: unknown,
): Promise<void> {
  const parsed = parseJobThreadId(threadId);
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

export function registerReplyTools(ctx: ToolContext): void {
  const {
    server,
    client,
    transport,
    conversationBuffer,
    ackReactions,
    botMessageTracker,
    latestMessageTracker,
    turnObligations,
    resolveTurnMessageId,
    satisfyTurn,
  } = ctx;

  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a Feishu chat. Markdown/text is the default and stays a normal copyable text message. Use Feishu cards only as explicit opt-in when structure clearly improves readability; pass format="card" for generated cards or the "card" param with raw Schema 2.0 JSON for pre-built cards.',
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
            'Output format. Omit or set "text" for normal Markdown/text messages. Set to "card" only as explicit opt-in for structured summaries, tables, code blocks, dense lists, or multi-section content.'
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

      // Route type by key prefix: img_* -> image, otherwise -> file.
      // (Feishu's messageResource.get only accepts 'image' | 'file'; audio
      // and video are routed via 'file'.)
      const resourceType = file_key.startsWith('img_') ? 'image' : 'file';

      const sanitizedName = file_name ? capSanitizedFilename(file_name, 200) : '';
      const savedName = sanitizedName ? `${file_key}-${sanitizedName}` : file_key;
      const filePath = path.join(inboxDir, savedName);

      try {
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
}
