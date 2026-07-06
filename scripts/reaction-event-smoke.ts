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

async function waitForHandled(count: number): Promise<void> {
  for (let i = 0; i < 20 && forwardedMessages.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

channel.setMessageHandler(async (message) => {
  forwardedMessages.push(message);
});

channel.getBotMessageTracker().add('om_bot_reply_001', {
  chatId: 'oc_allowed',
  threadId: 'omt_allowed',
  quotedContext: {
    text: 'The issue has been created and linked.',
    msgType: 'text',
  },
});
channel.getBotMessageTracker().add('om_bot_reply_denied', { chatId: 'oc_denied' });
(channel as any).nameCache.set('ou_reactor_001', 'Kevin');
channel.setBotOpenId('ou_bot');

try {
  await channel.handleSdkReactionEvent({
    messageId: 'om_bot_reply_001',
    emojiType: 'OK',
    operator: { openId: 'ou_reactor_001' },
    action: 'added',
    actionTime: Date.now(),
  });
  await waitForHandled(1);

  assert.equal(forwardedMessages.length, 1, 'user emoji reactions on bot replies should surface as turns');
  const reactionMessage = forwardedMessages[0] as any;
  assert.equal(reactionMessage.messageId, 'om_bot_reply_001');
  assert.equal(reactionMessage.chatId, 'oc_allowed');
  assert.equal(reactionMessage.threadId, 'omt_allowed');
  assert.equal(reactionMessage.senderId, 'ou_reactor_001');
  assert.equal(reactionMessage.senderName, 'Kevin');
  assert.equal(reactionMessage.messageType, 'reaction');
  assert.equal(reactionMessage.reaction.emojiType, 'OK');
  assert.equal(reactionMessage.reaction.targetMessageId, 'om_bot_reply_001');
  assert.match(reactionMessage.text, /User Kevin .*reacted to a previous bot reply with emoji OK/);
  assert.match(reactionMessage.text, /normal user interaction turn/);
  assert.match(reactionMessage.text, /Do not classify OK, DONE, THUMBSUP/);
  assert.match(reactionMessage.text, /The issue has been created and linked/);
  assert.ok(
    logs.some((line) => line.includes('Routing user reaction OK on bot message om_bot_reply_001')),
    'allowed tracked chat should reach reaction delivery path',
  );

  await channel.handleSdkReactionEvent({
    messageId: 'om_bot_reply_denied',
    emojiType: 'OK',
    operator: { openId: 'ou_reactor_001' },
    action: 'added',
    actionTime: Date.now(),
  });
  assert.ok(
    logs.some((line) => line.includes('Reaction from ou_reactor_001 rejected by whitelist')),
    'tracked chat metadata should be used for reaction whitelist checks',
  );

  await channel.handleSdkReactionEvent({
    messageId: 'om_bot_reply_001',
    emojiType: 'MeMeMe',
    operator: { openId: 'ou_bot' },
    action: 'added',
    actionTime: Date.now(),
  });

  await channel.handleSdkReactionEvent({
    messageId: 'om_untracked_user_message',
    emojiType: 'OK',
    operator: { openId: 'ou_reactor_001' },
    action: 'added',
    actionTime: Date.now(),
  });
} finally {
  console.error = originalConsoleError;
}

assert.equal(
  forwardedMessages.length,
  1,
  'bot self-reactions and untracked message reactions should remain ignored',
);

console.log('PASS');
