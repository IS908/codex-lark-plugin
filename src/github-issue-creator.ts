import { spawn } from 'node:child_process';
import { appConfig } from './config.js';
import {
  extractGithubIssueUrl,
  formatIssueProposalIssueBody,
  type IssueProposalFile,
} from './issue-proposal-store.js';

export type GithubIssueCreateMethod = 'gh' | 'http';

export interface GithubIssueCreateResult {
  ok: boolean;
  message: string;
  issueUrl?: string;
  method?: GithubIssueCreateMethod;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

const GH_ENV_KEYS = ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'];

function buildGhEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.env.GH_TOKEN !== undefined) env.GH_TOKEN = process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN !== undefined) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (appConfig.githubIssueToken && !env.GH_TOKEN && !env.GITHUB_TOKEN) {
    env.GH_TOKEN = appConfig.githubIssueToken;
  }
  return env;
}

function redactSensitiveText(text: string): string {
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function appendCappedOutput(
  current: string,
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
): string {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return current;
  }
  const remaining = maxBytes - state.bytes;
  const slice = chunk.subarray(0, remaining);
  state.bytes += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  return current + slice.toString('utf8');
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ProcessResult> {
  let stdout = '';
  let stderr = '';
  const outputState = { bytes: 0, truncated: false };
  let timedOut = false;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildGhEnv(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCappedOutput(stdout, chunk, outputState, maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCappedOutput(stderr, chunk, outputState, maxOutputBytes);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        truncated: outputState.truncated,
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr),
      });
    });
  });
}

function formatProcessFailure(prefix: string, result: ProcessResult): string {
  const parts = [
    `${prefix} failed`,
    `exitCode=${result.exitCode}`,
    result.signal ? `signal=${result.signal}` : null,
    result.timedOut ? 'timedOut=true' : null,
    result.truncated ? 'output truncated' : null,
    result.stderr.trim() ? `stderr=${result.stderr.trim()}` : null,
    result.stdout.trim() ? `stdout=${result.stdout.trim()}` : null,
  ].filter(Boolean);
  return parts.join('; ');
}

async function createWithGh(proposal: IssueProposalFile, body: string): Promise<GithubIssueCreateResult> {
  const args = [
    'issue',
    'create',
    '--repo',
    proposal.meta.target_repo,
    '--title',
    proposal.meta.title,
    '--body',
    body,
  ];

  let result: ProcessResult;
  try {
    result = await runProcess(
      appConfig.githubIssueGhCommand,
      args,
      appConfig.githubIssueTimeoutMs,
      appConfig.githubIssueMaxOutputBytes,
    );
  } catch (err: any) {
    return { ok: false, message: `Failed to execute gh issue create: ${err?.message ?? String(err)}` };
  }

  if (result.timedOut || result.exitCode !== 0) {
    return { ok: false, message: formatProcessFailure('gh issue create', result) };
  }

  const issueUrl = extractGithubIssueUrl(`${result.stdout}\n${result.stderr}`);
  if (!issueUrl) {
    return {
      ok: false,
      message: `gh issue create completed but did not return a GitHub issue URL. stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
    };
  }

  return {
    ok: true,
    method: 'gh',
    issueUrl,
    message: `Created GitHub issue via gh: ${issueUrl}`,
  };
}

function repoPath(targetRepo: string): string | null {
  const [owner, repo, ...rest] = targetRepo.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function createWithHttp(proposal: IssueProposalFile, body: string): Promise<GithubIssueCreateResult> {
  const token = appConfig.githubIssueToken;
  if (!token) {
    return {
      ok: false,
      message: 'HTTP fallback unavailable: set LARK_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.',
    };
  }

  const path = repoPath(proposal.meta.target_repo);
  if (!path) {
    return { ok: false, message: `Invalid target_repo "${proposal.meta.target_repo}". Expected owner/name.` };
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
        title: proposal.meta.title,
        body,
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

export async function createGithubIssueFromProposal(
  proposal: IssueProposalFile,
): Promise<GithubIssueCreateResult> {
  const body = formatIssueProposalIssueBody(proposal);
  const ghResult = await createWithGh(proposal, body);
  if (ghResult.ok) return ghResult;

  const httpResult = await createWithHttp(proposal, body);
  if (httpResult.ok) {
    return {
      ...httpResult,
      message: `${httpResult.message} (after gh fallback: ${ghResult.message})`,
    };
  }

  return {
    ok: false,
    message: `${ghResult.message}; ${httpResult.message}`,
  };
}
