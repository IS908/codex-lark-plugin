import { spawn } from 'node:child_process';
import { appConfig } from './config.js';
import type {
  LarkUserMessageFetchResult,
  LarkUserMessageFetcher,
} from './lark-transport-contracts.js';

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function createLarkCliUserMessageFetcher(): LarkUserMessageFetcher | undefined {
  if (!appConfig.quotedCardUserFetchEnabled) return undefined;
  return {
    fetchMessage: (messageId: string) => fetchMessageWithLarkCliUserIdentity(messageId),
  };
}

async function fetchMessageWithLarkCliUserIdentity(
  messageId: string,
): Promise<LarkUserMessageFetchResult> {
  const args = [
    'im',
    '+messages-mget',
    '--message-ids',
    messageId,
    '--as',
    'user',
    '--format',
    'json',
    '--no-reactions',
  ];
  const result = await runProcess(appConfig.quotedCardUserFetchCommand, args, {
    timeoutMs: appConfig.quotedCardUserFetchTimeoutMs,
    maxOutputBytes: appConfig.quotedCardUserFetchMaxBytes,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      fetchResult: code === 'ENOENT' ? 'unavailable' : 'error',
      diagnostic: sanitizeDiagnostic(`spawn_error=${code ?? result.error.message}`),
    };
  }
  if (result.timedOut) {
    return {
      fetchResult: 'timeout',
      diagnostic: sanitizeDiagnostic(`timeout_ms=${appConfig.quotedCardUserFetchTimeoutMs}`),
    };
  }
  if (result.truncated) {
    return {
      fetchResult: 'error',
      diagnostic: sanitizeDiagnostic(`stdout_truncated max_bytes=${appConfig.quotedCardUserFetchMaxBytes}`),
    };
  }
  if (result.exitCode !== 0) {
    return {
      fetchResult: 'error',
      diagnostic: sanitizeDiagnostic(
        `exit_code=${result.exitCode ?? 'null'} signal=${result.signal ?? 'none'} stderr=${result.stderr}`,
      ),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim() || '{}');
    const item = findMessageItem(parsed, messageId);
    if (!item) {
      return {
        fetchResult: 'empty',
        diagnostic: 'empty_response',
      };
    }
    return { item };
  } catch (error) {
    return {
      fetchResult: 'error',
      diagnostic: sanitizeDiagnostic(`json_parse_error=${error instanceof Error ? error.message : String(error)}`),
    };
  }
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult, keepForceKillTimer = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepForceKillTimer && forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    const append = (current: string, chunk: Buffer, currentBytes: number): [string, number] => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > options.maxOutputBytes) {
        truncated = true;
        const allowed = Math.max(0, options.maxOutputBytes - currentBytes);
        return [current + chunk.subarray(0, allowed).toString('utf8'), nextBytes];
      }
      return [current + chunk.toString('utf8'), nextBytes];
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 250);
      forceKillTimer.unref?.();
      finish({
        exitCode: null,
        signal: 'SIGTERM',
        timedOut,
        truncated,
        stdout,
        stderr,
      }, true);
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      [stdout, stdoutBytes] = append(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      [stderr, stderrBytes] = append(stderr, chunk, stderrBytes);
    });
    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
        stdout,
        stderr,
        error,
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        return;
      }
      finish({
        exitCode,
        signal,
        timedOut,
        truncated,
        stdout,
        stderr,
      });
    });
  });
}

function findMessageItem(parsed: any, messageId: string): unknown | undefined {
  if (parsed?.message_id === messageId || parsed?.messageId === messageId) return parsed;
  const candidates = [
    parsed?.messages,
    parsed?.items,
    parsed?.data?.messages,
    parsed?.data?.items,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.find((item: any) => !item?.message_id || item.message_id === messageId) ?? candidate[0];
  }
  return undefined;
}

function sanitizeDiagnostic(value: string): string {
  const sanitized = value
    .replace(/\s+/g, ' ')
    .replace(/((?:app|tenant)_access_token|authorization|secret|token)=\S+/gi, '$1=[redacted]')
    .trim();
  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized;
}
