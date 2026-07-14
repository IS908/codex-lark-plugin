import { appConfig } from './config.js';
import type { LarkMessage } from './lark-message.js';
import { audit } from './audit-log.js';
import type { ConversationFlushResult, ConversationFlushReason } from './memory/buffer.js';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import {
  createNextConversationBoundaryFields,
  preserveConversationBoundaryFields,
} from './conversation-boundary.js';
import { isFeishuOpenMessageId } from './codex-exec-error.js';
import { extractMessageText } from './message-content.js';
import type { IdentitySession } from './identity-session.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';
import {
  accessControlStore,
  type AccessControlAction,
  type AccessControlSnapshot,
  type AccessControlListName,
} from './runtime-access-control.js';
import {
  formatAccessControlMutationMessage,
  validateAccessControlMutation,
  type AccessControlValidationInput,
} from './access-control-validation.js';

export interface CodexModelCommandOptions {
  message: LarkMessage;
  sessionStore?: CodexExecSessionStore;
  identitySession?: IdentitySession;
  useCodexSessions?: boolean;
  validateChatAccess?: AccessControlValidationInput['validateChatAccess'];
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  recordAssistantMessage?: (message: { chatId: string; threadId?: string; text: string }) => void;
  flushConversation?: (request: {
    chatId: string;
    threadId?: string;
    reason: ConversationFlushReason;
    commitBeforeRemove?: (result: { summary?: string } | void) => Promise<void>;
  }) => Promise<ConversationFlushResult>;
  resetSessionHealth?: (sessionKey: string) => void;
}

type ModelCommand =
  | { action: 'show' }
  | { action: 'reset' }
  | { action: 'set'; model: string }
  | { action: 'invalid'; error: string };

type AccessCommand =
  | { action: 'status' }
  | { action: 'admin-list'; list: AccessControlListName }
  | { action: 'add' | 'remove'; list: AccessControlListName; value: string }
  | { action: 'invalid'; error: string };

type ControlCommand =
  | { kind: 'help' }
  | { kind: 'model'; command: ModelCommand }
  | { kind: 'access'; command: AccessCommand }
  | { kind: 'flush'; command: SimpleControlCommand }
  | { kind: 'new'; command: SimpleControlCommand };

type SimpleControlCommand =
  | { action: 'run' }
  | { action: 'invalid'; error: string };

interface ChatCommandDefinition {
  name: 'help' | 'model' | 'access' | 'flush' | 'new';
  usage: string;
  description: string;
  scope: 'user' | 'owner';
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const defaultSessionStore = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);
const CHAT_COMMANDS: ChatCommandDefinition[] = [
  {
    name: 'help',
    usage: '/help',
    description: 'Show supported chat commands and permission scope.',
    scope: 'user',
  },
  {
    name: 'model',
    usage: '/model [model-id|reset]',
    description: 'Show, set, or clear the current chat/thread Codex model override.',
    scope: 'user',
  },
  {
    name: 'flush',
    usage: '/flush',
    description: 'Distill buffered conversation context now and keep using the current Codex session.',
    scope: 'user',
  },
  {
    name: 'new',
    usage: '/new',
    description: 'Distill buffered context, then clear the current chat/thread session pointer for a fresh next turn.',
    scope: 'user',
  },
  {
    name: 'access',
    usage: '/access [list|add|remove|admin list ...]',
    description: 'Inspect or manage runtime access control.',
    scope: 'owner',
  },
];
const CONTROL_COMMAND_PATTERN = new RegExp(
  `^/(?:${CHAT_COMMANDS.map((command) => command.name).join('|')})(?:\\s|$)`,
  'i',
);

