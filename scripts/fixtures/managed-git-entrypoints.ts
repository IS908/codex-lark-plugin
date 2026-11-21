import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deliverMessageViaCodexExec } from '../../src/codex-exec-delivery.js';
import { buildCodexExecArgs, CodexExecAbortedError, type CodexExecRequest } from '../../src/codex-exec.js';
import { FileCodexExecSessionStore, buildCodexExecSessionKey } from '../../src/codex-session-store.js';
import { appConfig } from '../../src/config.js';
import { ContinuationInputStore } from '../../src/continuation/input-store.js';
import { allocateContinuationWorkspace } from '../../src/continuation/managed-workspace.js';
import { createContinuationRuntime } from '../../src/continuation/runtime.js';
import { parseCronRunInput } from '../../src/cron/contracts.js';
import { createCronPromptExecutor } from '../../src/cron/prompt-executor.js';
import { CronRunAdmission } from '../../src/cron/run-admission.js';
import type { ManagedGitSelection, ManagedWorkspaceRoots } from '../../src/domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from '../../src/domain/workspace.js';
import { IdentitySession } from '../../src/identity-session.js';
import type { LarkMessage } from '../../src/lark-message.js';
import type { ManagedWorkspaceStore } from '../../src/ports/managed-workspace.js';
import type { DurableRunRepository } from '../../src/ports/durable-run.js';
import type { JobFile } from '../../src/job-contracts.js';
import { resolveManagedGitSelection } from '../../src/managed-git-registry.js';
import { admitManagedWorkspaceDependencies } from '../../src/managed-workspace-dependencies.js';
import { managedForegroundRunOwner } from '../../src/managed-workspace-admission.js';
import { pinWorkspacePath } from '../../src/workspace-projects.js';

