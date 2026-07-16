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

export function formatContinuationDiagnosticMessage(event: {
  event: string;
  jobId: string;
  attemptId?: string;
  state?: string;
}): string {
  return [
    '[continuation]',
    `event=${formatDiagnosticField(event.event, 64)}`,
    `job_id=${formatDiagnosticField(event.jobId, 128)}`,
    `attempt_id=${formatDiagnosticField(event.attemptId, 128)}`,
    `state=${formatDiagnosticField(event.state, 64)}`,
  ].join(' ');
}

export function formatZonedDiagnosticTime(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}.${byType.fractionalSecond}${normalizeOffset(byType.timeZoneName)}`;
  } catch {
    return date.toISOString();
  }
}

function normalizeOffset(value: string | undefined): string {
  if (!value || value === 'GMT' || value === 'UTC') return '+00:00';
  const match = value.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return value;
  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}
