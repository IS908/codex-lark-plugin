import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { appConfig } = await import('../src/config.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { BotMessageTracker } = await import('../src/channel.js');
const { TurnObligationTracker } = await import('../src/turn-obligation.js');
const { MemoryStore } = await import('../src/memory/file.js');
const {
  createCodexExecActionDispatcher,
  parseCodexExecActionOutput,
} = await import('../src/codex-exec-actions.js');

const root = mkdtempSync(join(tmpdir(), 'codex-exec-actions-'));
const oldJobsDir = (appConfig as any).jobsDir;
const oldGithubIssueActionEnabled = (appConfig as any).githubIssueActionEnabled;
const oldGithubIssueDefaultRepo = (appConfig as any).githubIssueDefaultRepo;
const oldGithubIssueAllowedRepos = (appConfig as any).githubIssueAllowedRepos;
const oldGithubIssueCommand = (appConfig as any).githubIssueCommand;
const oldGithubIssueTimeoutMs = (appConfig as any).githubIssueTimeoutMs;
const oldGithubIssueMaxOutputBytes = (appConfig as any).githubIssueMaxOutputBytes;
const oldMockGhArgsPath = process.env.MOCK_GH_ARGS_PATH;
const oldMockGhFail = process.env.MOCK_GH_FAIL;
try {
  const jobsDir = join(root, 'jobs');
  const memoriesDir = join(root, 'memories');
  const localCliConfigPath = join(root, 'local-cli-tools.json');
  const mockGhArgsPath = join(root, 'mock-gh-args.json');
  const mockGhPath = join(root, 'mock-gh.cjs');
  (appConfig as any).jobsDir = jobsDir;
  (appConfig as any).githubIssueActionEnabled = true;
  (appConfig as any).githubIssueDefaultRepo = 'IS908/codex-lark-plugin';
  (appConfig as any).githubIssueAllowedRepos = ['IS908/codex-lark-plugin'];
  (appConfig as any).githubIssueCommand = mockGhPath;
  (appConfig as any).githubIssueTimeoutMs = 5_000;
  (appConfig as any).githubIssueMaxOutputBytes = 2048;
  process.env.MOCK_GH_ARGS_PATH = mockGhArgsPath;
  await mkdir(jobsDir, { recursive: true });
  writeFileSync(
    mockGhPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (process.env.MOCK_GH_FAIL === '1') {",
      "  console.error('mock gh failure token=secret');",
      '  process.exit(2);',
      '}',
      "fs.writeFileSync(process.env.MOCK_GH_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      "console.log('https://github.com/IS908/codex-lark-plugin/issues/999');",
      '',
    ].join('\n'),
    'utf-8',
  );
  chmodSync(mockGhPath, 0o755);
  writeFileSync(
    localCliConfigPath,
    JSON.stringify({
      tools: {
        echo: {
          command: '/bin/echo',
          fixedArgs: [],
          paramBlocklist: ['--secret'],
          envAllowlist: [],
          inheritEnv: false,
          allowedCallers: 'public',
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        },
      },
    }),
    'utf-8',
  );

  const parsed = parseCodexExecActionOutput([
    'Done.',
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        {
          type: 'save_memory',
          memory_type: 'profile',
          content: '- prefers concise updates',
          reason: 'Useful durable user preference',
          tier: 'private',
        },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(parsed.kind, 'actions');
  assert.equal(parsed.replyText, 'Done.');
  assert.equal(parsed.actions.length, 1);

  const invalid = parseCodexExecActionOutput('<LARK_ACTIONS_JSON>{"version":2,"actions":[]}</LARK_ACTIONS_JSON>');
  assert.equal(invalid.kind, 'invalid_actions');
  assert.match(invalid.error, /version/i);

  const recallParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [{ type: 'recall_message', message_id: 'om_bot_recall_action' }],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(recallParsed.kind, 'actions');
  assert.equal(recallParsed.actions[0].type, 'recall_message');

  const issueParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        {
          type: 'create_github_issue',
          title: 'Bridge should create issues',
          body: 'Issue body',
          labels: ['bug'],
        },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(issueParsed.kind, 'actions');
  assert.equal(issueParsed.actions[0].type, 'create_github_issue');

  const identitySession = new IdentitySession(() => 'ou_owner');
  identitySession.setCaller('oc_exec', 'thread_exec', 'ou_user');
  const dispatcher = createCodexExecActionDispatcher({
    memoryStore: new MemoryStore(memoriesDir),
    identitySession,
    localCliToolsConfigPath: localCliConfigPath,
  });

  const results = await dispatcher.execute({
    message: {
      messageId: 'om_exec',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'remember this and create a job',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'save_memory',
        memory_type: 'profile',
        content: '- prefers concise updates',
        reason: 'Useful durable user preference',
        tier: 'private',
      },
      {
        type: 'create_job',
        name: 'Exec Action Job',
        job_type: 'message',
        schedule: 'daily at 09:00',
        content: 'standup reminder',
        target_chat_id: 'oc_exec',
      },
      {
        type: 'run_local_cli_tool',
        tool: 'echo',
        args: ['hello-from-action'],
      },
      {
        type: 'create_github_issue',
        title: 'Lark action issue',
        body: 'Issue body from exec action',
        labels: ['bug', 'enhancement'],
      },
    ],
  });

  assert.equal(results.length, 4);
  assert.ok(results.every((result: any) => result.ok), JSON.stringify(results));
  const privateProfile = readFileSync(join(memoriesDir, 'profiles', 'ou_user', 'private.md'), 'utf-8');
  assert.match(privateProfile, /prefers concise updates/);
  assert.equal(existsSync(join(jobsDir, 'exec-action-job.json')), true);
  assert.match(results[2].message, /hello-from-action/);
  assert.match(results[3].message, /https:\/\/github\.com\/IS908\/codex-lark-plugin\/issues\/999/);
  const ghArgs = JSON.parse(readFileSync(mockGhArgsPath, 'utf-8'));
  assert.deepEqual(ghArgs.slice(0, 6), [
    'issue',
    'create',
    '--repo',
    'IS908/codex-lark-plugin',
    '--title',
    'Lark action issue',
  ]);
  assert.ok(ghArgs.includes('--body'));
  assert.ok(ghArgs.includes('Issue body from exec action'));
  assert.ok(ghArgs.includes('--label'));
  assert.ok(ghArgs.includes('bug'));
  assert.ok(ghArgs.includes('enhancement'));

  (appConfig as any).githubIssueActionEnabled = false;
  const disabledIssue = await dispatcher.execute({
    message: {
      messageId: 'om_exec_issue_disabled',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create issue',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'create_github_issue', title: 'Disabled', body: 'Disabled body' }],
  });
  assert.equal(disabledIssue[0].ok, false);
  assert.match(disabledIssue[0].message, /disabled/i);
  (appConfig as any).githubIssueActionEnabled = true;

  const deniedRepoIssue = await dispatcher.execute({
    message: {
      messageId: 'om_exec_issue_denied_repo',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create issue in another repo',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'create_github_issue', repo: 'Other/repo', title: 'Denied', body: 'Denied body' }],
  });
  assert.equal(deniedRepoIssue[0].ok, false);
  assert.match(deniedRepoIssue[0].message, /not in LARK_GITHUB_ALLOWED_REPOS/i);

  (appConfig as any).githubIssueDefaultRepo = null;
  (appConfig as any).githubIssueAllowedRepos = [];
  const missingRepoPolicyIssue = await dispatcher.execute({
    message: {
      messageId: 'om_exec_issue_missing_policy',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create issue with no repo policy',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'create_github_issue', repo: 'IS908/codex-lark-plugin', title: 'Missing policy', body: 'Missing policy body' }],
  });
  assert.equal(missingRepoPolicyIssue[0].ok, false);
  assert.match(missingRepoPolicyIssue[0].message, /DEFAULT_REPO or LARK_GITHUB_ALLOWED_REPOS/i);
  (appConfig as any).githubIssueDefaultRepo = 'IS908/codex-lark-plugin';
  (appConfig as any).githubIssueAllowedRepos = ['IS908/codex-lark-plugin'];

  process.env.MOCK_GH_FAIL = '1';
  const failedCommandIssue = await dispatcher.execute({
    message: {
      messageId: 'om_exec_issue_command_failed',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create issue but command fails',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'create_github_issue', title: 'Command failed', body: 'Command failed body' }],
  });
  assert.equal(failedCommandIssue[0].ok, false);
  assert.match(failedCommandIssue[0].message, /exit_code=2/);
  assert.doesNotMatch(failedCommandIssue[0].message, /secret/);
  delete process.env.MOCK_GH_FAIL;

  const recallCalls: string[] = [];
  const botTracker = new BotMessageTracker(10);
  botTracker.add('om_bot_recall_action', { chatId: 'oc_exec', threadId: 'thread_exec' });
  const turnObligations = new TurnObligationTracker({ timeoutMs: 60_000 });
  turnObligations.begin({
    messageId: 'om_exec_recall_turn',
    chatId: 'oc_exec',
    threadId: 'thread_exec',
    caller: 'ou_user',
    mode: 'exec',
  });
  const recallDispatcher = createCodexExecActionDispatcher({
    memoryStore: new MemoryStore(memoriesDir),
    identitySession,
    localCliToolsConfigPath: localCliConfigPath,
    botMessageTracker: botTracker,
    turnObligations,
    larkTransport: {
      recallMessage: async (messageId: string) => {
        recallCalls.push(messageId);
      },
    } as any,
  });
  const recallResults = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_turn',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall that bot message',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_bot_recall_action' }],
  });
  assert.deepEqual(recallCalls, ['om_bot_recall_action']);
  assert.equal(recallResults.length, 1);
  assert.equal(recallResults[0].ok, true);
  assert.equal(turnObligations.getStatus('om_exec_recall_turn'), 'satisfied');

  const deniedRecall = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_denied',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall unknown',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_unknown' }],
  });
  assert.equal(deniedRecall[0].ok, false);
  assert.match(deniedRecall[0].message, /not a tracked bot message/i);

  botTracker.add('om_bot_other_scope', { chatId: 'oc_other', threadId: 'thread_exec' });
  const wrongScopeRecall = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_wrong_scope',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall wrong scope',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_bot_other_scope' }],
  });
  assert.equal(wrongScopeRecall[0].ok, false);
  assert.match(
    wrongScopeRecall[0].message,
    /recall_message denied: om_bot_other_scope belongs to chat=oc_other thread=thread_exec, does not belong to chat=oc_exec thread=thread_exec/i,
  );
} finally {
  (appConfig as any).jobsDir = oldJobsDir;
  (appConfig as any).githubIssueActionEnabled = oldGithubIssueActionEnabled;
  (appConfig as any).githubIssueDefaultRepo = oldGithubIssueDefaultRepo;
  (appConfig as any).githubIssueAllowedRepos = oldGithubIssueAllowedRepos;
  (appConfig as any).githubIssueCommand = oldGithubIssueCommand;
  (appConfig as any).githubIssueTimeoutMs = oldGithubIssueTimeoutMs;
  (appConfig as any).githubIssueMaxOutputBytes = oldGithubIssueMaxOutputBytes;
  if (oldMockGhArgsPath === undefined) delete process.env.MOCK_GH_ARGS_PATH;
  else process.env.MOCK_GH_ARGS_PATH = oldMockGhArgsPath;
  if (oldMockGhFail === undefined) delete process.env.MOCK_GH_FAIL;
  else process.env.MOCK_GH_FAIL = oldMockGhFail;
  rmSync(root, { recursive: true, force: true });
}

console.log('codex-exec-actions smoke: PASS');
