import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { deliverMessageViaCodexExec } from '../../src/codex-exec-delivery.js';
import { buildCodexExecArgs, CodexExecAbortedError, type CodexExecRequest } from '../../src/codex-exec.js';
import { FileCodexExecSessionStore, buildCodexExecSessionKey } from '../../src/codex-session-store.js';
import { appConfig } from '../../src/config.js';
import { ContinuationInputStore } from '../../src/continuation/input-store.js';
import { createContinuationRuntime } from '../../src/continuation/runtime.js';
import { createCronPromptExecutor } from '../../src/cron/prompt-executor.js';
import type { ManagedGitSelection, ManagedWorkspaceRoots } from '../../src/domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from '../../src/domain/workspace.js';
import { IdentitySession } from '../../src/identity-session.js';
import type { LarkMessage } from '../../src/lark-message.js';
import type { ManagedWorkspaceStore } from '../../src/ports/managed-workspace.js';

export async function checkManagedGitEntrypoints(input: {
  base: string; project: WorkspaceProjectBinding; roots: ManagedWorkspaceRoots; git: ManagedGitSelection;
  codexHome: string; store: ManagedWorkspaceStore;
}): Promise<void> {
  const { base, project, roots, git, codexHome } = input;
  const registry = path.join(base, 'entrypoint-projects.json');
  const storage = path.join(base, 'entrypoint-storage.json');
  await fs.writeFile(registry, JSON.stringify({ version: 1, roots: [], projects: [], default: 'path:source' }));
  await fs.writeFile(storage, JSON.stringify({ version: 1, scratchRoot: roots.scratch.directory, artifactRoot: roots.artifacts.directory }));
  const config = { codexExecCwd: base, codexExecSandbox: 'workspace-write' as const, codexExecIgnoreUserConfig: true,
    codexExecProfile: null, workspaceProjectsConfigPath: registry, managedWorkspaceConfigPath: storage };
  const previous = Object.fromEntries(Object.keys(config).map((key) => [key, appConfig[key as keyof typeof config]]));
  Object.assign(appConfig, config);
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const inject = (store: ManagedWorkspaceStore) => {
    const ensure = store.ensure.bind(store);
    return mock.method(store, 'ensure', (request: Parameters<typeof ensure>[0]) => ensure({ ...request, git }));
  };
  const injected = inject(input.store);
  const assertLaunch = (request: CodexExecRequest) => {
    assert.ok(request.cwd?.endsWith('/git-checkout'));
    assert.notEqual(request.cwd, project.directory);
    assert.equal(request.workspaceDirectory?.binding.directory, request.cwd);
    assert.equal(typeof request.validateManagedGitLaunch, 'function');
    const args = buildCodexExecArgs(request, path.join(base, 'entrypoint-output'));
    assert.ok(args.includes('default_permissions="lark-managed-git"') && args.includes('--strict-config'));
    assert.ok(!args.includes('--sandbox') && !args.includes('--add-dir'));
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
    abortNext = true;
    await assert.rejects(foreground({ ...message, messageId: 'om_git_foreground_second' }), CodexExecAbortedError);
    assert.equal(launched.length, 4, 'an aborted resume must not trigger a new session');

    const cron = createCronPromptExecutor({ identitySession: new IdentitySession(), sessionStore, useCodexSessions: false,
      managedWorkspaceStore: () => input.store,
      runCodexExec: async (request) => { assertLaunch(request); return { text: 'Fixture report' }; } });
    const now = new Date().toISOString();
    const result = await cron({ runId: 'entrypoint-cron', managedWorkspace: { roots, createdAt: now }, job: {
      id: 'git-fixture', name: 'Git fixture Cron', createdAt: now, revision: 1, schedule: '*/5 * * * *', scheduleHuman: 'Every five minutes',
      timezone: 'UTC', type: 'prompt', prompt: 'Run the fixture.', workspaceProject: project,
      originChatId: 'oc_cron', targetChatId: 'oc_cron', createdBy: 'ou_fixture',
    } }, new AbortController().signal);
    assert.equal(result.runStatus, 'success', result.failureReason ?? undefined);
    assert.equal(result.report, 'Fixture report');

    let continuationLaunch: CodexExecRequest | undefined;
    let fixtureJobId: string | undefined;
    const runtime = await createContinuationRuntime({ enabled: true, databasePath: path.join(base, 'entrypoint-async.sqlite'),
      artifactsDir: path.join(base, 'entrypoint-legacy-artifacts'), managedWorkspaceConfigPath: storage, sourceRegistryPath: registry,
      allowedWorkingRoot: base, foregroundWorkingRoot: base, maxAttempts: 1, maxRetries: 0, maxTotalMinutes: 30,
      timeoutMs: 10_000, retentionDays: 7, maxConcurrency: 1, configuredSandbox: 'read-only', getTransport: () => null,
      runCodexExec: async (request) => {
        assertLaunch(request);
        assert.match(request.prompt, /Workspace: .*\/git-checkout/);
        assert.ok(request.configOverrides?.every((entry) => !entry.includes('="write"')));
        continuationLaunch = request;
        throw new Error('Fixture stopped after observing the bound checkout.');
      } });
    try {
      assert.ok(runtime.health.available && runtime.worker && runtime.durableRepository?.getManagedWorkspaceStore);
      const asyncInjection = inject(runtime.durableRepository.getManagedWorkspaceStore());
      try {
        const admitted = await runtime.service.createFromMessage({ title: 'Check fixture', objective: 'Check the fixture.',
          deliverables: [{ id: 'result', description: 'Fixture result.', required: true }],
          acceptance_criteria: [{ id: 'complete', description: 'Fixture status checked.', deliverable_ids: ['result'] }],
          verification_requirements: [{ id: 'evidence', kind: 'evidence_reference', description: 'Status evidence.' }],
          context_snapshot: { summary: 'Git workspace check.', completed_steps: [], remaining_steps: ['Check status.'],
            constraints: [], decisions: [], references: [] }, required_tools: [], working_directory: project.directory,
        }, { ...message, messageId: 'om_git_async_fixture' }, null, null, [], project);
        fixtureJobId = admitted.job.jobId;
        for (let tick = 0; tick < 40 && !continuationLaunch; tick++) {
          await runtime.worker.tick();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const final = await runtime.service.getForActor(admitted.job.jobId, message.senderId);
        assert.ok(continuationLaunch, final.errorSummary ?? 'Async Task did not reach the sandboxed launch.');
      } finally {
        asyncInjection.mock.restore();
      }
    } finally {
      await runtime.close();
      if (fixtureJobId) await new ContinuationInputStore(path.join(base, 'inputs')).remove(fixtureJobId);
    }
  } finally {
    injected.mock.restore();
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    Object.assign(appConfig, previous);
  }
}
