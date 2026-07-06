import { z } from 'zod';
import { runConfiguredLocalCliTool } from '../local-cli-tools.js';
import {
  formatIssueProposalForList,
} from '../issue-proposal-store.js';
import {
  createIssueFromProposal,
  createIssueProposal,
  createLowRiskPullRequestFromProposal,
  listVisibleIssueProposals,
  rejectIssueProposal,
  type IssueProposalLocalCliRunner,
} from '../issue-proposal-service.js';
import type { ToolContext, ToolResult } from './tool-context.js';

const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const AutomationLevelSchema = z.enum(['discovery-only', 'low-risk-auto-pr-eligible']);
const StatusSchema = z.enum(['pending', 'approved', 'created', 'rejected', 'all']);

function textResult(text: string, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

function createLocalCliRunner(
  ctx: ToolContext,
  chatId: string,
  threadId: string | undefined,
): IssueProposalLocalCliRunner {
  return (tool, args) =>
    runConfiguredLocalCliTool({
      identitySession: ctx.identitySession,
      tool,
      args,
      chat_id: chatId,
      thread_id: threadId,
    });
}

export function registerIssueProposalTools(ctx: ToolContext): void {
  const { server, channel, resolveCaller } = ctx;

  server.registerTool(
    'create_issue_proposal',
    {
      description:
        'Create a durable pending GitHub issue proposal. This does not create a GitHub issue; a maintainer must later authorize create_issue_from_proposal.',
      inputSchema: z.object({
        title: z.string().describe('Proposed GitHub issue title'),
        body: z.string().describe('Proposed GitHub issue body or finding summary'),
        evidence: z.array(z.string()).optional().describe('Evidence lines supporting the finding'),
        impact: z.string().optional().describe('User impact or maintenance risk'),
        priority: PrioritySchema.optional().describe('Suggested priority: P0, P1, P2, or P3'),
        automation_level: AutomationLevelSchema.optional().describe('Whether this is discovery-only or low-risk auto-PR eligible'),
        target_repo: z.string().describe('GitHub repository in owner/name form'),
        target_chat_id: z.string().optional().describe('Feishu chat that should see this proposal. Defaults to current chat_id.'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ title, body, evidence, impact, priority, automation_level, target_repo, target_chat_id, chat_id, thread_id }) => {
      const auditArgs = { title, priority, automation_level, target_repo, target_chat_id, chat_id, thread_id };
      const auth = resolveCaller('create_issue_proposal', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const result = await createIssueProposal({
        title,
        body,
        evidence,
        impact,
        priority,
        automationLevel: automation_level,
        targetRepo: target_repo,
        targetChatId: target_chat_id ?? chat_id,
        originChatId: chat_id,
        caller,
        auditArgs,
      });
      if (!result.ok) return textResult(result.message, true);
      return textResult(`Created issue proposal "${result.proposal.meta.id}". Reply with approval before filing a GitHub issue.`);
    },
  );

  server.registerTool(
    'list_issue_proposals',
    {
      description:
        'List visible issue proposals. Private chats show proposals created by the caller; group chats show proposals targeting the group chat.',
      inputSchema: z.object({
        status: StatusSchema.optional().default('pending').describe('Proposal status filter'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ status, chat_id, thread_id }) => {
      const auditArgs = { status, chat_id, thread_id };
      const auth = resolveCaller('list_issue_proposals', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const isPrivate = channel.isPrivateChat(chat_id);
      const result = await listVisibleIssueProposals({
        caller,
        chatId: chat_id,
        isPrivateChat: isPrivate,
        status,
        auditArgs,
      });

      if (!result.ok) return textResult(result.message, true);
      if (result.proposals.length === 0) return textResult('No issue proposals found.');
      return textResult(result.proposals.map(formatIssueProposalForList).join('\n\n'));
    },
  );

  server.registerTool(
    'reject_issue_proposal',
    {
      description: 'Reject a pending issue proposal. Only the proposal creator or configured owner can reject it.',
      inputSchema: z.object({
        id: z.string().describe('Issue proposal id'),
        reason: z.string().optional().describe('Optional rejection reason'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ id, reason, chat_id, thread_id }) => {
      const auditArgs = { id, reason, chat_id, thread_id };
      const auth = resolveCaller('reject_issue_proposal', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const result = await rejectIssueProposal({ id, reason, caller, auditArgs });
      return textResult(result.message, !result.ok);
    },
  );

  server.registerTool(
    'create_issue_from_proposal',
    {
      description:
        'Create a GitHub issue from a previously stored proposal after explicit maintainer authorization. Omit tool to use the built-in proposal filing path; tool, when provided, must be a configured local-cli-tools.json tool name rather than a raw executable name.',
      inputSchema: z.object({
        id: z.string().describe('Issue proposal id'),
        tool: z.string().optional().describe('Configured local-cli-tools.json tool name override. Omit for the built-in proposal filing path.'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ id, tool, chat_id, thread_id }) => {
      const auditArgs = { id, tool, chat_id, thread_id };
      const auth = resolveCaller('create_issue_from_proposal', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const result = await createIssueFromProposal({
        id,
        caller,
        tool,
        runLocalCli: createLocalCliRunner(ctx, chat_id, thread_id),
        auditArgs,
      });
      return textResult(result.message, !result.ok);
    },
  );

  server.registerTool(
    'create_low_risk_pr_from_proposal',
    {
      description:
        'Create a low-risk GitHub PR from an eligible issue proposal after its GitHub issue exists. Uses the allowlisted local CLI tool gh_low_risk_pr_create by default, never merges or releases.',
      inputSchema: z.object({
        id: z.string().describe('Issue proposal id'),
        tool: z.string().optional().default('gh_low_risk_pr_create').describe('Configured local CLI tool name'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ id, tool = 'gh_low_risk_pr_create', chat_id, thread_id }) => {
      const auditArgs = { id, tool, chat_id, thread_id };
      const auth = resolveCaller('create_low_risk_pr_from_proposal', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const result = await createLowRiskPullRequestFromProposal({
        id,
        caller,
        tool,
        runLocalCli: createLocalCliRunner(ctx, chat_id, thread_id),
        auditArgs,
      });
      return textResult(result.message, !result.ok);
    },
  );
}
