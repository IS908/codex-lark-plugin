/**
 * Job Store — CRUD operations for cronjob JSON files.
 *
 * Each job is stored as a separate JSON file at {jobsDir}/{id}.json.
 * The file contains a { meta, runtime } structure separating user-defined
 * configuration from system-managed execution state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { appConfig } from './config.js';

// ─── Types ──────────────────────────────────────────────────

export interface JobMeta {
  id: string;
  name: string;
  type: 'prompt' | 'message';
  schedule: string;
  schedule_human: string;
  prompt?: string;
  content?: string;
  msg_type?: string;
  /** Chat that receives the job output. Used by scheduler delivery + list_jobs visibility filter. */
  target_chat_id: string;
  /** Where the job was created (debug/audit). For legacy jobs, backfilled from target_chat_id. */
  origin_chat_id: string;
  /** Optional model override for prompt-type jobs. Passed in notification meta so Codex can dispatch with a supported model id. */
  model?: string;
  status: 'active' | 'paused';
  created_by: string;
  created_at: string;
}

export interface JobRuntime {
  last_run_at: string | null;
  next_run_at: string;
  run_count: number;
  last_error: string | null;
}

export interface JobFile {
  meta: JobMeta;
  runtime: JobRuntime;
}

// ─── ID Sanitization ────────────────────────────────────────

export function sanitizeJobId(input: string): string {
  const id = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return id || `job-${Date.now()}`;
}

// ─── Schedule Alias Expansion ───────────────────────────────

const DAY_MAP: Record<string, string> = {
  sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6',
  sunday: '0', monday: '1', tuesday: '2', wednesday: '3',
  thursday: '4', friday: '5', saturday: '6',
};

export const SUPPORTED_SCHEDULE_FORMAT_HINT =
  'Use a supported recurring format such as "daily at 09:00", "weekdays at 09:00", ' +
  '"weekly on mon at 09:00", "every 5m", "every 2h", or a 5-field cron expression like "0 9 * * *".';

function assertNotUnsupportedOneOffSchedule(trimmed: string): void {
  const oneOffAlias = /^(once|now|later)$/i;
  const relativeOneOff = /^(today|tomorrow)\s+at\s+\d{1,2}:\d{2}$/i;
  const absoluteTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/;
  if (oneOffAlias.test(trimmed) || relativeOneOff.test(trimmed) || absoluteTimestamp.test(trimmed)) {
    throw new Error(`unsupported schedule "${trimmed}": one-off schedules are not supported yet. ${SUPPORTED_SCHEDULE_FORMAT_HINT}`);
  }
}

/**
 * Expand a human-friendly schedule alias to a standard 5-field cron expression.
 * If the input is already a valid cron expression, returns it as-is.
 * Returns { cron, human } where human is the display label.
 */
export function expandSchedule(input: string): { cron: string; human: string } {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('schedule is required');
  }
  assertNotUnsupportedOneOffSchedule(trimmed);
  let result: { cron: string; human: string } | null = null;

  // every Nm
  let match = trimmed.match(/^every\s+(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (match) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      throw new Error('every Nm must be between 1m and 60m');
    }
    if (60 % n !== 0) {
      throw new Error('every Nm must divide evenly into 60 minutes');
    }
    result = { cron: `*/${n} * * * *`, human: `every ${n}m` };
  }

  // every Nh
  if (!result) {
    match = trimmed.match(/^every\s+(\d+)\s*h(?:ours?)?$/);
    if (match) {
      const n = Number(match[1]);
      if (!Number.isInteger(n) || n < 1 || n > 24) {
        throw new Error('every Nh must be between 1h and 24h');
      }
      if (24 % n !== 0) {
        throw new Error('every Nh must divide evenly into 24 hours');
      }
      result = { cron: `0 */${n} * * *`, human: `every ${n}h` };
    }
  }

  // daily at HH:MM
  if (!result) {
    match = trimmed.match(/^daily\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, h, m] = match;
      result = { cron: `${parseInt(m)} ${parseInt(h)} * * *`, human: `daily at ${h}:${m}` };
    }
  }

  // weekdays at HH:MM
  if (!result) {
    match = trimmed.match(/^weekdays\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, h, m] = match;
      result = { cron: `${parseInt(m)} ${parseInt(h)} * * 1-5`, human: `weekdays at ${h}:${m}` };
    }
  }

  // weekly on {day} at HH:MM
  if (!result) {
    match = trimmed.match(/^weekly\s+on\s+(\w+)\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, day, h, m] = match;
      const dayNum = DAY_MAP[day];
      if (dayNum !== undefined) {
        result = { cron: `${parseInt(m)} ${parseInt(h)} * * ${dayNum}`, human: `weekly on ${day} at ${h}:${m}` };
      }
    }
  }

  // Fallback: treat input as a raw cron expression
  if (!result) {
    result = { cron: trimmed, human: trimmed };
  }

  // Parse the final cron against the configured timezone to validate syntax.
  // Bad cron syntax throws immediately; invalid LARK_CRON_TIMEZONE values
  // only fail later when computeNextRun() calls .next() on the expression,
  // but create_job always calls computeNextRun after expandSchedule, so both
  // classes of error surface at create_job time (not at scheduler-tick time).
  CronExpressionParser.parse(result.cron, { tz: appConfig.cronTimezone });

  return result;
}

