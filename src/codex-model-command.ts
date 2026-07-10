import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import {
  buildCodexExecSessionKey,
  FileCodexExecSessionStore,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import { isFeishuOpenMessageId } from './codex-exec-error.js';
import { extractMessageText } from './message-content.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';

export interface CodexModelCommandOptions {
  message: LarkMessage;
  sessionStore?: CodexExecSessionStore;
  useCodexSessions?: boolean;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  recordAssistantMessage?: (message: { chatId: string; threadId?: string; text: string }) => void;
}

type ModelCommand =
  | { action: 'show' }
  | { action: 'reset' }
  | { action: 'set'; model: string }
  | { action: 'invalid'; error: string };

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const defaultSessionStore = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);

export async function handleCodexModelCommand(
  opts: CodexModelCommandOptions,
): Promise<boolean> {
  const command = parseCodexModelCommand(opts.message);
  if (!command) return false;

  const text = await executeCodexModelCommand(command, opts);
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

function parseCodexModelCommand(message: LarkMessage): ModelCommand | null {
  if (message.chatType !== 'p2p' && message.chatType !== 'group') return null;
  if (message.messageType === 'reaction') return null;

  const text = commandTextCandidate(message);
  if (!text) return null;

  const normalized = stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim());
  const match = normalized.match(/^\/model(?:\s+(.+))?$/i);
  if (!match) return null;

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

function commandTextCandidate(message: LarkMessage): string {
  const fromRaw = extractMessageText(message.rawContent, message.messageType);
  if (looksLikeModelCommand(fromRaw)) return fromRaw;
  return message.text;
}

function looksLikeModelCommand(text: string): boolean {
  return /^\/model(?:\s|$)/i.test(stripLeadingMentions(text.replace(/\u00a0/g, ' ').trim()));
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
