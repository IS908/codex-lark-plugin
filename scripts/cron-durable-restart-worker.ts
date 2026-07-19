import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../src/config.js';
import { CronPromptWorkload } from '../src/cron/direct-exec-workload.js';
import { createCronDelivery } from '../src/cron/delivery.js';
import { CronRunAdmission } from '../src/cron/run-admission.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { DurableRunWorker } from '../src/durable-run/worker.js';
import { createInitialJobRuntime, readJob, writeJob, type JobFile } from '../src/job-store.js';
import type {
  DurableRunRepository,
} from '../src/ports/durable-run.js';

type CrashStage =
  | 'before-admission-commit'
  | 'after-run-commit-before-cursor'
  | 'after-claim-before-execution'
  | 'after-execution-started-before-attempt-commit'
  | 'after-attempt-outbox-commit-before-delivery'
  | 'after-send-before-delivery-commit';

const [mode, stageArg, root] = process.argv.slice(2);
const stage = stageArg as CrashStage;
const NOW = '2026-07-19T01:17:00.000Z';
const JOB_ID = 'durable-restart';

if (!root || !isStage(stage)) {
  throw new Error('Usage: cron-durable-restart-worker.ts <mode> <stage> <root>.');
}

(appConfig as { jobsDir: string }).jobsDir = join(root, 'jobs');

if (mode === 'crash') {
  await runCrash(stage, root);
} else if (mode === 'resume-admission') {
  await resumeAdmission(root);
} else if (mode === 'resume-worker') {
  await resumeWorker(stage, root);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}

async function runCrash(crashStage: CrashStage, sharedRoot: string): Promise<void> {
  await ensureJob();
  const repository = await SqliteDurableRunRepository.open({
    databasePath: databasePath(sharedRoot),
    deliveryLeaseMs: 100,
  });
  if (crashStage === 'before-admission-commit' || crashStage === 'after-run-commit-before-cursor') {
    const admission = new CronRunAdmission({
      runRepository: crashStage === 'before-admission-commit'
        ? interceptRepository(repository, { beforeCreate: () => checkpoint(crashStage) })
        : repository,
      ...(crashStage === 'after-run-commit-before-cursor'
        ? {
            jobRepository: {
              readJob,
              mutateJob: async () => checkpoint(crashStage),
            },
          }
        : {}),
    });
    const job = await requiredJob();
    await admission.admitScheduled(job, new Date(NOW));
    throw new Error('Crash stage did not suspend admission.');
  }

  const admission = new CronRunAdmission({ runRepository: repository });
  const result = await admission.admitScheduled(await requiredJob(), new Date(NOW));
  if (!result.admitted) throw new Error(`Expected admission before ${crashStage}; got ${result.reason}.`);
  await runCronWorker(repository, crashStage, sharedRoot, true);
  throw new Error('Crash stage did not suspend worker.');
}

async function resumeAdmission(sharedRoot: string): Promise<void> {
  const repository = await SqliteDurableRunRepository.open({ databasePath: databasePath(sharedRoot) });
  try {
    const result = await new CronRunAdmission({ runRepository: repository })
      .admitScheduled(await requiredJob(), new Date(NOW));
    if (!result.admitted) throw new Error(`Expected restart admission; got ${result.reason}.`);
  } finally {
    repository.close();
  }
  process.stdout.write('RESUME_COMPLETE\n');
}

async function resumeWorker(crashStage: CrashStage, sharedRoot: string): Promise<void> {
  const repository = await SqliteDurableRunRepository.open({
    databasePath: databasePath(sharedRoot),
    deliveryLeaseMs: 100,
  });
  try {
    await runCronWorker(repository, crashStage, sharedRoot, false);
  } finally {
    repository.close();
  }
  process.stdout.write('RESUME_COMPLETE\n');
}

async function runCronWorker(
  baseRepository: SqliteDurableRunRepository,
  crashStage: CrashStage,
  sharedRoot: string,
  crash: boolean,
): Promise<void> {
  const repository = crash
    ? interceptRepository(baseRepository, {
        beforeMarkExecutionStarted: crashStage === 'after-claim-before-execution'
          ? () => checkpoint(crashStage)
          : undefined,
        afterCommitTransition: crashStage === 'after-attempt-outbox-commit-before-delivery'
          ? () => checkpoint(crashStage)
          : undefined,
      })
    : baseRepository;
  const workload = new CronPromptWorkload({
    executor: async (input) => {
      await appendFile(join(sharedRoot, 'executions.log'), `${input.runId}\n`, 'utf8');
      if (crash && crashStage === 'after-execution-started-before-attempt-commit') {
        await checkpoint(crashStage);
      }
      return successfulExecution(input.runId);
    },
  });
  const delivery = createCronDelivery({
    sendReply: async (request) => {
      const runId = await onlyRunId(baseRepository);
      const expectedKey = `cron:${runId}:terminal`;
      if (request.idempotencyKey !== expectedKey) {
        throw new Error(`Expected stable delivery key ${expectedKey}; got ${request.idempotencyKey ?? '(missing)'}.`);
      }
      await appendFile(join(sharedRoot, 'delivery-attempts.log'), `${request.idempotencyKey}\n`, 'utf8');
      await recordConfirmedDelivery(sharedRoot, request.idempotencyKey);
      if (crash && crashStage === 'after-send-before-delivery-commit') {
        await checkpoint(crashStage);
      }
      return {
        isError: false,
        sentCount: 1,
        messageIds: ['om_durable_restart'],
      };
    },
    now: () => new Date(NOW),
  });
  const worker = new DurableRunWorker({
    repository,
    workloads: [workload],
    delivery,
    clock: { now: () => new Date(NOW) },
    maxConcurrencyByWorkload: { cron_prompt: 1 },
    scanIntervalMs: 10,
    heartbeatIntervalMs: 20,
    leaseDurationMs: 100,
    workerId: crash ? 'crashing-cron-worker' : 'restarted-cron-worker',
  });
  if (crash) {
    setInterval(() => {}, 1_000);
    await worker.tick();
    await new Promise<never>(() => {});
  }
  worker.start();
  await waitFor(async () => {
    const run = await baseRepository.get(await onlyRunId(baseRepository));
    return Boolean(
      run
      && (run.status === 'completed' || run.status === 'blocked' || run.status === 'failed')
      && outboxIsTerminal(sharedRoot),
    );
  });
  await worker.stop();
}

