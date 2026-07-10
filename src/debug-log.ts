import { appConfig } from './config.js';
import { formatZonedDiagnosticTime } from './diagnostic-log-format.js';
import { appendRotatingLine } from './resource-governance.js';

export function debugLog(msg: string): void {
  const line = `${formatZonedDiagnosticTime(new Date(), appConfig.cronTimezone)} ${formatDebugMessage(msg)}\n`;
  void appendRotatingLine(appConfig.debugLogPath, line, {
    maxBytes: appConfig.logMaxBytes,
    maxFiles: appConfig.logMaxFiles,
    archiveRetentionMonths: appConfig.logArchiveRetentionMonths,
  }).catch(() => undefined);
  console.error(msg);
}

function formatDebugMessage(msg: string): string {
  const match = msg.match(/^\[([^\]\r\n]+)\]\s*(.*)$/);
  if (!match) return msg;
  const [, scope, rest] = match;
  return rest ? `${scope} ${rest}` : scope;
}
