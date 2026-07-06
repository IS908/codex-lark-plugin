import { appConfig } from './config.js';
import {
  extractGithubIssueUrl,
  formatIssueProposalIssueBody,
  type IssueProposalFile,
} from './issue-proposal-store.js';

export type GithubIssueCreateMethod = 'http';

export interface GithubIssueCreateResult {
  ok: boolean;
  message: string;
  issueUrl?: string;
  method?: GithubIssueCreateMethod;
}

export interface GithubIssueCreateInput {
  targetRepo: string;
  title: string;
  body: string;
}

function redactSensitiveText(text: string): string {
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function repoPath(targetRepo: string): string | null {
  const [owner, repo, ...rest] = targetRepo.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function createWithHttp(input: GithubIssueCreateInput): Promise<GithubIssueCreateResult> {
  const token = appConfig.githubIssueToken;
  if (!token) {
    return {
      ok: false,
      message: 'Built-in GitHub issue filing unavailable: set LARK_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.',
    };
  }

  const path = repoPath(input.targetRepo);
  if (!path) {
    return { ok: false, message: `Invalid target_repo "${input.targetRepo}". Expected owner/name.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), appConfig.githubIssueTimeoutMs);
  try {
    const response = await fetch(`${appConfig.githubIssueApiBaseUrl.replace(/\/+$/, '')}/repos/${path}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        message: `GitHub HTTP issue creation failed: status=${response.status} body=${redactSensitiveText(text).slice(0, 1000)}`,
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: 'GitHub HTTP issue creation returned invalid JSON.' };
    }
    if (typeof parsed?.html_url !== 'string' || !extractGithubIssueUrl(parsed.html_url)) {
      return { ok: false, message: 'GitHub HTTP issue creation response did not contain html_url.' };
    }
    return {
      ok: true,
      method: 'http',
      issueUrl: parsed.html_url,
      message: `Created GitHub issue via HTTP API: ${parsed.html_url}`,
    };
  } catch (err: any) {
    const message = err?.name === 'AbortError'
      ? `GitHub HTTP issue creation timed out after ${appConfig.githubIssueTimeoutMs}ms.`
      : `GitHub HTTP issue creation failed: ${err?.message ?? String(err)}`;
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

export async function createGithubIssue(input: GithubIssueCreateInput): Promise<GithubIssueCreateResult> {
  return createWithHttp(input);
}

export async function createGithubIssueFromProposal(
  proposal: IssueProposalFile,
): Promise<GithubIssueCreateResult> {
  const httpResult = await createGithubIssue({
    targetRepo: proposal.meta.target_repo,
    title: proposal.meta.title,
    body: formatIssueProposalIssueBody(proposal),
  });
  if (httpResult.ok) return httpResult;

  return {
    ok: false,
    message: `${httpResult.message} Pass a configured local CLI override tool for host-local commands.`,
  };
}
