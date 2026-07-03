/**
 * Issue proposal MCP tool smoke tests.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import { readIssueProposal } from '../src/issue-proposal-store.js';
import type { LarkChannel } from '../src/channel.js';
import {
  createMockLarkClient,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} from './test-helpers/tool-fixtures.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const dir = mkdtempSync(join(tmpdir(), 'issue-proposal-tools-smoke-'));
const proposalsDir = join(dir, 'proposals');
const cliConfigPath = join(dir, 'local-cli-tools.json');
const cliScriptPath = join(dir, 'fake-gh-issue-create.js');
const cliPrScriptPath = join(dir, 'fake-gh-pr-create.js');
const cliCallsPath = join(dir, 'calls.json');
const cliPrCallsPath = join(dir, 'pr-calls.json');
const originalProposalsDir = (appConfig as { issueProposalsDir?: string }).issueProposalsDir;
const originalCliConfigPath = appConfig.localCliToolsConfigPath;
const originalOwner = appConfig.ownerOpenId;

(appConfig as { issueProposalsDir: string }).issueProposalsDir = proposalsDir;
(appConfig as { localCliToolsConfigPath: string }).localCliToolsConfigPath = cliConfigPath;
(appConfig as { ownerOpenId: string }).ownerOpenId = 'ou_owner';

writeFileSync(
  cliScriptPath,
  [
    'const fs = require("node:fs");',
    'const callsPath = process.env.CALLS_PATH;',
    'const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, "utf8")) : [];',
    'calls.push(process.argv.slice(2));',
    'fs.writeFileSync(callsPath, JSON.stringify(calls, null, 2));',
    'console.log("https://github.com/IS908/codex-lark-plugin/issues/321");',
  ].join('\n'),
);
writeFileSync(
  cliPrScriptPath,
  [
    'const fs = require("node:fs");',
    'const callsPath = process.env.PR_CALLS_PATH;',
    'const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, "utf8")) : [];',
    'calls.push(process.argv.slice(2));',
    'fs.writeFileSync(callsPath, JSON.stringify(calls, null, 2));',
    'console.log("https://github.com/IS908/codex-lark-plugin/pull/654");',
  ].join('\n'),
);
writeFileSync(
  cliConfigPath,
  JSON.stringify(
    {
      tools: {
        gh_issue_create: {
          command: process.execPath,
          fixedArgs: [cliScriptPath],
          paramAllowlist: ['--repo', '--title', '--body'],
          envAllowlist: [],
          env: { CALLS_PATH: cliCallsPath },
          inheritEnv: false,
          timeoutMs: 5000,
          maxOutputBytes: 4096,
          allowedCallers: 'owners',
        },
        gh_low_risk_pr_create: {
          command: process.execPath,
          fixedArgs: [cliPrScriptPath],
          paramAllowlist: ['--repo', '--proposal-id', '--issue', '--title', '--body'],
          envAllowlist: [],
          env: { PR_CALLS_PATH: cliPrCallsPath },
          inheritEnv: false,
          timeoutMs: 5000,
          maxOutputBytes: 4096,
          allowedCallers: 'owners',
        },
      },
    },
    null,
    2,
  ),
);

try {
  const { server: fakeServer, getTool } = createToolServerHarness();
  const identity = new IdentitySession(() => null);
  identity.setCaller('chat_owner', 'thread_owner', 'ou_owner');
  identity.setCaller('chat_other', 'thread_other', 'ou_other');

  registerTools(
    fakeServer as any,
    createMockLarkClient() as any,
    createNoopMemoryStore(),
    identity,
    createPrivateChatChannel() as unknown as LarkChannel,
  );

  const createProposal = getTool('create_issue_proposal');
  const listProposals = getTool('list_issue_proposals');
  const createIssue = getTool('create_issue_from_proposal');
  const createPr = getTool('create_low_risk_pr_from_proposal');
  const rejectProposal = getTool('reject_issue_proposal');

  const created = await createProposal({
    title: 'Scheduled review found a delivery gap',
    body: 'Cronjob output was generated but did not reach Feishu.',
    evidence: ['run_status=success', 'delivery_status=failed'],
    impact: 'Users cannot see scheduled reports.',
    priority: 'P1',
    automation_level: 'discovery-only',
    target_repo: 'IS908/codex-lark-plugin',
    target_chat_id: 'chat_owner',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  if (created.isError) fail(`1: create_issue_proposal failed ${JSON.stringify(created)}`);
  const createdText = created.content[0].text;
  const id = createdText.match(/proposal-[a-zA-Z0-9-]+/)?.[0];
  if (!id) fail(`1: create response missing proposal id: ${createdText}`);
  passed++;

  const listed = await listProposals({ status: 'pending', chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (listed.isError) fail(`2: list_issue_proposals failed ${JSON.stringify(listed)}`);
  const listText = listed.content[0].text;
  if (!listText.includes(id) || !listText.includes('Scheduled review found a delivery gap')) {
    fail(`2: pending list missing proposal ${id}: ${listText}`);
  }
  passed++;

  const denied = await createIssue({ id, chat_id: 'chat_other', thread_id: 'thread_other' });
  if (!denied.isError) fail(`3: non-owner should not create issue, got ${JSON.stringify(denied)}`);
  const stillPending = await readIssueProposal(id);
  if (stillPending?.meta.status !== 'pending') fail(`3: denied create changed status ${stillPending?.meta.status}`);
  passed++;

  const issue = await createIssue({ id, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (issue.isError) fail(`4: create_issue_from_proposal failed ${JSON.stringify(issue)}`);
  const issueText = issue.content[0].text;
  if (!issueText.includes('https://github.com/IS908/codex-lark-plugin/issues/321')) {
    fail(`4: create response missing issue URL: ${issueText}`);
  }
  const persisted = await readIssueProposal(id);
  if (persisted?.meta.status !== 'created') fail(`4: expected created, got ${persisted?.meta.status}`);
  if (persisted?.meta.github_issue_number !== 321) fail(`4: expected issue number 321, got ${persisted?.meta.github_issue_number}`);
  const calls = JSON.parse(readFileSync(cliCallsPath, 'utf-8')) as string[][];
  if (calls.length !== 1) fail(`4: expected one CLI call, got ${calls.length}`);
  if (!calls[0].some((arg) => arg === '--repo=IS908/codex-lark-plugin')) fail(`4: repo arg missing ${JSON.stringify(calls[0])}`);
  if (!calls[0].some((arg) => arg.startsWith('--title=Scheduled review'))) fail(`4: title arg missing ${JSON.stringify(calls[0])}`);
  if (!calls[0].some((arg) => arg.includes('Authorization Required'))) fail(`4: body arg missing authorization section ${JSON.stringify(calls[0])}`);
  passed++;

  const duplicate = await createIssue({ id, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (duplicate.isError) fail(`5: idempotent create should succeed ${JSON.stringify(duplicate)}`);
  const callsAfterDuplicate = JSON.parse(readFileSync(cliCallsPath, 'utf-8')) as string[][];
  if (callsAfterDuplicate.length !== 1) fail(`5: duplicate create should not call CLI again, got ${callsAfterDuplicate.length}`);
  passed++;

  const discoveryOnlyPr = await createPr({ id, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (!discoveryOnlyPr.isError) fail(`6: discovery-only proposal should not create PR, got ${JSON.stringify(discoveryOnlyPr)}`);
  passed++;

  const lowRisk = await createProposal({
    title: 'Docs mention stale version badge',
    body: 'README version badge can drift from package metadata.',
    evidence: ['README.md badge differs from package.json'],
    priority: 'P3',
    automation_level: 'low-risk-auto-pr-eligible',
    target_repo: 'IS908/codex-lark-plugin',
    target_chat_id: 'chat_owner',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  const lowRiskId = lowRisk.content[0].text.match(/proposal-[a-zA-Z0-9-]+/)?.[0];
  if (!lowRiskId) fail(`7: missing low-risk proposal id ${JSON.stringify(lowRisk)}`);
  const lowRiskBeforeIssue = await createPr({ id: lowRiskId, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (!lowRiskBeforeIssue.isError) fail(`7: PR creation should require a linked issue, got ${JSON.stringify(lowRiskBeforeIssue)}`);
  const lowRiskIssue = await createIssue({ id: lowRiskId, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (lowRiskIssue.isError) fail(`7: create low-risk issue failed ${JSON.stringify(lowRiskIssue)}`);
  passed++;

  const pr = await createPr({ id: lowRiskId, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (pr.isError) fail(`8: create_low_risk_pr_from_proposal failed ${JSON.stringify(pr)}`);
  const prText = pr.content[0].text;
  if (!prText.includes('https://github.com/IS908/codex-lark-plugin/pull/654')) {
    fail(`8: create PR response missing PR URL: ${prText}`);
  }
  const lowRiskPersisted = await readIssueProposal(lowRiskId);
  if (lowRiskPersisted?.meta.github_pr_number !== 654) {
    fail(`8: expected PR number 654, got ${lowRiskPersisted?.meta.github_pr_number}`);
  }
  const prCalls = JSON.parse(readFileSync(cliPrCallsPath, 'utf-8')) as string[][];
  if (prCalls.length !== 1) fail(`8: expected one PR CLI call, got ${prCalls.length}`);
  if (!prCalls[0].some((arg) => arg === `--proposal-id=${lowRiskId}`)) fail(`8: proposal id arg missing ${JSON.stringify(prCalls[0])}`);
  if (!prCalls[0].some((arg) => arg === '--issue=https://github.com/IS908/codex-lark-plugin/issues/321')) {
    fail(`8: linked issue arg missing ${JSON.stringify(prCalls[0])}`);
  }
  if (!prCalls[0].some((arg) => arg.startsWith('--title=[auto-review] Docs mention stale version badge'))) {
    fail(`8: auto-review title missing ${JSON.stringify(prCalls[0])}`);
  }
  if (!prCalls[0].some((arg) => arg.includes('must not be merged or released automatically'))) {
    fail(`8: PR body missing safety boundary ${JSON.stringify(prCalls[0])}`);
  }
  passed++;

  const duplicatePr = await createPr({ id: lowRiskId, chat_id: 'chat_owner', thread_id: 'thread_owner' });
  if (duplicatePr.isError) fail(`9: idempotent PR create should succeed ${JSON.stringify(duplicatePr)}`);
  const prCallsAfterDuplicate = JSON.parse(readFileSync(cliPrCallsPath, 'utf-8')) as string[][];
  if (prCallsAfterDuplicate.length !== 1) fail(`9: duplicate PR create should not call CLI again, got ${prCallsAfterDuplicate.length}`);
  passed++;

  const rejected = await createProposal({
    title: 'Duplicate noisy finding',
    body: 'This should be rejected.',
    target_repo: 'IS908/codex-lark-plugin',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  const rejectedId = rejected.content[0].text.match(/proposal-[a-zA-Z0-9-]+/)?.[0];
  if (!rejectedId) fail(`10: missing rejected proposal id ${JSON.stringify(rejected)}`);
  const rejectedResult = await rejectProposal({
    id: rejectedId,
    reason: 'Duplicate of an existing issue.',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  if (rejectedResult.isError) fail(`10: reject_issue_proposal failed ${JSON.stringify(rejectedResult)}`);
  const rejectedPersisted = await readIssueProposal(rejectedId);
  if (rejectedPersisted?.meta.status !== 'rejected') fail(`10: expected rejected, got ${rejectedPersisted?.meta.status}`);
  passed++;
} finally {
  if (originalProposalsDir === undefined) {
    delete (appConfig as { issueProposalsDir?: string }).issueProposalsDir;
  } else {
    (appConfig as { issueProposalsDir: string }).issueProposalsDir = originalProposalsDir;
  }
  (appConfig as { localCliToolsConfigPath: string }).localCliToolsConfigPath = originalCliConfigPath;
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = originalOwner;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`issue-proposal-tools smoke: ${passed}/10 PASS`);
