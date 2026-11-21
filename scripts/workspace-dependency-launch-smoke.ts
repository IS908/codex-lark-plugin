import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { promisify } from 'node:util';
import { createManagedGitSandboxOptions, DEPENDENCY_GUARD_PROFILE, dependencyGuardSandboxOverrides } from '../src/managed-git-sandbox.js';
import { MANAGED_GIT_CHECKOUT_LEAF } from '../src/managed-workspace-mkdir.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { probeCodexExecWithLoopback } from './fixtures/codex-loopback-exec.js';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-launch-')));
const [home, codexHome, temp, work, cacheParent] = ['home', 'codex', 'temp', 'work', 'cache-root'].map((name) => path.join(root, name));
process.env.HOME = home;
process.env.CODEX_HOME = codexHome;
process.env.TMPDIR = temp;
process.env.LARK_APP_ID = 'cli_fixture';
process.env.LARK_APP_SECRET = 'not-a-real-secret';

try {
  const config = path.join(home, '.codex', 'channels', 'lark', 'runtime-config');
  const cache = path.join(cacheParent, 'wheelhouse');
  await Promise.all([config, codexHome, temp, work, cache].map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const marker = path.join(root, 'started');
  const command = path.join(root, 'fixture-codex');
  await fs.writeFile(command, `#!/bin/sh
/bin/cat >/dev/null
printf launched > "$LAUNCH_FIXTURE_MARKER"
while [ "$#" -gt 1 ]; do
  if [ "$1" = --output-last-message ]; then printf fixture > "$2"; exit 0; fi
  shift
done
exit 1
`, { mode: 0o700 });
  const { buildCodexExecArgs, runCodexExecCommand } = await import('../src/codex-exec.js');
  const { runConfiguredLocalCliToolAsCaller } = await import('../src/local-cli-tools.js');
  const request = { command, cwd: work, sandbox: 'workspace-write', prompt: 'fixture', extraEnv: { LAUNCH_FIXTURE_MARKER: marker } } as const;
  assert.throws(() => buildCodexExecArgs({ ...request, openAiLoopbackUrl: 'https://example.test/v1' }, marker), /Invalid Codex model endpoint/);
  assert.throws(() => buildCodexExecArgs({ ...request, openAiLoopbackUrl: 'http://secret@127.0.0.1/v1' }, marker), /Invalid Codex model endpoint/);
  assert.equal((await runCodexExecCommand(request)).text, 'fixture');
  assert.equal(await fs.readFile(marker, 'utf8'), 'launched');
  await fs.unlink(marker);

  const registry = path.join(config, 'workspace-dependencies.json');
  const cacheBinding = await pinWorkspacePath(root, cache);
  await fs.writeFile(registry, JSON.stringify({ version: 1, projects: [], caches: [{ scope: 'fixture', key: 'a'.repeat(64),
    ecosystem: 'pip', cache: cacheBinding, artifactManifestSha256: 'b'.repeat(64) }] }), { mode: 0o600 });
  // Protection applies to all launches, even when no projects opt in to dependency reuse.
  for (const extra of [{ cwd: cacheParent }, { additionalWritableDirs: [cache] }, { additionalWritableDirs: [config] }]) {
    await assert.rejects(runCodexExecCommand({ ...request, ...extra }), { code: 'dependency_write_overlap' });
  }
  await assert.rejects(runCodexExecCommand({ ...request, extraEnv: { ...request.extraEnv, CODEX_HOME: cache } }),
    { code: 'dependency_write_overlap' });
  await assert.rejects(runCodexExecCommand({ ...request, extraEnv: { ...request.extraEnv, CODEX_HOME: undefined } }),
    { code: 'dependency_runtime_home_required' });
  await assert.rejects(runCodexExecCommand({ ...request, extraEnv: { ...request.extraEnv, CODEX_SQLITE_HOME: cache } }),
    { code: 'dependency_launch_unsupported' });
  await assert.rejects(runCodexExecCommand({ ...request, sandbox: 'danger-full-access' }), { code: 'dependency_launch_unsupported' });
  await assert.rejects(runCodexExecCommand({ ...request, configOverrides: ['approval_policy="on-request"'] }), { code: 'dependency_launch_unsupported' });
  const scratch = path.join(work, 'run');
  const checkout = path.join(scratch, MANAGED_GIT_CHECKOUT_LEAF);
  const gitDirectory = path.join(checkout, '.git');
  const [source, objects] = ['source', 'git-cache'].map((name) => path.join(work, name));
  await Promise.all([gitDirectory, source, objects].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  const bind = (directory: string) => pinWorkspacePath(root, directory);
  const managedGitSandbox = await createManagedGitSandboxOptions({ mode: 'workspace-write', authorizedRoots: [root],
    source: await bind(source), cache: await bind(objects), scratch: await bind(scratch), artifacts: cacheBinding,
    checkout: { checkout: await bind(checkout), gitDirectory: await bind(gitDirectory) } });
  const managedRequest = { ...request, cwd: checkout, sandbox: undefined, managedGitSandbox, configOverrides: [...managedGitSandbox.overrides],
    ignoreUserConfig: true, strictConfig: true, validateManagedGitLaunch: async (command: string, env: NodeJS.ProcessEnv) => ({ command, env, prefix: [] }) };
  await assert.rejects(runCodexExecCommand(managedRequest), { code: 'dependency_write_overlap' });
  await assert.rejects(runCodexExecCommand({ ...managedRequest, configOverrides: [...managedRequest.configOverrides, 'approval_policy="on-request"'] }),
    { code: 'dependency_launch_unsupported' });
  await assert.rejects(runCodexExecCommand({ ...managedRequest, managedGitSandbox: { ...managedGitSandbox, writableDirectories: [] } }),
    { code: 'dependency_launch_unsupported' });
  await assert.rejects(runCodexExecCommand({ ...request, additionalWritableDirs: [scratch],
    extraEnv: { ...request.extraEnv, LARK_MANAGED_SCRATCH_DIR: scratch, TMPDIR: scratch },
    validateManagedGitLaunch: async (command, env) => {
      assert.equal(env.TMPDIR, scratch, 'the validated managed scratch is still the tool temp directory');
      return { command, prefix: [], env: { ...env, TMPDIR: cache } };
    } }), { code: 'dependency_launch_unsupported' });
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  process.env.TMPDIR = cache;
  await assert.rejects(runCodexExecCommand(request), { code: 'dependency_write_overlap' });
  const { createContinuationRuntime } = await import('../src/continuation/runtime.js');
  const dryRunOptions = { enabled: true, databasePath: path.join(home, 'unused.sqlite'),
    artifactsDir: path.join(home, 'unused-artifacts'), allowedWorkingRoot: work, maxAttempts: 5, maxRetries: 2,
    maxTotalMinutes: 30, timeoutMs: 60_000, retentionDays: 30, maxConcurrency: 1, configuredSandbox: 'workspace-write',
    getTransport: () => ({} as never), dryRun: true } as const;
  let dryRunError: unknown;
  const allocateTemporary = mock.method(fs, 'mkdtemp');
  try {
    const dryRun = await createContinuationRuntime({ ...dryRunOptions, reportError: (error) => { dryRunError = error; } });
    assert.equal(dryRun.health.available, false);
    assert.equal((dryRunError as { code?: string })?.code, 'dependency_write_overlap');
    assert.equal(allocateTemporary.mock.callCount(), 0, 'dry-run must not allocate before checking the cache boundary');
    await dryRun.close();
  } finally { allocateTemporary.mock.restore(); }
  assert.deepEqual(await fs.readdir(cache), [], 'output storage must not be allocated inside the protected cache');
  process.env.TMPDIR = work;
  await assert.rejects(runCodexExecCommand(request), { code: 'dependency_write_overlap' });
  process.env.TMPDIR = temp;
  const allowedDryRun = await createContinuationRuntime(dryRunOptions);
  try { assert.equal(allowedDryRun.health.available, true); }
  finally { await allowedDryRun.close(); }
  assert.deepEqual(await fs.readdir(temp), [], 'guarded dry-run removes only its owned temporary directory');
  const tool = await runConfiguredLocalCliToolAsCaller({ caller: 'ou_fixture', tool: 'fixture' });
  assert.equal(tool.ok, false);
  assert.equal(tool.failure?.subtype, 'dependency_host_cli_unavailable');
  const native = process.env.LARK_TEST_CODEX_NATIVE_BINARY;
  if (native) {
    const exec = promisify(execFile);
    const run = (file: string) => exec(native, ['sandbox', ...dependencyGuardSandboxOverrides([work], false)
      .flatMap((setting) => ['-c', setting]), '-P', DEPENDENCY_GUARD_PROFILE, '-C', work, '--', '/usr/bin/touch', file],
    { cwd: work, env: { HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', TMPDIR: temp }, timeout: 15_000 });
    const allowed = path.join(work, 'native-private-output');
    const blocked = path.join(cache, 'native-protected-output');
    await run(allowed);
    await fs.access(allowed);
    await assert.rejects(run(blocked));
    await assert.rejects(fs.access(blocked), { code: 'ENOENT' });
    console.log('workspace dependency native named profile: private write allowed, cache write denied');

    const fakeKey = 'sk-fixture-not-a-credential';
    await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: fakeKey }), { mode: 0o600 });
    const isolatedEnv = { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
      HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', OPENAI_API_KEY: fakeKey,
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1' };
    const runArtifacts = path.join(root, 'run-artifacts');
    await fs.mkdir(runArtifacts, { mode: 0o700 });
    const protectedGit = await createManagedGitSandboxOptions({ mode: 'workspace-write', authorizedRoots: [root],
      source: await bind(source), cache: await bind(objects), scratch: await bind(scratch), artifacts: await bind(runArtifacts),
      checkout: { checkout: await bind(checkout), gitDirectory: await bind(gitDirectory) } });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const modes = [ ['regular', request], ['managed-git', { ...managedRequest,
      managedGitSandbox: protectedGit, configOverrides: [...protectedGit.overrides] }] ] as const;
    for (const [mode, launchRequest] of modes) {
      let sessionId: string | null = null;
      for (const phase of ['start', 'resume']) {
        const privateFile = path.join(launchRequest.cwd, `exec-${mode}-${phase}`);
        const protectedFile = path.join(cache, `exec-${mode}-${phase}`);
        const success = `LARK_DEPENDENCY_BOUNDARY_${mode}_${phase}`;
        await probeCodexExecWithLoopback({ cwd: launchRequest.cwd, env: isolatedEnv, overrides: [], marker: success, authorization: `Bearer ${fakeKey}`,
          command: `/usr/bin/touch ${quote(privateFile)} && ! /usr/bin/touch ${quote(protectedFile)} && printf %s ${quote(success)}`,
          launch: async (_overrides, loopbackBaseUrl) => {
            const result = await runCodexExecCommand({ ...launchRequest, command: native, model: 'gpt-5.4', timeoutMs: 25_000,
              resumeSessionId: sessionId, openAiLoopbackUrl: loopbackBaseUrl, extraEnv: isolatedEnv });
            assert.ok(result.sessionId, 'actual Codex launch must return a reusable session ID');
            if (sessionId) assert.equal(result.sessionId, sessionId);
            sessionId = result.sessionId;
            return result.text;
          } });
        await fs.access(privateFile);
        await assert.rejects(fs.access(protectedFile), { code: 'ENOENT' });
      }
      console.log(`workspace dependency native ${mode} exec and resume: private write allowed, cache write denied`);
    }
  }
  console.log('workspace dependency launch smoke: PASS');
} finally { await fs.rm(root, { recursive: true, force: true }); }
