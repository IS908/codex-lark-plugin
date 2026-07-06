const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

export interface DiagnosticRawPart {
  raw: string;
}

export function diagnosticRaw(raw: string): DiagnosticRawPart {
  return { raw };
}

export function redactDiagnosticString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

export function truncateDiagnosticString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}... (${value.length} chars)`;
}

export function formatDiagnosticField(value: unknown, maxLen = 200): string {
  if (value === null || value === undefined || value === '') return '-';
  const text = truncateDiagnosticString(redactDiagnosticString(String(value)), maxLen);
  if (!text) return '-';
  return /[\s"'\\]/.test(text) ? JSON.stringify(text) : text;
}

export function formatDiagnosticPayload(value: unknown, maxLen = 2000): string {
  if (value === undefined) return '-';
  try {
    return truncateDiagnosticString(JSON.stringify(value), maxLen);
  } catch {
    return '"<unserializable>"';
  }
}

export function formatDiagnosticLine(parts: Array<unknown | DiagnosticRawPart>): string {
  const fields = parts.map((part) => {
    if (part && typeof part === 'object' && 'raw' in part && typeof part.raw === 'string') {
      return part.raw || '-';
    }
    return formatDiagnosticField(part);
  });
  return `${fields.join('  ')}\n`;
}
