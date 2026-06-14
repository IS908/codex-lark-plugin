import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import type { CodexExecRequest, CodexExecRunner } from './codex-exec.js';
import { normalizeCodexExecResult, runCodexExecCommand } from './codex-exec.js';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';
import { untrustedDataBlock } from './prompts.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { splitDocCommentText } from './doc-comment-api.js';
import { shouldSendFeishuReplyForMessage } from './codex-exec-error.js';

export interface CodexExecDeliveryOptions {
  message: LarkMessage;
  displayLabel: string;
  runCodexExec?: CodexExecRunner;
  sessionStore?: CodexExecSessionStore;
  useCodexSessions?: boolean;
  sessionHealth?: CodexExecSessionHealthRecorder;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  sendDocCommentReply?: (request: DocCommentExecReplyRequest) => Promise<{ replyId?: string }>;
  recordAssistantMessage?: (message: { chatId: string; text: string }) => void;
  turnObligations?: TurnObligationTracker;
}

export interface CodexExecSessionHealthRecorder {
  recordTurn(input: {
    sessionKey: string;
    chatId: string;
    threadId?: string;
    sessionId?: string | null;
    resumed: boolean;
    promptBytes: number;
    responseBytes: number;
  }): void;
}

export interface DocCommentExecReplyRequest {
  chat_id: string;
  thread_id: string;
  doc_token: string;
  comment_id: string;
  file_type: string;
  content: string;
}

export function buildCodexExecPrompt(message: LarkMessage, displayLabel: string): string {
  const isDocComment = message.chatType === 'doc_comment';
  const metaLines = [
    `message_id: ${message.messageId}`,
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    `user_id: ${message.senderId}`,
    ...(message.threadId ? [`thread_id: ${message.threadId}`] : []),
    ...(message.docComment
      ? [
          `doc_token: ${message.docComment.fileToken}`,
          `comment_id: ${message.docComment.commentId}`,
          `file_type: ${message.docComment.fileType}`,
        ]
      : []),
    ...(message.botMentioned ? ['bot_mentioned: true'] : []),
  ];
  const displayBlocks = [
    untrustedDataBlock('codex-exec-display-label', displayLabel),
    ...(message.chatName ? [untrustedDataBlock('codex-exec-chat-name', message.chatName)] : []),
    ...(message.parentContent
      ? [untrustedDataBlock('codex-exec-parent-message', message.parentContent)]
      : []),
    ...(message.attachments?.length
      ? [untrustedDataBlock('codex-exec-attachments', JSON.stringify(message.attachments))]
      : []),
  ];

  return [
    isDocComment ? 'Reply to this Feishu/Lark document comment.' : 'Reply to this Feishu/Lark message.',
    isDocComment
      ? 'Return only the plain text that should be posted as a Feishu document-comment reply. Do not include tool-call instructions, transport metadata, or commentary about this wrapper.'
      : 'Return only the message text that should be sent back to Feishu. Do not include tool-call instructions, transport metadata, or commentary about this wrapper.',
    'This turn may be running inside a resumed Codex exec session for the same Feishu chat/thread. Use prior session context when available.',
    'For heavy multi-step tasks, use subagents where available so the resumed main session stays smaller.',
    'If the user asks for an action you cannot complete in this exec bridge environment, say exactly what is missing and keep the answer concise.',
    'If this turn intentionally should not send a Feishu reply, put [LARK_DEFER] or [LARK_NO_REPLY] on its own line outside code fences, optionally followed by a short reason.',
    '',
    '[Feishu metadata]',
    metaLines.join('\n'),
    '',
    '[Feishu display data]',
    displayBlocks.join('\n\n'),
    '',
    '[Message text]',
    untrustedDataBlock('codex-exec-message-text', message.text),
  ].join('\n');
}

function collectImagePaths(message: LarkMessage): string[] {
  const paths = new Set<string>();
  if (message.imagePath) paths.add(message.imagePath);
  for (const imagePath of message.imagePaths ?? []) paths.add(imagePath);
  return [...paths];
}

const defaultSessionStore = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);

export async function deliverMessageViaCodexExec(
  opts: CodexExecDeliveryOptions,
): Promise<void> {
  const { message, displayLabel, sendReply, turnObligations } = opts;
  const runCodexExec = opts.runCodexExec ?? runCodexExecCommand;
  const useCodexSessions = opts.useCodexSessions ?? appConfig.codexExecUseSessions;
  const sessionStore = opts.sessionStore ?? defaultSessionStore;
  const sessionKey = buildCodexExecSessionKey(message.chatId, message.threadId);
  const existingSession = useCodexSessions ? await sessionStore.get(sessionKey) : null;
  const request: CodexExecRequest = {
    prompt: buildCodexExecPrompt(message, displayLabel),
    imagePaths: collectImagePaths(message),
    command: appConfig.codexExecCommand,
    cwd: appConfig.codexExecCwd,
    timeoutMs: appConfig.codexExecTimeoutMs,
    sandbox: appConfig.codexExecSandbox,
    model: appConfig.codexExecModel,
    profile: appConfig.codexExecProfile,
    ignoreUserConfig: appConfig.codexExecIgnoreUserConfig,
    skipGitRepoCheck: true,
    resumeSessionId: existingSession?.sessionId ?? null,
  };

  let result;
  let usedResumeSessionId = request.resumeSessionId;
  try {
    result = normalizeCodexExecResult(await runCodexExec(request));
  } catch (err) {
    if (!request.resumeSessionId) throw err;
    console.error(
      `[codex-exec] Failed to resume session ${request.resumeSessionId} for ${sessionKey}; starting a new session: ${
        (err as Error).message
      }`,
    );
    result = normalizeCodexExecResult(
      await runCodexExec({ ...request, resumeSessionId: null }),
    );
    usedResumeSessionId = null;
  }

  if (useCodexSessions && result.sessionId) {
    await sessionStore.set({
      key: sessionKey,
      sessionId: result.sessionId,
      chatId: message.chatId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  let text = result.text.trim();
  if (!text) {
    text = 'Codex exec returned an empty response.';
  }
  opts.sessionHealth?.recordTurn({
    sessionKey,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    sessionId: result.sessionId ?? usedResumeSessionId ?? null,
    resumed: !!usedResumeSessionId,
    promptBytes: Buffer.byteLength(request.prompt, 'utf8'),
    responseBytes: Buffer.byteLength(result.text, 'utf8'),
  });
  if (turnObligations?.markDeferredFromText(message.messageId, 'exec_assistant_text', text)) {
    return;
  }

  if (message.chatType === 'doc_comment') {
    if (!message.docComment) {
      throw new Error('doc_comment exec delivery requires docComment metadata');
    }
    if (!opts.sendDocCommentReply) {
      throw new Error('doc_comment exec delivery requires sendDocCommentReply');
    }
    for (const chunk of splitDocCommentText(text)) {
      await opts.sendDocCommentReply({
        chat_id: message.chatId,
        thread_id: message.threadId ?? message.docComment.commentId,
        doc_token: message.docComment.fileToken,
        comment_id: message.docComment.commentId,
        file_type: message.docComment.fileType,
        content: chunk,
      });
    }
    opts.recordAssistantMessage?.({
      chatId: message.chatId,
      text,
    });
    return;
  }

  if (!shouldSendFeishuReplyForMessage(message)) {
    console.error(
      `[codex-exec] Suppressed Feishu reply for non-user-visible or synthetic message ${message.messageId} (${message.chatType})`,
    );
    return;
  }

  await sendReply({
    chat_id: message.chatId,
    text,
    reply_to: message.messageId,
    thread_id: message.threadId,
  });
}
