import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexExecToolTraceWriter } from './codex-exec-trace.js';
import {
  createCodexExecRuntimeMetricsCollector,
  extractCodexExecUsageFromJsonLine,
  logCodexExecRuntimeMetrics,
  mergeCodexExecUsage,
  type CodexExecRuntimeMetrics,
  type CodexExecUsage,
} from './codex-exec-metrics.js';

export type { CodexExecRuntimeMetrics, CodexExecUsage } from './codex-exec-metrics.js';
export { extractCodexExecUsage } from './codex-exec-metrics.js';

export type CodexExecSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexExecRequest {
  prompt: string;
  imagePaths?: string[];
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  sandbox?: CodexExecSandbox;
  model?: string | null;
  profile?: string | null;
  ignoreUserConfig?: boolean;
  skipGitRepoCheck?: boolean;
  resumeSessionId?: string | null;
  extraEnv?: Record<string, string | undefined>;
  progress?: {
    filePath: string;
    token: string;
  };
  actions?: {
    filePath: string;
    token: string;
  };
  traceLogId?: string;
  traceRunId?: string;
}

export interface CodexExecResult {
  text: string;
  sessionId?: string | null;
  usage?: CodexExecUsage | null;
  runtimeMetrics?: CodexExecRuntimeMetrics | null;
}

export type CodexExecRunner = (request: CodexExecRequest) => Promise<string | CodexExecResult>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 16 * 1024;
const ERROR_TAIL_CAP = 4 * 1024;

export function isCodexExecTimeoutError(err: unknown): boolean {
  return (
    err instanceof CodexExecTimeoutError ||
    (err instanceof Error && /\bcodex exec timed out after \d+ms\b/.test(err.message))
  );
}

function tailText(text: string, maxLen = ERROR_TAIL_CAP): string {
  if (text.length <= maxLen) return text;
  return text.slice(text.length - maxLen);
}

export class CodexExecTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;

  constructor(timeoutMs: number, stdout: string, stderr: string) {
    super(`codex exec timed out after ${timeoutMs}ms`);
    this.name = 'CodexExecTimeoutError';
    this.timeoutMs = timeoutMs;
    this.stdoutTail = tailText(stdout);
    this.stderrTail = tailText(stderr);
  }
}

export class CodexExecProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, detail: string) {
    super(`codex exec failed with exit ${exitCode}: ${truncate(detail, 2000)}`);
    this.name = 'CodexExecProcessError';
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdoutTail = tailText(stdout);
    this.stderrTail = tailText(stderr);
  }
}

function appendCapped(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (next.length <= OUTPUT_CAP) return next;
  return next.slice(next.length - OUTPUT_CAP);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function extractSessionIdFromJsonLine(line: string): string | null {
  try {
    const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      return event.thread_id;
    }
  } catch {
    // Ignore non-JSON output. Errors still surface through the process exit path.
  }
  return null;
}

export function extractCodexExecSessionId(jsonl: string): string | null {
  for (const line of jsonl.split(/\r?\n/)) {
    const sessionId = line.trim() ? extractSessionIdFromJsonLine(line) : null;
    if (sessionId) return sessionId;
  }
  return null;
}

export function buildCodexExecArgs(
  request: CodexExecRequest,
  outputFile: string,
): string[] {
  const args = [
    'exec',
    '--json',
    '--color',
    'never',
    '--output-last-message',
    outputFile,
  ];

  if (request.ignoreUserConfig ?? true) args.push('--ignore-user-config');
  if (request.skipGitRepoCheck ?? true) args.push('--skip-git-repo-check');
  if (request.sandbox) args.push('--sandbox', request.sandbox);
  if (request.model) args.push('--model', request.model);
  if (request.profile) args.push('--profile', request.profile);
  for (const imagePath of request.imagePaths ?? []) {
    args.push('--image', imagePath);
  }

  if (request.resumeSessionId) {
    args.push('resume', request.resumeSessionId, '-');
  } else {
    args.push('-');
  }

  return args;
}

export function normalizeCodexExecResult(result: string | CodexExecResult): CodexExecResult {
  if (typeof result === 'string') return { text: result };
  return result;
}

export async function runCodexExecCommand(request: CodexExecRequest): Promise<CodexExecResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-codex-exec-'));
  const outputFile = path.join(tmpDir, 'last-message.txt');
  const command = request.command ?? 'codex';
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = request.cwd ?? process.cwd();
  const args = buildCodexExecArgs(request, outputFile);

  let stdout = '';
  let stderr = '';
  let stdoutLineBuffer = '';
  let sessionId: string | null = null;
  let usage: CodexExecUsage | null = null;
  let timedOut = false;
  const runtimeMetrics = createCodexExecRuntimeMetricsCollector();
  const toolTrace = createCodexExecToolTraceWriter(
    request.traceLogId || request.traceRunId
      ? { logId: request.traceLogId, runId: request.traceRunId }
      : undefined,
  );

  function recordStdoutJsonLine(line: string): void {
    sessionId ??= extractSessionIdFromJsonLine(line);
    usage = mergeCodexExecUsage(usage, extractCodexExecUsageFromJsonLine(line));
    runtimeMetrics.recordLine(line);
    toolTrace?.recordLine(line);
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          ...request.extraEnv,
        },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk);
        stdoutLineBuffer += chunk.toString('utf8');
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          recordStdoutJsonLine(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new CodexExecTimeoutError(timeoutMs, stdout, stderr));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? 'none'}`;
          reject(new CodexExecProcessError(code, signal, stdout, stderr, detail));
          return;
        }
        resolve();
      });

      child.stdin.end(request.prompt);
    });

    sessionId ??= extractCodexExecSessionId(stdoutLineBuffer);
    for (const line of stdoutLineBuffer.split(/\r?\n/)) {
      if (line.trim()) recordStdoutJsonLine(line);
    }
    stdoutLineBuffer = '';
    await toolTrace?.flush();
    const metrics = runtimeMetrics.finish();
    usage = mergeCodexExecUsage(usage, metrics.usage ?? null);
    await logCodexExecRuntimeMetrics(metrics, { logId: request.traceLogId });
    const answer = await fs.readFile(outputFile, 'utf8');
    return {
      text: answer.trim(),
      sessionId,
      ...(usage ? { usage } : {}),
      runtimeMetrics: metrics,
    };
  } finally {
    for (const line of stdoutLineBuffer.split(/\r?\n/)) {
      if (line.trim()) {
        runtimeMetrics.recordLine(line);
        toolTrace?.recordLine(line);
      }
    }
    await toolTrace?.flush();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
