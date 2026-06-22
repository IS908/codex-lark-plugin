import assert from 'node:assert/strict';
import {
  isFeishuWithdrawnMessageError,
  isRetryableFeishuError,
  withFeishuRetry,
  withTimeout,
} from '../src/feishu-retry.js';

function transientError(code = 'ECONNRESET'): Error {
  const err = new Error(code) as Error & { code?: string };
  err.code = code;
  return err;
}

function permanentFeishuError(): Error {
  const err = new Error('permission denied') as Error & { response?: { data: { code: number; msg: string } } };
  err.response = { data: { code: 99991672, msg: 'permission denied' } };
  return err;
}

async function captureRejects(promise: Promise<unknown>, pattern: RegExp): Promise<any> {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (err: any) {
    assert.match(err?.message ?? String(err), pattern);
    return err;
  }
}

assert.equal(isRetryableFeishuError(transientError()), true);
assert.equal(isRetryableFeishuError(permanentFeishuError()), false);
assert.equal(
  isRetryableFeishuError({ response: { data: { code: '99991672', msg: 'permission denied' } } }),
  false,
);
assert.equal(
  isRetryableFeishuError({ response: { data: { code: 99990001, msg: 'business error' } } }),
  false,
);
assert.equal(
  isRetryableFeishuError({ response: { status: 500, data: { code: 230011, msg: 'The message was withdrawn.' } } }),
  false,
);
assert.equal(
  isFeishuWithdrawnMessageError({
    cause: { response: { data: { code: 230011, msg: 'The message was withdrawn.' } } },
  }),
  true,
);

let attempts = 0;
const retried = await withFeishuRetry(
  'unit.retry-success',
  async () => {
    attempts++;
    if (attempts < 3) throw transientError();
    return 'ok';
  },
  { attempts: 3, baseDelayMs: 1, timeoutMs: 100 },
);
assert.equal(retried, 'ok');
assert.equal(attempts, 3);

let exhaustedAttempts = 0;
const exhaustedErr = await captureRejects(
  withFeishuRetry(
    'unit.retry-exhaustion',
    async () => {
      exhaustedAttempts++;
      throw transientError('ETIMEDOUT');
    },
    { attempts: 2, baseDelayMs: 1, timeoutMs: 100 },
  ),
  /unit\.retry-exhaustion failed after 2 attempts/,
);
assert.equal(exhaustedAttempts, 2);
assert.equal((exhaustedErr as any).code, 'ETIMEDOUT');
assert.equal((exhaustedErr as any).cause?.code, 'ETIMEDOUT');

let exhaustedStatusAttempts = 0;
const exhaustedStatusErr = await captureRejects(
  withFeishuRetry(
    'unit.status-exhaustion',
    async () => {
      exhaustedStatusAttempts++;
      const err = new Error('rate limited') as Error & { status?: number; response?: { status: number } };
      err.status = 429;
      err.response = { status: 429 };
      throw err;
    },
    { attempts: 1, baseDelayMs: 1, timeoutMs: 100 },
  ),
  /unit\.status-exhaustion failed after 1 attempts/,
);
assert.equal(exhaustedStatusAttempts, 1);
assert.equal((exhaustedStatusErr as any).status, 429);
assert.equal((exhaustedStatusErr as any).response?.status, 429);

let permanentAttempts = 0;
await assert.rejects(
  withFeishuRetry(
    'unit.permanent',
    async () => {
      permanentAttempts++;
      throw permanentFeishuError();
    },
    { attempts: 5, baseDelayMs: 1, timeoutMs: 100 },
  ),
  /permission denied/,
);
assert.equal(permanentAttempts, 1);

let businessErrorAttempts = 0;
await assert.rejects(
  withFeishuRetry(
    'unit.business-code',
    async () => {
      businessErrorAttempts++;
      return { code: 230001, msg: 'param error' };
    },
    { attempts: 5, baseDelayMs: 1, timeoutMs: 100 },
  ),
  /Feishu API \[230001\]: param error/,
);
assert.equal(businessErrorAttempts, 1);

await assert.rejects(
  withTimeout(new Promise(() => {}), 5, 'unit.timeout'),
  /unit\.timeout timed out after 5ms/,
);

let timedAttempts = 0;
const timedErr = await captureRejects(
  withFeishuRetry(
    'unit.operation-timeout',
    async () => {
      timedAttempts++;
      return new Promise(() => {});
    },
    { attempts: 2, baseDelayMs: 1, timeoutMs: 5 },
  ),
  /unit\.operation-timeout failed after 2 attempts/,
);
assert.equal(timedAttempts, 2);
assert.equal((timedErr as any).code, 'FEISHU_TIMEOUT');

let noRetryTimeoutAttempts = 0;
const noRetryTimeoutErr = await captureRejects(
  withFeishuRetry(
    'unit.no-timeout-retry',
    async () => {
      noRetryTimeoutAttempts++;
      return new Promise(() => {});
    },
    { attempts: 5, baseDelayMs: 1, timeoutMs: 5, retryTimeout: false },
  ),
  /^unit\.no-timeout-retry timed out after 5ms$/,
);
assert.equal(noRetryTimeoutAttempts, 1);
assert.equal((noRetryTimeoutErr as any).code, 'FEISHU_TIMEOUT');

console.log('feishu-retry smoke: PASS');
