import { appConfig } from './config.js';
import type { JobMeta } from './job-contracts.js';

export function normalizeJobTimezone(input?: string | null): string {
  const timezone = (input ?? appConfig.cronTimezone).trim();
  if (!timezone) throw new Error('timezone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid timezone "${timezone}". Use an IANA timezone such as "Asia/Shanghai", "Asia/Tokyo", or "UTC".`);
  }
  return timezone;
}

export function jobTimezone(job: Pick<JobMeta, 'timezone'>): string {
  return normalizeJobTimezone(job.timezone);
}
