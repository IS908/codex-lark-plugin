import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import type { CodexExecRequest, CodexExecRunner } from './codex-exec.js';
import { isCodexExecTimeoutError, normalizeCodexExecResult, runCodexExecCommand } from './codex-exec.js';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import { preserveConversationBoundaryFields } from './conversation-boundary.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';
import { larkReplyPresentationGuideline, untrustedDataBlock } from './prompts.js';
import { findLarkDeferSentinel, type TurnObligationTracker } from './turn-obligation.js';
import { splitDocCommentText } from './doc-comment-api.js';
import { isFeishuOpenMessageId, shouldSendFeishuReplyForMessage } from './codex-exec-error.js';
import {
  buildCodexExecProgressPrompt,
  createCodexExecProgressSink,
  type CodexExecProgressLimits,
  type CodexExecProgressEvent,
  type CodexExecProgressPromptInfo,
} from './codex-exec-progress.js';
import {
  formatCodexExecActionResults,
  type CodexExecActionExecutionResult,
  type CodexExecActionDispatcher,
  type CodexExecAction,
} from './codex-exec-actions.js';
import { formatCodexExecRuntimeMetricsFooter } from './codex-exec-metrics.js';
import {
  buildCodexExecActionChannelPrompt,
  createCodexExecActionChannel,
  type CodexExecActionChannelPromptInfo,
} from './codex-exec-action-channel.js';
import { listConfiguredLocalCliToolNames } from './local-cli-tools.js';
import { logSafeError } from './safe-log.js';

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
  progressBaseDir?: string;
  progressLimits?: Partial<CodexExecProgressLimits>;
  progressVisible?: boolean;
  onProgress?: (event: CodexExecProgressEvent) => void;
  onFinalText?: (text: string) => void;
  onActionResults?: (results: CodexExecActionExecutionResult[]) => void;
  actionBaseDir?: string;
  traceLogId?: string;
  traceRunId?: string;
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

const VISIBLE_SUCCESS_ACTIONS = new Set<CodexExecActionExecutionResult['action']>([
  'create_job',
  'list_jobs',
  'update_job',
  'disable_job',
  'delete_job',
  'upsert_job',
  'get_run_trace',
  'recall_message',
  'run_local_cli_tool',
]);

const SUPPRESS_EMPTY_SUCCESS_ACTIONS = new Set<CodexExecActionExecutionResult['action']>([
  'send_message',
]);

function shouldShowActionSummary(results: CodexExecActionExecutionResult[]): boolean {
  return results.some((result) => !result.ok || VISIBLE_SUCCESS_ACTIONS.has(result.action));
}

function shouldSuppressEmptyActionReply(results: CodexExecActionExecutionResult[]): boolean {
  return results.length > 0 && results.every((result) => result.ok && SUPPRESS_EMPTY_SUCCESS_ACTIONS.has(result.action));
}

function resolveProgressLimits(overrides: Partial<CodexExecProgressLimits> = {}): CodexExecProgressLimits {
  return {
    enabled: overrides.enabled ?? appConfig.codexExecProgressEnabled,
    maxMessages: overrides.maxMessages ?? appConfig.codexExecProgressMaxMessages,
    maxChars: overrides.maxChars ?? appConfig.codexExecProgressMaxChars,
    minIntervalMs: overrides.minIntervalMs ?? appConfig.codexExecProgressMinIntervalMs,
    pollIntervalMs: overrides.pollIntervalMs ?? appConfig.codexExecProgressPollIntervalMs,
  };
}

