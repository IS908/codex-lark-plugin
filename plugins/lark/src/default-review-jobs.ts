import {
  computeNextRun,
  createInitialJobRuntime,
  expandSchedule,
  jobExists,
  normalizeJobTimezone,
  writeJob,
  type JobFile,
} from './job-store.js';

export const DEFAULT_SELF_REVIEW_JOB_ID = 'plugin-self-review';
export const DEFAULT_LOW_RISK_FIX_JOB_ID = 'plugin-low-risk-auto-fix';

export interface CreateDefaultReviewJobsInput {
  targetRepo: string;
  targetChatId: string;
  originChatId: string;
  createdBy: string;
  timezone?: string;
  now?: Date;
}

export interface CreateDefaultReviewJobsResult {
  created: string[];
  skipped: string[];
  jobs: JobFile[];
}

function selfReviewPrompt(targetRepo: string): string {
  return [
    `Review repository ${targetRepo} for plugin user-experience problems and maintainability issues.`,
    'Send a concise Feishu report with created proposals, skipped findings, and maintainer decisions needed.',
    'For actionable findings, use create_issue_proposal instead of directly creating GitHub issues.',
    'Do not modify code, open PRs, merge, or release from this self-review job.',
  ].join('\n');
}

function lowRiskFixPrompt(targetRepo: string): string {
  return [
    `Review pending low-risk issue proposals for repository ${targetRepo}.`,
    'Only low-risk documentation, test-only, typo, or metadata consistency items may be prepared for PR work.',
    'Never modify Feishu message delivery, scheduler semantics, identity/permission logic, Codex exec action bridge behavior, dependencies, startup path, or release flow.',
    'Never merge PRs and never create releases. If unsure whether an item is low-risk, report it for maintainer authorization instead.',
  ].join('\n');
}

function buildJob(input: CreateDefaultReviewJobsInput, spec: {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
}, timezone: string, now: Date): JobFile {
  const expanded = expandSchedule(spec.schedule, timezone);
  const nextRunAt = computeNextRun(expanded.cron, timezone);
  return {
    meta: {
      id: spec.id,
      name: spec.name,
      type: 'prompt',
      schedule: expanded.cron,
      schedule_human: expanded.human,
      timezone,
      prompt: spec.prompt,
      target_chat_id: input.targetChatId,
      origin_chat_id: input.originChatId,
      status: 'paused',
      created_by: input.createdBy,
      created_at: now.toISOString(),
    },
    runtime: createInitialJobRuntime(nextRunAt),
  };
}

export async function createDefaultReviewJobs(input: CreateDefaultReviewJobsInput): Promise<CreateDefaultReviewJobsResult> {
  const timezone = normalizeJobTimezone(input.timezone);
  const now = input.now ?? new Date();
  const specs = [
    {
      id: DEFAULT_SELF_REVIEW_JOB_ID,
      name: 'Plugin Self Review',
      schedule: 'weekly on fri at 17:00',
      prompt: selfReviewPrompt(input.targetRepo),
    },
    {
      id: DEFAULT_LOW_RISK_FIX_JOB_ID,
      name: 'Plugin Low-Risk Auto Fix',
      schedule: 'weekly on fri at 18:00',
      prompt: lowRiskFixPrompt(input.targetRepo),
    },
  ];

  const result: CreateDefaultReviewJobsResult = { created: [], skipped: [], jobs: [] };
  for (const spec of specs) {
    if (await jobExists(spec.id)) {
      result.skipped.push(spec.id);
      const existing = buildJob(input, spec, timezone, now);
      existing.meta.status = 'paused';
      result.jobs.push(existing);
      continue;
    }
    const job = buildJob(input, spec, timezone, now);
    await writeJob(job);
    result.created.push(job.meta.id);
    result.jobs.push(job);
  }
  return result;
}
