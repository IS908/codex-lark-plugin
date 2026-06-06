import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
}

export type CodexExecRunner = (request: CodexExecRequest) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 16 * 1024;

function appendCapped(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (next.length <= OUTPUT_CAP) return next;
  return next.slice(next.length - OUTPUT_CAP);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export async function runCodexExecCommand(request: CodexExecRequest): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-codex-exec-'));
  const outputFile = path.join(tmpDir, 'last-message.txt');
  const command = request.command ?? 'codex';
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = request.cwd ?? process.cwd();

  const args = [
    'exec',
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
  args.push('-');

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk);
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
          reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? 'none'}`;
          reject(new Error(`codex exec failed with exit ${code}: ${truncate(detail, 2000)}`));
          return;
        }
        resolve();
      });

      child.stdin.end(request.prompt);
    });

    const answer = await fs.readFile(outputFile, 'utf8');
    return answer.trim();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