export async function handleCodexModelCommand(
  opts: CodexModelCommandOptions,
): Promise<boolean> {
  const parsed = parseControlCommand(opts.message);
  if (!parsed) return false;

  const caller = opts.identitySession?.getCaller(opts.message.chatId, opts.message.threadId) ?? opts.message.senderId;
  const auditArgs = {
    chat_id: opts.message.chatId,
    thread_id: opts.message.threadId,
    message_id: opts.message.messageId,
    command: commandTextCandidate(opts.message).slice(0, 160),
  };

  let text: string;
  if (parsed.kind === 'help') {
    text = formatHelpMessage();
  } else if (parsed.kind === 'model') {
    try {
      if (parsed.command.action === 'invalid') {
        text = parsed.command.error;
        await audit('lark_model_command', caller, auditArgs, 'error');
      } else {
        text = await executeCodexModelCommand(parsed.command, opts);
        await audit('lark_model_command', caller, auditArgs, 'ok');
      }
    } catch (err) {
      await audit('lark_model_command', caller, auditArgs, 'error');
      text = err instanceof Error ? err.message : String(err);
    }
  } else if (parsed.kind === 'flush') {
    try {
      if (parsed.command.action === 'invalid') {
        text = parsed.command.error;
        await audit('lark_flush_command', caller, auditArgs, 'error');
      } else {
        text = await executeFlushCommand(opts);
        await audit('lark_flush_command', caller, auditArgs, 'ok');
      }
    } catch (err) {
      await audit('lark_flush_command', caller, auditArgs, 'error');
      text = formatFlushFailure(err, false);
    }
  } else if (parsed.kind === 'new') {
    try {
      if (parsed.command.action === 'invalid') {
        text = parsed.command.error;
        await audit('lark_new_session_command', caller, auditArgs, 'error');
      } else {
        text = await executeNewSessionCommand(opts);
        await audit('lark_new_session_command', caller, auditArgs, 'ok');
      }
    } catch (err) {
      await audit('lark_new_session_command', caller, auditArgs, 'error');
      text = formatFlushFailure(err, true);
    }
  } else if (!appConfig.ownerOpenId || caller !== appConfig.ownerOpenId) {
    await audit('lark_access_command', caller, auditArgs, 'denied');
    text = 'This access command is owner-only. Set LARK_OWNER_OPEN_ID and use the configured owner identity.';
  } else {
    try {
      if (parsed.command.action === 'invalid') {
        text = parsed.command.error;
        await audit('lark_access_command', caller, auditArgs, 'error');
      } else {
        text = await executeAccessCommand(parsed.command, caller, opts);
        await audit('lark_access_command', caller, auditArgs, 'ok');
      }
    } catch (err) {
      await audit('lark_access_command', caller, auditArgs, 'error');
      text = err instanceof Error ? err.message : String(err);
    }
  }

  await opts.sendReply({
    chat_id: opts.message.chatId,
    text,
    ...(isFeishuOpenMessageId(opts.message.messageId) ? { reply_to: opts.message.messageId } : {}),
    thread_id: opts.message.threadId,
  });
  opts.recordAssistantMessage?.({
    chatId: opts.message.chatId,
    threadId: opts.message.threadId,
    text,
  });
  return true;
}

function parseControlCommand(message: LarkMessage): ControlCommand | null {
  if (message.chatType !== 'p2p' && message.chatType !== 'group') return null;
  if (message.messageType === 'reaction') return null;

  const text = controlCommandText(message);
  if (!text) return null;
  const normalized = stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim());
  if (/^\/model(?:\s|$)/i.test(normalized)) {
    return { kind: 'model', command: parseCodexModelCommandText(normalized) };
  }
  if (/^\/access(?:\s|$)/i.test(normalized)) {
    return { kind: 'access', command: parseAccessCommandText(normalized) };
  }
  if (/^\/help(?:\s|$)/i.test(normalized)) {
    return { kind: 'help' };
  }
  if (/^\/flush(?:\s|$)/i.test(normalized)) {
    return { kind: 'flush', command: parseNoArgControlCommand(normalized, 'flush') };
  }
  if (/^\/new(?:\s|$)/i.test(normalized)) {
    return { kind: 'new', command: parseNoArgControlCommand(normalized, 'new') };
  }
  return null;
}