/**
 * Compute the next run time from a cron expression.
 * Uses the configured timezone (LARK_CRON_TIMEZONE) so cron hours
 * always match the user's local wall-clock time.
 */
export function computeNextRun(cronExpr: string): string {
  const expr = CronExpressionParser.parse(cronExpr, { tz: appConfig.cronTimezone });
  return expr.next().toISOString()!;
}

/**
 * Compute the latest scheduled occurrence at or before `now`.
 *
 * Used by crash recovery for jobs that may have missed many intervals while
 * the daemon was offline. Adding 1ms makes exact-boundary timestamps inclusive
 * because cron-parser's `prev()` is exclusive of `currentDate`.
 */
export function computeLatestDueRun(cronExpr: string, now: Date = new Date()): string {
  const inclusiveNow = new Date(now.getTime() + 1);
  const expr = CronExpressionParser.parse(cronExpr, {
    tz: appConfig.cronTimezone,
    currentDate: inclusiveNow,
  });
  return expr.prev().toISOString()!;
}

// ─── CRUD ───────────────────────────────────────────────────

async function ensureJobsDir(): Promise<string> {
  const dir = appConfig.jobsDir;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function jobPath(id: string): string {
  return path.join(appConfig.jobsDir, `${id}.json`);
}

function canonicalJobIdFromFile(file: string): string {
  return path.basename(file, '.json');
}

const jobWriteQueues = new Map<string, Promise<void>>();

async function withJobWriteQueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = jobWriteQueues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  jobWriteQueues.set(id, queued);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (jobWriteQueues.get(id) === queued) {
      jobWriteQueues.delete(id);
    }
  }
}

function applyCanonicalJobId(job: JobFile, id: string, source: string): JobFile {
  if (job.meta.id && job.meta.id !== id) {
    console.error(
      `[job-store] Using filename id "${id}" for ${source}; file meta.id="${job.meta.id}" is stale.`,
    );
  }
  job.meta.id = id;
  return job;
}

/**
 * Backfill new fields on pre-v0.9 jobs so the rest of the code can rely on them.
 * Exported for unit testing; production callers should use readJob / listAllJobs.
 *
 * Handles in-field transitions from earlier releases:
 *   - Pre-v0.9 jobs lack origin_chat_id. Backfill from target_chat_id.
 *   - Pre-v0.9 jobs often have empty created_by. Attribute to LARK_OWNER_OPEN_ID
 *     so the operator retains update/delete rights after upgrade.
 *
 * v0.9.0 also introduced a short-lived `send_chat_id` field (identical to
 * target_chat_id). v0.11.1 drops it — any job file still carrying the key
 * is handled by a cast-aware read below, then forgotten on next write.
 */
