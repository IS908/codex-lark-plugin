import type { LarkMessage } from './channel.js';
import { isCodexExecTimeoutError } from './codex-exec.js';

export const CODEX_EXEC_TIMEOUT_REPLY =
  'Task timed out and this turn was stopped. Please narrow the task scope or try again later.';

export function isFeishuOpenMessageId(messageId: string | undefined | null): boolean {
  return typeof messageId === 'string' && messageId.startsWith('om_');
}

export function isSyntheticSystemMessageId(messageId: string | undefined | null): boolean {
  return typeof messageId === 'string' && messageId.startsWith('flush-');
}

export function shouldSendFeishuReplyForMessage(
  message: Pick<LarkMessage, 'chatType' | 'messageId'>,
): boolean {
  return (message.chatType === 'p2p' || message.chatType === 'group') && isFeishuOpenMessageId(message.messageId);
}

export const shouldSendCodexExecFailureReply = shouldSendFeishuReplyForMessage;

export function formatCodexExecFailureReply(err: unknown): string {
  if (isCodexExecTimeoutError(err)) return CODEX_EXEC_TIMEOUT_REPLY;

  const errText = err instanceof Error ? err.message : String(err);
  return `Codex exec failed: ${errText.slice(0, 1500)}`;
}
