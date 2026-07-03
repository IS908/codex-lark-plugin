import { z } from 'zod';
import { appConfig } from '../config.js';
import { audit } from '../audit-log.js';
import { runConfiguredLocalCliTool } from '../local-cli-tools.js';
import {
  createIssueProposal,
  extractGithubIssueUrl,
  extractGithubPullRequestUrl,
  formatIssueProposalForList,
  formatIssueProposalIssueBody,
  formatIssueProposalPullRequestBody,
  listIssueProposals,
  markIssueProposalApproved,
  markIssueProposalCreated,
  markIssueProposalPullRequestCreated,
  markIssueProposalPullRequestError,
  readIssueProposal,
  rejectIssueProposal,
  type IssueProposalFile,
} from '../issue-proposal-store.js';
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

function canMutateProposal(proposal: IssueProposalFile, caller: string): boolean {
  return proposal.meta.created_by === caller || (!!appConfig.ownerOpenId && appConfig.ownerOpenId === caller);
}

function localCliArgsForProposal(proposal: IssueProposalFile): string[] {
  return [
    `--repo=${proposal.meta.target_repo}`,
    `--title=${proposal.meta.title}`,
    `--body=${formatIssueProposalIssueBody(proposal)}`,
  ];
}

function lowRiskPullRequestTitle(proposal: IssueProposalFile): string {
  const title = proposal.meta.title.trim();
  return title.startsWith('[auto-review]') ? title : `[auto-review] ${title}`;
}

function localCliArgsForPullRequestProposal(proposal: IssueProposalFile): string[] {
  return [
    `--repo=${proposal.meta.target_repo}`,
    `--proposal-id=${proposal.meta.id}`,
    `--issue=${proposal.meta.github_issue_url ?? ''}`,
    `--title=${lowRiskPullRequestTitle(proposal)}`,
    `--body=${formatIssueProposalPullRequestBody(proposal)}`,
  ];
}

async function createIssueViaLocalCli(
  ctx: ToolContext,
  proposal: IssueProposalFile,
  caller: string,
  chatId: string,
  threadId: string | undefined,
  tool: string,
): Promise<ToolResult> {
  if (proposal.meta.status === 'created' && proposal.meta.github_issue_url) {
    return textResult(`Issue already created for proposal ${proposal.meta.id}: ${proposal.meta.github_issue_url}`);
  }
  if (proposal.meta.status === 'rejected') {
    return textResult(`Issue proposal "${proposal.meta.id}" was rejected and cannot be filed.`, true);
  }

  const approved = await markIssueProposalApproved(proposal.meta.id, { approvedBy: caller });
  if (!approved) return textResult(`Issue proposal "${proposal.meta.id}" not found.`, true);

  const result = await runConfiguredLocalCliTool({
    identitySession: ctx.identitySession,
    tool,
    args: localCliArgsForProposal(approved),
    chat_id: chatId,
    thread_id: threadId,
  });

  if (!result.ok) {
    await markIssueProposalApproved(proposal.meta.id, { approvedBy: caller, lastError: result.message });
    return textResult(`Failed to create GitHub issue for proposal "${proposal.meta.id}": ${result.message}`, true);
  }

  const issueUrl = extractGithubIssueUrl(result.message);
  if (!issueUrl) {
    await markIssueProposalApproved(proposal.meta.id, {
      approvedBy: caller,
      lastError: 'Local CLI completed but did not return a GitHub issue URL.',
    });
    return textResult(`Local CLI completed but did not return a GitHub issue URL for proposal "${proposal.meta.id}".`, true);
  }

  const created = await markIssueProposalCreated(proposal.meta.id, {
    approvedBy: caller,
    githubIssueUrl: issueUrl,
  });
  void audit('create_issue_from_proposal', caller, { id: proposal.meta.id, tool, chat_id: chatId, thread_id: threadId }, 'ok');
  return textResult(`Created GitHub issue for proposal "${proposal.meta.id}": ${created?.meta.github_issue_url ?? issueUrl}`);
}

