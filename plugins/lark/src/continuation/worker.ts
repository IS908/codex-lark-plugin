import type {
  ContinuationAudit,
  ContinuationClock,
  ContinuationDelivery,
  ContinuationExecutor,
  ContinuationRepository,
} from '../ports/continuation.js';
import { DurableRunWorker } from '../durable-run/worker.js';
import { AsyncTaskKernelAdapter } from './async-task-kernel-adapter.js';

export interface ContinuationWorkerOptions {
  repository: ContinuationRepository;
  executor: ContinuationExecutor;
  delivery: ContinuationDelivery;
  clock: ContinuationClock;
  audit?: ContinuationAudit;
  maxConcurrency: number;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  workerId?: string;
  debug?: (message: string) => void;
}

export class ContinuationWorker {
  private readonly worker: DurableRunWorker;

  constructor(options: ContinuationWorkerOptions) {
    const adapter = new AsyncTaskKernelAdapter(options);
    this.worker = new DurableRunWorker({
      repository: adapter,
      workloads: [adapter],
      delivery: adapter,
      clock: options.clock,
      maxConcurrencyByWorkload: { async_task: options.maxConcurrency },
      ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
      workerId: options.workerId ?? 'continuation-worker',
      onExecutionStateError: (claim) => adapter.handleWorkerStateError(claim),
    });
  }

  get activeCount(): number {
    return this.worker.activeCount;
  }

  start(): void {
    this.worker.start();
  }

  tick(): Promise<void> {
    return this.worker.tick();
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }
}
