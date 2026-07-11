import assert from 'node:assert/strict';

process.env.LARK_APP_ID = 'sdk_runtime_retry_app_id';
process.env.LARK_APP_SECRET = 'sdk_runtime_retry_secret';
process.env.LARK_ACK_EMOJI = '';

const { LarkChannel } = await import('../src/channel.js');
const { startSdkChannelRuntimeWithRetry } = await import('../src/sdk-channel-runtime.js');

let attempts = 0;
let connected = false;

const connectedPromise = new Promise<void>((resolve, reject) => {
  const controller = startSdkChannelRuntimeWithRetry(new LarkChannel(), {
    retryDelayMs: () => 1,
    onConnected: () => {
      connected = true;
      resolve();
    },
    onStopped: reject,
    createChannel: () => ({
      botIdentity: { openId: 'ou_retry_bot', name: 'Codex Bot' },
      on() {
        return () => {};
      },
      async connect() {
        attempts++;
        if (attempts === 1) throw new Error('temporary Feishu DNS failure');
      },
    }) as any,
  });

  setTimeout(() => {
    if (!connected) {
      controller.stop();
      reject(new Error('runtime retry did not connect'));
    }
  }, 200);
});

assert.equal(attempts, 1, 'first connection attempt should run immediately without throwing');
assert.equal(connected, false, 'initial connect failure should not be reported as connected');

await connectedPromise;

assert.equal(attempts, 2, 'runtime should retry after the initial failure');
assert.equal(connected, true);

console.log('sdk-runtime-retry smoke: PASS');
