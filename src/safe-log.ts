function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function pickHeader(headers: unknown, ...names: string[]): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  for (const name of names) {
    const direct = record[name];
    if (typeof direct === 'string' && direct) return direct;
    const lower = record[name.toLowerCase()];
    if (typeof lower === 'string' && lower) return lower;
  }
  return undefined;
}

export function redactErrorForLog(err: unknown): unknown {
  if (Array.isArray(err)) return err.map(redactErrorForLog);
  if (!err || typeof err !== 'object') return err instanceof Error ? err.message : err;

  const anyErr = err as any;
  const response = anyErr.response;
  const data = response?.data ?? anyErr.data;
  const apiError = data && typeof data === 'object' ? data : null;
  const apiErrorInner = apiError?.error && typeof apiError.error === 'object' ? apiError.error : null;
  const config = response?.config ?? anyErr.config;

  const out: Record<string, unknown> = {
    name: anyErr.name,
    message: anyErr.message ?? String(err),
  };
  if (anyErr.code) out.code = anyErr.code;
  if (response?.status) out.status = response.status;
  if (response?.statusText) out.statusText = response.statusText;

  if (apiError?.code || apiError?.msg) {
    out.feishu = {
      code: apiError.code,
      msg: apiError.msg,
      log_id: firstString(apiError.log_id, apiErrorInner?.log_id, pickHeader(response?.headers, 'x-tt-logid')),
      request_id: pickHeader(response?.headers, 'x-request-id', 'request-id'),
      field_violations: apiError.field_violations ?? apiErrorInner?.field_violations,
    };
  }

  if (config?.method || config?.url) {
    out.request = {
      method: config.method,
      url: config.url,
    };
  }

  return out;
}

export function logSafeError(message: string, err: unknown): void {
  console.error(message, redactErrorForLog(err));
}
