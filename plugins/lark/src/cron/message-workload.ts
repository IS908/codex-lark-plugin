import type {
  DurableRunDeliveryRequest,
  DurableRunInterruptedAttempt,
  DurableRunPreflight,
  DurableRunTransition,
  DurableRunWorkloadClaim,
  DurableRunWorkloadContext,
} from '../domain/durable-run.js';
import type { DurableRunWorkload } from '../ports/durable-run.js';
import {
  CRON_RUN_STATE_VERSION,
  completedCronStatePreflight,
  parseCronRunInput,
  parseCronRunState,
  type CronMessageExecution,
  type CronRunInput,
  type CronRunState,
  type CronTerminalPayload,
} from './contracts.js';

export class CronMessageWorkload implements DurableRunWorkload<CronRunInput, CronRunState, CronMessageExecution> {
  readonly kind = 'cron_message';

  parseInput(value: unknown, version: number): CronRunInput {
    return parseCronRunInput(value, version, 'message');
  }

  parseState(value: unknown, version: number): CronRunState {
    return parseCronRunState(value, version);
  }

  async preflight(
    context: DurableRunWorkloadContext<CronRunInput, CronRunState>,
  ): Promise<DurableRunPreflight> {
    return completedCronStatePreflight(context.state) ?? { action: 'execute' };
  }

  async execute(
    claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
    signal: AbortSignal,
  ): Promise<CronMessageExecution> {
    signal.throwIfAborted();
    const job = claim.run.input.job;
    if (job.type !== 'message' || !job.content?.trim()) {
      throw new Error('Cron message content must not be empty.');
    }
    return { content: job.content, messageType: job.messageType ?? 'text' };
  }

  reduce(
    claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
    execution: CronMessageExecution,
  ): DurableRunTransition {
    return {
      status: 'completed',
      stateVersion: CRON_RUN_STATE_VERSION,
      state: {
        schemaVersion: 1,
        phase: 'completed',
        commit: { kind: 'message', ...execution },
      } satisfies CronRunState,
      attempt: { outcome: 'success', operationRisk: 'pure' },
      deliveries: [messageDelivery(claim, execution)],
    };
  }

  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition {
    return {
      status: 'recovering',
      stateVersion: context.claim.run.stateVersion,
      state: context.claim.run.state,
      nextRunAt: context.recoveredAt,
      attempt: { outcome: 'interrupted_pure', operationRisk: 'pure' },
    };
  }
}

function messageDelivery(
  claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
  execution: CronMessageExecution,
): DurableRunDeliveryRequest {
  const job = claim.run.input.job;
  const payload: CronTerminalPayload = {
    schemaVersion: 1,
    kind: 'message',
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    jobRevision: job.revision,
    content: execution.content,
    messageType: execution.messageType,
  };
  return {
    kind: 'cron_terminal',
    attemptId: claim.attempt.attemptId,
    idempotencyKey: `cron:${claim.run.runId}:terminal`,
    route: claim.run.route,
    payload,
  };
}
