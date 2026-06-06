import { appConfig } from './config.js';
import type { LarkMessage } from './channel.js';
import type { CodexExecRequest, CodexExecRunner } from './codex-exec.js';
import { runCodexExecCommand } from './codex-exec.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';

export interface CodexExecDeliveryOptions {
  message: LarkMessage;
  displayLabel: string;
  runCodexExec?: CodexExecRunner;
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
}

export function buildCodexExecPrompt(message: LarkMessage, displayLabel: string): string {
  const metaLines = [
    `message_id: ${message.messageId}`,
    `chat_id: ${message.chatId}`,
    `chat_type: ${message.chatType}`,
    `user: ${displayLabel}`,
    `user_id: ${message.senderId}`,
    ...(message.chatName ? [`chat_name: ${message.chatName}`] : []),
    ...(message.threadId ? [`thread_id: ${message.threadId}`] : []),
    ...(message.botMentioned ? ['bot_mentioned: true'] : []),
    ...(message.parentContent ? [`parent_content: ${message.parentContent}`] : []),
    ...(message.attachments?.length
      ? [`attachments: ${JSON.stringify(message.attachments)}`]
      : []),
  ];

  return [
    'Reply to this Feishu/Lark message.',
    'Return only the message text that should be sent back to Feishu. Do not include tool-call instructions, transport metadata, or commentary about this wrapper.',
    'If the user asks for an action you cannot complete in this one-shot exec environment, say exactly what is missing and keep the answer concise.',
    '',
    '[Feishu metadata]',
    metaLines.join('\n'),
    '',
    '[Message text]',
    message.text,
  ].join('\n');
}

function collectImagePaths(message: LarkMessage): string[] {
  const paths = new Set<string>();
  if (message.imagePath) paths.add(message.imagePath);
  for (const imagePath of message.imagePaths ?? []) paths.add(imagePath);
  return [...paths];
}

export async function deliverMessageViaCodexExec(
  opts: CodexExecDeliveryOptions,
): Promise<void> {
  const { message, displayLabel, sendReply } = opts;
  const runCodexExec = opts.runCodexExec ?? runCodexExecCommand;
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
  };

  let text = (await runCodexExec(request)).trim();
  if (!text) {
    text = 'Codex exec returned an empty response.';
  }

  await sendReply({
    chat_id: message.chatId,
    text,
    reply_to: message.messageId,
    thread_id: message.threadId,
  });
}
