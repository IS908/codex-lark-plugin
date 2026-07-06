import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import { createGithubIssueFromProposal } from './github-issue-creator.js';
import {
  createIssueProposal as createIssueProposalFile,
  extractGithubIssueUrl,
  extractGithubPullRequestUrl,
  formatIssueProposalForList,
  formatIssueProposalIssueBody,
  formatIssueProposalPullRequestBody,
  listIssueProposals as listIssueProposalFiles,
  markIssueProposalApproved,
  markIssueProposalCreated,
  markIssueProposalPullRequestCreated,
  markIssueProposalPullRequestError,
  readIssueProposal,
  rejectIssueProposal as rejectIssueProposalFile,
  type IssueProposalAutomationLevel,
  type IssueProposalFile,
  type IssueProposalPriority,
  type IssueProposalStatus,
} from './issue-proposal-store.js';
import type { RunConfiguredLocalCliToolResult } from './local-cli-tools.js';

export type IssueProposalAction =
  | 'create_issue_proposal'
  | 'list_issue_proposals'
  | 'reject_issue_proposal'
  | 'create_issue_from_proposal'
  | 'create_low_risk_pr_from_proposal';

export type IssueProposalServiceErrorCode =
  | 'not_found'
  | 'not_authorized'
  | 'rejected'
  | 'ineligible'
  | 'missing_issue'
  | 'create_failed'
  | 'missing_url'
  | 'store_error';

export type IssueProposalServiceError = {
  ok: false;
  action: IssueProposalAction;
  code: IssueProposalServiceErrorCode;
  message: string;
  proposal?: IssueProposalFile;
};

export type IssueProposalServiceResult<T> = ({ ok: true; action: IssueProposalAction; message: string } & T) | IssueProposalServiceError;

export type IssueProposalLocalCliRunner = (
  tool: string,
  args: string[],
) => Promise<RunConfiguredLocalCliToolResult>;

type AuditArgs = Record<string, unknown>;

export interface CreateIssueProposalInput {
  title: string;
  body: string;
  evidence?: string[];
  impact?: string;
  priority?: IssueProposalPriority;
  automationLevel?: IssueProposalAutomationLevel;
  targetRepo: string;
  targetChatId: string;
  originChatId: string;
  caller: string;
  auditArgs?: AuditArgs;
}

export interface ListIssueProposalsInput {
  caller: string;
  chatId: string;
  isPrivateChat: boolean;
  status?: IssueProposalStatus | 'all';
  auditArgs?: AuditArgs;
}

export interface RejectIssueProposalInput {
  id: string;
  reason?: string;
  caller: string;
  auditArgs?: AuditArgs;
}

export interface CreateIssueFromProposalInput {
  id: string;
  caller: string;
  tool?: string;
  runLocalCli: IssueProposalLocalCliRunner;
  auditArgs?: AuditArgs;
}

export interface CreateLowRiskPullRequestFromProposalInput {
  id: string;
  caller: string;
  tool: string;
  runLocalCli: IssueProposalLocalCliRunner;
  auditArgs?: AuditArgs;
}