export async function checkManagedGitEntrypoints(input: {
  base: string; project: WorkspaceProjectBinding; roots: ManagedWorkspaceRoots; git: ManagedGitSelection;
  codexHome: string; store: ManagedWorkspaceStore;
  dependency?: { command: string; repository: DurableRunRepository; key: string;
    provision: (operator: string) => Promise<(enabled: boolean) => Promise<void>>; verify: (directory: string, cwd: string) => void };
}): Promise<void> {
  const { base, project, roots, git, codexHome, dependency } = input;
  const registry = path.join(base, 'entrypoint-projects.json');
  const operator = path.join(path.dirname(base), 'entrypoint-operator');
  await fs.mkdir(operator, { mode: 0o700 });
  const storage = path.join(operator, 'entrypoint-storage.json');
  const gitSources = path.join(operator, 'workspace-git-sources.json');
  await fs.writeFile(registry, JSON.stringify({ version: 1, roots: [], projects: [], default: 'path:source' }));
  await fs.writeFile(storage, JSON.stringify({ version: 1, scratchRoot: roots.scratch.directory, artifactRoot: roots.artifacts.directory }));
  const optIn = () => fs.writeFile(gitSources, JSON.stringify({ version: 1, projects: [{ source: project.directory,
    cache: git.cache.directory, repositoryId: git.repositoryId, scope: git.scope, commit: git.commit }] }), { mode: 0o600 });
  await optIn();
  const enableDependency = await dependency?.provision(operator);
  const selectionInput = { configPath: storage, roots, project, authorizedRoots: [base] as const };
  const child = path.join(project.directory, 'registered-project-child');
  await fs.mkdir(child);
  await assert.rejects(resolveManagedGitSelection({ ...selectionInput, project: await pinWorkspacePath(base, child) }),
    { code: 'git_project_overlap' });
  await assert.rejects(resolveManagedGitSelection({ ...selectionInput, project: undefined, roots: { ...roots, artifacts: git.cache } }),
    { code: 'overlapping_git_cache' });
  await assert.rejects(resolveManagedGitSelection({ ...selectionInput, preserveOptOut: true }), { code: 'git_project_overlap' });
  const config = { codexExecCwd: base, codexExecSandbox: 'workspace-write' as const, codexExecIgnoreUserConfig: true,
    codexExecProfile: null, workspaceProjectsConfigPath: registry, managedWorkspaceConfigPath: storage,
    codexExecCommand: dependency?.command ?? appConfig.codexExecCommand };
  const previous = Object.fromEntries(Object.keys(config).map((key) => [key, appConfig[key as keyof typeof config]]));
  Object.assign(appConfig, config);
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const assertLaunch = (request: CodexExecRequest) => {
    assert.ok(request.cwd?.endsWith('/git-checkout'));
    assert.notEqual(request.cwd, project.directory);
    assert.equal(request.workspaceDirectory?.binding.directory, request.cwd);
    assert.equal(typeof request.validateManagedGitLaunch, 'function');
    const args = buildCodexExecArgs(request, path.join(base, 'entrypoint-output'));
    assert.ok(args.includes('default_permissions="lark-managed-git"') && args.includes('--strict-config'));
    assert.ok(!args.includes('--sandbox') && !args.includes('--add-dir'));
    if (dependency) {
      const directory = request.extraEnv?.LARK_MANAGED_PYTHON_DEPS;
      assert.ok(directory?.startsWith(`${request.extraEnv?.LARK_MANAGED_SCRATCH_DIR}/`));
      assert.equal(request.extraEnv?.PYTHONPATH, undefined);
      dependency.verify(directory!, request.cwd!);
    }
  };
  try {
    const sessionStore = new FileCodexExecSessionStore(path.join(base, 'entrypoint-sessions'));
    const message: LarkMessage = { messageId: 'om_git_foreground', chatId: 'oc_git', chatType: 'p2p', senderId: 'ou_fixture',
      senderName: 'Fixture', text: 'Check the fixture.', rawContent: '', messageType: 'text' };
    await sessionStore.set({ key: buildCodexExecSessionKey(message.chatId), sessionId: 'old-project-session', chatId: message.chatId,
      workspaceProject: project, workspaceProjectSenderId: message.senderId, updatedAt: new Date().toISOString() });
    const launched: CodexExecRequest[] = [];
    let abortNext = false;
    const foreground = (message: LarkMessage) => deliverMessageViaCodexExec({ message, displayLabel: 'Git fixture', sessionStore,
      useCodexSessions: true, managedWorkspaceStore: () => input.store, progressLimits: { enabled: false },
      runCodexExec: async (request) => {
        assertLaunch(request);
        launched.push(request);
        if (abortNext) throw new CodexExecAbortedError('', '');
        assert.doesNotMatch(request.prompt, /"type":"run_local_cli_tool"/);
        const actions = request.actions!;
        await fs.appendFile(actions.filePath, JSON.stringify({ version: 1, type: 'lark_action_request', token: actions.token,
          actions: [{ type: 'run_local_cli_tool', tool: 'fixture', args: [] }] }) + '\n');
        return { text: 'OK', sessionId: `fixture-foreground-${launched.length}` };
      }, onActionResults: (results) => {
        assert.equal(results[0]?.action, 'run_local_cli_tool');
        assert.equal(results[0]?.ok, false);
        assert.match(results[0]?.message ?? '', /Host CLI tools cannot run/);
      }, deliverySink: async () => {} });
    await foreground(message);
    await foreground(message);
    await foreground({ ...message, messageId: 'om_git_foreground_second' });
    assert.deepEqual(launched.map((request) => request.resumeSessionId), [null, 'fixture-foreground-1', null]);
    assert.equal(launched[0].cwd, launched[1].cwd);
    assert.notEqual(launched[0].cwd, launched[2].cwd);
    if (dependency) {
      assert.equal(launched[0].extraEnv?.LARK_MANAGED_PYTHON_DEPS, launched[1].extraEnv?.LARK_MANAGED_PYTHON_DEPS);
      assert.notEqual(launched[0].extraEnv?.LARK_MANAGED_PYTHON_DEPS, launched[2].extraEnv?.LARK_MANAGED_PYTHON_DEPS);
    }
    abortNext = true;
    await assert.rejects(foreground({ ...message, messageId: 'om_git_foreground_second' }), CodexExecAbortedError);
    assert.equal(launched.length, 4, 'an aborted resume must not trigger a new session');

    const cron = createCronPromptExecutor({ identitySession: new IdentitySession(), sessionStore, useCodexSessions: false,
      managedWorkspaceStore: () => input.store,
      runCodexExec: async (request) => { assertLaunch(request); return { text: 'Fixture report' }; } });
    const now = new Date().toISOString();
    const cronFixture = { runId: 'entrypoint-cron', managedWorkspace: { roots, createdAt: now, git }, job: {
      id: 'git-fixture', name: 'Git fixture Cron', createdAt: now, revision: 1, schedule: '*/5 * * * *', scheduleHuman: 'Every five minutes',
      timezone: 'UTC', type: 'prompt', prompt: 'Run the fixture.', workspaceProject: project,
      originChatId: 'oc_cron', targetChatId: 'oc_cron', createdBy: 'ou_fixture',
    } } as const;
    let cronInput: Parameters<typeof cron>[0] = cronFixture;
    if (dependency) {
      const job: JobFile = { meta: { id: cronFixture.job.id, revision: 1, name: cronFixture.job.name, type: 'prompt',
        prompt: cronFixture.job.prompt, schedule: cronFixture.job.schedule, schedule_human: cronFixture.job.scheduleHuman,
        timezone: 'UTC', origin_chat_id: 'oc_cron', target_chat_id: 'oc_cron', created_by: 'ou_fixture', created_at: now,
        workspace_project: project, status: 'active' }, runtime: { last_run_at: null, next_run_at: now, run_count: 0, last_error: null } };
      const scheduled = { ...structuredClone(job), meta: { ...job.meta, id: `${job.meta.id}-scheduled` } };
      const definitions = new Map([[job.meta.id, job], [scheduled.meta.id, scheduled]]);
      const admission = new CronRunAdmission({ runRepository: dependency.repository,
        jobRepository: { readJob: async (id) => definitions.get(id) ?? null,
          mutateJob: async (id, mutate) => { const job = definitions.get(id); if (job) await mutate(job); return job ?? null; } },
        resolveManagedWorkspaceRoots: async () => roots,
        resolveManagedGitSelection: (project, roots) => resolveManagedGitSelection({ ...selectionInput, project, roots }),
        resolveDependencySelections: (project, roots, git) => admitManagedWorkspaceDependencies({ ...selectionInput,
          project, roots, git, codexCommand: dependency.command }),
      });
      const admitted = await admission.admitManual(job, 'fixture', new Date(now));
      assert.ok(admitted.admitted);
      const saved = (await dependency.repository.get(admitted.runId))!;
      const parsed = parseCronRunInput(saved.input, saved.inputVersion, 'prompt');
      assert.deepEqual(parsed.managedWorkspace?.dependencySelections?.map(({ identity }) => identity.key), [dependency.key]);
      const occurrence = await admission.admitScheduled(scheduled, new Date(now));
      assert.ok(occurrence.admitted && occurrence.scheduledOccurrence);
      const savedOccurrence = (await dependency.repository.get(occurrence.runId))!;
      assert.deepEqual(parseCronRunInput(savedOccurrence.input, savedOccurrence.inputVersion, 'prompt').managedWorkspace?.dependencySelections,
        parsed.managedWorkspace?.dependencySelections);
      cronInput = { ...parsed, runId: admitted.runId };
    }
    assert.deepEqual(parseCronRunInput({ schemaVersion: 1, job: cronInput.job, managedWorkspace: cronInput.managedWorkspace }, 1).managedWorkspace?.git, git);
    const result = await cron(cronInput, new AbortController().signal);
    assert.equal(result.runStatus, 'success', result.failureReason ?? undefined);
    assert.equal(result.report, 'Fixture report');
    if (enableDependency) {
      const revalidateApproval = launched[0].validateManagedDependencyApproval;
      assert.ok(revalidateApproval);
      await revalidateApproval();
      await enableDependency(false);
      await assert.rejects(revalidateApproval(), { code: 'dependency_selection_revoked' });
      await assert.rejects(foreground(message), { code: 'dependency_selection_revoked' });
      const revoked = await cron(cronInput, new AbortController().signal);
      assert.equal(revoked.runStatus, 'failed');
      assert.match(revoked.failureReason ?? '', /dependency selection/);
      const sessionKey = buildCodexExecSessionKey(message.chatId);
      const owner = managedForegroundRunOwner(message, sessionKey);
      const allocation = input.store.get(owner)!.allocation;
      const content = Buffer.from('Committed report.');
      await fs.writeFile(path.join(allocation.artifacts.directory, 'report.txt'), content);
      input.store.rememberForegroundArtifacts(owner.runId, { version: 2, sessionKey, actorId: message.senderId, chatId: message.chatId,
        sourceMessageId: message.messageId, messageType: message.messageType, reply: { status: 'pending', text: 'Ready.' }, files: [
          { status: 'pending', reference: { relativePath: 'report.txt', sha256: createHash('sha256').update(content).digest('hex') } },
        ] });
      let uploaded = false;
      await deliverMessageViaCodexExec({ message, displayLabel: 'Committed fixture', sessionStore,
        managedWorkspaceStore: () => input.store, authorizeForegroundArtifactRoute: async () => true,
        uploadManagedArtifact: async (bytes) => { assert.deepEqual(bytes, content); uploaded = true; return 'fixture_upload'; },
        sendReply: async ({ rawMessage }) => ({ sentCount: 1, statusText: 'sent', messageIds: [rawMessage ? 'om_attachment' : 'om_report'] }),
        runCodexExec: async () => assert.fail('Committed delivery must not re-enter dependency preparation.'),
      });
      assert.ok(uploaded);
      assert.equal(input.store.getForegroundArtifacts(owner.runId)?.files[0]?.status, 'sent');
      await enableDependency(true);
    }
    await fs.unlink(gitSources);
    await assert.rejects(foreground(message), { code: 'git_selection_revoked' });
    const revoked = await cron(cronInput, new AbortController().signal);
    assert.equal(revoked.runStatus, 'failed');
    assert.match(revoked.failureReason ?? '', /authorization/);
    await optIn();

    let continuationLaunch: CodexExecRequest | undefined;
    const fixtureJobIds: string[] = [];
    const asyncState = dependency ? path.join(base, 'async-state') : base;
    let runtimeError: unknown;
    const runtime = await createContinuationRuntime({ enabled: true, databasePath: path.join(asyncState, 'entrypoint-async.sqlite'),
      artifactsDir: path.join(asyncState, 'entrypoint-legacy-artifacts'), managedWorkspaceConfigPath: storage, sourceRegistryPath: registry,
      reportError: (error) => { runtimeError = error; },
      allowedWorkingRoot: base, foregroundWorkingRoot: base, maxAttempts: 1, maxRetries: 0, maxTotalMinutes: 30,
      timeoutMs: dependency ? 90_000 : 10_000, retentionDays: 7, maxConcurrency: 1, configuredSandbox: 'read-only', getTransport: () => null,
      command: dependency?.command,
      runCodexExec: async (request) => {
        assertLaunch(request);
        assert.match(request.prompt, /Workspace: .*\/git-checkout/);
        assert.ok(request.configOverrides?.every((entry) => !entry.includes('="write"')));
        continuationLaunch = request;
        throw new Error('Fixture stopped after observing the bound checkout.');
      } });
    try {
      assert.ok(runtime.health.available && runtime.worker && runtime.durableRepository?.getManagedWorkspaceStore, String(runtimeError));
        const admit = (messageId: string) => runtime.service.createFromMessage({ title: 'Check fixture', objective: 'Check the fixture.',
          deliverables: [{ id: 'result', description: 'Fixture result.', required: true }],
          acceptance_criteria: [{ id: 'complete', description: 'Fixture status checked.', deliverable_ids: ['result'] }],
          verification_requirements: [{ id: 'evidence', kind: 'evidence_reference', description: 'Status evidence.' }],
          context_snapshot: { summary: 'Git workspace check.', completed_steps: [], remaining_steps: ['Check status.'],
            constraints: [], decisions: [], references: [] }, required_tools: [], working_directory: path.relative(base, project.directory),
        }, { ...message, messageId }, null, null, []);
        const revokedAsync = await admit('om_git_async_revoked');
        fixtureJobIds.push(revokedAsync.job.jobId);
        assert.deepEqual(revokedAsync.job.permissions.filesystem.managedWorkspaceGit, git);
        if (dependency) assert.deepEqual(revokedAsync.job.permissions.filesystem.dependencySelections?.map(({ identity }) => identity.key), [dependency.key]);
        const unrelated = path.join(base, 'legacy-workspace');
        await fs.mkdir(unrelated);
        const legacy = { ...revokedAsync.job, workingDirectory: unrelated, permissions: { ...revokedAsync.job.permissions,
          filesystem: { root: base } } } as typeof revokedAsync.job;
        const legacyPolicy = { currentWorkingRoot: base, foregroundWorkingRoot: project.directory, managedWorkspaceConfigPath: storage };
        assert.equal(await allocateContinuationWorkspace(legacy, undefined, legacyPolicy), undefined);
        await assert.rejects(allocateContinuationWorkspace({ ...legacy, workingDirectory: project.directory }, undefined, legacyPolicy),
          { code: 'git_project_overlap' });
        await assert.rejects(allocateContinuationWorkspace({ ...legacy, workingDirectory: git.cache.directory }, undefined, legacyPolicy),
          { code: 'overlapping_git_cache' });
        if (enableDependency) await enableDependency(false);
        else await fs.unlink(gitSources);
        for (let tick = 0; tick < (dependency ? 2500 : 40); tick++) {
          if ((await runtime.service.getForActor(revokedAsync.job.jobId, message.senderId)).status === 'blocked') break;
          await runtime.worker.tick();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const blocked = await runtime.service.getForActor(revokedAsync.job.jobId, message.senderId);
        assert.equal(blocked.status, 'blocked', blocked.errorSummary);
        assert.match(blocked.errorSummary ?? '', enableDependency ? /dependency selection/ : /authorization/);
        assert.equal(continuationLaunch, undefined);
        if (enableDependency) await enableDependency(true);
        else await optIn();
        const admitted = await admit('om_git_async_fixture');
        fixtureJobIds.push(admitted.job.jobId);
        for (let tick = 0; tick < (dependency ? 2500 : 40) && !continuationLaunch; tick++) {
          await runtime.worker.tick();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const final = await runtime.service.getForActor(admitted.job.jobId, message.senderId);
        assert.ok(continuationLaunch, final.errorSummary ?? 'Async Task did not reach the sandboxed launch.');
    } finally {
      await runtime.close();
      const inputStore = new ContinuationInputStore(path.join(asyncState, 'inputs'));
      for (const jobId of fixtureJobIds) await inputStore.remove(jobId);
    }
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    Object.assign(appConfig, previous);
  }
}
