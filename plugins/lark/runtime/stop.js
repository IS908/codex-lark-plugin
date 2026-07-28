import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  stopLarkInstances
} from "./chunks/chunk-L3455GPA.js";
import {
  appConfig
} from "./chunks/chunk-IEHY4GE3.js";
import "./chunks/chunk-VT5EWFRM.js";

// src/stop.ts
var okStatuses = /* @__PURE__ */ new Set(["no_lock", "stale_lock_removed", "process_terminated"]);
try {
  const results = await stopLarkInstances(appConfig.appId);
  for (const result of results) console.error(result.message);
  process.exit(results.every((result) => okStatuses.has(result.status)) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