function interceptRepository(
  base: DurableRunRepository,
  hooks: {
    beforeCreate?: () => Promise<never>;
    beforeMarkExecutionStarted?: () => Promise<never>;
    afterCommitTransition?: () => Promise<never>;
  },
): DurableRunRepository {
  return {
    initialize: () => base.initialize(),
    create: async (request) => {
      if (hooks.beforeCreate) await hooks.beforeCreate();
      return base.create(request);
    },
    get: (runId) => base.get(runId),
    getActiveByConcurrencyKey: (key) => base.getActiveByConcurrencyKey(key),
    claimDue: (kinds, workerId, now, leaseExpiresAt) => base.claimDue(kinds, workerId, now, leaseExpiresAt),
    markExecutionStarted: async (claim, now) => {
      if (hooks.beforeMarkExecutionStarted) await hooks.beforeMarkExecutionStarted();
      return base.markExecutionStarted(claim, now);
    },
    heartbeat: (claim, now, leaseExpiresAt) => base.heartbeat(claim, now, leaseExpiresAt),
    commitTransition: async (claim, transition, now) => {
      const result = await base.commitTransition(claim, transition, now);
      if (result === 'committed' && hooks.afterCommitTransition) await hooks.afterCommitTransition();
      return result;
    },
    failAttempt: (claim, failure, now, transition) => base.failAttempt(claim, failure, now, transition),
    recoverExpiredLeases: (kinds, now) => base.recoverExpiredLeases(kinds, now),
    claimDelivery: (kinds, workerId, now) => base.claimDelivery(kinds, workerId, now),
    markDeliveryStarted: (claim, now) => base.markDeliveryStarted(claim, now),
    commitDelivery: (claim, result, now) => base.commitDelivery(claim, result, now),
    close: () => {},
  };
}

async function ensureJob(): Promise<void> {
  if (await readJob(JOB_ID)) return;
  await writeJob({
    meta: {
      id: JOB_ID,
      revision: 1,
      name: 'Durable restart smoke',
      type: 'prompt',
      schedule: '*/5 * * * *',
      schedule_human: 'every 5m',
      timezone: 'UTC',
      prompt: 'Produce the durable restart smoke report.',
      target_chat_id: 'oc_durable_restart',
      origin_chat_id: 'oc_durable_restart_origin',
      status: 'active',
      created_by: 'ou_durable_restart',
      created_at: '2026-07-19T00:00:00.000Z',
    },
    runtime: createInitialJobRuntime('2026-07-19T01:00:00.000Z'),
  } satisfies JobFile);
}

async function requiredJob(): Promise<JobFile> {
  const job = await readJob(JOB_ID);
  if (!job) throw new Error('Expected durable restart smoke job.');
  return job;
}

function successfulExecution(runId: string) {
  return {
    report: `Durable restart report for ${runId}.`,
    runStatus: 'success' as const,
    failureReason: null,
    diagnostics: {
      run_id: runId,
      job_id: JOB_ID,
      job_name: 'Durable restart smoke',
      schedule: '*/5 * * * *',
      timezone: 'UTC',
      timeout_ms: 0,
      started_at: NOW,
      ended_at: NOW,
      duration_ms: 0,
      status: 'success' as const,
      stages: [],
    },
  };
}

async function recordConfirmedDelivery(sharedRoot: string, idempotencyKey: string): Promise<void> {
  const path = join(sharedRoot, 'deliveries.log');
  try {
    const existing = await readFile(path, 'utf8');
    if (existing.split('\n').includes(idempotencyKey)) return;
  } catch {
    // The first confirmed delivery creates the log.
  }
  await appendFile(path, `${idempotencyKey}\n`, 'utf8');
}

async function onlyRunId(_repository: DurableRunRepository): Promise<string> {
  const database = new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    const row = database.prepare('SELECT run_id AS runId FROM durable_runs LIMIT 1').get() as
      | { runId: string }
      | undefined;
    if (!row?.runId) throw new Error('Expected one durable Cron Run.');
    return row.runId;
  } finally {
    database.close();
  }
}

function outboxIsTerminal(sharedRoot: string): boolean {
  const database = new DatabaseSync(databasePath(sharedRoot), { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT status
      FROM durable_outbox
      ORDER BY created_at
      LIMIT 1
    `).get() as { status: string } | undefined;
    return row?.status === 'sent' || row?.status === 'unknown';
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for durable Cron restart recovery.');
}

async function checkpoint(checkpointStage: CrashStage): Promise<never> {
  process.stdout.write(`CRASH_READY:${checkpointStage}\n`);
  setInterval(() => {}, 1_000);
  return new Promise<never>(() => {});
}

function databasePath(sharedRoot: string): string {
  return join(sharedRoot, 'durable-runs.sqlite');
}

function isStage(value: string | undefined): value is CrashStage {
  return value === 'before-admission-commit'
    || value === 'after-run-commit-before-cursor'
    || value === 'after-claim-before-execution'
    || value === 'after-execution-started-before-attempt-commit'
    || value === 'after-attempt-outbox-commit-before-delivery'
    || value === 'after-send-before-delivery-commit';
}
