import { appConfig } from './config.js';
import { debugLog } from './debug-log.js';
import type { MemoryStore } from './memory/file.js';
import { sweepInbox } from './resource-governance.js';

export function runStartupResourceCleanup(memoryStore: MemoryStore): void {
  void sweepInbox(appConfig.inboxDir, {
    maxAgeMs: appConfig.inboxMaxAgeHours * 60 * 60 * 1000,
    maxBytes: appConfig.inboxMaxBytes,
  })
    .then((result) => {
      if (result.removedOld || result.removedForSize) {
        debugLog(
          `[governance] Inbox cleanup removed ${result.removedOld} old and ${result.removedForSize} LRU files`,
        );
      }
    })
    .catch((err) => debugLog(`[governance] Inbox cleanup failed: ${err}`));

  void memoryStore
    .pruneEpisodes()
    .then((result) => {
      if (result.removedFiles) debugLog(`[governance] Episode pruning removed ${result.removedFiles} files`);
    })
    .catch((err) => debugLog(`[governance] Episode pruning failed: ${err}`));
}
