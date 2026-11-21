import { once } from 'node:events';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { ContinuationInputStore } from '../../src/continuation/input-store.js';

const { inputsDir, jobId } = workerData as { inputsDir: string; jobId: string };
const store = new ContinuationInputStore(inputsDir);
await store.withCreationLock(jobId, async () => {
  const aged = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(join(inputsDir, jobId), aged, aged);
  const release = once(parentPort!, 'message', { signal: AbortSignal.timeout(15_000) });
  parentPort!.postMessage('held');
  await release;
});
