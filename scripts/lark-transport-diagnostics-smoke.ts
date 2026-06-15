import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SDK_FALLBACK_POLICIES,
  formatSdkFallbackLog,
  sdkFailureDiagnostic,
  sdkFallbackPolicy,
} from '../src/lark-transport-diagnostics.js';

const err = new Error('Internal Error') as Error & {
  code?: string;
  context?: unknown;
  cause?: unknown;
};
err.name = 'LarkChannelError';
err.code = 'unknown';
err.context = { operation: 'recall', messageId: 'om_123' };
err.cause = {
  response: {
    status: 500,
    data: { code: 99991663, msg: 'Internal Error' },
  },
  config: { headers: { Authorization: 'Bearer should-not-log' } },
};

const diagnostic = sdkFailureDiagnostic(err);
assert.match(diagnostic, /name=LarkChannelError/);
assert.match(diagnostic, /message=Internal Error/);
assert.match(diagnostic, /code=unknown/);
assert.match(diagnostic, /status=500/);
assert.match(diagnostic, /feishu_code=99991663/);
assert.match(diagnostic, /context=/);
assert.doesNotMatch(diagnostic, /should-not-log/);
assert.doesNotMatch(diagnostic, /send failed/);

assert.equal(
  formatSdkFallbackLog('recall', err),
  `[lark-transport] SDK recall failed; falling back to raw OpenAPI ${diagnostic}`,
);

assert.deepEqual(sdkFallbackPolicy('send'), {
  operation: 'send',
  behavior: 'fallback-to-raw',
  rawFallback: true,
});
assert.deepEqual(sdkFallbackPolicy('recall'), {
  operation: 'recall',
  behavior: 'fallback-to-raw',
  rawFallback: true,
});
assert.deepEqual(sdkFallbackPolicy('edit_message'), {
  operation: 'edit_message',
  behavior: 'fail-closed',
  rawFallback: false,
});
assert.deepEqual(sdkFallbackPolicy('download_resource'), {
  operation: 'download_resource',
  behavior: 'fail-closed',
  rawFallback: false,
});
assert.deepEqual(sdkFallbackPolicy('fetch_message_text'), {
  operation: 'fetch_message_text',
  behavior: 'best-effort-raw-context',
  rawFallback: true,
});

assert.ok(SDK_FALLBACK_POLICIES.length >= 8);

const policyDoc = readFileSync('docs/lark-transport-fallback-policy.md', 'utf8');
for (const policy of SDK_FALLBACK_POLICIES) {
  assert.match(policyDoc, new RegExp(`\\b${policy.operation}\\b`));
  assert.match(policyDoc, new RegExp(policy.behavior));
}
assert.match(policyDoc, /Doc-comment SDK decision/i);
assert.match(policyDoc, /receive.*SDK/is);
assert.match(policyDoc, /selected-text.*fetch.*SDK/is);
assert.match(policyDoc, /reply_id/is);
assert.match(policyDoc, /top-level.*raw/is);
assert.match(policyDoc, /raw-only/is);

console.log('lark-transport-diagnostics smoke: PASS');
