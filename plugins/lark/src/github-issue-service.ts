import { audit } from './audit-log.js';
import { createGithubIssue } from './github-issue-creator.js';
import { extractGithubIssueUrl } from './issue-proposal-store.js';
import type { RunConfiguredLocalCliToolResult } from './local-cli-tools.js';

export type GithubIssueAction = 'create_github_issue';

export type GithubIssueServiceErrorCode =
  | 'create_failed'
  | 'missing_url'
  | 'missing_runner';

export type GithubIssueServiceError = {
  ok: false;
  action: GithubIssueAction;
  code: GithubIssueServiceErrorCode;
  message: string;
};

export type GithubIssueServiceResult<T> = ({ ok: true; action: GithubIssueAction; message: string } & T) | GithubIssueServiceError;

export type GithubIssueLocalCliRunner = (
  tool: string,
  args: string[],
) => Promise<RunConfiguredLocalCliToolResult>;

type AuditArgs = Record<string, unknown>;

export interface CreateDirectGithubIssueInput {
  title: string;
  body: string;
  targetRepo: string;
  caller: string;
  tool?: string;
  runLocalCli?: GithubIssueLocalCliRunner;
  auditArgs?: AuditArgs;
}

function serviceError(
  code: GithubIssueServiceErrorCode,
  message: string,
): GithubIssueServiceError {
  return { ok: false, action: 'create_github_issue', code, message };
}

function directGithubIssueLocalCliArgs(input: Pick<CreateDirectGithubIssueInput, 'targetRepo' | 'title' | 'body'>): string[] {
  return [
    `--repo=${input.targetRepo}`,
    `--title=${input.title}`,
    `--body=${input.body}`,
  ];
}

export async function createDirectGithubIssue(input: CreateDirectGithubIssueInput): Promise<GithubIssueServiceResult<{
  issueUrl: string;
}>> {
  if (input.tool) {
    if (!input.runLocalCli) {
      void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'error');
      return serviceError('missing_runner', 'Configured local CLI runner is unavailable for direct GitHub issue creation.');
    }

    const result = await input.runLocalCli(input.tool, directGithubIssueLocalCliArgs(input));
    if (!result.ok) {
      void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'error');
      return serviceError('create_failed', `Failed to create GitHub issue via local CLI tool "${input.tool}": ${result.message}`);
    }

    const issueUrl = extractGithubIssueUrl(result.message);
    if (!issueUrl) {
      void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'error');
      return serviceError('missing_url', `Local CLI tool "${input.tool}" completed but did not return a GitHub issue URL.`);
    }

    void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'ok');
    return {
      ok: true,
      action: 'create_github_issue',
      issueUrl,
      message: `Created GitHub issue: ${issueUrl}`,
    };
  }

  const result = await createGithubIssue({
    targetRepo: input.targetRepo,
    title: input.title,
    body: input.body,
  });
  if (!result.ok || !result.issueUrl) {
    void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'error');
    return serviceError('create_failed', result.message);
  }

  void audit('create_github_issue', input.caller, input.auditArgs ?? {}, 'ok');
  return {
    ok: true,
    action: 'create_github_issue',
    issueUrl: result.issueUrl,
    message: `Created GitHub issue: ${result.issueUrl}`,
  };
}
