import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appConfig } from '../src/config.js';
import { ContinuationInputStore } from '../src/continuation/input-store.js';
import { createContinuationRuntime } from '../src/continuation/runtime.js';
import type { ContinuationActionInput } from '../src/continuation/service.js';
import type { LarkMessage } from '../src/lark-message.js';
import { resolveWorkspaceProject } from '../src/workspace-projects.js';
import type { CodexExecRequest } from '../src/codex-exec.js';
import { readManagedArtifact } from '../src/managed-workspace-artifact.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-async-'));
try {
  const base = await fs.realpath(fixture);
  const app = path.join(base, 'app');
  const docs = path.join(base, 'docs');
  const staleSource = path.join(base, 'stale');
  const scratchRoot = path.join(base, 'scratch');
  const artifactRoot = path.join(base, 'formal');
  const managedWorkspaceConfigPath = path.join(base, 'managed-workspace.json');
  await fs.mkdir(app);
  await fs.mkdir(docs);
  await fs.mkdir(staleSource);
  await fs.mkdir(scratchRoot);
  await fs.mkdir(artifactRoot);
  const registryPath = path.join(base, 'projects.json');
  Object.assign(appConfig, { codexExecCwd: base, workspaceProjectsConfigPath: registryPath });
  const configure = (selector: string) => fs.writeFile(registryPath, JSON.stringify({
    version: 1, roots: [], projects: [], default: selector,
  }));
  await configure('path:app');
  const binding = await resolveWorkspaceProject({ authorizedRoot: base, registryPath });
  assert.ok(binding);
  const staleBinding = await resolveWorkspaceProject({ authorizedRoot: base, registryPath, selector: 'path:stale' });
  assert.ok(staleBinding);
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
  const requests: CodexExecRequest[] = [];
  const open = (allowedWorkingRoot = base, foregroundWorkingRoot = base) => createContinuationRuntime({
    enabled: true, databasePath: path.join(base, 'runs.sqlite'), artifactsDir: path.join(base, 'artifacts'),
    managedWorkspaceConfigPath,
    allowedWorkingRoot, foregroundWorkingRoot, maxAttempts: 1, maxRetries: 0, maxTotalMinutes: 30, timeoutMs: 10_000,
    retentionDays: 7, maxConcurrency: 1, configuredSandbox: 'read-only',
    getTransport: () => ({} as never),
    runCodexExec: async (request) => {
      requests.push(request);
      launches.push(request.cwd!);
      const formal = request.extraEnv?.LARK_MANAGED_ARTIFACTS_DIR;
      if (formal) {
        const text = 'checkpoint evidence';
        const sha256 = createHash('sha256').update(text).digest('hex');
        await fs.writeFile(path.join(formal, 'result.txt'), text);
        return JSON.stringify({
          outcome: 'failed', error_code: 'test_handoff', error_summary: 'Test handoff.', retryable: false,
          completed_work: [], unperformed_work: ['Finish.'],
          checkpoint: {
            schema_version: 2, current_step_id: 'inspect', summary: 'Draft evidence.',
            completed_step_ids: [], completed_criterion_ids: [], completed_deliverable_ids: [],
            remaining_steps: [], artifacts: [{ id: 'file', deliverable_id: 'result', path: 'result.txt', sha256 }],
            evidence: [], side_effects: [], constraints: [], decisions: [], next_action: null, stop_reason: 'Test handoff.',
          },
        });
      }
      throw new Error('Test stopped after observing CWD.');
    },
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
    const legacy = await admit('om_legacy');
    assert.equal(legacy.job.workingDirectory, docs);
    legacyJobId = legacy.job.jobId;
    await fs.writeFile(managedWorkspaceConfigPath, JSON.stringify({ version: 1, scratchRoot, artifactRoot }));
    const { job } = await admit('om_valid', binding);
    validJobId = job.jobId;
    assert.equal(job.workingDirectory, app, 'a model directory cannot replace the trusted selection');
    assert.deepEqual(job.permissions.filesystem.workspaceProject, binding);
    assert.equal(job.permissions.filesystem.managedWorkspaceRoots?.scratch.directory, scratchRoot);
    staleJobId = (await admit('om_stale', staleBinding)).job.jobId;
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
  await fs.unlink(managedWorkspaceConfigPath);
  await fs.rename(staleSource, path.join(base, 'displaced-stale'));
  await fs.symlink(docs, staleSource, 'dir');
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
    const managedRequest = requests.find((request) => request.cwd === app);
    assert.ok(managedRequest?.extraEnv?.LARK_MANAGED_SCRATCH_DIR);
    assert.equal(path.dirname(managedRequest.extraEnv.LARK_MANAGED_SCRATCH_DIR), scratchRoot);
    assert.equal(path.dirname(managedRequest.extraEnv.LARK_MANAGED_ARTIFACTS_DIR!), artifactRoot);
    assert.equal(managedRequest.sandbox, 'read-only');
    assert.deepEqual(managedRequest.additionalWritableDirs ?? [], [], 'managed paths do not add write access in read-only mode');
    const failed = await status(restarted, validJobId);
    assert.equal(failed.checkpoint?.artifacts[0]?.path, 'result.txt', failed.errorSummary ?? undefined);
    const originalScratch = managedRequest.extraEnv.LARK_MANAGED_SCRATCH_DIR;
    await fs.rename(originalScratch, path.join(scratchRoot, 'unavailable'));
    const store = restarted.durableRepository!.getManagedWorkspaceStore!();
    const openFormal = () => store.openDirectory({ kind: 'async_task', runId: validJobId }, 'artifacts', [base]);
    const formal = await openFormal();
    const expectedSha256 = failed.checkpoint!.artifacts[0].sha256;
    const readArtifact = (name: string, maxBytes = 128) => readManagedArtifact({
      directory: formal, relativePath: name, maxBytes, expectedSha256, revalidate: openFormal,
    });
    assert.equal((await readArtifact('result.txt')).content.toString(), 'checkpoint evidence');
    await assert.rejects(restarted.service.deleteForActor(validJobId, source.senderId), /cannot be deleted/);
    assert.equal((await status(restarted, validJobId)).deletedAt, undefined);
    await assert.rejects(readArtifact('result.txt', 1), { code: 'artifact_invalid' });
    await fs.symlink('result.txt', path.join(formal, 'linked.txt'));
    await assert.rejects(readArtifact('linked.txt'), { code: 'artifact_invalid' });
    await fs.unlink(path.join(formal, 'linked.txt'));
    await fs.writeFile(path.join(formal, 'result.txt'), 'changed');
    await assert.rejects(readArtifact('result.txt'), { code: 'artifact_invalid' });
    await fs.writeFile(path.join(formal, 'result.txt'), 'checkpoint evidence');
    const retry = await restarted.service.retryForActor(validJobId, source.senderId, undefined, 'explicit-retry');
    assert.equal(retry.retryOfJobId, validJobId);
    assert.equal(retry.checkpoint?.artifacts[0]?.sha256, failed.checkpoint?.artifacts[0]?.sha256);
    const child = store.get({ kind: 'async_task', runId: retry.jobId })!.allocation;
    assert.notEqual(child.scratch.directory, originalScratch);
    assert.notEqual(child.artifacts.directory, formal);
    assert.equal(await fs.readFile(path.join(child.artifacts.directory, 'result.txt'), 'utf8'), 'checkpoint evidence');
    await fs.rename(child.artifacts.directory, path.join(artifactRoot, 'unavailable-child'));
    await runUntil(restarted, retry.jobId, 'blocked');
    const storageBlocked = await status(restarted, retry.jobId);
    assert.equal(storageBlocked.errorCode, 'continuation_working_directory_denied');
    assert.equal(storageBlocked.checkpoint?.artifacts[0]?.path, 'result.txt');
    assert.deepEqual(storageBlocked.resultArtifacts ?? [], []);
    await fs.rename(app, path.join(base, 'old-app'));
    await fs.symlink(docs, app, 'dir');
    await runUntil(restarted, staleJobId, 'blocked');
    assert.equal((await status(restarted, staleJobId)).errorCode, 'continuation_working_directory_denied');
    await runUntil(restarted, legacyJobId, 'failed');
    assert.deepEqual([...launches].sort(), [app, docs].sort(), 'only the legacy job may use docs');
    assert.equal(requests.find((request) => request.cwd === docs)?.extraEnv?.LARK_MANAGED_SCRATCH_DIR, undefined);
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
    assert.deepEqual([...launches].sort(), [app, docs].sort(), 'the old execution root does not authorize launches after restart');
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
