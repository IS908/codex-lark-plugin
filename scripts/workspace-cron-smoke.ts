import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appConfig } from '../src/config.js';
import { createCodexExecActionDispatcher } from '../src/codex-exec-actions.js';
import { deliverMessageViaCodexExec } from '../src/codex-exec-delivery.js';
import { FileCodexExecSessionStore } from '../src/codex-session-store.js';
import { parseCronRunInput } from '../src/cron/contracts.js';
import { createCronPromptExecutor } from '../src/cron/prompt-executor.js';
import { CronRunAdmission } from '../src/cron/run-admission.js';
import { SqliteDurableRunRepository } from '../src/durable-run/sqlite-repository.js';
import { IdentitySession } from '../src/identity-session.js';
import { createJob } from '../src/job-service.js';
import { readJob } from '../src/job-store.js';
import { MemoryStore } from '../src/memory/file.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-cron-'));
try {
  const base = await fs.realpath(fixture);
  const app = path.join(base, 'app');
  const docs = path.join(base, 'docs');
  await fs.mkdir(app);
  await fs.mkdir(docs);
  const configPath = path.join(base, 'workspace-projects.json');
  const configure = (selector: string) => fs.writeFile(configPath, JSON.stringify({
    version: 1, roots: [], projects: [], default: selector,
  }));
  Object.assign(appConfig, {
    codexExecCwd: base,
    workspaceProjectsConfigPath: configPath,
    jobsDir: path.join(base, 'jobs'),
    auditLogPath: path.join(base, 'audit.log'),
  });
  const create = (name: string, type: 'prompt' | 'message' = 'prompt') => createJob({
    name, type, schedule: '*/5 * * * *', timezone: 'UTC',
    prompt: '/project path:docs\nReturn the report.', content: 'Fixed reminder.',
    targetChatId: 'oc_target', originChatId: 'oc_target', caller: 'ou_owner',
  });
  assert.ok((await create('legacy')).ok);
  await configure('path:app');
  assert.ok((await create('pinned')).ok);
  const pinned = await readJob('pinned');
  const legacy = await readJob('legacy');
  assert.ok(pinned && legacy);
  assert.equal(pinned.meta.workspace_project?.directory, app);
  assert.equal(legacy.meta.workspace_project, undefined);

  const databasePath = path.join(base, 'runs.sqlite');
  let pinnedRun: string;
  let legacyRun: string;
  const first = await SqliteDurableRunRepository.open({ databasePath });
  try {
    const admission = new CronRunAdmission({ runRepository: first });
    const now = new Date();
    const results = await Promise.all([
      admission.admitManual(pinned, 'pinned', now), admission.admitManual(legacy, 'legacy', now),
    ]);
    assert.ok(results[0].admitted && results[1].admitted);
    pinnedRun = results[0].runId;
    legacyRun = results[1].runId;
  } finally {
    first.close();
  }

  await configure('path:docs');
  const identity = new IdentitySession();
  const dispatcher = createCodexExecActionDispatcher({
    identitySession: identity, memoryStore: new MemoryStore(path.join(base, 'memory')),
  });
  identity.setCaller('oc_target', undefined, 'ou_owner');
  const throughForeground = (type: 'create_job' | 'upsert_job', text: string, expected = true) => deliverMessageViaCodexExec({
    message: {
      messageId: 'om_workspace_select', chatId: 'oc_target', chatType: 'p2p', senderId: 'ou_owner',
      text, currentUserText: text, workspaceDirectiveText: text, messageType: 'text', rawContent: '',
    },
    displayLabel: 'Select Cron workspace',
    useCodexSessions: false,
    actionDispatcher: dispatcher,
    progressLimits: { enabled: false },
    runCodexExec: async ({ actions }) => {
      assert.ok(actions);
      await fs.appendFile(actions.filePath, `${JSON.stringify({
        version: 1, type: 'lark_action_request', token: actions.token,
        actions: [{ type, name: 'action-job', job_type: 'prompt', schedule: '*/5 * * * *', prompt: 'Report' }],
      })}\n`);
      return { text: 'OK' };
    },
    onActionResults: (results) => assert.equal(results[0]?.ok, expected, results[0]?.message),
    deliverySink: async () => {},
  });
  identity.setCaller('oc_target', undefined, 'ou_other');
  await throughForeground('create_job', '/project path:app\nCreate a Cron job.', false);
  assert.equal(await readJob('action-job'), null, 'the project choice must not be attributed to a different caller');
  identity.setCaller('oc_target', undefined, 'ou_owner');
  await throughForeground('create_job', '/project path:app\nCreate a Cron job.');
  const original = await readJob('action-job');
  assert.equal(original?.meta.workspace_project?.directory, app, 'Cron uses the parent selection, not the registry default');
  const beforeRebind = await SqliteDurableRunRepository.open({ databasePath });
  let originalActionRunId: string;
  try {
    const admission = new CronRunAdmission({ runRepository: beforeRebind });
    const admitted = await admission.admitManual(original!, 'before-rebind', new Date());
    assert.ok(admitted.admitted);
    originalActionRunId = admitted.runId;
  } finally {
    beforeRebind.close();
  }
  await throughForeground('upsert_job', 'Update the Cron job.');
  assert.equal((await readJob('action-job'))?.meta.workspace_project?.directory, app);
  await throughForeground('upsert_job', '/project path:docs\nUpdate the Cron job.');
  const rebound = await readJob('action-job');
  assert.equal(rebound?.meta.workspace_project?.directory, docs);
  assert.ok(rebound!.meta.revision > original!.meta.revision);

  const second = await SqliteDurableRunRepository.open({ databasePath });
  try {
    const results: string[] = [];
    const execute = createCronPromptExecutor({
      identitySession: new IdentitySession(),
      sessionStore: new FileCodexExecSessionStore(path.join(base, 'sessions')),
      useCodexSessions: false,
      runCodexExec: async ({ cwd }) => { results.push(cwd); return { text: 'Report' }; },
    });
    const read = async (runId: string) => {
      const run = await second.get(runId);
      assert.ok(run);
      const { job } = parseCronRunInput(run.input, run.inputVersion, 'prompt');
      assert.ok(job.type === 'prompt' && job.prompt !== undefined);
      return { runId, job: { ...job, type: job.type, prompt: job.prompt } };
    };
    const signal = new AbortController().signal;
    const bound = await read(pinnedRun);
    const actionRun = await read(originalActionRunId);
    assert.equal(bound.job.workspaceProject?.directory, app);
    assert.equal(actionRun.job.workspaceProject?.directory, app, 'rebinding a definition does not retarget its queued Run');
    assert.equal((await execute(bound, signal)).runStatus, 'success');
    assert.equal((await execute(actionRun, signal)).runStatus, 'success');
    assert.equal((await execute(await read(legacyRun), signal)).runStatus, 'success');
    assert.deepEqual(results, [app, app, base]);

    await fs.rename(app, path.join(base, 'old-app'));
    await fs.symlink(docs, app, 'dir');
    assert.equal((await execute(bound, signal)).runStatus, 'failed');
    assert.deepEqual(results, [app, app, base], 'a saved run never opens a swapped project');
  } finally {
    second.close();
  }

  await configure('path:does-not-exist');
  const invalid = await create('invalid');
  assert.equal(invalid.ok, false);
  assert.ok((await create('fixed', 'message')).ok, 'fixed messages do not select workspaces');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
