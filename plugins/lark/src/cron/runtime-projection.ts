import type { DurableRunDeliveryClaim, DurableRunDeliveryResult } from '../domain/durable-run.js';
import { mutateJob } from '../job-store.js';
import type { CronTerminalPayload } from './contracts.js';

export interface CronDeliveryRoute {
  kind: 'cron_job';
  targetChatId: string;
  originChatId: string;
  jobId: string;
  createdAt: string;
  revision: number;
}

export interface CronRuntimeProjectionRepository {
  mutateJob: typeof mutateJob;
}

export async function projectCronDeliveryPending(
  claim: Pick<DurableRunDeliveryClaim, 'runId'>,
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
  now: string,
  repository: CronRuntimeProjectionRepository = { mutateJob },
): Promise<boolean> {
  let applied = false;
  await repository.mutateJob(route.jobId, (job) => {
    if (!matchesProjection(job, route, claim.runId)) return false;
    if (job.runtime.delivery_status === null || job.runtime.delivery_status === undefined) {
      job.runtime.run_count += 1;
      job.runtime.last_run_at = now;
    }
    job.runtime.run_status = payload.runStatus;
    job.runtime.output_status = 'generated';
    job.runtime.delivery_status = 'pending';
    job.runtime.report = payload.kind === 'report' ? payload.report : payload.content;
    job.runtime.report_type = payload.kind === 'report' ? payload.reportType : 'job_message';
    job.runtime.delivery_error = null;
    job.runtime.last_error = payload.runStatus === 'failed'
      ? payload.failureReason ?? 'CronJob execution failed.'
      : null;
    job.runtime.diagnostics = payload.kind === 'report' ? payload.diagnostics : null;
    applied = true;
  });
  return applied;
}

export async function projectCronDeliveryResult(
  claim: Pick<DurableRunDeliveryClaim, 'runId'>,
  route: CronDeliveryRoute,
  payload: CronTerminalPayload,
  result: DurableRunDeliveryResult,
  repository: CronRuntimeProjectionRepository = { mutateJob },
): Promise<boolean> {
  let applied = false;
  await repository.mutateJob(route.jobId, (job) => {
    if (!matchesProjection(job, route, claim.runId)) return false;
    if (result.status === 'retry') {
      job.runtime.delivery_status = 'pending';
      job.runtime.delivery_error = result.errorSummary;
    } else if (result.status === 'sent') {
      job.runtime.delivery_status = 'sent';
      job.runtime.delivery_error = null;
    } else if (result.status === 'superseded') {
      job.runtime.delivery_status = 'failed';
      job.runtime.delivery_error = 'CronJob delivery was superseded.';
    } else {
      job.runtime.delivery_status = 'failed';
      job.runtime.delivery_error = result.errorSummary;
    }
    if (payload.runStatus === 'failed') {
      job.runtime.last_error = payload.failureReason ?? 'CronJob execution failed.';
    }
    applied = true;
  });
  return applied;
}

export async function autoPauseCronJobForDeliveryFailure(
  route: CronDeliveryRoute,
  reason: string,
  repository: CronRuntimeProjectionRepository = { mutateJob },
  runId?: string,
): Promise<boolean> {
  let applied = false;
  await repository.mutateJob(route.jobId, (job) => {
    if (
      job.meta.created_at !== route.createdAt
      || job.meta.revision !== route.revision
      || job.meta.status !== 'active'
      || (runId !== undefined && job.runtime.run_id !== runId)
    ) return false;
    job.meta.status = 'paused';
    job.runtime.last_error = `${reason} (auto-paused: permanent target error)`;
    applied = true;
  });
  return applied;
}

function matchesProjection(
  job: Parameters<Parameters<typeof mutateJob>[1]>[0],
  route: CronDeliveryRoute,
  runId: string,
): boolean {
  return job.meta.id === route.jobId
    && job.meta.created_at === route.createdAt
    && job.meta.revision === route.revision
    && job.runtime.run_id === runId;
}
