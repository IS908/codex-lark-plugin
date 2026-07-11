import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';

export const ACCESS_CONTROL_LISTS = [
  'allowed_user_ids',
  'allowed_chat_ids',
  'group_no_mention_chat_ids',
] as const;

export type AccessControlListName = typeof ACCESS_CONTROL_LISTS[number];
export type AccessControlAction = 'add' | 'remove';

export interface AccessControlSnapshot {
  version: 1;
  revision: number;
  updated_at?: string;
  updated_by?: string;
  allowed_user_ids: string[];
  allowed_chat_ids: string[];
  group_no_mention_chat_ids: string[];
}

export interface AccessControlReader {
  allowsMessage(senderId: string, chatId: string): boolean;
  allowsDocComment(senderId: string): boolean;
  allowsNoMentionChat(chatId: string): boolean;
  isAllowedUserId(userId: string): boolean;
  snapshot(): AccessControlSnapshot;
}

export interface AccessControlMutationResult {
  changed: boolean;
  snapshot: AccessControlSnapshot;
}

const DEFAULT_SNAPSHOT: AccessControlSnapshot = {
  version: 1,
  revision: 0,
  allowed_user_ids: [],
  allowed_chat_ids: [],
  group_no_mention_chat_ids: [],
};

function cloneSnapshot(snapshot: AccessControlSnapshot): AccessControlSnapshot {
  return {
    version: 1,
    revision: snapshot.revision,
    ...(snapshot.updated_at ? { updated_at: snapshot.updated_at } : {}),
    ...(snapshot.updated_by ? { updated_by: snapshot.updated_by } : {}),
    allowed_user_ids: [...snapshot.allowed_user_ids],
    allowed_chat_ids: [...snapshot.allowed_chat_ids],
    group_no_mention_chat_ids: [...snapshot.group_no_mention_chat_ids],
  };
}

function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${field} must contain only strings`);
    const trimmed = item.trim();
    if (!trimmed) throw new Error(`${field} must not contain empty strings`);
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseAccessControlSnapshot(raw: unknown): AccessControlSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('access-control.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported access-control.json version: ${String(obj.version)}`);
  }
  const revision = obj.revision === undefined ? 0 : Number(obj.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error('access-control.json revision must be a non-negative integer');
  }
  const updatedAt = obj.updated_at;
  const updatedBy = obj.updated_by;
  if (updatedAt !== undefined && typeof updatedAt !== 'string') {
    throw new Error('access-control.json updated_at must be a string');
  }
  if (updatedBy !== undefined && typeof updatedBy !== 'string') {
    throw new Error('access-control.json updated_by must be a string');
  }
  return {
    version: 1,
    revision,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(updatedBy ? { updated_by: updatedBy } : {}),
    allowed_user_ids: parseStringList(obj.allowed_user_ids, 'allowed_user_ids'),
    allowed_chat_ids: parseStringList(obj.allowed_chat_ids, 'allowed_chat_ids'),
    group_no_mention_chat_ids: parseStringList(
      obj.group_no_mention_chat_ids,
      'group_no_mention_chat_ids',
    ),
  };
}

function listValue(snapshot: AccessControlSnapshot, list: AccessControlListName): string[] {
  return snapshot[list];
}

export class AccessControlStore implements AccessControlReader {
  private filePath: string;
  private current = cloneSnapshot(DEFAULT_SNAPSHOT);

  constructor(filePath = appConfig.accessControlConfigPath) {
    this.filePath = filePath;
  }

  async load(filePath = this.filePath): Promise<AccessControlSnapshot> {
    this.filePath = filePath;
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        this.current = cloneSnapshot(DEFAULT_SNAPSHOT);
        return this.snapshot();
      }
      throw err;
    }

    const parsed = parseAccessControlSnapshot(JSON.parse(text));
    this.current = parsed;
    return this.snapshot();
  }

  snapshot(): AccessControlSnapshot {
    return cloneSnapshot(this.current);
  }

  allowsMessage(senderId: string, chatId: string): boolean {
    const snapshot = this.current;
    const userConfigured = snapshot.allowed_user_ids.length > 0;
    const chatConfigured = snapshot.allowed_chat_ids.length > 0;
    if (!userConfigured && !chatConfigured) return true;
    const userOk = userConfigured && snapshot.allowed_user_ids.includes(senderId);
    const chatOk = chatConfigured && snapshot.allowed_chat_ids.includes(chatId);
    return userOk || chatOk;
  }

  allowsDocComment(senderId: string): boolean {
    return this.current.allowed_user_ids.length === 0 || this.current.allowed_user_ids.includes(senderId);
  }

  allowsNoMentionChat(chatId: string): boolean {
    return this.current.group_no_mention_chat_ids.includes(chatId);
  }

  isAllowedUserId(userId: string): boolean {
    return this.current.allowed_user_ids.includes(userId);
  }

  async mutate(args: {
    action: AccessControlAction;
    list: AccessControlListName;
    value: string;
    updatedBy: string;
  }): Promise<AccessControlMutationResult> {
    const value = args.value.trim();
    if (!value) throw new Error('access-control value must not be empty');

    const next = this.snapshot();
    const values = listValue(next, args.list);
    const exists = values.includes(value);
    if (args.action === 'add' && exists) return { changed: false, snapshot: this.snapshot() };
    if (args.action === 'remove' && !exists) return { changed: false, snapshot: this.snapshot() };

    if (args.action === 'add') values.push(value);
    else values.splice(values.indexOf(value), 1);
    next.revision += 1;
    next.updated_at = new Date().toISOString();
    next.updated_by = args.updatedBy;

    await this.persist(next);
    this.current = next;
    return { changed: true, snapshot: this.snapshot() };
  }

  replaceForTest(snapshot: Partial<Omit<AccessControlSnapshot, 'version'>> = {}): void {
    this.current = {
      ...cloneSnapshot(DEFAULT_SNAPSHOT),
      ...snapshot,
      version: 1,
      allowed_user_ids: [...(snapshot.allowed_user_ids ?? [])],
      allowed_chat_ids: [...(snapshot.allowed_chat_ids ?? [])],
      group_no_mention_chat_ids: [...(snapshot.group_no_mention_chat_ids ?? [])],
    };
  }

  private async persist(snapshot: AccessControlSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    await fs.writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);
  }
}

export const accessControlStore = new AccessControlStore();