function parseCodexModelCommandText(normalized: string): ModelCommand {
  const match = normalized.match(/^\/model(?:\s+(.+))?$/i);
  if (!match) return { action: 'invalid', error: 'Invalid /model command.' };
  const arg = (match[1] ?? '').trim();
  if (!arg) return { action: 'show' };
  if (/^reset$/i.test(arg)) return { action: 'reset' };
  if (!isValidModelId(arg)) {
    return {
      action: 'invalid',
      error:
        'Invalid model id. Use a single model id without spaces or control characters, for example `/model gpt-5`.',
    };
  }
  return { action: 'set', model: arg };
}

function parseAccessCommandText(normalized: string): AccessCommand {
  const match = normalized.match(/^\/access(?:\s+(.+))?$/i);
  const arg = (match?.[1] ?? '').trim();
  if (!arg || /^list$/i.test(arg) || /^status$/i.test(arg)) return { action: 'status' };

  const adminListMatch = arg.match(/^admin\s+list(?:\s+(.+))?$/i);
  if (adminListMatch) {
    const list = normalizeAccessList(adminListMatch[1]);
    if (!list) {
      return {
        action: 'invalid',
        error:
          'Invalid /access admin list command. Use `/access admin list users`, `/access admin list chats`, or `/access admin list no-mention`.',
      };
    }
    return { action: 'admin-list', list };
  }

  const parts = arg.split(/\s+/);
  const action = parts[0]?.toLowerCase();
  const list = normalizeAccessList(parts[1]);
  const value = parts.slice(2).join(' ').trim();
  if (action !== 'add' && action !== 'remove') {
    return { action: 'invalid', error: 'Invalid /access command. Use `/access`, `/access add user ou_xxx`, `/access remove chat oc_xxx`, or `/access add no-mention oc_xxx`.' };
  }
  if (!list || !value) {
    return { action: 'invalid', error: 'Invalid /access command. list and value are required for add/remove.' };
  }
  return { action, list, value };
}

function parseNoArgControlCommand(normalized: string, commandName: 'flush' | 'new'): SimpleControlCommand {
  const match = normalized.match(new RegExp(`^/${commandName}(?:\\s+(.+))?$`, 'i'));
  const arg = (match?.[1] ?? '').trim();
  if (!arg) return { action: 'run' };
  return { action: 'invalid', error: `Invalid /${commandName} command. Use /${commandName} with no arguments.` };
}

function normalizeAccessList(raw: string | undefined): AccessControlListName | null {
  const value = raw?.toLowerCase().replace(/_/g, '-');
  if (value === 'user' || value === 'users' || value === 'allowed-user-ids') return 'allowed_user_ids';
  if (value === 'chat' || value === 'chats' || value === 'allowed-chat-ids') return 'allowed_chat_ids';
  if (
    value === 'no-mention' ||
    value === 'no-mentions' ||
    value === 'group-no-mention-chat-ids' ||
    value === 'trusted-group'
  ) {
    return 'group_no_mention_chat_ids';
  }
  return null;
}

function controlCommandText(message: LarkMessage): string {
  const fromRaw = extractMessageText(message.rawContent, message.messageType);
  if (looksLikeControlCommand(fromRaw)) return fromRaw;
  return message.text;
}

function commandTextCandidate(message: LarkMessage): string {
  return controlCommandText(message);
}

function looksLikeControlCommand(text: string): boolean {
  return CONTROL_COMMAND_PATTERN.test(stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim()));
}

function stripLeadingMentions(text: string): string {
  let remaining = text;
  for (let i = 0; i < 8; i++) {
    const next = remaining.replace(/^@\S+(?:\s+|$)/, '').trimStart();
    if (next === remaining) break;
    remaining = next;
  }
  return remaining.trim();
}

function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model);
}

