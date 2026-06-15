export interface QuotedContextMessage {
  messageId: string;
  parentId?: string;
  rootMessageId?: string;
  threadId?: string;
  parentContent?: string;
}

export interface QuotedContextTransport {
  fetchMessageText(messageId: string): Promise<string | null>;
}

export interface AddQuotedContextResult {
  quotedMessageId?: string;
  loaded: boolean;
}

export function isOpenMessageId(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('om_');
}

export function selectQuotedMessageId(message: QuotedContextMessage): string | undefined {
  return (
    message.parentId ||
    (isOpenMessageId(message.rootMessageId) && message.rootMessageId !== message.messageId
      ? message.rootMessageId
      : undefined) ||
    (isOpenMessageId(message.threadId) && message.threadId !== message.messageId ? message.threadId : undefined)
  );
}

export async function addQuotedContext(
  message: QuotedContextMessage,
  transport: QuotedContextTransport,
): Promise<AddQuotedContextResult> {
  const quotedMessageId = selectQuotedMessageId(message);
  if (!quotedMessageId) return { loaded: false };

  try {
    const parentText = await transport.fetchMessageText(quotedMessageId);
    if (!parentText) return { quotedMessageId, loaded: false };
    message.parentContent = parentText;
    return { quotedMessageId, loaded: true };
  } catch {
    return { quotedMessageId, loaded: false };
  }
}
