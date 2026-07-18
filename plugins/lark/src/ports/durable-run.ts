import type {
  DurableRunClaim,
  DurableRunCreateRequest,
  DurableRunCreateResult,
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
  DurableRunFailure,
  DurableRunInterruptedAttempt,
  DurableRunPreflight,
  DurableRunRecord,
  DurableRunTransition,
  DurableRunWorkloadClaim,
  DurableRunWorkloadContext,
} from '../domain/durable-run.js';

export interface DurableRunWorkload<Input = unknown, State = unknown, Result = unknown> {
  kind: string;
  parseInput(value: unknown, version: number): Input;
  parseState(value: unknown, version: number): State;
  preflight(context: DurableRunWorkloadContext<Input, State>): Promise<DurableRunPreflight>;
  execute(claim: DurableRunWorkloadClaim<Input, State>, signal: AbortSignal): Promise<Result>;
  reduce(claim: DurableRunWorkloadClaim<Input, State>, result: Result): DurableRunTransition;
  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition;
}

export function materializeDurableRunWorkloadContext<Input, State>(
  workload: Pick<
    DurableRunWorkload<Input, State, unknown>,
    'kind' | 'parseInput' | 'parseState'
  >,
  run: DurableRunRecord,
): DurableRunWorkloadContext<Input, State> {
  if (workload.kind !== run.workloadKind) {
    throw new Error(
      `Durable run workload kind mismatch: expected ${run.workloadKind}, received ${workload.kind}`,
    );
  }
  const input = workload.parseInput(run.input, run.inputVersion);
  const state = workload.parseState(run.state, run.stateVersion);
  return { ...run, input, state };
}

export function materializeDurableRunWorkloadClaim<Input, State>(
  claim: DurableRunClaim,
  context: DurableRunWorkloadContext<Input, State>,
): DurableRunWorkloadClaim<Input, State> {
  if (claim.run.runId !== context.runId || claim.run.rowVersion !== context.rowVersion) {
    throw new Error('Durable run workload context does not match the claim.');
  }
  return { ...claim, run: context };
}

export interface DurableRunRepository {
  initialize(): Promise<void>;
  create(request: DurableRunCreateRequest): Promise<DurableRunCreateResult>;
  get(runId: string): Promise<DurableRunRecord | null>;
  claimDue(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<DurableRunClaim | null>;
  markExecutionStarted(claim: DurableRunClaim, now: string): Promise<void>;
  heartbeat(claim: DurableRunClaim, now: string, leaseExpiresAt: string): Promise<boolean>;
  commitTransition(
    claim: DurableRunClaim,
    transition: DurableRunTransition,
    now: string,
  ): Promise<void>;
  failAttempt(claim: DurableRunClaim, failure: DurableRunFailure, now: string): Promise<void>;
  recoverExpiredLeases(now: string): Promise<DurableRunInterruptedAttempt[]>;
  claimDelivery(
    workloadKinds: readonly string[],
    workerId: string,
    now: string,
  ): Promise<DurableRunDeliveryClaim | null>;
  commitDelivery(
    claim: DurableRunDeliveryClaim,
    result: DurableRunDeliveryResult,
    now: string,
  ): Promise<void>;
  close(): void;
}

export interface DurableRunDelivery {
  deliver(claim: DurableRunDeliveryClaim): Promise<DurableRunDeliveryResult>;
}

export interface DurableRunClock {
  now(): Date;
}
