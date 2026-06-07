import { appConfig } from './config.js';
import { appendRotatingLine } from './resource-governance.js';

export function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  void appendRotatingLine(appConfig.debugLogPath, line, {
    maxBytes: appConfig.logMaxBytes,
    maxFiles: appConfig.logMaxFiles,
  }).catch(() => undefined);
  console.error(msg);
}
