import assert from 'node:assert/strict';

process.env.LARK_APP_ID = 'sdk_runtime_app_id';
process.env.LARK_APP_SECRET = 'sdk_runtime_secret';
process.env.LARK_ACK_EMOJI = '';
process.env.LARK_ALLOWED_USER_IDS = '';
process.env.LARK_ALLOWED_CHAT_IDS = '';

const { LarkChannel } = await import('../src/channel.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { startSdkChannelRuntime } = await import('../src/sdk-channel-runtime.js');

type Handler = (event: any) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler>();
let connected = false;
const fakeSdkChannel = {
  botIdentity: { openId: 'ou_bot', name: 'Codex Bot' },
  rawClient: null,
  on(nameOrHandlers: string | Record<string, Handler>, handler?: Handler) {
    if (typeof nameOrHandlers === 'string') {
      handlers.set(nameOrHandlers, handler!);
    } else {
      for (const [name, fn] of Object.entries(nameOrHandlers)) {
        handlers.set(name, fn);
      }
    }
    return () => {};
  },
  async connect() {
    connected = true;
  },
};

const channel = new LarkChannel();
(channel.getClient() as any).im.v1.messageReaction.create = async () => ({
  data: { reaction_id: 'reaction_sdk_ack' },
});

const identitySession = new IdentitySession(() => 'ou_owner');
channel.setIdentitySession(identitySession);

const handled: any[] = [];
channel.setMessageHandler(async (message) => {
  handled.push(message);
});

await startSdkChannelRuntime(channel, {
  createChannel: () => fakeSdkChannel as any,
});

assert.equal(connected, true);
for (const eventName of ['message', 'comment', 'reaction', 'reject', 'error']) {
  assert.equal(handlers.has(eventName), true, `missing SDK ${eventName} handler`);
}

await handlers.get('message')!({
  messageId: 'om_sdk_live',
  chatId: 'oc_sdk_p2p',
  chatType: 'p2p',
  senderId: 'ou_sdk_sender',
  senderName: 'SDK Sender',
  content: 'hello via sdk',
  rawContentType: 'text',
  mentionedBot: false,
  mentionAll: false,
  mentions: [],
  resources: [{ type: 'file', fileKey: 'file_sdk', fileName: 'report.pdf' }],
  createTime: Date.now(),
});

for (let i = 0; i < 20 && handled.length < 1; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(handled.length, 1);
assert.equal(handled[0].messageId, 'om_sdk_live');
assert.equal(handled[0].chatId, 'oc_sdk_p2p');
assert.equal(handled[0].senderId, 'ou_sdk_sender');
assert.equal(handled[0].attachments[0].fileKey, 'file_sdk');
assert.equal(identitySession.getCaller('oc_sdk_p2p'), 'ou_sdk_sender');

await handlers.get('comment')!({
  fileToken: 'dox_sdk_live',
  fileType: 'docx',
  commentId: 'cmt_sdk_live',
  replyId: 'rpl_sdk_live',
  operator: { openId: 'ou_commenter' },
  mentionedBot: true,
  timestamp: Date.now(),
});

for (let i = 0; i < 20 && handled.length < 2; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(handled.length, 2);
assert.equal(handled[1].chatId, 'doc:dox_sdk_live');
assert.equal(handled[1].threadId, 'cmt_sdk_live');
assert.equal(identitySession.getCaller('doc:dox_sdk_live', 'cmt_sdk_live'), 'ou_commenter');

channel.getBotMessageTracker().add('om_bot_reply', { chatId: 'oc_sdk_p2p' });
await handlers.get('reaction')!({
  messageId: 'om_bot_reply',
  operator: { openId: 'ou_sdk_sender' },
  emojiType: 'OK',
  action: 'added',
  actionTime: Date.now(),
});
assert.equal(handled.length, 2, 'reaction events must remain passive');

console.log('sdk-runtime smoke: PASS');
