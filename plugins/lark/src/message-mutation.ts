export interface BotMessageScopeLookup {
  get(messageId: string): { chatId?: string; threadId?: string } | undefined;
}

export type TrackedBotMessageScopeResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateTrackedBotMessageScope(args: {
  toolName: string;
  messageId: string;
  chatId: string;
  threadId?: string;
  botMessageTracker?: BotMessageScopeLookup;
}): TrackedBotMessageScopeResult {
  const tracked = args.botMessageTracker?.get(args.messageId);
  if (!tracked) {
    return {
      ok: false,
      message: `${args.toolName} denied: ${args.messageId} is not a tracked bot message.`,
    };
  }
  if (tracked.chatId !== args.chatId || (tracked.threadId ?? '') !== (args.threadId ?? '')) {
    return {
      ok: false,
      message:
        `${args.toolName} denied: ${args.messageId} belongs to chat=${tracked.chatId ?? '(unknown)'}` +
        ` thread=${tracked.threadId ?? '(none)'}, does not belong to chat=${args.chatId}` +
        ` thread=${args.threadId ?? '(none)'}.`,
    };
  }
  return { ok: true };
}