async function executeCodexModelCommand(
  command: ModelCommand,
  opts: CodexModelCommandOptions,
): Promise<string> {
  if (command.action === 'invalid') return command.error;

  const useSessions = opts.useCodexSessions ?? appConfig.codexExecUseSessions;
  const sessionStore = opts.sessionStore ?? defaultSessionStore;
  const sessionKey = buildCodexExecSessionKey(opts.message.chatId, opts.message.threadId);
  const existing = useSessions ? await sessionStore.get(sessionKey) : null;

  if (command.action === 'show') {
    if (existing?.model) {
      return `Effective Codex model: ${existing.model}\nSource: chat/thread override.`;
    }
    if (appConfig.codexExecModel) {
      return `Effective Codex model: ${appConfig.codexExecModel}\nSource: LARK_CODEX_EXEC_MODEL.`;
    }
    return 'Effective Codex model: Codex CLI default.\nSource: no chat/thread override or LARK_CODEX_EXEC_MODEL is configured.';
  }

  if (!useSessions) {
    return 'Per-chat model overrides require LARK_CODEX_EXEC_USE_SESSIONS=true.';
  }

  if (command.action === 'reset') {
    if (!existing?.model) {
      return 'No chat/thread model override is set.';
    }
    await sessionStore.set({
      key: sessionKey,
      sessionId: existing.sessionId || '',
      chatId: opts.message.chatId,
      ...(opts.message.threadId ? { threadId: opts.message.threadId } : {}),
      updatedAt: new Date().toISOString(),
      ...preserveConversationBoundaryFields(existing),
    });
    return appConfig.codexExecModel
      ? `Chat/thread model override cleared. Effective Codex model now falls back to LARK_CODEX_EXEC_MODEL: ${appConfig.codexExecModel}.`
      : 'Chat/thread model override cleared. Effective Codex model now falls back to the Codex CLI default.';
  }

  await sessionStore.set({
    key: sessionKey,
    sessionId: existing?.sessionId || '',
    chatId: opts.message.chatId,
    ...(opts.message.threadId ? { threadId: opts.message.threadId } : {}),
    updatedAt: new Date().toISOString(),
    ...preserveConversationBoundaryFields(existing),
    model: command.model,
  });
  return `Chat/thread Codex model override set to ${command.model}. Subsequent realtime turns in this chat/thread will use it.`;
}

async function executeFlushCommand(opts: CodexModelCommandOptions): Promise<string> {
  if (!opts.flushConversation) {
    return 'Manual conversation flush is not configured.';
  }
  const result = await opts.flushConversation({
    chatId: opts.message.chatId,
    ...(opts.message.threadId ? { threadId: opts.message.threadId } : {}),
    reason: 'manual',
  });
  if (result.status === 'empty') return 'No buffered conversation context to flush.';
  if (result.status === 'busy') return 'A conversation flush is already running for this chat. Try again after it finishes.';
  return formatFlushSuccess(result, false);
}

async function executeNewSessionCommand(opts: CodexModelCommandOptions): Promise<string> {
  const useSessions = opts.useCodexSessions ?? appConfig.codexExecUseSessions;
  if (!useSessions) {
    return 'New chat requires LARK_CODEX_EXEC_USE_SESSIONS=true.';
  }
  if (!opts.flushConversation) {
    return 'Manual conversation flush is not configured. New chat was not started.';
  }

  let committedSessionKey: string | null = null;
  const flushResult = await opts.flushConversation({
    chatId: opts.message.chatId,
    ...(opts.message.threadId ? { threadId: opts.message.threadId } : {}),
    reason: 'new_session',
    commitBeforeRemove: async (result) => {
      committedSessionKey = await clearCodexSessionPointer(opts, {
        status: 'flushed',
        messageCount: 0,
        ...(result?.summary ? { summary: result.summary } : {}),
      });
    },
  });
  if (flushResult.status === 'busy') {
    return 'A conversation flush is already running for this chat. New chat was not started.';
  }

  const sessionKey = committedSessionKey ?? await clearCodexSessionPointer(opts, flushResult);
  opts.resetSessionHealth?.(sessionKey);
  if (flushResult.status === 'empty') {
    return 'No buffered context needed archiving. New Codex session will start on the next turn.';
  }
  return formatFlushSuccess(flushResult, true);
}

