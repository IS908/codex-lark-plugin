import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import { audit } from './audit-log.js';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import { isFeishuOpenMessageId } from './codex-exec-error.js';
import { extractMessageText } from './message-content.js';
import type { IdentitySession } from './identity-session.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';
import {
  accessControlStore,
  type AccessControlAction,
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
}

type ModelCommand =
  | { action: 'show' }
  | { action: 'reset' }
  | { action: 'set'; model: string }
  | { action: 'invalid'; error: string };

type AccessCommand =
  | { action: 'list' }
  | { action: 'add' | 'remove'; list: AccessControlListName; value: string }
  | { action: 'invalid'; error: string };

type ControlCommand =
  | { kind: 'model'; command: ModelCommand }
  | { kind: 'access'; command: AccessCommand };

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const defaultSessionStore = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);

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
  if (parsed.kind === 'model') {
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
  if (!arg || /^list$/i.test(arg)) return { action: 'list' };

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
  return /^\/(?:model|access)(?:\s|$)/i.test(stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim()));
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
    model: command.model,
  });
  return `Chat/thread Codex model override set to ${command.model}. Subsequent realtime turns in this chat/thread will use it.`;
}

async function executeAccessCommand(
  command: AccessCommand,
  caller: string,
  opts: CodexModelCommandOptions,
): Promise<string> {
  if (command.action === 'invalid') return command.error;
  if (command.action === 'list') return JSON.stringify(accessControlStore.snapshot(), null, 2);
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
  return JSON.stringify({
    changed: result.changed,
    message: formatAccessControlMutationMessage(
      result.changed,
      validated.action,
      validated.list,
      validated.value,
    ),
    resolved_from_current_chat: validated.resolvedFromCurrentChat,
    snapshot: result.snapshot,
  }, null, 2);
}
