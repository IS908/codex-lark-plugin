/**
 * Issue proposal store smoke tests.
 *
 * Verifies the durable proposal lifecycle used by periodic reviews before
 * any GitHub issue is created.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../src/config.js';
import {
  createIssueProposal,
  formatIssueProposalForList,
  formatIssueProposalPullRequestBody,
  listIssueProposals,
  markIssueProposalCreated,
  markIssueProposalPullRequestCreated,
  readIssueProposal,
  rejectIssueProposal,
} from '../src/issue-proposal-store.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const dir = mkdtempSync(join(tmpdir(), 'issue-proposal-store-smoke-'));
const originalDir = (appConfig as { issueProposalsDir?: string }).issueProposalsDir;
(appConfig as { issueProposalsDir: string }).issueProposalsDir = dir;

try {
  const created = await createIssueProposal({
    title: 'Cron report did not reach Feishu',
    body: 'The scheduled report produced output but users could not see it.',
    evidence: ['runtime.output_status=generated', 'delivery_status=failed'],
    impact: 'Users miss scheduled reports.',
    priority: 'P1',
    automationLevel: 'discovery-only',
    targetRepo: 'IS908/codex-lark-plugin',
    targetChatId: 'oc_review',
    originChatId: 'oc_origin',
    createdBy: 'ou_owner',
    now: new Date('2026-07-02T10:00:00.000Z'),
  });

  if (created.meta.id !== 'proposal-20260702100000-cron-report-did-not-reach-feishu') {
    fail(`1: unexpected id ${created.meta.id}`);
  }
  if (created.meta.status !== 'pending') fail(`1: expected pending, got ${created.meta.status}`);
  if (created.meta.priority !== 'P1') fail(`1: expected P1, got ${created.meta.priority}`);
  passed++;

  const loaded = await readIssueProposal(created.meta.id);
  if (!loaded || loaded.meta.title !== created.meta.title) fail('2: read proposal did not round-trip');
  passed++;

  const pending = await listIssueProposals({ status: 'pending', targetChatId: 'oc_review' });
  if (pending.length !== 1 || pending[0].meta.id !== created.meta.id) {
    fail(`3: pending list mismatch ${JSON.stringify(pending)}`);
  }
  const noneForOtherChat = await listIssueProposals({ status: 'pending', targetChatId: 'oc_other' });
  if (noneForOtherChat.length !== 0) fail(`3: targetChatId filter leaked proposals ${noneForOtherChat.length}`);
  passed++;

  const marked = await markIssueProposalCreated(created.meta.id, {
    approvedBy: 'ou_owner',
    githubIssueUrl: 'https://github.com/IS908/codex-lark-plugin/issues/999',
    githubIssueNumber: 999,
    now: new Date('2026-07-02T10:05:00.000Z'),
  });
  if (!marked) fail('4: mark created returned null');
  if (marked.meta.status !== 'created') fail(`4: expected created, got ${marked.meta.status}`);
  if (marked.meta.github_issue_url !== 'https://github.com/IS908/codex-lark-plugin/issues/999') {
    fail(`4: issue url missing ${JSON.stringify(marked.meta)}`);
  }
  passed++;

  const secondMark = await markIssueProposalCreated(created.meta.id, {
    approvedBy: 'ou_owner',
    githubIssueUrl: 'https://github.com/IS908/codex-lark-plugin/issues/1000',
    githubIssueNumber: 1000,
    now: new Date('2026-07-02T10:06:00.000Z'),
  });
  if (!secondMark) fail('5: second mark returned null');
  if (secondMark.meta.github_issue_number !== 999) {
    fail(`5: created proposal should be idempotent, got ${secondMark.meta.github_issue_number}`);
  }
  passed++;

  const prBody = formatIssueProposalPullRequestBody(marked);
  if (!prBody.includes('issue-proposal-id: proposal-20260702100000-cron-report-did-not-reach-feishu')) {
    fail(`6: PR body missing proposal marker: ${prBody}`);
  }
  if (!prBody.includes('https://github.com/IS908/codex-lark-plugin/issues/999')) {
    fail(`6: PR body missing linked issue: ${prBody}`);
  }
  if (!prBody.includes('must not be merged or released automatically')) {
    fail(`6: PR body missing automation boundary: ${prBody}`);
  }
  const prMarked = await markIssueProposalPullRequestCreated(created.meta.id, {
    approvedBy: 'ou_owner',
    githubPullRequestUrl: 'https://github.com/IS908/codex-lark-plugin/pull/1001',
    now: new Date('2026-07-02T10:07:00.000Z'),
  });
  if (!prMarked) fail('6: mark PR created returned null');
  if (prMarked.meta.github_pr_url !== 'https://github.com/IS908/codex-lark-plugin/pull/1001') {
    fail(`6: PR url missing ${JSON.stringify(prMarked.meta)}`);
  }
  if (prMarked.meta.github_pr_number !== 1001) {
    fail(`6: expected PR number 1001, got ${prMarked.meta.github_pr_number}`);
  }
  passed++;

  const duplicateTitle = await createIssueProposal({
    title: 'Cron report did not reach Feishu',
    body: 'Same title and timestamp should not overwrite the first proposal.',
    priority: 'P2',
    automationLevel: 'discovery-only',
    targetRepo: 'IS908/codex-lark-plugin',
    targetChatId: 'oc_review',
    originChatId: 'oc_origin',
    createdBy: 'ou_owner',
    now: new Date('2026-07-02T10:00:00.000Z'),
  });
  if (duplicateTitle.meta.id !== 'proposal-20260702100000-cron-report-did-not-reach-feishu-2') {
    fail(`7: duplicate id should get suffix, got ${duplicateTitle.meta.id}`);
  }
  const originalAfterDuplicate = await readIssueProposal(created.meta.id);
  if (originalAfterDuplicate?.meta.github_issue_number !== 999) {
    fail('7: duplicate proposal overwrote the original');
  }
  passed++;

  const rejected = await createIssueProposal({
    title: 'Noisy duplicate finding',
    body: 'Duplicate of an existing issue.',
    priority: 'P3',
    automationLevel: 'discovery-only',
    targetRepo: 'IS908/codex-lark-plugin',
    targetChatId: 'oc_review',
    originChatId: 'oc_origin',
    createdBy: 'ou_owner',
    now: new Date('2026-07-02T11:00:00.000Z'),
  });
  const rejectedResult = await rejectIssueProposal(rejected.meta.id, {
    rejectedBy: 'ou_owner',
    reason: 'Duplicate of #999.',
    now: new Date('2026-07-02T11:05:00.000Z'),
  });
  if (!rejectedResult || rejectedResult.meta.status !== 'rejected') fail('8: reject did not persist status');
  if (rejectedResult.meta.rejection_reason !== 'Duplicate of #999.') fail('8: reject did not persist reason');
  passed++;

  const summary = formatIssueProposalForList(prMarked);
  if (!summary.includes('proposal-20260702100000-cron-report-did-not-reach-feishu')) fail(`9: summary missing id: ${summary}`);
  if (!summary.includes('created')) fail(`9: summary missing status: ${summary}`);
  if (!summary.includes('https://github.com/IS908/codex-lark-plugin/issues/999')) fail(`9: summary missing issue URL: ${summary}`);
  if (!summary.includes('https://github.com/IS908/codex-lark-plugin/pull/1001')) fail(`9: summary missing PR URL: ${summary}`);
  passed++;
} finally {
  if (originalDir === undefined) {
    delete (appConfig as { issueProposalsDir?: string }).issueProposalsDir;
  } else {
    (appConfig as { issueProposalsDir: string }).issueProposalsDir = originalDir;
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`issue-proposal-store smoke: ${passed}/9 PASS`);
