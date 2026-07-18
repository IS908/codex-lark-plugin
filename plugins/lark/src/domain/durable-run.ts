export type DurableRunFailureCategory =
  | 'invalid_invocation'
  | 'transient'
  | 'authentication_required'
  | 'permission_required'
  | 'capability_unavailable'
  | 'terminal'
  | 'unknown';

export type DurableRunRetrySafety = 'safe' | 'unsafe' | 'unknown';

export type DurableRunOperationRisk =
  | 'pure'
  | 'read_only'
  | 'idempotent_write'
  | 'external_side_effect'
  | 'unknown';

export interface DurableRunFailure {
  category: DurableRunFailureCategory;
  retrySafety: DurableRunRetrySafety;
  capabilityAvailable: boolean;
  operationRisk: DurableRunOperationRisk;
  hints: string[];
  failedStep: string;
  diagnostic: string;
  fingerprint: string;
}

export interface DurableRunRecoveryBudget {
  fingerprintAttempts: number;
  totalAttempts: number;
  maxFingerprintAttempts: number;
  maxTotalAttempts: number;
}

export type DurableRunRecoveryDecision =
  | {
      action: 'retry';
      status: 'recovering';
      delaySeconds: number;
      reason: string;
    }
  | {
      action: 'wait_user';
      status: 'waiting_user';
      prompt: string;
      reason: string;
    }
  | {
      action: 'block';
      status: 'blocked';
      reason: string;
    }
  | {
      action: 'fail';
      status: 'failed';
      reason: string;
    };
