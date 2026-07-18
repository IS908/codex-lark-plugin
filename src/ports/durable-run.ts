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
} from '../domain/durable-run.js';

export interface DurableRunWorkload<Input = unknown, State = unknown, Result = unknown> {
  kind: string;
  parseInput(value: unknown, version: number): Input;
  parseState(value: unknown, version: number): State;
  preflight(run: DurableRunRecord): Promise<DurableRunPreflight>;
  execute(claim: DurableRunClaim, signal: AbortSignal): Promise<Result>;
  reduce(claim: DurableRunClaim, result: Result): DurableRunTransition;
  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition;
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
  recoverExpiredLeases(now: string): Promise<number>;
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
