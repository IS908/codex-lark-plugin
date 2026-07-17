/**
 * Append-only audit log for sensitive MCP tool invocations.
 *
 * Purpose: the operator can retrospectively inspect which tools were called
 * on their machine, by whom, and with what outcome. This is primarily a
 * defense against terminal-side incidents (borrowed laptop, screen share,
 * accidental invocation) — the log itself is plaintext on the same disk,
 * so the trust boundary is OS file permissions.
 *
 * Best-effort: log failures never propagate out of this module (would be
 * worse to crash a tool call because of a log I/O issue).
 */
import { appConfig } from './config.js';
import {
  diagnosticRaw,
  formatDiagnosticLine,
  formatDiagnosticPayload,
  formatZonedDiagnosticTime,
  redactDiagnosticString,
} from './diagnostic-log-format.js';
import { appendRotatingLine } from './resource-governance.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

/** Best-effort append. Never throws. */
export async function audit(
  tool: string,
  caller: string | null,
  args: Record<string, unknown>,
  outcome: AuditOutcome,
): Promise<void> {
  // Wrap the whole body — JSON.stringify can throw on non-serializable args
  // (circular refs, bigint, etc.), and a logging side-effect must never
  // affect the calling tool's behavior.
  try {
    let argsForLog: Record<string, unknown>;
    try {
      argsForLog = redact(args);
      JSON.stringify(argsForLog);
    } catch {
      argsForLog = { serialization_error: '<unserializable>' };
    }
    const line = formatDiagnosticLine([
      formatZonedDiagnosticTime(new Date(), appConfig.cronTimezone),
      inferAuditLogId(argsForLog),
      'audit',
      tool,
      outcome,
      caller ?? '-',
      diagnosticRaw(formatDiagnosticPayload(argsForLog)),
    ]);

    await appendRotatingLine(appConfig.auditLogPath, line, {
      maxBytes: appConfig.logMaxBytes,
      maxFiles: appConfig.logMaxFiles,
      archiveRetentionMonths: appConfig.logArchiveRetentionMonths,
    });
  } catch {
    // Silent — log failures should never affect tool behavior.
  }
}

function inferAuditLogId(args: Record<string, unknown>): string {
  for (const key of ['job_id', 'jobId', 'message_id', 'messageId', 'reply_to', 'fallback_message_id', 'thread_id', 'threadId', 'chat_id', 'chatId']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '-';
}

/**
 * Truncate long string fields so the log stays scannable and doesn't balloon
 * on large save_memory / prompt payloads.
 */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/(token|secret|password|authorization|cookie|api[_-]?key|credential)/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (typeof v === 'string' && v.length > 80) {
      const redacted = redactDiagnosticString(v);
      out[k] = `${redacted.slice(0, 60)}... (${v.length} chars)`;
    } else if (typeof v === 'string') {
      out[k] = redactDiagnosticString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
