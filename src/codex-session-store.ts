import fs from 'node:fs/promises';
import path from 'node:path';

export interface CodexExecSessionRecord {
  key: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  updatedAt: string;
  model?: string;
  generation?: number;
  cutoffMessageId?: string;
  cutoffTimestampMs?: number;
  handoffSummary?: string;
  handoffConsumedAt?: string;
  boundaryUpdatedAt?: string;
}

export interface CodexExecSessionStore {
  get(key: string): Promise<CodexExecSessionRecord | null>;
  set(record: CodexExecSessionRecord): Promise<void>;
}

export interface CodexSessionRetentionCandidate {
  key: string;
  sessionId: string;
  path: string;
  updatedAt: string;
}

export interface CodexSessionRetentionOptions {
  retentionMs: number;
  now?: Date;
  dryRun?: boolean;
  activeKeys?: ReadonlySet<string>;
}

export interface CodexSessionRetentionResult {
  scanned: number;
  eligible: number;
  deleted: number;
  skippedActive: number;
  skippedRecent: number;
  skippedAbnormal: number;
  skippedOther: number;
  failed: number;
  removedEmptyDirs: number;
  candidates: CodexSessionRetentionCandidate[];
}

export function buildCodexExecSessionKey(chatId: string, threadId?: string): string {
  return threadId ? `chat:${chatId}:thread:${threadId}` : `chat:${chatId}`;
}

function recordPath(rootDir: string, key: string): string {
  const filename = Buffer.from(key, 'utf8').toString('base64url');
  return path.join(rootDir, `${filename}.json`);
}

function isRecord(value: unknown, key: string): value is CodexExecSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexExecSessionRecord>;
  return record.key === key && typeof record.sessionId === 'string';
}

function isRetentionRecord(value: unknown): value is CodexExecSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexExecSessionRecord>;
  return (
    typeof record.key === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.chatId === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

export class FileCodexExecSessionStore implements CodexExecSessionStore {
  constructor(private readonly rootDir: string) {}

  async get(key: string): Promise<CodexExecSessionRecord | null> {
    try {
      const raw = await fs.readFile(recordPath(this.rootDir, key), 'utf8');
      const parsed = JSON.parse(raw);
      return isRecord(parsed, key) ? parsed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(record: CodexExecSessionRecord): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const targetPath = recordPath(this.rootDir, record.key);
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async cleanupExpired(options: CodexSessionRetentionOptions): Promise<CodexSessionRetentionResult> {
    const now = options.now ?? new Date();
    const retentionMs = Math.max(1, Math.floor(options.retentionMs));
    const cutoffMs = now.getTime() - retentionMs;
    const result: CodexSessionRetentionResult = {
      scanned: 0,
      eligible: 0,
      deleted: 0,
      skippedActive: 0,
      skippedRecent: 0,
      skippedAbnormal: 0,
      skippedOther: 0,
      failed: 0,
      removedEmptyDirs: 0,
      candidates: [],
    };

    let files: string[];
    try {
      files = await collectFiles(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }

    for (const filePath of files) {
      result.scanned += 1;
      if (!filePath.endsWith('.json')) {
        result.skippedOther += 1;
        continue;
      }

      let record: CodexExecSessionRecord;
      let mtimeMs = 0;
      try {
        const [raw, info] = await Promise.all([
          fs.readFile(filePath, 'utf8'),
          fs.stat(filePath),
        ]);
        const parsed = JSON.parse(raw);
        if (!isRetentionRecord(parsed)) {
          result.skippedAbnormal += 1;
          continue;
        }
        record = parsed;
        mtimeMs = info.mtimeMs;
      } catch {
        result.skippedAbnormal += 1;
        continue;
      }

      if (options.activeKeys?.has(record.key)) {
        result.skippedActive += 1;
        continue;
      }

      const updatedAtMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        result.skippedAbnormal += 1;
        continue;
      }

      if (updatedAtMs > cutoffMs || mtimeMs > cutoffMs) {
        result.skippedRecent += 1;
        continue;
      }

      result.eligible += 1;
      result.candidates.push({
        key: record.key,
        sessionId: record.sessionId,
        path: filePath,
        updatedAt: record.updatedAt,
      });
      if (options.dryRun) continue;

      try {
        await fs.unlink(filePath);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }

    if (!options.dryRun) {
      result.removedEmptyDirs = await removeEmptyDirectories(this.rootDir);
    }

    return result;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function removeEmptyDirectories(rootDir: string): Promise<number> {
  async function visit(dir: string): Promise<{ empty: boolean; removed: number }> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { empty: false, removed: 0 };
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const result = await visit(child);
      removed += result.removed;
    }

    const after = await fs.readdir(dir);
    if (dir !== rootDir && after.length === 0) {
      try {
        await fs.rmdir(dir);
        removed += 1;
        return { empty: true, removed };
      } catch {
        return { empty: false, removed };
      }
    }

    return { empty: after.length === 0, removed };
  }

  return (await visit(rootDir)).removed;
}