async function enrichCodexExecActionPromptInfo(
  info: CodexExecActionChannelPromptInfo | null,
): Promise<CodexExecActionChannelPromptInfo | null> {
  if (!info?.enabled) return info;
  const baseInfo = appConfig.codexExecToolTraceEnabled
    ? { ...info, traceQueryEnabled: true }
    : info;
  if (appConfig.codexExecSandbox === 'danger-full-access') return baseInfo;

  try {
    const localCliToolNames = await listConfiguredLocalCliToolNames();
    if (localCliToolNames.length === 0) return baseInfo;
    return { ...baseInfo, localCliToolNames };
  } catch (err) {
    logSafeError('[codex-exec-actions] local CLI host bridge config unavailable:', err);
    return baseInfo;
  }
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

function resolveTraceLogId(message: LarkMessage, explicit?: string): string {
  if (explicit?.trim()) return explicit;
  if (message.chatType === 'cronjob') {
    const parsedThread = message.threadId?.match(/^job-(.+)-[a-f0-9]{12}-\d{10,}$/);
    if (parsedThread?.[1]) return parsedThread[1];
  }
  return message.messageId;
}

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

export function buildCodexExecPrompt(
  message: LarkMessage,
  displayLabel: string,
  progressInfo: CodexExecProgressPromptInfo | null = null,
  actionInfo: CodexExecActionChannelPromptInfo | null = null,
): string {
  const isDocComment = message.chatType === 'doc_comment';
  const isReaction = message.messageType === 'reaction' && !!message.reaction;
  const metaLines = [
    `message_id: ${message.messageId}`,
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    `message_type: ${message.messageType}`,
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
    ...(message.reaction
      ? [
          `reaction_emoji: ${message.reaction.emojiType}`,
          `reaction_operator_id: ${message.reaction.operatorId}`,
          `reaction_target_message_id: ${message.reaction.targetMessageId}`,
          `reaction_source: ${message.reaction.source}`,
        ]
      : []),
    ...(message.botMentioned ? ['bot_mentioned: true'] : []),
    ...(message.unmentionedGroupTrigger ? ['unmentioned_group_trigger: true'] : []),
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
  const unmentionedGroupPrompt = message.unmentionedGroupTrigger
    ? [
        'This group message entered through an explicit trusted-group no-mention allowlist. Reply only when the message is clearly a question, command, or relevant thread continuation for Codex; otherwise return [LARK_NO_REPLY]. Ask for confirmation before sensitive or high-risk operations when intent is ambiguous.',
      ]
    : [];

  return [
    isDocComment
      ? 'Reply to this Feishu/Lark document comment.'
      : isReaction
        ? 'Handle this Feishu/Lark emoji reaction on a previous bot reply.'
        : 'Reply to this Feishu/Lark message.',
    isDocComment
      ? 'Return only the plain text that should be posted as a Feishu document-comment reply. Do not include tool-call instructions, transport metadata, or commentary about this wrapper.'
      : isReaction
        ? 'Treat the emoji as normal user input carried by the reacted bot reply. Interpret the emoji together with the target message content and prior session context, then decide whether to continue, retry an action, ask for clarification, send a visible reply, or return [LARK_NO_REPLY]. Do not classify DONE, OK, THUMBSUP, or similar emojis as passive by emoji type alone.'
        : 'Return only the message text that should be sent back to Feishu. Do not include tool-call instructions, transport metadata, or commentary about this wrapper.',
    larkReplyPresentationGuideline,
    'This turn may be running inside a resumed Codex exec session for the same Feishu chat/thread. Use prior session context when available.',
    'For heavy multi-step tasks, use subagents where available so the resumed main session stays smaller.',
    ...unmentionedGroupPrompt,
    'If the user asks for a supported built-in Lark action, request it through the structured Lark action mechanism instead of saying the MCP tool is unavailable.',
    'This exec turn has no background continuation after the visible reply is posted. Do not promise to create, file, post, reply with a link, or continue later unless the same turn writes a structured side-channel action, creates a cronjob action, or intentionally returns [LARK_DEFER]/[LARK_NO_REPLY].',
    ...buildCodexExecActionChannelPrompt(actionInfo),
    'For cronjob schedule fields, use only supported recurring formats: "daily at 09:00", "weekdays at 09:00", "weekly on mon at 09:00", "every 5m", "every 2h", or a 5-field cron expression such as "0 9 * * *". Do not use one-off or natural-language aliases such as "once", "now", "later", "tomorrow at 09:00", or "YYYY-MM-DD HH:mm". Use timezone for an IANA timezone such as "Asia/Shanghai", "Asia/Tokyo", or "UTC"; if omitted, the plugin stores the current LARK_CRON_TIMEZONE default into the job file.',
    'For existing cronjobs, prefer the stable job_id returned by create_job/list_jobs; use name only when it is unique. If create_job reports that a job already exists, use list_jobs plus update_job, disable_job, delete_job, or upsert_job instead of retrying create_job with the same name.',
    'Use send_message when the user asks Codex to send back an image, file, or ordered text+image rich message through Feishu. For a single image/file, use message.kind=image|file with source=local_path, source=current_message:first_image, or source=quoted_message:first_image. File messages only support local_path. For mixed text and images, use message.kind=rich with ordered parts; the parent bridge prefers one Feishu post and falls back to split messages while preserving order and thread context. Do not use send_message for document comments, audio, video, or interactive cards yet.',
    'Do not put chat_id, thread_id, open_id, created_by, or caller in the action request; the parent Lark bridge derives identity from the current Feishu event.',
    'For ordinary replies, do not write an action request.',
    'If this turn intentionally should not send a Feishu reply, put [LARK_DEFER] or [LARK_NO_REPLY] on its own line outside code fences, optionally followed by a short reason.',
    ...buildCodexExecProgressPrompt(progressInfo),
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
  const sessionModel = useCodexSessions && existingSession?.model ? existingSession.model : null;
  const progressLimits = resolveProgressLimits(opts.progressLimits);
  const progressBaseDir = opts.progressBaseDir ?? appConfig.codexExecCwd;
  const actionBaseDir = opts.actionBaseDir ?? appConfig.codexExecCwd;
  const actionChannel = await createCodexExecActionChannel({
    baseDir: actionBaseDir,
    caller: message.senderId,
    messageId: message.messageId,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  });
  if (!actionChannel) {
    throw new Error('Codex exec action side channel setup failed.');
  }
  const progressSink = await createCodexExecProgressSink({
    baseDir: progressBaseDir,
    limits: {
      ...progressLimits,
      enabled:
        progressLimits.enabled &&
        (shouldSendFeishuReplyForMessage(message) || (message.chatType === 'doc_comment' && !!message.docComment)),
    },
    caller: message.senderId,
    messageId: message.messageId,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(opts.progressVisible === false
      ? {}
      : { send: (content: string) => sendCodexExecProgressMessage(opts, message, content) }),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const request: CodexExecRequest = {
    prompt: buildCodexExecPrompt(
      message,
      displayLabel,
      progressSink?.promptInfo ?? null,
      await enrichCodexExecActionPromptInfo(actionChannel?.promptInfo ?? null),
    ),
    imagePaths: collectImagePaths(message),
    command: appConfig.codexExecCommand,
    cwd: appConfig.codexExecCwd,
    timeoutMs: appConfig.codexExecTimeoutMs,
    sandbox: appConfig.codexExecSandbox,
    model: sessionModel ?? appConfig.codexExecModel,
    profile: appConfig.codexExecProfile,
    ignoreUserConfig: appConfig.codexExecIgnoreUserConfig,
    skipGitRepoCheck: true,
    resumeSessionId: existingSession?.sessionId || null,
    traceLogId: resolveTraceLogId(message, opts.traceLogId),
    traceRunId: opts.traceRunId,
    ...(progressSink || actionChannel
      ? {
          extraEnv: {
            ...(progressSink?.extraEnv ?? {}),
            ...(actionChannel?.extraEnv ?? {}),
          },
          ...(progressSink
            ? {
                progress: {
                  filePath: progressSink.filePath,
                  token: progressSink.token,
                },
              }
            : {}),
          ...(actionChannel
            ? {
                actions: {
                  filePath: actionChannel.filePath,
                  token: actionChannel.token,
                },
              }
            : {}),
        }
      : {}),
  };

  let result;
  let usedResumeSessionId = request.resumeSessionId;
  if (useCodexSessions) activeCodexExecSessionKeys.add(sessionKey);
  try {
    progressSink?.start();
    result = normalizeCodexExecResult(await runCodexExec(request));
  } catch (err) {
    if (!request.resumeSessionId || isCodexExecTimeoutError(err)) {
      await actionChannel.cleanup();
      throw err;
    }
    console.error(
      `[codex-exec] Failed to resume session ${request.resumeSessionId} for ${sessionKey}; starting a new session: ${
        (err as Error).message
      }`,
    );
    await actionChannel?.reset();
    try {
      result = normalizeCodexExecResult(
        await runCodexExec({ ...request, resumeSessionId: null }),
      );
    } catch (retryErr) {
      await actionChannel.cleanup();
      throw retryErr;
    }
    usedResumeSessionId = null;
  } finally {
    await progressSink?.stop();
    if (useCodexSessions) activeCodexExecSessionKeys.delete(sessionKey);
  }

  if (useCodexSessions && result.sessionId) {
    await sessionStore.set({
      key: sessionKey,
      sessionId: result.sessionId,
      chatId: message.chatId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      updatedAt: new Date().toISOString(),
      ...preserveConversationBoundaryFields(existingSession),
      ...(sessionModel ? { model: sessionModel } : {}),
    });
  }

  let sideChannelActions: CodexExecAction[] = [];
  try {
    sideChannelActions = (await actionChannel.read()).actions;
  } catch (err) {
    (err as { stdoutTail?: string }).stdoutTail ??= result.text;
    throw err;
  } finally {
    await actionChannel.cleanup();
  }

  const deferredByText = !!findLarkDeferSentinel(result.text);
  let text = result.text.trim();
  let suppressVisibleReply = false;
  if (sideChannelActions.length > 0) {
    const actionResults = opts.actionDispatcher
      ? await opts.actionDispatcher.execute({ message, actions: sideChannelActions })
      : [
          {
            ok: false,
            action: 'action_channel' as const,
            message: 'Lark exec action dispatcher is not configured.',
          },
        ];
    opts.onActionResults?.(actionResults);
    const actionSummary = formatCodexExecActionResults(actionResults);
    if (!text) {
      if (shouldSuppressEmptyActionReply(actionResults)) {
        suppressVisibleReply = true;
      } else {
        text = actionSummary;
      }
    } else if (shouldShowActionSummary(actionResults)) {
      text = `${text}\n\n[Action results]\n${actionSummary}`;
    }
  } else {
    opts.onActionResults?.([]);
  }
  if (!text) {
    text = 'Codex exec returned an empty response.';
  }
  const lifecycleGuard = guardCodexExecLifecycleReply(text, {
    allowFollowupPromise: sideChannelActions.length > 0 || deferredByText,
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
  opts.onFinalText?.(text);
  if (suppressVisibleReply) {
    return;
  }
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

  const runtimeFooter = appConfig.cardFooterMetricsEnabled
    ? formatCodexExecRuntimeMetricsFooter(
        result.runtimeMetrics ?? null,
        appConfig.cardFooterMetricsTokenUsageThreshold,
      )
    : undefined;
  await sendReply({
    chat_id: message.chatId,
    text,
    ...(isFeishuOpenMessageId(message.messageId) ? { reply_to: message.messageId } : {}),
    thread_id: message.threadId,
    ...(runtimeFooter ? { runtimeFooter } : {}),
  });
}

async function sendCodexExecProgressMessage(
  opts: CodexExecDeliveryOptions,
  message: LarkMessage,
  content: string,
): Promise<void> {
  if (message.chatType === 'doc_comment') {
    if (!message.docComment || !opts.sendDocCommentReply) return;
    await opts.sendDocCommentReply({
      chat_id: message.chatId,
      thread_id: message.threadId ?? message.docComment.commentId,
      doc_token: message.docComment.fileToken,
      comment_id: message.docComment.commentId,
      file_type: message.docComment.fileType,
      content,
    });
    opts.recordAssistantMessage?.({
      chatId: message.chatId,
      threadId: message.threadId,
      text: content,
    });
    return;
  }

  if (!shouldSendFeishuReplyForMessage(message)) return;
  await opts.sendReply({
    chat_id: message.chatId,
    text: content,
    ...(isFeishuOpenMessageId(message.messageId) ? { reply_to: message.messageId } : {}),
    thread_id: message.threadId,
  });
}
