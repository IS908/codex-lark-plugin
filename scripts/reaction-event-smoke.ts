import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_ALLOWED_USER_IDS = '';
process.env.LARK_ALLOWED_CHAT_IDS = 'oc_allowed';

const { LarkChannel } = await import('../src/channel.js');

const channel = new LarkChannel();
const forwardedMessages: unknown[] = [];
const logs: string[] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  logs.push(args.map(String).join(' '));
};

channel.setMessageHandler(async (message) => {
  forwardedMessages.push(message);
});

channel.getBotMessageTracker().add('om_bot_reply_001', { chatId: 'oc_allowed' });
channel.getBotMessageTracker().add('om_bot_reply_denied', { chatId: 'oc_denied' });
(channel as any).nameCache.set('ou_reactor_001', 'Kevin');

try {
  await (channel as any).handleReactionEvent({
    message_id: 'om_bot_reply_001',
    reaction_type: { emoji_type: 'OK' },
    operator_type: 'user',
    user_id: { open_id: 'ou_reactor_001' },
  });

  assert.equal(
    forwardedMessages.length,
    0,
    'user emoji reactions on bot replies should not trigger a Codex message turn',
  );
  assert.ok(
    logs.some((line) => line.includes('Ignoring user reaction OK on bot message om_bot_reply_001')),
    'allowed tracked chat should reach passive-reaction ignore path',
  );

  await (channel as any).handleReactionEvent({
    message_id: 'om_bot_reply_denied',
    reaction_type: { emoji_type: 'OK' },
    operator_type: 'user',
    user_id: { open_id: 'ou_reactor_001' },
  });
  assert.ok(
    logs.some((line) => line.includes('Reaction from ou_reactor_001 rejected by whitelist')),
    'tracked chat metadata should be used for reaction whitelist checks',
  );

  await (channel as any).handleReactionEvent({
    message_id: 'om_bot_reply_001',
    reaction_type: { emoji_type: 'MeMeMe' },
    operator_type: 'app',
    user_id: { open_id: 'ou_reactor_001' },
  });

  await (channel as any).handleReactionEvent({
    message_id: 'om_untracked_user_message',
    reaction_type: { emoji_type: 'OK' },
    operator_type: 'user',
    user_id: { open_id: 'ou_reactor_001' },
  });
} finally {
  console.error = originalConsoleError;
}

assert.equal(
  forwardedMessages.length,
  0,
  'bot self-reactions and untracked message reactions should remain ignored',
);

console.log('PASS');
