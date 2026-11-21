import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appConfig } from '../src/config.js';
import { ContinuationInputStore } from '../src/continuation/input-store.js';
import { createContinuationRuntime } from '../src/continuation/runtime.js';
import type { ContinuationActionInput } from '../src/continuation/service.js';
import type { LarkMessage } from '../src/lark-message.js';
import { resolveWorkspaceProject } from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-async-'));
try {
  const base = await fs.realpath(fixture);
  const app = path.join(base, 'app');
  const docs = path.join(base, 'docs');
  await fs.mkdir(app);
  await fs.mkdir(docs);
  const registryPath = path.join(base, 'projects.json');
  Object.assign(appConfig, { codexExecCwd: base, workspaceProjectsConfigPath: registryPath });
  const configure = (selector: string) => fs.writeFile(registryPath, JSON.stringify({
    version: 1, roots: [], projects: [], default: selector,
  }));
  await configure('path:app');
  const binding = await resolveWorkspaceProject({ authorizedRoot: base, registryPath });
  assert.ok(binding);
  const action: ContinuationActionInput = {
    title: 'Check project', objective: 'Check status in the selected workspace.',
    deliverables: [{ id: 'result', description: 'Workspace status.', required: true }],
    acceptance_criteria: [{ id: 'complete', description: 'Status verified.', deliverable_ids: ['result'] }],
    verification_requirements: [{ id: 'verified', description: 'Status evidence.', kind: 'evidence_reference' }],
    context_snapshot: {
      summary: 'Workspace check requested.', completed_steps: [], remaining_steps: ['Check status.'],
      constraints: [], decisions: [], references: [],
    },
    required_tools: [], working_directory: 'docs',
  };
  const source: LarkMessage = {
    messageId: 'om_workspace_async', chatId: 'oc_workspace', chatType: 'group', senderId: 'ou_actor',
    text: '/project path:app\nRun the check in the background.', messageType: 'text', rawContent: '',
  };
  const launches: string[] = [];
  const open = (allowedWorkingRoot = base, foregroundWorkingRoot = base) => createContinuationRuntime({
    enabled: true, databasePath: path.join(base, 'runs.sqlite'), artifactsDir: path.join(base, 'artifacts'),
    allowedWorkingRoot, foregroundWorkingRoot, maxAttempts: 1, maxRetries: 0, maxTotalMinutes: 30, timeoutMs: 10_000,
    retentionDays: 7, maxConcurrency: 1, configuredSandbox: 'read-only',
    getTransport: () => ({} as never),
    runCodexExec: async ({ cwd }) => { launches.push(cwd); throw new Error('Test stopped after observing CWD.'); },
    delivery: { async deliver() { return { status: 'delivered', messageId: 'om_done' }; } },
  });
  const first = await open();
  let validJobId: string;
  let staleJobId: string;
  let legacyJobId: string;
  try {
    assert.equal(first.health.available, true);
    const admit = (messageId: string, workspaceProject?: typeof binding) => first.service.createFromMessage(
      action, { ...source, messageId }, null, null, [], workspaceProject,
    );
    const { job } = await admit('om_valid', binding);
    validJobId = job.jobId;
    assert.equal(job.workingDirectory, app, 'a model directory cannot replace the trusted selection');
    assert.deepEqual(job.permissions.filesystem.workspaceProject, binding);
    staleJobId = (await admit('om_stale', binding)).job.jobId;
    const legacy = await admit('om_legacy');
    assert.equal(legacy.job.workingDirectory, docs);
    legacyJobId = legacy.job.jobId;
  } finally {
    await first.close();
  }
  const narrowed = await open(docs);
  try {
    await assert.rejects(narrowed.service.preflightFromMessage(action, source, null, null, 0, binding), {
      code: 'outside_authorized_root',
    });
  } finally {
    await narrowed.close();
  }
  await configure('path:docs');
  const restarted = await open();
  const status = (runtime: typeof restarted, jobId: string) => runtime.service.getForActor(jobId, source.senderId);
  const runUntil = async (runtime: typeof restarted, jobId: string, result: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await status(runtime, jobId)).status === result) return;
      await runtime.worker!.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await status(runtime, jobId)).status, result);
  };
  let narrowedJobId: string;
  try {
    assert.equal((await status(restarted, validJobId)).workingDirectory, app);
    assert.deepEqual((await status(restarted, validJobId)).permissions.filesystem.workspaceProject, binding);
    await runUntil(restarted, validJobId, 'failed');
    assert.deepEqual(launches, [app], 'restart does not pick up the new registry default');
    await fs.rename(app, path.join(base, 'old-app'));
    await fs.symlink(docs, app, 'dir');
    await runUntil(restarted, staleJobId, 'blocked');
    assert.equal((await status(restarted, staleJobId)).errorCode, 'continuation_working_directory_denied');
    await runUntil(restarted, legacyJobId, 'failed');
    assert.deepEqual(launches, [app, docs], 'only the legacy job may use docs');
    const moved = await resolveWorkspaceProject({ authorizedRoot: base, registryPath, selector: 'path:old-app' });
    assert.ok(moved);
    narrowedJobId = (await restarted.service.createFromMessage(
      action, { ...source, messageId: 'om_narrowed' }, null, null, [], moved,
    )).job.jobId;
  } finally {
    await restarted.close();
  }
  const execRootNarrowed = await open(base, docs);
  try {
    await runUntil(execRootNarrowed, narrowedJobId, 'blocked');
    assert.equal((await status(execRootNarrowed, narrowedJobId)).errorCode, 'continuation_working_directory_denied');
    assert.deepEqual(launches, [app, docs], 'the old execution root does not authorize launches after restart');
  } finally {
    await execRootNarrowed.close();
  }
} finally {
  const inputsDir = path.join(fixture, 'inputs');
  const inputs = new ContinuationInputStore(inputsDir);
  for (const entry of await fs.readdir(inputsDir).catch(() => [] as string[])) {
    if (entry.startsWith('job_')) await inputs.remove(entry);
  }
  await fs.rm(fixture, { recursive: true, force: true });
}