async function clearCodexSessionPointer(
  opts: CodexModelCommandOptions,
  flushResult: ConversationFlushResult,
): Promise<string> {
  const sessionStore = opts.sessionStore ?? defaultSessionStore;
  const sessionKey = buildCodexExecSessionKey(opts.message.chatId, opts.message.threadId);
  const existing = await sessionStore.get(sessionKey);
  await sessionStore.set({
    key: sessionKey,
    sessionId: '',
    chatId: opts.message.chatId,
    ...(opts.message.threadId ? { threadId: opts.message.threadId } : {}),
    updatedAt: new Date().toISOString(),
    ...(existing?.model ? { model: existing.model } : {}),
    ...createNextConversationBoundaryFields({
      existing,
      cutoffMessageId: opts.message.messageId,
      cutoffTimestampMs: opts.message.timestampMs,
      handoffSummary: flushResult.summary,
    }),
  });
  return sessionKey;
}

function formatFlushSuccess(result: ConversationFlushResult, startedNewSession: boolean): string {
  const headline = startedNewSession
    ? `Conversation context archived (${result.messageCount} messages). New Codex session will start on the next turn.`
    : `Conversation context flushed (${result.messageCount} messages). Current Codex session is unchanged.`;
  return result.summary ? `${headline}\n\nSummary:\n${result.summary}` : headline;
}

function formatFlushFailure(err: unknown, newSession: boolean): string {
  const prefix = newSession
    ? 'New session was not started because conversation flush failed; current session and buffered context were preserved.'
    : 'Conversation flush failed; current session and buffered context were preserved.';
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}\nError: ${message}`;
}

function formatHelpMessage(): string {
  const formatSection = (scope: ChatCommandDefinition['scope'], title: string) => {
    const rows = CHAT_COMMANDS.filter((command) => command.scope === scope);
    return [
      title,
      ...rows.map((command) => `- ${command.usage}: ${command.description}`),
    ].join('\n');
  };
  return [
    'Available chat commands',
    '',
    formatSection('user', 'User commands:'),
    '',
    formatSection('owner', 'Owner-only commands:'),
  ].join('\n');
}

async function executeAccessCommand(
  command: AccessCommand,
  caller: string,
  opts: CodexModelCommandOptions,
): Promise<string> {
  if (command.action === 'invalid') return command.error;
  if (command.action === 'status') {
    return formatAccessStatus(accessControlStore.snapshot(), caller, opts.message);
  }
  if (command.action === 'admin-list') {
    return formatAccessAdminList(command.list, accessControlStore.snapshot());
  }

  const validated = await validateAccessControlMutation({
    action: command.action,
    list: command.list,
    value: command.value,
    currentChatId: opts.message.chatId,
    currentChatType: opts.message.chatType,
    validateChatAccess: opts.validateChatAccess,
  });
  const result = await accessControlStore.mutate({
    action: validated.action as AccessControlAction,
    list: validated.list,
    value: validated.value,
    updatedBy: caller,
  });
  return formatAccessControlMutationMessage(
    result.changed,
    validated.action,
    validated.list,
    validated.value,
  );
}

function formatAccessStatus(
  snapshot: AccessControlSnapshot,
  caller: string,
  message: LarkMessage,
): string {
  const userAllowed =
    snapshot.allowed_user_ids.length === 0 || snapshot.allowed_user_ids.includes(caller);
  const chatAllowed =
    snapshot.allowed_chat_ids.length === 0 || snapshot.allowed_chat_ids.includes(message.chatId);
  const noMentionEnabled =
    message.chatType === 'group' && snapshot.group_no_mention_chat_ids.includes(message.chatId);

  return [
    `User access: ${userAllowed ? 'allowed' : 'blocked'}`,
    `Chat access: ${chatAllowed ? 'allowed' : 'blocked'}`,
    `No-mention mode: ${noMentionEnabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

function formatAccessAdminList(
  list: AccessControlListName,
  snapshot: AccessControlSnapshot,
): string {
  const values = snapshot[list];
  const label =
    list === 'allowed_user_ids'
      ? 'Configured users'
      : list === 'allowed_chat_ids'
        ? 'Configured chats'
        : 'Configured no-mention chats';
  if (values.length === 0) return `${label}: none`;
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}
