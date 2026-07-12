export const TRACE_RUN_ID_DISPLAY_LENGTH = 16;

export function formatTraceRunIdForDisplay(runId: string | null | undefined): string {
  const raw = (runId ?? '').trim();
  if (!raw) return '-';
  const hex = raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (hex.length >= TRACE_RUN_ID_DISPLAY_LENGTH) {
    return hex.slice(0, TRACE_RUN_ID_DISPLAY_LENGTH);
  }
  const compact = raw.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return compact.slice(0, TRACE_RUN_ID_DISPLAY_LENGTH) || '-';
}
