import os from 'node:os';
import path from 'node:path';
import { appConfig } from './config.js';
import { stopSingleInstanceLock } from './resource-governance.js';

const lockPath = path.join(os.tmpdir(), `codex-lark-${appConfig.appId}.lock`);

const okStatuses = new Set(['no_lock', 'stale_lock_removed', 'process_terminated']);

try {
  const result = await stopSingleInstanceLock(lockPath);
  console.error(result.message);
  process.exit(okStatuses.has(result.status) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