async function createLowRiskPullRequestViaLocalCli(
  ctx: ToolContext,
  proposal: IssueProposalFile,
  caller: string,
  chatId: string,
  threadId: string | undefined,
  tool: string,
): Promise<ToolResult> {
  const auditArgs = { id: proposal.meta.id, tool, chat_id: chatId, thread_id: threadId };

  if (proposal.meta.github_pr_url) {
    return textResult(`Low-risk PR already created for proposal ${proposal.meta.id}: ${proposal.meta.github_pr_url}`);
  }
  if (proposal.meta.status === 'rejected') {
    return textResult(`Issue proposal "${proposal.meta.id}" was rejected and cannot open a PR.`, true);
  }
  if (proposal.meta.automation_level !== 'low-risk-auto-pr-eligible') {
    return textResult(
      `Issue proposal "${proposal.meta.id}" is ${proposal.meta.automation_level}; only low-risk-auto-pr-eligible proposals can open automatic PRs.`,
      true,
    );
  }
  if (proposal.meta.status !== 'created' || !proposal.meta.github_issue_url) {
    return textResult(
      `Issue proposal "${proposal.meta.id}" must have a created GitHub issue before opening a low-risk PR.`,
      true,
    );
  }

  const result = await runConfiguredLocalCliTool({
    identitySession: ctx.identitySession,
    tool,
    args: localCliArgsForPullRequestProposal(proposal),
    chat_id: chatId,
    thread_id: threadId,
  });

  if (!result.ok) {
    await markIssueProposalPullRequestError(proposal.meta.id, { approvedBy: caller, lastError: result.message });
    return textResult(`Failed to create low-risk PR for proposal "${proposal.meta.id}": ${result.message}`, true);
  }

  const pullRequestUrl = extractGithubPullRequestUrl(result.message);
  if (!pullRequestUrl) {
    const lastError = 'Local CLI completed but did not return a GitHub pull request URL.';
    await markIssueProposalPullRequestError(proposal.meta.id, { approvedBy: caller, lastError });
    return textResult(`${lastError} Proposal: "${proposal.meta.id}".`, true);
  }

  const updated = await markIssueProposalPullRequestCreated(proposal.meta.id, {
    approvedBy: caller,
    githubPullRequestUrl: pullRequestUrl,
  });
  void audit('create_low_risk_pr_from_proposal', caller, auditArgs, 'ok');
  return textResult(`Created low-risk PR for proposal "${proposal.meta.id}": ${updated?.meta.github_pr_url ?? pullRequestUrl}`);
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
        priority: PrioritySchema.optional().describe('Suggested priority'),
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

      try {
        const proposal = await createIssueProposal({
          title,
          body,
          evidence,
          impact,
          priority,
          automationLevel: automation_level,
          targetRepo: target_repo,
          targetChatId: target_chat_id ?? chat_id,
          originChatId: chat_id,
          createdBy: caller,
        });
        void audit('create_issue_proposal', caller, auditArgs, 'ok');
        return textResult(`Created issue proposal "${proposal.meta.id}". Reply with approval before filing a GitHub issue.`);
      } catch (err: any) {
        void audit('create_issue_proposal', caller, auditArgs, 'error');
        return textResult(`Failed to create issue proposal: ${err?.message ?? String(err)}`, true);
      }
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
      const proposals = await listIssueProposals({
        status,
        ...(isPrivate ? { createdBy: caller } : { targetChatId: chat_id }),
      });

      void audit('list_issue_proposals', caller, auditArgs, 'ok');
      if (proposals.length === 0) return textResult('No issue proposals found.');
      return textResult(proposals.map(formatIssueProposalForList).join('\n\n'));
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
      const proposal = await readIssueProposal(id);
      if (!proposal) return textResult(`Issue proposal "${id}" not found.`, true);
      if (!canMutateProposal(proposal, caller)) {
        void audit('reject_issue_proposal', caller, auditArgs, 'denied');
        return textResult(`You are not authorized to reject issue proposal "${id}".`, true);
      }
      const rejected = await rejectIssueProposal(id, { rejectedBy: caller, reason });
      void audit('reject_issue_proposal', caller, auditArgs, 'ok');
      return textResult(`Rejected issue proposal "${rejected?.meta.id ?? id}".`);
    },
  );

  server.registerTool(
    'create_issue_from_proposal',
    {
      description:
        'Create a GitHub issue from a previously stored proposal after explicit maintainer authorization. Uses the allowlisted local CLI tool gh_issue_create by default.',
      inputSchema: z.object({
        id: z.string().describe('Issue proposal id'),
        tool: z.string().optional().default('gh_issue_create').describe('Configured local CLI tool name'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ id, tool = 'gh_issue_create', chat_id, thread_id }) => {
      const auditArgs = { id, tool, chat_id, thread_id };
      const auth = resolveCaller('create_issue_from_proposal', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;
      const proposal = await readIssueProposal(id);
      if (!proposal) return textResult(`Issue proposal "${id}" not found.`, true);
      if (!canMutateProposal(proposal, caller)) {
        void audit('create_issue_from_proposal', caller, auditArgs, 'denied');
        return textResult(`You are not authorized to create an issue from proposal "${id}".`, true);
      }
      return createIssueViaLocalCli(ctx, proposal, caller, chat_id, thread_id, tool);
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
      const proposal = await readIssueProposal(id);
      if (!proposal) return textResult(`Issue proposal "${id}" not found.`, true);
      if (!canMutateProposal(proposal, caller)) {
        void audit('create_low_risk_pr_from_proposal', caller, auditArgs, 'denied');
        return textResult(`You are not authorized to create a PR from proposal "${id}".`, true);
      }
      return createLowRiskPullRequestViaLocalCli(ctx, proposal, caller, chat_id, thread_id, tool);
    },
  );
}
