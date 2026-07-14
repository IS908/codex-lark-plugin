export const MAX_SCHEDULER_RETRIES = 3;

const RETRY_DELAYS = [30_000, 60_000, 120_000]; // 30s, 60s, 120s

/** Network/transient error codes that warrant a retry. */
const RETRYABLE_NETWORK_ERRORS = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
]);

/** HTTP status codes that warrant a retry. */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);
const PERMANENT_TARGET_HTTP_CODES = new Set([403, 404]);
const PERMANENT_TARGET_API_CODES = new Set([
  99991672, // permission denied / target inaccessible
]);

export function schedulerRetryDelayMs(attempt: number): number {
  return RETRY_DELAYS[attempt - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
}

export function isRetryableError(err: any): boolean {
  // Network-level errors (Node.js syscall errors)
  if (err?.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true;
  if (err?.cause?.code && RETRYABLE_NETWORK_ERRORS.has(err.cause.code)) return true;

  // HTTP status from Feishu SDK (wrapped in response)
  const status = err?.response?.status ?? err?.status ?? err?.cause?.response?.status ?? err?.cause?.status;
  if (status && RETRYABLE_HTTP_CODES.has(status)) return true;

  // Feishu API error codes: permission/param errors are NOT retryable
  const apiCode = Number(
    err?.response?.data?.code ?? err?.data?.code ?? err?.cause?.response?.data?.code ?? err?.cause?.data?.code,
  );
  if (Number.isFinite(apiCode)) {
    // Known non-retryable Feishu codes
    // 99991672 = permission denied, 230001 = param error
    if (apiCode === 99991672 || apiCode === 230001) return false;
    return false;
  }

  // Error message heuristics
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('enotfound') || msg.includes('econnreset')) {
    return true;
  }

  return false;
}

export function isPermanentTargetError(err: any): boolean {
  if (isRetryableError(err)) return false;

  const status = err?.response?.status ?? err?.status ?? err?.cause?.response?.status ?? err?.cause?.status;
  if (PERMANENT_TARGET_HTTP_CODES.has(status)) return true;

  const apiCode = Number(
    err?.response?.data?.code ?? err?.data?.code ?? err?.cause?.response?.data?.code ?? err?.cause?.data?.code,
  );
  return PERMANENT_TARGET_API_CODES.has(apiCode);
}
