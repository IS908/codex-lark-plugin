import type {
  DurableRunClaim,
  DurableRunCreateRequest,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunRecord,
  DurableRunTransition,
} from '../domain/durable-run.js';
import type {
  DurableRunClaimMutationResult,
  DurableRunClock,
  DurableRunDelivery,
  DurableRunRepository,
  DurableRunWorkload,
} from '../ports/durable-run.js';
import { DurableRunWorker } from './worker.js';

export interface DurableRunRegistration {
  kind: string;
  repository: DurableRunRepository;
  workload: DurableRunWorkload;
  delivery: DurableRunDelivery;
  maxConcurrency: number;
  onExecutionStateError?: (claim: DurableRunClaim, error: unknown) => Promise<void> | void;
}

export interface DurableRunRuntimeOptions {
  baseRepository: DurableRunRepository;
  registrations: readonly DurableRunRegistration[];
  clock: DurableRunClock;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  workerId?: string;
}

export interface DurableRunRuntime {
  worker: DurableRunWorker;
  repository: DurableRunRepository;
  start(): void;
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function createDurableRunRuntime(options: DurableRunRuntimeOptions): DurableRunRuntime {
  if (options.registrations.length === 0) {
    throw new Error('Durable Run runtime requires at least one workload registration.');
  }
  const registrationByKind = new Map<string, DurableRunRegistration>();
  for (const registration of options.registrations) {
    if (registration.kind !== registration.workload.kind) {
      throw new Error(`Durable Run registration kind mismatch: ${registration.kind}.`);
    }
    if (registrationByKind.has(registration.kind)) {
      throw new Error(`Duplicate Durable Run registration: ${registration.kind}.`);
    }
    registrationByKind.set(registration.kind, registration);
  }
  const repository = new RoutedDurableRunRepository(options.baseRepository, registrationByKind);
  const delivery: DurableRunDelivery = {
    deliver(claim) {
      return requiredRegistration(registrationByKind, claim.workloadKind).delivery.deliver(claim);
    },
  };
  const worker = new DurableRunWorker({
    repository,
    workloads: options.registrations.map((registration) => registration.workload),
    delivery,
    clock: options.clock,
    maxConcurrencyByWorkload: Object.fromEntries(
      options.registrations.map((registration) => [registration.kind, registration.maxConcurrency]),
    ),
    ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    workerId: options.workerId ?? 'durable-run-worker',
    onExecutionStateError: async (claim, error) => {
      await requiredRegistration(registrationByKind, claim.run.workloadKind)
        .onExecutionStateError?.(claim, error);
    },
  });
  return {
    worker,
    repository,
    start: () => worker.start(),
    tick: () => worker.tick(),
    stop: () => worker.stop(),
  };
}

class RoutedDurableRunRepository implements DurableRunRepository {
  private executionCursor = 0;
  private deliveryCursor = 0;

  constructor(
    private readonly base: DurableRunRepository,
    private readonly registrations: ReadonlyMap<string, DurableRunRegistration>,
  ) {}

  initialize(): Promise<void> { return this.base.initialize(); }
  create(request: DurableRunCreateRequest) {
    return requiredRegistration(this.registrations, request.workloadKind).repository.create(request);
  }
  get(runId: string): Promise<DurableRunRecord | null> { return this.base.get(runId); }
  getActiveByConcurrencyKey(key: string) { return this.base.getActiveByConcurrencyKey(key); }

  async claimDue(kinds: readonly string[], workerId: string, now: string, leaseExpiresAt: string) {
    const groups = repositoryGroups(this.registrations, kinds);
    const result = await roundRobin(groups, this.executionCursor, async (group) =>
      group.repository.claimDue(group.kinds, workerId, now, leaseExpiresAt));
    this.executionCursor = result.nextCursor;
    return result.value;
  }

  markExecutionStarted(claim: DurableRunClaim, now: string) {
    return this.repositoryForClaim(claim).markExecutionStarted(claim, now);
  }
  heartbeat(claim: DurableRunClaim, now: string, leaseExpiresAt: string) {
    return this.repositoryForClaim(claim).heartbeat(claim, now, leaseExpiresAt);
  }
  commitTransition(claim: DurableRunClaim, transition: DurableRunTransition, now: string) {
    return this.repositoryForClaim(claim).commitTransition(claim, transition, now);
  }
  failAttempt(
    claim: DurableRunClaim,
    failure: DurableRunFailure,
    now: string,
    transition?: DurableRunTransition,
  ): Promise<DurableRunClaimMutationResult> {
    return this.repositoryForClaim(claim).failAttempt(claim, failure, now, transition);
  }

  async recoverExpiredLeases(kinds: readonly string[], now: string): Promise<DurableRunInterruptedAttempt[]> {
    const groups = repositoryGroups(this.registrations, kinds);
    const recovered = await Promise.all(
      groups.map((group) => group.repository.recoverExpiredLeases(group.kinds, now)),
    );
    return recovered.flat();
  }

  async claimDelivery(kinds: readonly string[], workerId: string, now: string) {
    const groups = repositoryGroups(this.registrations, kinds);
    const result = await roundRobin(groups, this.deliveryCursor, async (group) =>
      group.repository.claimDelivery(group.kinds, workerId, now));
    this.deliveryCursor = result.nextCursor;
    return result.value;
  }

  commitDelivery(claim: DurableRunDeliveryClaim, result: DurableRunDeliveryResult, now: string) {
    return requiredRegistration(this.registrations, claim.workloadKind)
      .repository.commitDelivery(claim, result, now);
  }

  close(): void {
    // The storage owner closes the shared database after every worker stops.
  }

  private repositoryForClaim(claim: DurableRunClaim): DurableRunRepository {
    return requiredRegistration(this.registrations, claim.run.workloadKind).repository;
  }
}

interface RepositoryGroup {
  repository: DurableRunRepository;
  kinds: string[];
}

function repositoryGroups(
  registrations: ReadonlyMap<string, DurableRunRegistration>,
  kinds: readonly string[],
): RepositoryGroup[] {
  const groups = new Map<DurableRunRepository, string[]>();
  for (const kind of kinds) {
    const registration = requiredRegistration(registrations, kind);
    const entries = groups.get(registration.repository) ?? [];
    entries.push(kind);
    groups.set(registration.repository, entries);
  }
  return [...groups].map(([repository, groupedKinds]) => ({ repository, kinds: groupedKinds }));
}

async function roundRobin<T>(
  groups: readonly RepositoryGroup[],
  cursor: number,
  operation: (group: RepositoryGroup) => Promise<T | null>,
): Promise<{ value: T | null; nextCursor: number }> {
  if (groups.length === 0) return { value: null, nextCursor: 0 };
  for (let offset = 0; offset < groups.length; offset++) {
    const index = (cursor + offset) % groups.length;
    const value = await operation(groups[index]);
    if (value) return { value, nextCursor: (index + 1) % groups.length };
  }
  return { value: null, nextCursor: (cursor + 1) % groups.length };
}

function requiredRegistration(
  registrations: ReadonlyMap<string, DurableRunRegistration>,
  kind: string,
): DurableRunRegistration {
  const registration = registrations.get(kind);
  if (!registration) throw new Error(`Unknown Durable Run workload registration: ${kind}`);
  return registration;
}
