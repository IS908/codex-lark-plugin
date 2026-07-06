import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import { createCodexExecActionDispatcher } from '../src/codex-exec-actions.js';
import { readIssueProposal, type IssueProposalFile } from '../src/issue-proposal-store.js';
import type { LarkChannel } from '../src/channel.js';
import {
  createMockLarkClient,
  createNoopMemoryStore,
  createPrivateChatChannel,
  createToolServerHarness,
} from './test-helpers/tool-fixtures.js';

function proposalIdFromText(text: string): string {
  const id = text.match(/proposal-[a-zA-Z0-9-]+/)?.[0];
  assert.ok(id, `missing proposal id in text: ${text}`);
  return id;
}

function comparableProposalShape(proposal: IssueProposalFile | null): Record<string, unknown> {
  assert.ok(proposal, 'proposal should exist');
  return {
    title: proposal.meta.title,
    body: proposal.meta.body,
    evidence: proposal.meta.evidence,
    impact: proposal.meta.impact ?? null,
    priority: proposal.meta.priority,
    automation_level: proposal.meta.automation_level,
    target_repo: proposal.meta.target_repo,
    target_chat_id: proposal.meta.target_chat_id,
    origin_chat_id: proposal.meta.origin_chat_id,
    created_by: proposal.meta.created_by,
    status: proposal.meta.status,
    rejected_by: proposal.meta.rejected_by ?? null,
    rejection_reason: proposal.meta.rejection_reason ?? null,
  };
}

let passed = 0;
const proposalsDir = mkdtempSync(join(tmpdir(), 'issue-proposal-lifecycle-parity-'));
const originalProposalsDir = appConfig.issueProposalsDir;
const originalOwner = appConfig.ownerOpenId;
(appConfig as { issueProposalsDir: string }).issueProposalsDir = proposalsDir;
(appConfig as { ownerOpenId: string | null }).ownerOpenId = null;

try {
  const identity = new IdentitySession(() => null);
  identity.setCaller('oc_parity', 'thread_parity', 'ou_parity');
  identity.setCaller('oc_other', 'thread_other', 'ou_other');
  const noopMemory = createNoopMemoryStore();
  const fakeClient = createMockLarkClient();
  const fakeChannel = createPrivateChatChannel() as unknown as LarkChannel;
  const { server: fakeServer, getTool } = createToolServerHarness();

  registerTools(
    fakeServer as any,
    fakeClient as any,
    noopMemory,
    identity,
    fakeChannel,
  );

  const createProposalTool = getTool('create_issue_proposal');
  const listProposalsTool = getTool('list_issue_proposals');
  const rejectProposalTool = getTool('reject_issue_proposal');
  const createIssueTool = getTool('create_issue_from_proposal');

  const dispatcher = createCodexExecActionDispatcher({
    memoryStore: noopMemory,
    identitySession: identity,
  });
  const execMessage = {
    messageId: 'om_parity',
    chatId: 'oc_parity',
    threadId: 'thread_parity',
    chatType: 'p2p' as const,
    senderId: 'ou_parity',
    text: 'create issue proposal',
    messageType: 'text' as const,
    rawContent: '{}',
  };

  const sharedInput = {
    title: 'Parity review found duplicated proposal logic',
    body: 'MCP and exec proposal handling should share service semantics.',
    evidence: ['MCP path and exec path both mutate proposal files'],
    impact: 'Adapters can drift if lifecycle logic is duplicated.',
    priority: 'P2' as const,
    automation_level: 'discovery-only' as const,
    target_repo: 'IS908/codex-lark-plugin',
    target_chat_id: 'oc_parity',
  };

  const mcpCreate = await createProposalTool({
    ...sharedInput,
    chat_id: 'oc_parity',
    thread_id: 'thread_parity',
  });
  assert.equal(mcpCreate.isError, undefined, JSON.stringify(mcpCreate));
  const mcpId = proposalIdFromText(mcpCreate.content[0].text);

  const execCreate = await dispatcher.execute({
    message: execMessage,
    actions: [{ type: 'create_issue_proposal', ...sharedInput }],
  });
  assert.equal(execCreate[0].ok, true, JSON.stringify(execCreate));
  const execId = proposalIdFromText(execCreate[0].message);

  assert.deepEqual(
    comparableProposalShape(await readIssueProposal(mcpId)),
    comparableProposalShape(await readIssueProposal(execId)),
  );
  passed++;

  const mcpList = await listProposalsTool({
    status: 'pending',
    chat_id: 'oc_parity',
    thread_id: 'thread_parity',
  });
  assert.equal(mcpList.isError, undefined, JSON.stringify(mcpList));
  assert.match(mcpList.content[0].text, new RegExp(mcpId));
  assert.match(mcpList.content[0].text, new RegExp(execId));

  const execList = await dispatcher.execute({
    message: execMessage,
    actions: [{ type: 'list_issue_proposals', status: 'pending' }],
  });
  assert.equal(execList[0].ok, true, JSON.stringify(execList));
  assert.match(execList[0].message, new RegExp(mcpId));
  assert.match(execList[0].message, new RegExp(execId));
  passed++;

  const mcpDenied = await createIssueTool({
    id: mcpId,
    chat_id: 'oc_other',
    thread_id: 'thread_other',
  });
  assert.equal(mcpDenied.isError, true, JSON.stringify(mcpDenied));

  const execDenied = await dispatcher.execute({
    message: {
      ...execMessage,
      chatId: 'oc_other',
      threadId: 'thread_other',
      senderId: 'ou_other',
    },
    actions: [{ type: 'create_issue_from_proposal', id: execId }],
  });
  assert.equal(execDenied[0].ok, false, JSON.stringify(execDenied));
  assert.equal((await readIssueProposal(mcpId))?.meta.status, 'pending');
  assert.equal((await readIssueProposal(execId))?.meta.status, 'pending');
  assert.match(mcpDenied.content[0].text, /not authorized/i);
  assert.match(execDenied[0].message, /not authorized/i);
  passed++;

  const mcpReject = await rejectProposalTool({
    id: mcpId,
    reason: 'Covered by the shared service slice.',
    chat_id: 'oc_parity',
    thread_id: 'thread_parity',
  });
  assert.equal(mcpReject.isError, undefined, JSON.stringify(mcpReject));

  const execReject = await dispatcher.execute({
    message: execMessage,
    actions: [
      {
        type: 'reject_issue_proposal',
        id: execId,
        reason: 'Covered by the shared service slice.',
      },
    ],
  });
  assert.equal(execReject[0].ok, true, JSON.stringify(execReject));
  assert.deepEqual(
    comparableProposalShape(await readIssueProposal(mcpId)),
    comparableProposalShape(await readIssueProposal(execId)),
  );
  passed++;
} finally {
  (appConfig as { issueProposalsDir: string }).issueProposalsDir = originalProposalsDir;
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = originalOwner;
  rmSync(proposalsDir, { recursive: true, force: true });
}

console.log(`issue-proposal-lifecycle parity smoke: ${passed}/4 PASS`);
