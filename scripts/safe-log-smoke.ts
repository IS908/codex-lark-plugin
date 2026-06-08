/**
 * Safe logging smoke test.
 * Ensures Feishu/Axios-style errors are reduced before logging so tokens
 * and request headers do not leak into debug output.
 */
import { logSafeError, redactErrorForLog } from '../src/safe-log.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const err: any = new Error('Request failed with status code 400');
err.response = {
  status: 400,
  statusText: 'Bad Request',
  headers: {
    'x-request-id': 'req_123',
    'x-tt-logid': 'log_123',
  },
  config: {
    url: 'https://open.feishu.cn/open-apis/im/v1/messages/flush-1/reply',
    method: 'post',
    headers: {
      Authorization: 'Bearer t-secret-token',
      'Content-Type': 'application/json',
    },
    data: '{"content":"sensitive body"}',
  },
  data: {
    code: 99992354,
    msg: 'invalid open_message_id',
    error: {
      log_id: 'log_123',
      field_violations: [{ field: 'message_id', value: 'flush-1' }],
    },
  },
};

const redacted = redactErrorForLog(err);
const json = JSON.stringify(redacted);
if (json.includes('t-secret-token') || json.includes('Authorization') || json.includes('Bearer')) {
  fail(`redacted log leaked auth data: ${json}`);
}
if (json.includes('sensitive body')) {
  fail(`redacted log leaked request body: ${json}`);
}
if (!json.includes('99992354') || !json.includes('invalid open_message_id') || !json.includes('log_123')) {
  fail(`redacted log lost useful Feishu diagnostics: ${json}`);
}

const nested = redactErrorForLog([[err]]);
const nestedJson = JSON.stringify(nested);
if (!nestedJson.includes('Request failed with status code 400') || !nestedJson.includes('log_123')) {
  fail(`nested SDK error redaction lost useful diagnostics: ${nestedJson}`);
}
if (nestedJson.includes('t-secret-token') || nestedJson.includes('Authorization') || nestedJson.includes('Bearer')) {
  fail(`nested SDK error redaction leaked auth data: ${nestedJson}`);
}

const captured: unknown[][] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  captured.push(args);
};
try {
  logSafeError('[safe-log-smoke] upload failed:', err);
} finally {
  console.error = originalConsoleError;
}
const capturedJson = JSON.stringify(captured);
if (!capturedJson.includes('[safe-log-smoke] upload failed:') || !capturedJson.includes('99992354')) {
  fail(`logSafeError lost prefix or diagnostics: ${capturedJson}`);
}
if (capturedJson.includes('t-secret-token') || capturedJson.includes('Authorization') || capturedJson.includes('Bearer')) {
  fail(`logSafeError leaked auth data: ${capturedJson}`);
}
if (capturedJson.includes('sensitive body')) {
  fail(`logSafeError leaked request body: ${capturedJson}`);
}

console.log('PASS');
