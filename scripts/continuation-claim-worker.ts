import { parentPort, workerData } from 'node:worker_threads';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';

interface ClaimWorkerData {
  databasePath: string;
  artifactsDir: string;
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  barrier: SharedArrayBuffer;
}

const input = workerData as ClaimWorkerData;
const barrier = new Int32Array(input.barrier);
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
Atomics.wait(barrier, 1, 0);

const repository = await SqliteContinuationRepository.open({
  databasePath: input.databasePath,
  artifactsDir: input.artifactsDir,
  jitter: () => 0,
});
try {
  const claim = await repository.claimDue(input.workerId, input.now, input.leaseExpiresAt);
  parentPort?.postMessage(claim ? { jobId: claim.job.jobId, workerId: input.workerId } : null);
} finally {
  repository.close();
}
