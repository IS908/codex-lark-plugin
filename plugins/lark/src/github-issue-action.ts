import { spawn } from 'node:child_process';
import { appConfig } from './config.js';

export interface GitHubIssueActionInput {
  repo?: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface GitHubIssueActionResult {
  ok: boolean;
  message: string;
  url?: string;
  repo?: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+/;

export async function createGitHubIssueFromAction(
  input: GitHubIssueActionInput,
): Promise<GitHubIssueActionResult> {
  const repo = resolveRepo(input.repo);
  if (!repo.ok) return repo;

  const args = [
    'issue',
    'create',
    '--repo',
    repo.repo,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
  for (const label of input.labels ?? []) {
    args.push('--label', label);
  }

  const result = await runProcess(appConfig.githubIssueCommand, args, {
    timeoutMs: appConfig.githubIssueTimeoutMs,
    maxOutputBytes: appConfig.githubIssueMaxOutputBytes,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      repo: repo.repo,
      message: `Failed to execute GitHub issue command: ${code ?? result.error.message}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      repo: repo.repo,
      message: `GitHub issue command timed out after ${appConfig.githubIssueTimeoutMs}ms.`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      repo: repo.repo,
      message: `GitHub issue command failed: exit_code=${result.exitCode ?? 'null'} signal=${result.signal ?? 'none'} stderr=${result.stderr || '<empty>'}`,
    };
  }

  const output = result.stdout.trim();
  const url = output.match(ISSUE_URL_RE)?.[0];
  if (!url) {
    return {
      ok: true,
      repo: repo.repo,
      message: `Created GitHub issue in ${repo.repo}, but no issue URL was detected in command output: ${output || '<empty>'}`,
    };
  }
  return {
    ok: true,
    repo: repo.repo,
    url,
    message: `Created GitHub issue ${url}`,
  };
}

function resolveRepo(requestedRepo: string | undefined): GitHubIssueActionResult & { repo: string } {
  if (!appConfig.githubIssueActionEnabled) {
    return { ok: false, repo: '', message: 'create_github_issue is disabled. Set LARK_GITHUB_ISSUE_ACTION_ENABLED=true to enable it.' };
  }

  const repo = (requestedRepo?.trim() || appConfig.githubIssueDefaultRepo || '').trim();
  if (!repo) {
    return { ok: false, repo: '', message: 'create_github_issue requires repo or LARK_GITHUB_DEFAULT_REPO.' };
  }
  if (!REPO_RE.test(repo)) {
    return { ok: false, repo, message: `Invalid GitHub repo "${repo}". Expected owner/repo.` };
  }

  const allowedRepos = appConfig.githubIssueAllowedRepos;
  const normalizedRepo = repo.toLowerCase();
  if (allowedRepos.length > 0) {
    const allowed = allowedRepos.map((item) => item.toLowerCase());
    if (!allowed.includes(normalizedRepo)) {
      return { ok: false, repo, message: `GitHub repo ${repo} is not in LARK_GITHUB_ALLOWED_REPOS.` };
    }
    return { ok: true, repo, message: '' };
  }

  if (!appConfig.githubIssueDefaultRepo) {
    return {
      ok: false,
      repo,
      message: 'create_github_issue requires LARK_GITHUB_DEFAULT_REPO or LARK_GITHUB_ALLOWED_REPOS.',
    };
  }

  if (normalizedRepo !== appConfig.githubIssueDefaultRepo.toLowerCase()) {
    return { ok: false, repo, message: `GitHub repo ${repo} does not match LARK_GITHUB_DEFAULT_REPO.` };
  }

  return { ok: true, repo, message: '' };
}

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const outputState = { bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKillTimer.unref();
    }, options.timeoutMs);

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCappedOutput(stdout, chunk, outputState, options.maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCappedOutput(stderr, chunk, outputState, options.maxOutputBytes);
    });
    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        truncated: outputState.truncated,
        stdout: sanitizeOutput(stdout),
        stderr: sanitizeOutput(stderr),
        error,
      });
    });
    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut,
        truncated: outputState.truncated,
        stdout: sanitizeOutput(stdout),
        stderr: sanitizeOutput(stderr),
      });
    });
  });
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

function sanitizeOutput(value: string): string {
  const sanitized = value
    .replace(/((?:token|secret|password|passwd|credential|authorization|api[_-]?key|app[_-]?secret)\s*[=:]\s*)([^\s"'`]+)/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 1000 ? `${sanitized.slice(0, 997)}...` : sanitized;
}
