import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContinuationClock, ContinuationExecutor } from '../src/ports/continuation.js';
import { createContinuationRuntime } from '../src/continuation/runtime.js';

const mode = process.argv[2];
const sharedRoot = process.argv[3];
if (mode === '--checkpoint-child' && sharedRoot) {
  await runCheckpointChild(sharedRoot);
} else if (mode === '--resume-child' && sharedRoot) {
  await runResumeChild(sharedRoot);
} else {
  await runParent();
}

async function runParent(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'continuation-restart-'));
  const checkpointChild = spawn(process.execPath, [
    '--import',
    'tsx',
    new URL(import.meta.url).pathname,
    '--checkpoint-child',
    root,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForOutput(checkpointChild, 'CHECKPOINT_COMMITTED');
  checkpointChild.kill('SIGKILL');
  await waitForExit(checkpointChild);

  const resumeChild = spawn(process.execPath, [
    '--import',
    'tsx',
    new URL(import.meta.url).pathname,
    '--resume-child',
    root,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = await collectOutput(resumeChild);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /RESUME_COMPLETE/);
  const deliveryLines = (await readFile(path.join(root, 'deliveries.log'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(deliveryLines.length, 1);
  console.log('continuation restart process smoke: PASS');
}

async function runCheckpointChild(root: string): Promise<void> {
  const runtime = await makeRuntime(root, fixedClock('2026-07-17T10:00:00.000Z'), {
    async execute(claim) {
      return {
        executionSessionId: 'session_checkpoint',
        outcome: {
          outcome: 'continue',
          checkpoint: {
            summary: 'Checkpoint committed.',
            completedSteps: ['first step'],
            remainingSteps: ['final step'],
            constraints: [],
            decisions: [],
            references: [],
          },
          nextStep: 'final step',
          resumeAfterSeconds: 60,
        },
      };
    },
  });
  const { job } = await runtime.service.createFromMessage({
    title: 'Restart task',
    objective: 'Complete across a process restart.',
    acceptance_criteria: ['One terminal delivery.'],
    context_snapshot: {
      summary: 'Ready.',
      completed_steps: [],
      remaining_steps: ['first step', 'final step'],
      constraints: [],
      decisions: [],
      references: [],
    },
    required_tools: [],
  }, {
    messageId: 'om_restart_source',
    chatId: 'oc_restart',
    chatType: 'p2p',
    senderId: 'ou_restart',
    text: 'Start restart task.',
    messageType: 'text',
    rawContent: '{"text":"Start restart task."}',
  });
  await runtime.worker!.tick();
  await waitFor(async () => (await runtime.service.getForActor(job.jobId, 'ou_restart')).status === 'waiting_retry');
  process.stdout.write('CHECKPOINT_COMMITTED\n');
  await new Promise(() => {});
}

async function runResumeChild(root: string): Promise<void> {
  const runtime = await makeRuntime(root, fixedClock('2026-07-17T10:02:00.000Z'), {
    async execute(claim) {
      assert.equal(claim.job.checkpoint?.summary, 'Checkpoint committed.');
      assert.equal(claim.job.executionSessionId, 'session_checkpoint');
      return {
        executionSessionId: 'session_checkpoint',
        outcome: {
          outcome: 'completed',
          finalMessage: 'Restart task completed.',
          resultSummary: 'Completed after restart.',
          artifacts: [],
        },
      };
    },
  });
  await runtime.worker!.tick();
  await waitFor(async () => {
    try {
      const content = await readFile(path.join(root, 'deliveries.log'), 'utf8');
      return content.trim().length > 0;
    } catch {
      return false;
    }
  });
  await runtime.close();
  process.stdout.write('RESUME_COMPLETE\n');
}

async function makeRuntime(
  root: string,
  clock: ContinuationClock,
  executor: ContinuationExecutor,
) {
  return createContinuationRuntime({
    enabled: true,
    databasePath: path.join(root, 'jobs.sqlite'),
    artifactsDir: path.join(root, 'artifacts'),
    allowedWorkingRoot: root,
    maxAttempts: 5,
    maxRetries: 2,
    maxTotalMinutes: 30,
    timeoutMs: 60_000,
    retentionDays: 30,
    maxConcurrency: 1,
    configuredSandbox: 'workspace-write',
    clock,
    getTransport: () => ({} as never),
    executor,
    delivery: {
      async deliver(claim) {
        await appendFile(path.join(root, 'deliveries.log'), `${claim.jobId}\n`, 'utf8');
        return { status: 'delivered', messageId: 'om_restart_terminal' };
      },
    },
  });
}

function fixedClock(iso: string): ContinuationClock {
  return { now: () => new Date(iso) };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for child continuation state.');
}

async function waitForOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (stdout.includes(marker)) return;
    if (child.exitCode !== null) throw new Error(stderr || `Child exited before ${marker}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill('SIGKILL');
  throw new Error(`Timed out waiting for ${marker}: ${stderr}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function collectOutput(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, stdout, stderr };
}
