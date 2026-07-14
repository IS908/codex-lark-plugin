import { createHash } from 'node:crypto';

/**
 * Prefix for synthetic `thread_id` values used by cronjob prompt executions.
 * Used only for IdentitySession isolation per cronjob run; it is not a real
 * Feishu thread.
 */
export const JOB_THREAD_PREFIX = 'job-';

export interface ParsedJobThreadId {
  jobId: string;
  createdAtHash?: string;
  runId?: string;
}

export function jobCreatedAtHash(createdAt: string): string {
  return createHash('sha256').update(createdAt).digest('hex').slice(0, 12);
}

export function parseJobThreadId(threadId: string | undefined): ParsedJobThreadId | null {
  if (!threadId?.startsWith(JOB_THREAD_PREFIX)) return null;
  const rest = threadId.slice(JOB_THREAD_PREFIX.length);
  const current = rest.match(/^(.+)-([a-f0-9]{12})-(\d{10,})$/);
  if (current) return { jobId: current[1], createdAtHash: current[2], runId: current[3] };
  const legacy = rest.match(/^(.+)-(\d{10,})$/);
  return legacy ? { jobId: legacy[1] } : null;
}

export function parseJobIdFromThreadId(threadId: string | undefined): string | null {
  return parseJobThreadId(threadId)?.jobId ?? null;
}
