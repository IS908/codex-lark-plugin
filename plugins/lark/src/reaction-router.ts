export type ReactionRouteReason =
  | 'bot-self'
  | 'untracked-message'
  | 'whitelist-denied'
  | 'missing-chat'
  | 'user-reaction';

export type ReactionRouteDecision =
  | {
      action: 'ignored';
      reason: Exclude<ReactionRouteReason, 'user-reaction'>;
    }
  | {
      action: 'deliver';
      reason: 'user-reaction';
      event: ReactionRouteEvent;
      trackedMessage: ReactionTrackedMessage;
    };

export interface ReactionTrackedMessage {
  chatId?: string;
  threadId?: string;
  quotedContext?: {
    text?: string;
    msgType?: string;
  };
}

export interface ReactionRouteEvent {
  messageId: string;
  emojiType?: string;
  operatorId?: string;
  isBotSelfReaction?: boolean;
}

export interface ReactionRouteOptions {
  event: ReactionRouteEvent;
  botMessageTracker: {
    get: (messageId: string) => ReactionTrackedMessage | undefined;
  };
  passesWhitelist: (senderId: string, chatId: string) => boolean;
  debugLog: (line: string) => void;
  logPrefix: string;
}

export function sdkReactionRouteEvent(reaction: {
  messageId?: string;
  emojiType?: string;
  operator?: { openId?: string };
}, botOpenId?: string): ReactionRouteEvent {
  return {
    messageId: reaction.messageId ?? '',
    emojiType: reaction.emojiType ?? '',
    operatorId: reaction.operator?.openId ?? '',
    isBotSelfReaction: !!botOpenId && reaction.operator?.openId === botOpenId,
  };
}

export function routeReactionEvent(opts: ReactionRouteOptions): ReactionRouteDecision {
  const { event, botMessageTracker, passesWhitelist, debugLog, logPrefix } = opts;

  if (event.isBotSelfReaction) {
    return { action: 'ignored', reason: 'bot-self' };
  }

  const trackedMessage = botMessageTracker.get(event.messageId);
  if (!trackedMessage) {
    return { action: 'ignored', reason: 'untracked-message' };
  }
  if (!trackedMessage.chatId) {
    debugLog(`${logPrefix} Reaction on bot message ${event.messageId} ignored because tracked chat_id is missing`);
    return { action: 'ignored', reason: 'missing-chat' };
  }

  if (!passesWhitelist(event.operatorId ?? '', trackedMessage.chatId)) {
    debugLog(`${logPrefix} Reaction from ${event.operatorId ?? ''} rejected by whitelist`);
    return { action: 'ignored', reason: 'whitelist-denied' };
  }

  debugLog(
    `${logPrefix} Routing user reaction ${event.emojiType || '(unknown)'} on bot message ${event.messageId} from ${event.operatorId ?? ''}`,
  );
  return { action: 'deliver', reason: 'user-reaction', event, trackedMessage };
}
