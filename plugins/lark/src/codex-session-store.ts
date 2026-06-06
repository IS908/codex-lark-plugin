import fs from 'node:fs/promises';
import path from 'node:path';

export interface CodexExecSessionRecord {
  key: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  updatedAt: string;
}

export interface CodexExecSessionStore {
  get(key: string): Promise<CodexExecSessionRecord | null>;
  set(record: CodexExecSessionRecord): Promise<void>;
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
    await fs.writeFile(
      recordPath(this.rootDir, record.key),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  }
}
