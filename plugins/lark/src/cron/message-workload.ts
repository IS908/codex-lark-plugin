import type {
  DurableRunDeliveryRequest,
  DurableRunInterruptedAttempt,
  DurableRunPreflight,
  DurableRunRecord,
  DurableRunTransition,
  DurableRunWorkloadClaim,
  DurableRunWorkloadContext,
} from '../domain/durable-run.js';
import type {
  DurableRunPersistedStateFailure,
  DurableRunUnclaimableReason,
  DurableRunWorkload,
} from '../ports/durable-run.js';
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
    return {
      content: job.content,
      messageType: job.messageType ?? 'text',
      runStatus: 'success',
      failureReason: null,
    };
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
      deliveries: [messageDelivery(claim, claim.run.input, execution)],
    };
  }

  recoverInterruptedAttempt(context: DurableRunInterruptedAttempt): DurableRunTransition {
    if (context.claim.attempt.ordinal >= context.claim.run.maxAttempts) {
      const input = this.parseInput(
        context.claim.run.input,
        context.claim.run.inputVersion,
      );
      const reason = 'The CronJob exhausted its execution attempt budget before the message could be committed.';
      const execution: CronMessageExecution = {
        content: `CronJob "${input.job.name}" failed.\n\nJob ID: ${input.job.id}\nReason: ${reason}`,
        messageType: 'text',
        runStatus: 'failed',
        failureReason: reason,
      };
      return {
        status: 'failed',
        stateVersion: CRON_RUN_STATE_VERSION,
        state: {
          schemaVersion: 1,
          phase: 'completed',
          commit: { kind: 'message', ...execution },
        } satisfies CronRunState,
        errorCode: 'cron_attempts_exhausted',
        errorSummary: reason,
        attempt: {
          outcome: 'attempts_exhausted',
          operationRisk: 'pure',
          errorCode: 'cron_attempts_exhausted',
          errorSummary: reason,
        },
        deliveries: [messageDelivery(context.claim, input, execution)],
      };
    }
    return {
      status: 'recovering',
      stateVersion: context.claim.run.stateVersion,
      state: context.claim.run.state,
      nextRunAt: context.recoveredAt,
      attempt: { outcome: 'interrupted_pure', operationRisk: 'pure' },
    };
  }

  terminalizeExpiredAttempt(
    claim: DurableRunWorkloadClaim<CronRunInput, CronRunState>,
  ): DurableRunTransition {
    const reason = 'The CronJob reached its maximum run age before the message could be committed.';
    const execution = failedMessageExecution(claim.run.input, reason);
    return {
      status: 'failed',
      stateVersion: CRON_RUN_STATE_VERSION,
      state: {
        schemaVersion: 1,
        phase: 'completed',
        commit: { kind: 'message', ...execution },
      } satisfies CronRunState,
      errorCode: 'cron_run_expired',
      errorSummary: reason,
      attempt: {
        outcome: 'expired',
        operationRisk: 'pure',
        errorCode: 'cron_run_expired',
        errorSummary: reason,
      },
      deliveries: [messageDelivery(claim, claim.run.input, execution)],
    };
  }

  terminalizeUnclaimable(
    run: DurableRunRecord,
    reason: DurableRunUnclaimableReason,
  ): DurableRunPersistedStateFailure {
    const input = this.parseInput(run.input, run.inputVersion);
    const detail = reason === 'expired'
      ? 'The CronJob reached its maximum run age before the message could be committed.'
      : 'The CronJob exhausted its execution attempt budget before the message could be committed.';
    const execution = failedMessageExecution(input, detail);
    return {
      errorCode: reason === 'expired' ? 'cron_run_expired' : 'cron_attempts_exhausted',
      errorSummary: detail,
      stateVersion: CRON_RUN_STATE_VERSION,
      state: {
        schemaVersion: 1,
        phase: 'completed',
        commit: { kind: 'message', ...execution },
      } satisfies CronRunState,
      deliveries: [messageDelivery({ run }, input, execution)],
    };
  }
}

function failedMessageExecution(input: CronRunInput, reason: string): CronMessageExecution {
  return {
    content: `CronJob "${input.job.name}" failed.\n\nJob ID: ${input.job.id}\nReason: ${reason}`,
    messageType: 'text',
    runStatus: 'failed',
    failureReason: reason,
  };
}

function messageDelivery(
  claim: { run: { runId: string; route: unknown }; attempt?: { attemptId: string } },
  input: CronRunInput,
  execution: CronMessageExecution,
): DurableRunDeliveryRequest {
  const job = input.job;
  const payload: CronTerminalPayload = {
    schemaVersion: 1,
    kind: 'message',
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    jobRevision: job.revision,
    content: execution.content,
    messageType: execution.messageType,
    runStatus: execution.runStatus,
    failureReason: execution.failureReason,
  };
  return {
    kind: 'cron_terminal',
    ...(claim.attempt ? { attemptId: claim.attempt.attemptId } : {}),
    idempotencyKey: `cron:${claim.run.runId}:terminal`,
    route: claim.run.route,
    payload,
  };
}