function serviceError(
  action: IssueProposalAction,
  code: IssueProposalServiceErrorCode,
  message: string,
  proposal?: IssueProposalFile,
): IssueProposalServiceError {
  return { ok: false, action, code, message, ...(proposal ? { proposal } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isServiceError(value: IssueProposalFile | IssueProposalServiceError): value is IssueProposalServiceError {
  return 'ok' in value && value.ok === false;
}

export function canMutateIssueProposal(proposal: IssueProposalFile, caller: string): boolean {
  return proposal.meta.created_by === caller || (!!appConfig.ownerOpenId && appConfig.ownerOpenId === caller);
}

function issueProposalLocalCliArgs(proposal: IssueProposalFile): string[] {
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

function issueProposalPullRequestLocalCliArgs(proposal: IssueProposalFile): string[] {
  return [
    `--repo=${proposal.meta.target_repo}`,
    `--proposal-id=${proposal.meta.id}`,
    `--issue=${proposal.meta.github_issue_url ?? ''}`,
    `--title=${lowRiskPullRequestTitle(proposal)}`,
    `--body=${formatIssueProposalPullRequestBody(proposal)}`,
  ];
}

export async function createIssueProposal(input: CreateIssueProposalInput): Promise<IssueProposalServiceResult<{
  proposal: IssueProposalFile;
}>> {
  try {
    const proposal = await createIssueProposalFile({
      title: input.title,
      body: input.body,
      evidence: input.evidence,
      impact: input.impact,
      priority: input.priority,
      automationLevel: input.automationLevel,
      targetRepo: input.targetRepo,
      targetChatId: input.targetChatId,
      originChatId: input.originChatId,
      createdBy: input.caller,
    });
    void audit('create_issue_proposal', input.caller, input.auditArgs ?? {}, 'ok');
    return {
      ok: true,
      action: 'create_issue_proposal',
      proposal,
      message: `Created issue proposal "${proposal.meta.id}".`,
    };
  } catch (err) {
    void audit('create_issue_proposal', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError(
      'create_issue_proposal',
      'store_error',
      `Failed to create issue proposal: ${errorMessage(err)}`,
    );
  }
}

export async function listVisibleIssueProposals(input: ListIssueProposalsInput): Promise<IssueProposalServiceResult<{
  proposals: IssueProposalFile[];
}>> {
  const proposals = await listIssueProposalFiles({
    status: input.status,
    ...(input.isPrivateChat ? { createdBy: input.caller } : { targetChatId: input.chatId }),
  });
  void audit('list_issue_proposals', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    action: 'list_issue_proposals',
    proposals,
    message: proposals.length ? proposals.map(formatIssueProposalForList).join('\n\n') : 'No issue proposals found.',
  };
}

async function readProposalForMutation(
  action: IssueProposalAction,
  id: string,
  caller: string,
  auditArgs: AuditArgs | undefined,
): Promise<IssueProposalFile | IssueProposalServiceError> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return serviceError(action, 'not_found', `Issue proposal "${id}" not found.`);
  if (!canMutateIssueProposal(proposal, caller)) {
    void audit(action, caller, auditArgs ?? {}, 'denied');
    const noun = action === 'create_low_risk_pr_from_proposal'
      ? 'create a PR from'
      : action === 'create_issue_from_proposal'
        ? 'create an issue from'
        : 'reject';
    return serviceError(action, 'not_authorized', `You are not authorized to ${noun} issue proposal "${id}".`, proposal);
  }
  return proposal;
}

export async function rejectIssueProposal(input: RejectIssueProposalInput): Promise<IssueProposalServiceResult<{
  proposal: IssueProposalFile | null;
}>> {
  const proposal = await readProposalForMutation(
    'reject_issue_proposal',
    input.id,
    input.caller,
    input.auditArgs,
  );
  if (isServiceError(proposal)) return proposal;

  const rejected = await rejectIssueProposalFile(input.id, {
    rejectedBy: input.caller,
    reason: input.reason,
  });
  void audit('reject_issue_proposal', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    action: 'reject_issue_proposal',
    proposal: rejected,
    message: `Rejected issue proposal "${rejected?.meta.id ?? input.id}".`,
  };
}

export async function createIssueFromProposal(input: CreateIssueFromProposalInput): Promise<IssueProposalServiceResult<{
  proposal: IssueProposalFile | null;
  issueUrl?: string;
}>> {
  const proposal = await readProposalForMutation(
    'create_issue_from_proposal',
    input.id,
    input.caller,
    input.auditArgs,
  );
  if (isServiceError(proposal)) return proposal;

  if (proposal.meta.status === 'created' && proposal.meta.github_issue_url) {
    return {
      ok: true,
      action: 'create_issue_from_proposal',
      proposal,
      issueUrl: proposal.meta.github_issue_url,
      message: `Issue already created for proposal ${proposal.meta.id}: ${proposal.meta.github_issue_url}`,
    };
  }
  if (proposal.meta.status === 'rejected') {
    return serviceError(
      'create_issue_from_proposal',
      'rejected',
      `Issue proposal "${proposal.meta.id}" was rejected and cannot be filed.`,
      proposal,
    );
  }

  const approved = await markIssueProposalApproved(proposal.meta.id, { approvedBy: input.caller });
  if (!approved) {
    return serviceError('create_issue_from_proposal', 'not_found', `Issue proposal "${proposal.meta.id}" not found.`);
  }

  const result = input.tool
    ? await input.runLocalCli(input.tool, issueProposalLocalCliArgs(approved))
    : await createGithubIssueFromProposal(approved);
  if (!result.ok) {
    await markIssueProposalApproved(proposal.meta.id, { approvedBy: input.caller, lastError: result.message });
    void audit('create_issue_from_proposal', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError(
      'create_issue_from_proposal',
      'create_failed',
      `Failed to create GitHub issue for proposal "${proposal.meta.id}": ${result.message}`,
      approved,
    );
  }

  const issueUrl = (result as { issueUrl?: string }).issueUrl ?? extractGithubIssueUrl(result.message);
  if (!issueUrl) {
    await markIssueProposalApproved(proposal.meta.id, {
      approvedBy: input.caller,
      lastError: 'Issue creation completed but did not return a GitHub issue URL.',
    });
    void audit('create_issue_from_proposal', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError(
      'create_issue_from_proposal',
      'missing_url',
      `Issue creation completed but did not return a GitHub issue URL for proposal "${proposal.meta.id}".`,
      approved,
    );
  }

  const created = await markIssueProposalCreated(proposal.meta.id, {
    approvedBy: input.caller,
    githubIssueUrl: issueUrl,
  });
  void audit('create_issue_from_proposal', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    action: 'create_issue_from_proposal',
    proposal: created,
    issueUrl,
    message: `Created GitHub issue for proposal "${proposal.meta.id}": ${created?.meta.github_issue_url ?? issueUrl}`,
  };
}

export async function createLowRiskPullRequestFromProposal(
  input: CreateLowRiskPullRequestFromProposalInput,
): Promise<IssueProposalServiceResult<{
  proposal: IssueProposalFile | null;
  pullRequestUrl?: string;
}>> {
  const proposal = await readProposalForMutation(
    'create_low_risk_pr_from_proposal',
    input.id,
    input.caller,
    input.auditArgs,
  );
  if (isServiceError(proposal)) return proposal;

  if (proposal.meta.github_pr_url) {
    return {
      ok: true,
      action: 'create_low_risk_pr_from_proposal',
      proposal,
      pullRequestUrl: proposal.meta.github_pr_url,
      message: `Low-risk PR already created for proposal ${proposal.meta.id}: ${proposal.meta.github_pr_url}`,
    };
  }
  if (proposal.meta.status === 'rejected') {
    return serviceError(
      'create_low_risk_pr_from_proposal',
      'rejected',
      `Issue proposal "${proposal.meta.id}" was rejected and cannot open a PR.`,
      proposal,
    );
  }
  if (proposal.meta.automation_level !== 'low-risk-auto-pr-eligible') {
    return serviceError(
      'create_low_risk_pr_from_proposal',
      'ineligible',
      `Issue proposal "${proposal.meta.id}" is ${proposal.meta.automation_level}; only low-risk-auto-pr-eligible proposals can open automatic PRs.`,
      proposal,
    );
  }
  if (proposal.meta.status !== 'created' || !proposal.meta.github_issue_url) {
    return serviceError(
      'create_low_risk_pr_from_proposal',
      'missing_issue',
      `Issue proposal "${proposal.meta.id}" must have a created GitHub issue before opening a low-risk PR.`,
      proposal,
    );
  }

  const result = await input.runLocalCli(input.tool, issueProposalPullRequestLocalCliArgs(proposal));
  if (!result.ok) {
    await markIssueProposalPullRequestError(proposal.meta.id, { approvedBy: input.caller, lastError: result.message });
    void audit('create_low_risk_pr_from_proposal', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError(
      'create_low_risk_pr_from_proposal',
      'create_failed',
      `Failed to create low-risk PR for proposal "${proposal.meta.id}": ${result.message}`,
      proposal,
    );
  }

  const pullRequestUrl = extractGithubPullRequestUrl(result.message);
  if (!pullRequestUrl) {
    const lastError = 'Local CLI completed but did not return a GitHub pull request URL.';
    await markIssueProposalPullRequestError(proposal.meta.id, { approvedBy: input.caller, lastError });
    void audit('create_low_risk_pr_from_proposal', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError(
      'create_low_risk_pr_from_proposal',
      'missing_url',
      `${lastError} Proposal: "${proposal.meta.id}".`,
      proposal,
    );
  }

  const updated = await markIssueProposalPullRequestCreated(proposal.meta.id, {
    approvedBy: input.caller,
    githubPullRequestUrl: pullRequestUrl,
  });
  void audit('create_low_risk_pr_from_proposal', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    action: 'create_low_risk_pr_from_proposal',
    proposal: updated,
    pullRequestUrl,
    message: `Created low-risk PR for proposal "${proposal.meta.id}": ${updated?.meta.github_pr_url ?? pullRequestUrl}`,
  };
}
