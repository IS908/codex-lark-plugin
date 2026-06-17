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
import {
  CODEX_EXEC_ACTIONS_END,
  CODEX_EXEC_ACTIONS_START,
  formatCodexExecActionResults,
  parseCodexExecActionOutput,
  type CodexExecActionDispatcher,
} from './codex-exec-actions.js';

export interface CodexExecDeliveryOptions {
  message: LarkMessage;
  displayLabel: string;
  runCodexExec?: CodexExecRunner;
  sessionStore?: CodexExecSessionStore;
  useCodexSessions?: boolean;
  sessionHealth?: CodexExecSessionHealthRecorder;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  sendDocCommentReply?: (request: DocCommentExecReplyRequest) => Promise<{ replyId?: string }>;
  recordAssistantMessage?: (message: { chatId: string; threadId?: string; text: string }) => void;
  turnObligations?: TurnObligationTracker;
  actionDispatcher?: CodexExecActionDispatcher;
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
    usage?: import('./codex-exec.js').CodexExecUsage | null;
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

interface LifecycleGuardResult {
  blocked: boolean;
  text: string;
  reason?: string;
}

const LIFECYCLE_PROMISE_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'english-create-or-file-promise',
    pattern: /\b(?:i\s*(?:am|'m)\s+|(?:i\s+will|i'll)\s+)(?:create|creating|open|opening|file|filing|submit|submitting|post|posting|add|adding)\b.{0,80}\b(?:issue|ticket|pull request|pr|comment|link|url)\b/i,
  },
  {
    reason: 'english-reply-after-action-promise',
    pattern: /\b(?:after|once)\s+(?:i\s+)?(?:create|created|open|opened|file|filed|submit|submitted|post|posted|add|added).{0,100}\b(?:reply|post|send|share|paste).{0,60}\b(?:link|url|it)\b/i,
  },
  {
    reason: 'english-followup-link-promise',
    pattern: /\b(?:i\s+will|i'll)\s+(?:reply|post|send|share|paste|follow\s+up).{0,80}\b(?:link|url|when\s+(?:it'?s|it\s+is)\s+(?:done|created|ready))\b/i,
  },
  {
    reason: 'chinese-create-promise',
    pattern: /(?:我(?:会|将|来|现在|这边)|现在|正在|马上|稍后|后续|一会儿).{0,24}(?:补提|创建|新建|提交|发起|开|提).{0,24}(?:issue|议题|工单|pr|pull request|链接|评论|comment)/i,
  },
  {
    reason: 'chinese-reply-after-action-promise',
    pattern: /(?:提好|创建好|建好|提交后|创建后|补提后).{0,30}(?:回贴|贴|回复|发|同步).{0,24}(?:链接|url)?/i,
  },
  {
    reason: 'chinese-async-followup-promise',
    pattern: /(?:稍后|后续|一会儿).{0,20}(?:继续|处理|回贴|回复|同步)/i,
  },
];

const SAFE_NON_EXECUTION_PATTERNS = [
  /\b(?:cannot|can't|unable to|not configured|not enabled|did not|do not|won't|will not|no automatic|not automatically).{0,120}\b(?:create|file|open|post|continue|follow up|issue|action|background)\b/i,
  /(?:不能|无法|不会|未|没有).{0,40}(?:自动|后台|继续|创建|补提|执行|发起|回贴)/,
];

function normalizeLifecycleGuardText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function isSafeNonExecutionReply(text: string): boolean {
  return SAFE_NON_EXECUTION_PATTERNS.some((pattern) => pattern.test(text));
}

function buildLifecycleGuardReply(reason: string): string {
  return [
    'No background follow-up was started.',
    '',
    `The Codex exec output was blocked because it promised a later external action (${reason}) without a structured action, defer/no-reply marker, or scheduled job. This Lark bridge runs one Codex exec turn and cannot continue working after posting the visible reply.`,
    '',
    'Please retry with an enabled structured action, create a job/defer intentionally, or ask for a draft instead of automatic execution.',
  ].join('\n');
}

export function guardCodexExecLifecycleReply(
  text: string,
  opts: { allowFollowupPromise: boolean },
): LifecycleGuardResult {
  if (opts.allowFollowupPromise) return { blocked: false, text };

  const normalized = normalizeLifecycleGuardText(text);
  if (!normalized || isSafeNonExecutionReply(normalized)) {
    return { blocked: false, text };
  }

  const match = LIFECYCLE_PROMISE_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  if (!match) return { blocked: false, text };

  return {
    blocked: true,
    reason: match.reason,
    text: buildLifecycleGuardReply(match.reason),
  };
}

