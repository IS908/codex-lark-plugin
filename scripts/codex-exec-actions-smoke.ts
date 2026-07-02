import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CRON_TIMEZONE = 'Asia/Shanghai';

const { appConfig } = await import('../src/config.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { BotMessageTracker } = await import('../src/channel.js');
const { TurnObligationTracker } = await import('../src/turn-obligation.js');
const { MemoryStore } = await import('../src/memory/file.js');
const { readIssueProposal } = await import('../src/issue-proposal-store.js');
const {
  createCodexExecActionDispatcher,
  parseCodexExecActionOutput,
} = await import('../src/codex-exec-actions.js');

const root = mkdtempSync(join(tmpdir(), 'codex-exec-actions-'));
const oldJobsDir = (appConfig as any).jobsDir;
const oldIssueProposalsDir = (appConfig as any).issueProposalsDir;
try {
  const jobsDir = join(root, 'jobs');
  const issueProposalsDir = join(root, 'issue-proposals');
  const memoriesDir = join(root, 'memories');
  const localCliConfigPath = join(root, 'local-cli-tools.json');
  const fakeIssueCreateScript = join(root, 'fake-gh-issue-create.js');
  (appConfig as any).jobsDir = jobsDir;
  (appConfig as any).issueProposalsDir = issueProposalsDir;
  await mkdir(jobsDir, { recursive: true });
  writeFileSync(
    fakeIssueCreateScript,
    [
      'const args = process.argv.slice(2);',
      'if (!args.some((arg) => arg.startsWith("--repo="))) process.exit(2);',
      'if (!args.some((arg) => arg.startsWith("--title="))) process.exit(3);',
      'if (!args.some((arg) => arg.includes("Authorization Required"))) process.exit(4);',
      'console.log("https://github.com/IS908/codex-lark-plugin/issues/654");',
    ].join('\n'),
    'utf-8',
  );
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
        gh_issue_create: {
          command: process.execPath,
          fixedArgs: [fakeIssueCreateScript],
          paramAllowlist: ['--repo', '--title', '--body'],
          envAllowlist: [],
          inheritEnv: false,
          allowedCallers: 'public',
          timeoutMs: 5000,
          maxOutputBytes: 4096,
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

  const missingScheduleParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        {
          type: 'create_job',
          name: 'Missing schedule',
          job_type: 'message',
          content: 'standup reminder',
        },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(missingScheduleParsed.kind, 'invalid_actions');
  assert.match(missingScheduleParsed.error, /actions\.0\.schedule/i);

  for (const schedule of ['once', 'now', 'later']) {
    const unsupportedScheduleParsed = parseCodexExecActionOutput([
      '<LARK_ACTIONS_JSON>',
      JSON.stringify({
        version: 1,
        actions: [
          {
            type: 'create_job',
            name: `Unsupported ${schedule}`,
            job_type: 'message',
            schedule,
            content: 'standup reminder',
          },
        ],
      }),
      '</LARK_ACTIONS_JSON>',
    ].join('\n'));
    assert.equal(unsupportedScheduleParsed.kind, 'invalid_actions');
    assert.match(unsupportedScheduleParsed.error, /unsupported schedule/i);
    assert.match(unsupportedScheduleParsed.error, /daily at 09:00/i);
  }

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

  const proposalParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        {
          type: 'create_issue_proposal',
          title: 'Periodic review found missing Feishu delivery',
          body: 'A cronjob generated a report but did not deliver it to Feishu.',
          evidence: ['run_status=success', 'delivery_status=failed'],
          impact: 'Users cannot see scheduled reports.',
          priority: 'P1',
          automation_level: 'discovery-only',
          target_repo: 'IS908/codex-lark-plugin',
          target_chat_id: 'oc_exec',
        },
        { type: 'list_issue_proposals', status: 'pending' },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(proposalParsed.kind, 'actions');
  if (proposalParsed.kind !== 'actions') throw new Error('proposalParsed should be actions');
  assert.deepEqual(
    proposalParsed.actions.map((action: any) => action.type),
    ['create_issue_proposal', 'list_issue_proposals'],
  );

  const unsupportedIssueParsed = parseCodexExecActionOutput([
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
  assert.equal(unsupportedIssueParsed.kind, 'invalid_actions');
  assert.match(unsupportedIssueParsed.error, /create_github_issue|Invalid discriminator/i);

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
    ],
  });

  assert.equal(results.length, 3);
  assert.ok(results.every((result: any) => result.ok), JSON.stringify(results));
  assert.match(results[1].message, /job_id: exec-action-job/i);
  assert.match(results[1].message, /Next run: .*Asia\/Shanghai; UTC /);
  const privateProfile = readFileSync(join(memoriesDir, 'profiles', 'ou_user', 'private.md'), 'utf-8');
  assert.match(privateProfile, /prefers concise updates/);
  assert.equal(existsSync(join(jobsDir, 'exec-action-job.json')), true);
  assert.match(results[2].message, /hello-from-action/);

  const proposalResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_proposal',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create issue proposal',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: proposalParsed.actions,
  });
  assert.equal(proposalResults.length, 2);
  assert.ok(proposalResults.every((result: any) => result.ok), JSON.stringify(proposalResults));
  const proposalId = proposalResults[0].message.match(/proposal-[a-zA-Z0-9-]+/)?.[0];
  assert.ok(proposalId, proposalResults[0].message);
  assert.match(proposalResults[1].message, new RegExp(proposalId));
  const proposalFile = await readIssueProposal(proposalId);
  assert.equal(proposalFile?.meta.status, 'pending');

  const createIssueResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_create_issue',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'approve issue proposal',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'create_issue_from_proposal', id: proposalId }],
  });
  assert.equal(createIssueResults.length, 1);
  assert.equal(createIssueResults[0].ok, true, JSON.stringify(createIssueResults));
  assert.match(createIssueResults[0].message, /https:\/\/github\.com\/IS908\/codex-lark-plugin\/issues\/654/);
  const createdProposal = await readIssueProposal(proposalId);
  assert.equal(createdProposal?.meta.status, 'created');
  assert.equal(createdProposal?.meta.github_issue_number, 654);

  const jobManagementParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        { type: 'list_jobs', status: 'all' },
        { type: 'update_job', name: 'Exec Action Job', content: 'updated reminder', schedule: 'weekdays at 10:00' },
        { type: 'disable_job', job_id: 'exec-action-job' },
        {
          type: 'upsert_job',
          name: 'Exec Action Job',
          job_type: 'message',
          schedule: 'daily at 11:00',
          content: 'upserted reminder',
          target_chat_id: 'oc_exec',
        },
        { type: 'delete_job', job_id: 'exec-action-job' },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(jobManagementParsed.kind, 'actions');
  if (jobManagementParsed.kind !== 'actions') {
    throw new Error(`expected job management actions, got ${JSON.stringify(jobManagementParsed)}`);
  }
  assert.deepEqual(
    jobManagementParsed.actions.map((action: any) => action.type),
    ['list_jobs', 'update_job', 'disable_job', 'upsert_job', 'delete_job'],
  );
  const defaultReviewJobsParsed = parseCodexExecActionOutput([
    '<LARK_ACTIONS_JSON>',
    JSON.stringify({
      version: 1,
      actions: [
        { type: 'create_default_review_jobs', target_repo: 'IS908/codex-lark-plugin', target_chat_id: 'oc_exec' },
      ],
    }),
    '</LARK_ACTIONS_JSON>',
  ].join('\n'));
  assert.equal(defaultReviewJobsParsed.kind, 'actions');
  if (defaultReviewJobsParsed.kind !== 'actions') {
    throw new Error(`expected default review job action, got ${JSON.stringify(defaultReviewJobsParsed)}`);
  }
  const defaultReviewJobResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_default_review_jobs',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'create default review jobs',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: defaultReviewJobsParsed.actions,
  });
  assert.equal(defaultReviewJobResults.length, 1);
  assert.equal(defaultReviewJobResults[0].ok, true, JSON.stringify(defaultReviewJobResults));
  assert.match(defaultReviewJobResults[0].message, /disabled by default/i);
  assert.equal(JSON.parse(readFileSync(join(jobsDir, 'plugin-self-review.json'), 'utf-8')).meta.status, 'paused');
  assert.equal(JSON.parse(readFileSync(join(jobsDir, 'plugin-low-risk-auto-fix.json'), 'utf-8')).meta.status, 'paused');
  const jobManagementResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_jobs',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'manage the reminder',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: jobManagementParsed.actions,
  });
  assert.equal(jobManagementResults.length, 5);
  assert.ok(jobManagementResults.every((result: any) => result.ok), JSON.stringify(jobManagementResults));
  assert.match(jobManagementResults[0].message, /exec-action-job/);
  assert.match(jobManagementResults[0].message, /standup reminder/);
  assert.match(jobManagementResults[1].message, /Updated job "exec-action-job"/);
  assert.match(jobManagementResults[1].message, /weekdays at 10:00/);
  assert.match(jobManagementResults[1].message, /Next run: .*Asia\/Shanghai; UTC /);
  assert.match(jobManagementResults[2].message, /Status: paused/i);
  assert.match(jobManagementResults[3].message, /Upserted job "exec-action-job"/);
  assert.match(jobManagementResults[3].message, /daily at 11:00/);
  assert.match(jobManagementResults[3].message, /Next run: .*Asia\/Shanghai; UTC /);
  assert.match(jobManagementResults[4].message, /Deleted job "exec-action-job"/);
  assert.equal(existsSync(join(jobsDir, 'exec-action-job.json')), false);

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
  (appConfig as any).issueProposalsDir = oldIssueProposalsDir;
  rmSync(root, { recursive: true, force: true });
}

console.log('codex-exec-actions smoke: PASS');
