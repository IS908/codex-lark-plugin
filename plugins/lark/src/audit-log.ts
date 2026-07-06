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
import { appendRotatingLine } from './resource-governance.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

interface AuditLogRecord {
  at: string;
  kind: 'audit';
  tool: string;
  outcome: AuditOutcome;
  caller: string | null;
  args: Record<string, unknown>;
}

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
    const record: AuditLogRecord = {
      at: new Date().toISOString(),
      kind: 'audit',
      tool,
      outcome,
      caller,
      args: argsForLog,
    };
    const line = `${JSON.stringify(record)}\n`;

    await appendRotatingLine(appConfig.auditLogPath, line, {
      maxBytes: appConfig.logMaxBytes,
      maxFiles: appConfig.logMaxFiles,
    });
  } catch {
    // Silent — log failures should never affect tool behavior.
  }
}

/**
 * Truncate long string fields so the log stays scannable and doesn't balloon
 * on large save_memory / prompt payloads.
 */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 80) {
      out[k] = `${v.slice(0, 60)}… (${v.length} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