export function buildCodexExecPrompt(message: LarkMessage, displayLabel: string): string {
  const isDocComment = message.chatType === 'doc_comment';
  const metaLines = [
    `message_id: ${message.messageId}`,
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    `user_id: ${message.senderId}`,
    ...(message.threadId ? [`thread_id: ${message.threadId}`] : []),
    ...(message.rootMessageId ? [`root_message_id: ${message.rootMessageId}`] : []),
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
    'If the user asks for a supported built-in Lark action, request it with the structured action block below instead of saying the MCP tool is unavailable.',
    'This exec turn has no background continuation after the visible reply is posted. Do not promise to create, file, post, reply with a link, or continue later unless the same final output includes a structured action, a create_job action, or an intentional [LARK_DEFER]/[LARK_NO_REPLY] marker.',
    'Supported action block format (append at most one block at the very end, outside code fences):',
    `${CODEX_EXEC_ACTIONS_START}\n{"version":1,"actions":[{"type":"save_memory","memory_type":"profile|chat|thread","content":"...","reason":"...","tier":"private|public"},{"type":"create_job","job_type":"message|prompt","name":"...","schedule":"daily at 09:00","content":"...","prompt":"...","target_chat_id":"optional"},{"type":"create_github_issue","repo":"optional owner/repo","title":"...","body":"...","labels":["optional"]},{"type":"run_local_cli_tool","tool":"configured-name","args":["..."]},{"type":"recall_message","message_id":"tracked-bot-message-id"}]}\n${CODEX_EXEC_ACTIONS_END}`,
    'Do not put chat_id, thread_id, open_id, created_by, or caller in the action block; the parent Lark bridge derives identity from the current Feishu event.',
    'If the user asks to create or file a GitHub issue, include a create_github_issue action block when you have enough title/body context. Do not say you created or will create an issue unless you include that action; if issue creation is not configured, provide an issue draft and say it cannot be created automatically.',
    'For ordinary replies, omit the action block.',
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
const activeCodexExecSessionKeys = new Set<string>();

export function getActiveCodexExecSessionKeys(): ReadonlySet<string> {
  return new Set(activeCodexExecSessionKeys);
}

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
  if (useCodexSessions) activeCodexExecSessionKeys.add(sessionKey);
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
  } finally {
    if (useCodexSessions) activeCodexExecSessionKeys.delete(sessionKey);
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

  const parsedOutput = parseCodexExecActionOutput(result.text);
  let text = parsedOutput.replyText.trim();
  if (parsedOutput.kind === 'invalid_actions') {
    text = `Invalid Lark action block: ${parsedOutput.error}`;
  } else if (parsedOutput.kind === 'actions' && parsedOutput.actions.length > 0) {
    const actionResults = opts.actionDispatcher
      ? await opts.actionDispatcher.execute({ message, actions: parsedOutput.actions })
      : [
          {
            ok: false,
            action: 'save_memory' as const,
            message: 'Lark exec action dispatcher is not configured.',
          },
        ];
    const actionSummary = formatCodexExecActionResults(actionResults);
    const hasActionError = actionResults.some((actionResult) => !actionResult.ok);
    if (!text) {
      text = actionSummary;
    } else if (hasActionError) {
      text = `${text}\n\n[Action results]\n${actionSummary}`;
    }
  }
  if (!text) {
    text = 'Codex exec returned an empty response.';
  }
  const lifecycleGuard = guardCodexExecLifecycleReply(text, {
    allowFollowupPromise: parsedOutput.kind === 'actions' || parsedOutput.kind === 'defer',
  });
  if (lifecycleGuard.blocked) {
    console.error(
      `[codex-exec] Blocked follow-up promise for message ${message.messageId}: ${lifecycleGuard.reason}`,
    );
    text = lifecycleGuard.text;
  }
  opts.sessionHealth?.recordTurn({
    sessionKey,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    sessionId: result.sessionId ?? usedResumeSessionId ?? null,
    resumed: !!usedResumeSessionId,
    promptBytes: Buffer.byteLength(request.prompt, 'utf8'),
    responseBytes: Buffer.byteLength(result.text, 'utf8'),
    usage: result.usage ?? null,
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
      threadId: message.threadId,
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
