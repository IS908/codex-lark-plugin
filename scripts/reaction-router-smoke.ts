import assert from 'node:assert/strict';
import {
  routeReactionEvent,
  type ReactionRouteDecision,
} from '../src/reaction-router.js';

const trackedMessages = new Map<string, { chatId?: string }>([
  ['om_allowed', { chatId: 'oc_allowed' }],
  ['om_denied', { chatId: 'oc_denied' }],
]);
const tracker = {
  get: (messageId: string) => trackedMessages.get(messageId),
};

const logs: string[] = [];
const passesWhitelist = (senderId: string, chatId: string) =>
  senderId === 'ou_allowed' && chatId === 'oc_allowed';
const debugLog = (line: string) => logs.push(line);

function route(event: {
  messageId: string;
  emojiType?: string;
  operatorId?: string;
  isBotSelfReaction?: boolean;
}): ReactionRouteDecision {
  return routeReactionEvent({
    event,
    botMessageTracker: tracker,
    passesWhitelist,
    debugLog,
    logPrefix: '[reaction-router-smoke]',
  });
}

assert.deepEqual(
  route({ messageId: 'om_allowed', emojiType: 'MeMeMe', operatorId: 'ou_allowed', isBotSelfReaction: true }),
  { action: 'ignored', reason: 'bot-self' },
);
assert.deepEqual(
  route({ messageId: 'om_unknown', emojiType: 'OK', operatorId: 'ou_allowed' }),
  { action: 'ignored', reason: 'untracked-message' },
);
assert.deepEqual(
  route({ messageId: 'om_denied', emojiType: 'OK', operatorId: 'ou_allowed' }),
  { action: 'ignored', reason: 'whitelist-denied' },
);
assert.deepEqual(
  route({ messageId: 'om_allowed', emojiType: 'OK', operatorId: 'ou_allowed' }),
  { action: 'ignored', reason: 'passive-feedback' },
);

assert.ok(
  logs.some((line) => line.includes('Reaction from ou_allowed rejected by whitelist')),
  'whitelist rejection should be logged',
);
assert.ok(
  logs.some((line) => line.includes('Ignoring user reaction OK on bot message om_allowed')),
  'allowed tracked reaction should reach passive-feedback log path',
);

console.log('reaction-router smoke: PASS');
