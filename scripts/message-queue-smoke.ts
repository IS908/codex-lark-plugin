/**
 * MessageQueue smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { MessageQueue } from '../src/queue.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 120,
  intervalMs = 5,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

// 1. Same chat/thread handlers still run sequentially.
{
  const q = new MessageQueue({ handlerTimeoutMs: 1000 });
  const events: string[] = [];

  q.enqueue('chat_A', 'thread_1', async () => {
    events.push('first:start');
    await sleep(20);
    events.push('first:end');
  });
  q.enqueue('chat_A', 'thread_1', async () => {
    events.push('second:start');
  });

  const completed = await waitUntil(() => events.includes('second:start'));
  if (!completed) fail('sequential handlers did not complete');
  if (events.join(',') !== 'first:start,first:end,second:start') {
    fail(`same-key order changed: ${events.join(',')}`);
  }
}

// 2. A stuck handler must not permanently block later messages in the same key.
{
  const q = new MessageQueue({ handlerTimeoutMs: 20 });
  const events: string[] = [];

  q.enqueue('chat_A', 'thread_1', async () => {
    events.push('stuck:start');
    await new Promise<void>(() => {});
  });
  q.enqueue('chat_A', 'thread_1', async () => {
    events.push('second:start');
  });

  const recovered = await waitUntil(() => events.includes('second:start'), 160);
  if (!recovered) fail('stuck handler permanently blocked same-key queue');
}

console.log('message-queue smoke: 2/2 PASS');
