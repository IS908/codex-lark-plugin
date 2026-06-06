import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEBUG_LOG = path.join(os.homedir(), '.codex', 'channels', 'lark', 'debug.log');

export function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch {}
  console.error(msg);
}
