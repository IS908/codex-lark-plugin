import { appConfig } from './config.js';
import {
  FileCodexExecSessionStore,
  type CodexSessionRetentionResult,
} from './codex-session-store.js';
import { getActiveCodexExecSessionKeys } from './codex-exec-delivery.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function formatCodexSessionRetentionSummary(
  result: CodexSessionRetentionResult,
  dryRun: boolean,
): string {
  return [
    `[codex-session-retention]${dryRun ? ' dry-run' : ''}`,
    `scanned=${result.scanned}`,
    `eligible=${result.eligible}`,
    `deleted=${result.deleted}`,
    `skipped_active=${result.skippedActive}`,
    `skipped_recent=${result.skippedRecent}`,
    `skipped_abnormal=${result.skippedAbnormal}`,
    `skipped_other=${result.skippedOther}`,
    `failed=${result.failed}`,
    `removed_empty_dirs=${result.removedEmptyDirs}`,
  ].join(' ');
}

export async function runCodexSessionRetention(): Promise<CodexSessionRetentionResult> {
  const dryRun = appConfig.codexSessionRetentionDryRun;
  const store = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);
  const result = await store.cleanupExpired({
    retentionMs: appConfig.codexSessionRetentionDays * DAY_MS,
    dryRun,
    activeKeys: getActiveCodexExecSessionKeys(),
  });

  console.error(formatCodexSessionRetentionSummary(result, dryRun));
  if (dryRun && result.candidates.length > 0) {
    const sample = result.candidates
      .slice(0, 20)
      .map((candidate) => `${candidate.key} updated_at=${candidate.updatedAt}`)
      .join('; ');
    console.error(`[codex-session-retention] dry-run candidates: ${sample}`);
  }

  return result;
}

export function startCodexSessionRetention(): NodeJS.Timeout | null {
  if (!appConfig.codexExecUseSessions) return null;
  const intervalMs = appConfig.codexSessionRetentionScanIntervalHours * HOUR_MS;
  if (intervalMs <= 0) {
    console.error('[codex-session-retention] disabled: scan interval is 0');
    return null;
  }

  const run = () => {
    void runCodexSessionRetention().catch((err) => {
      console.error(`[codex-session-retention] cleanup failed: ${(err as Error).message}`);
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.error(
    `[codex-session-retention] Started (ttl=${appConfig.codexSessionRetentionDays}d scan_every=${appConfig.codexSessionRetentionScanIntervalHours}h dry_run=${appConfig.codexSessionRetentionDryRun})`,
  );
  return timer;
}