export function backfillJob(job: JobFile): JobFile {
  // Resurrect target_chat_id from the dropped v0.9-v0.11.0 send_chat_id field
  // if a job file was written by one of those releases and target_chat_id is
  // somehow missing. Then drop the legacy field so it doesn't get persisted
  // back on the next write — prevents permanent ghost-field pollution of
  // operators' job JSON files.
  const legacy = job.meta as unknown as { send_chat_id?: string };
  if (!job.meta.target_chat_id && legacy.send_chat_id) {
    job.meta.target_chat_id = legacy.send_chat_id;
  }
  if (legacy.send_chat_id !== undefined) {
    delete legacy.send_chat_id;
  }

  if (!job.meta.origin_chat_id) job.meta.origin_chat_id = job.meta.target_chat_id;

  // Legacy jobs may have empty created_by (the old create_job defaulted to '').
  // Without a valid owner, update_job / delete_job would permanently reject
  // every caller. Attribute to the operator via LARK_OWNER_OPEN_ID so the
  // person running the upgrade can still manage them. If LARK_OWNER_OPEN_ID
  // is unset, we leave the field empty — operator can set it and restart.
  if (!job.meta.created_by && appConfig.ownerOpenId) {
    job.meta.created_by = appConfig.ownerOpenId;
  }
  return job;
}

export async function readJob(id: string): Promise<JobFile | null> {
  return readJobUnlocked(id);
}

async function readJobUnlocked(id: string): Promise<JobFile | null> {
  try {
    const data = await fs.readFile(jobPath(id), 'utf-8');
    return applyCanonicalJobId(backfillJob(JSON.parse(data) as JobFile), id, `${id}.json`);
  } catch {
    return null;
  }
}

/**
 * Persist a JobFile to disk under `{jobsDir}/{job.meta.id}.json`.
 *
 * The filename is the canonical job id when reading. writeJob is still a
 * full-file overwrite for new jobs or deliberate whole-job rewrites; callers
 * that update an existing job should prefer mutateJob so concurrent runtime
 * writes do not clobber user-edited metadata.
 */
export async function writeJob(job: JobFile): Promise<void> {
  await withJobWriteQueue(job.meta.id, () => writeJobUnlocked(job));
}

async function writeJobUnlocked(job: JobFile): Promise<void> {
  await ensureJobsDir();
  await fs.writeFile(jobPath(job.meta.id), JSON.stringify(job, null, 2), 'utf-8');
}

export async function mutateJob(
  id: string,
  mutate: (job: JobFile) => void | false | Promise<void | false>,
): Promise<JobFile | null> {
  return withJobWriteQueue(id, async () => {
    const job = await readJobUnlocked(id);
    if (!job) return null;
    const shouldContinue = await mutate(job);
    if (shouldContinue === false) return job;
    await writeJobUnlocked(job);
    return job;
  });
}

export async function deleteJob(id: string): Promise<boolean> {
  return withJobWriteQueue(id, async () => {
    try {
      await fs.unlink(jobPath(id));
      return true;
    } catch {
      return false;
    }
  });
}

export async function listAllJobs(): Promise<JobFile[]> {
  const dir = appConfig.jobsDir;
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  // Read all files in parallel — was sequential awaits in v1.0.6 and
  // earlier, which made list_jobs / scheduler tick O(N × per-file latency).
  // Negligible at typical scale (<10 jobs) but linear-bad once cronjob
  // counts grow. Promise.all with Promise.allSettled-style per-file
  // error handling preserves the "one bad file doesn't break the rest"
  // semantics of the original loop. See #64.
  const results = await Promise.all(
    jsonFiles.map(async (file): Promise<JobFile | null> => {
      try {
        const data = await fs.readFile(path.join(dir, file), 'utf-8');
        const id = canonicalJobIdFromFile(file);
        return applyCanonicalJobId(backfillJob(JSON.parse(data) as JobFile), id, file);
      } catch (err: any) {
        // Distinguish three failure modes so the operator's log signal
        // matches the actual cause (#64):
        //   - ENOENT: file vanished between readdir and readFile (benign
        //     race with concurrent deleteJob). Silent skip — the file is
        //     legitimately gone, which is the desired state.
        //   - SyntaxError: JSON parse failed. Genuinely corrupt.
        //   - Other (EACCES, EISDIR, etc.): unreadable for an unexpected
        //     reason. Operator should investigate.
        if (err?.code === 'ENOENT') return null;
        if (err instanceof SyntaxError) {
          console.error(`[job-store] Skipping corrupt job file ${file} (invalid JSON):`, err.message);
        } else {
          console.error(`[job-store] Skipping unreadable job file ${file}:`, err?.message ?? err);
        }
        return null;
      }
    }),
  );

  return results.filter((j): j is JobFile => j !== null);
}

export async function jobExists(id: string): Promise<boolean> {
  try {
    await fs.access(jobPath(id));
    return true;
  } catch {
    return false;
  }
}
