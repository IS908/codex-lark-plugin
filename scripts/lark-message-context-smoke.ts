import assert from 'node:assert/strict';
import { formatLarkMessageContextBlock } from '../src/lark-message-context.js';

const sdkBlock = formatLarkMessageContextBlock({
  messageId: 'om_sdk',
  text: 'SDK Card\nfrom channel sdk',
  msgType: 'interactive',
  chatId: 'oc_sdk',
  replyTo: 'om_parent',
  fetchStage: 'sdk_fetch',
  fetchIdentity: 'bot',
  fetchResult: 'success',
  sender: {
    senderType: 'app',
    idType: 'app_id',
  },
  interactiveCard: {
    title: 'SDK Card',
    text: 'SDK Card\nfrom channel sdk',
    rawContentShape: 'feishu_card_json',
  },
});
assert.match(sdkBlock, /kind: lark_message/);
assert.match(sdkBlock, /role: assistant/);
assert.match(sdkBlock, /source: feishu_api/);
assert.match(sdkBlock, /identity: bot/);
assert.match(sdkBlock, /chat_id: oc_sdk/);
assert.match(sdkBlock, /reply_to: om_parent/);
assert.match(sdkBlock, /msg_type: interactive_card/);
assert.match(sdkBlock, /title: SDK Card/);

const rawBlock = formatLarkMessageContextBlock({
  messageId: 'om_raw',
  text: 'Raw message',
  msgType: 'text',
  fetchStage: 'bot_mget',
  fetchIdentity: 'bot',
  fetchResult: 'success',
  sender: {
    senderType: 'user',
    idType: 'open_id',
  },
});
assert.match(rawBlock, /role: user/);
assert.match(rawBlock, /source: feishu_api/);
assert.match(rawBlock, /msg_type: text/);

const legacyRawBlock = formatLarkMessageContextBlock({
  messageId: 'om_legacy_raw',
  text: 'Legacy raw mget message',
  msgType: 'text',
  fetchStage: 'raw_mget',
  fetchIdentity: 'bot',
  fetchResult: 'success',
});
assert.match(legacyRawBlock, /source: feishu_api/);

const userBlock = formatLarkMessageContextBlock({
  messageId: 'om_user',
  text: 'User visible card',
  msgType: 'interactive',
  fetchStage: 'user_mget',
  fetchIdentity: 'user',
  fetchResult: 'success',
});
assert.match(userBlock, /source: lark_cli/);
assert.match(userBlock, /identity: user/);
assert.match(userBlock, /raw_content_shape: unknown/);

const cacheBlock = formatLarkMessageContextBlock({
  messageId: 'om_cache',
  text: 'Cached bot card',
  msgType: 'interactive',
  fetchStage: 'outbound_cache',
  fetchIdentity: 'cache',
  fetchResult: 'success',
});
assert.match(cacheBlock, /source: event/);
assert.match(cacheBlock, /identity: cache/);

const emptyTextBlock = formatLarkMessageContextBlock({
  messageId: 'om_empty',
  text: '',
  msgType: 'text',
});
assert.match(emptyTextBlock, /hydration_status: success/);
assert.match(emptyTextBlock, /content:\n$/);

const failedBlock = formatLarkMessageContextBlock({
  messageId: 'om_failed',
  text: null,
  msgType: 'interactive',
  fetchStage: 'user_mget',
  fetchIdentity: 'user',
  fetchResult: 'unavailable',
  diagnostic: 'spawn_error=ENOENT',
}, {
  hydrationStatus: 'failed',
  failureReason: 'fetch_failed',
  includeRecoveryHint: true,
});
assert.match(failedBlock, /hydration_status: failed/);
assert.match(failedBlock, /reason: fetch_failed/);
assert.match(failedBlock, /fetch_stage: user_mget/);
assert.match(failedBlock, /codex_recovery_hint: quoted interactive card context is unavailable through user identity/);

console.log('lark-message-context smoke: PASS');
