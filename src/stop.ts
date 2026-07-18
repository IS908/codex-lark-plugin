import { appConfig } from './config.js';
import { stopLarkInstances } from './instance-lock.js';

const okStatuses = new Set(['no_lock', 'stale_lock_removed', 'process_terminated']);

try {
  const results = await stopLarkInstances(appConfig.appId);
  for (const result of results) console.error(result.message);
  process.exit(results.every((result) => okStatuses.has(result.status)) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
