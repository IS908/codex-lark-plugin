import { stopSingleInstanceLock } from './resource-governance.js';
import { LARK_INSTANCE_LOCK_PATH } from './instance-lock.js';

const okStatuses = new Set(['no_lock', 'stale_lock_removed', 'process_terminated']);

try {
  const result = await stopSingleInstanceLock(LARK_INSTANCE_LOCK_PATH);
  console.error(result.message);
  process.exit(okStatuses.has(result.status) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
