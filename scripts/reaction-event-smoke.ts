import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_ALLOWED_USER_IDS = '';
process.env.LARK_ALLOWED_CHAT_IDS = '';

const { LarkChannel } = await import('../src/channel.js');

const channel = new LarkChannel();
const forwardedMessages: unknown[] = [];

channel.setMessageHandler(async (message) => {
  forwardedMessages.push(message);
});

channel.getBotMessageTracker().add('om_bot_reply_001');
(channel as any).nameCache.set('ou_reactor_001', 'Kevin');

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

assert.equal(
  forwardedMessages.length,
  0,
  'bot self-reactions and untracked message reactions should remain ignored',
);

console.log('PASS');
