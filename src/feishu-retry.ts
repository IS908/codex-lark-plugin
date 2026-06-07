import { appConfig } from './config.js';

export interface FeishuRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  retryTimeout?: boolean;
}

const RETRYABLE_NETWORK_ERRORS = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
]);

const RETRYABLE_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504]);
const PERMANENT_FEISHU_CODES = new Set([
  230001, // parameter error
  99991668, // invalid file_key/resource
  99991672, // permission denied
]);

export class FeishuTimeoutError extends Error {
  code = 'FEISHU_TIMEOUT';

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'FeishuTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function retryExhaustedError(label: string, attempts: number, err: unknown): Error {
  const wrapped = new Error(`${label} failed after ${attempts} attempts: ${errorMessage(err)}`) as Error & {
    code?: unknown;
    status?: unknown;
    response?: unknown;
    data?: unknown;
    cause?: unknown;
  };
  wrapped.cause = err;

  if (typeof err === 'object' && err !== null) {
    const original = err as any;
    if (original.code !== undefined) wrapped.code = original.code;
    if (original.status !== undefined) wrapped.status = original.status;
    if (original.response !== undefined) wrapped.response = original.response;
    if (original.data !== undefined) wrapped.data = original.data;
  }

  return wrapped;
}

function asFeishuBusinessError(result: unknown): Error | null {
  if (typeof result !== 'object' || result === null) return null;
  const payload = result as any;
  const code = Number(payload.code);
  if (!Number.isFinite(code) || code === 0) return null;
  const msg = payload.msg ?? payload.message ?? 'Feishu API error';
  const err = new Error(`Feishu API [${code}]: ${msg}`) as Error & { response?: { data: unknown }; data?: unknown };
  err.response = { data: payload };
  err.data = payload;
  return err;
}

export function isRetryableFeishuError(err: any): boolean {
  if (err?.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true;
  if (err?.cause?.code && RETRYABLE_NETWORK_ERRORS.has(err.cause.code)) return true;

  const status = err?.response?.status ?? err?.status;
  if (status && RETRYABLE_HTTP_CODES.has(status)) return true;

  const rawApiCode = err?.response?.data?.code ?? err?.data?.code;
  const apiCode = Number(rawApiCode);
  if (Number.isFinite(apiCode)) {
    if (PERMANENT_FEISHU_CODES.has(apiCode)) return false;
    return false;
  }

  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset')
  );
}

export function isFeishuTimeoutError(err: unknown): boolean {
  return err instanceof FeishuTimeoutError || (err as any)?.code === 'FEISHU_TIMEOUT';
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FeishuTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withFeishuRetry<T>(
  label: string,
  operation: () => Promise<T>,
  options: FeishuRetryOptions = {},
): Promise<T> {
  const attempts = positiveInt(options.attempts, appConfig.feishuApiRetryAttempts);
  const baseDelayMs = positiveInt(options.baseDelayMs, appConfig.feishuApiRetryBaseDelayMs);
  const timeoutMs = positiveInt(options.timeoutMs, appConfig.feishuApiTimeoutMs);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await withTimeout(operation(), timeoutMs, label);
      const businessError = asFeishuBusinessError(result);
      if (businessError) throw businessError;
      return result;
    } catch (err) {
      lastErr = err;
      if (isFeishuTimeoutError(err) && options.retryTimeout === false) throw err;
      if (!isRetryableFeishuError(err) || attempt >= attempts) break;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.error(
        `[feishu-retry] ${label} failed on attempt ${attempt}/${attempts}; retrying in ${delay}ms: ${errorMessage(err)}`,
      );
      await sleep(delay);
    }
  }

  if (!isRetryableFeishuError(lastErr)) {
    throw lastErr;
  }
  throw retryExhaustedError(label, attempts, lastErr);
}

export const feishuApiCall = withFeishuRetry;
