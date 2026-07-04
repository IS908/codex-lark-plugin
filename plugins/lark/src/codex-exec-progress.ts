import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit-log.js';
import { logSafeError } from './safe-log.js';

export interface CodexExecProgressLimits {
  enabled: boolean;
  maxMessages: number;
  maxChars: number;
  minIntervalMs: number;
  pollIntervalMs: number;
}

export interface CodexExecProgressPromptInfo extends CodexExecProgressLimits {
  filePath: string;
  token: string;
}

export interface CodexExecProgressSinkOptions {
  baseDir: string;
  limits: CodexExecProgressLimits;
  caller: string | null;
  messageId: string;
  chatId: string;
  threadId?: string;
  send?: (content: string) => Promise<void>;
  onProgress?: (event: CodexExecProgressEvent) => void;
}

export interface CodexExecProgressEvent {
  content: string;
  timestampMs: number;
  bytes: number;
  visible: boolean;
}

export interface CodexExecProgressCleanupOptions {
  maxAgeMs?: number;
  nowMs?: number;
}

export interface CodexExecProgressCleanupResult {
  progressDir: string;
  removed: number;
  kept: number;
  errors: number;
}

type ProgressRejectReason =
  | 'disabled'
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-token'
  | 'identity-field'
  | 'empty-content'
  | 'max-messages'
  | 'min-interval'
  | 'duplicate'
  | 'low-signal';

const IDENTITY_FIELDS = new Set([
  'chat_id',
  'chatId',
  'thread_id',
  'threadId',
  'open_id',
  'openId',
  'user_id',
  'userId',
  'caller',
  'created_by',
  'createdBy',
]);

const LOW_SIGNAL_PATTERNS = [
  /\b(?:i'?m|i am|working|processing|analyzing|thinking|continuing|still working)\b.{0,40}\b(?:on it|this|the task|now)?$/i,
  /\b(?:please wait|one moment|hold on)\b/i,
  /(?:我)?(?:正在|继续|还在).{0,12}(?:处理|分析|思考|看|推进)/,
  /(?:请稍等|稍等|等一下|马上回来)/,
];

export const CODEX_EXEC_PROGRESS_RETENTION_MS = 12 * 60 * 60 * 1000;
export const CODEX_EXEC_PROGRESS_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function progressParentDir(baseDir: string): string {
  return path.join(baseDir, '.lark-progress');
}

export class CodexExecProgressSink {
  readonly filePath: string;
  readonly token: string;

  private timer: NodeJS.Timeout | null = null;
  private offset = 0;
  private pending = '';
  private sentCount = 0;
  private lastSentAt = 0;
  private lastNormalized = '';
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly options: CodexExecProgressSinkOptions,
  ) {
    this.filePath = path.join(dir, 'progress.jsonl');
    this.token = randomUUID();
  }

  get promptInfo(): CodexExecProgressPromptInfo {
    return {
      filePath: this.filePath,
      token: this.token,
      ...this.options.limits,
    };
  }

  get extraEnv(): Record<string, string> {
    return {
      CODEX_LARK_PROGRESS_FILE: this.filePath,
      CODEX_LARK_PROGRESS_TOKEN: this.token,
    };
  }

  async prepare(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    await fs.writeFile(this.filePath, '', { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(this.filePath, 0o600);
  }

  start(): void {
    if (!this.options.limits.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((err) => logSafeError('[codex-exec-progress] drain failed:', err));
    }, this.options.limits.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drain();
    await this.processPendingLine();
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      await this.drainPromise;
      return;
    }
    this.draining = true;
    this.drainPromise = this.drainOnce();
    try {
      await this.drainPromise;
    } finally {
      this.draining = false;
      this.drainPromise = null;
    }
  }

  private async drainOnce(): Promise<void> {
    const text = await fs.readFile(this.filePath, 'utf-8').catch((err: any) => {
      if (err?.code === 'ENOENT') return '';
      throw err;
    });
    if (text.length <= this.offset) return;
    const chunk = text.slice(this.offset);
    this.offset = text.length;
    const lines = (this.pending + chunk).split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      await this.processLine(line);
    }
  }

  private async processPendingLine(): Promise<void> {
    const line = this.pending.trim();
    this.pending = '';
    if (line) await this.processLine(line);
  }

  private async processLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.auditDenied('invalid-json');
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.auditDenied('invalid-shape');
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (event.version !== 1 || event.type !== 'emit_lark_message' || event.mode !== 'progress') {
      this.auditDenied('invalid-shape');
      return;
    }
    if (event.token !== this.token) {
      this.auditDenied('invalid-token');
      return;
    }
    if (Object.keys(event).some((key) => IDENTITY_FIELDS.has(key))) {
      this.auditDenied('identity-field');
      return;
    }
    if (typeof event.content !== 'string') {
      this.auditDenied('invalid-shape');
      return;
    }

    const normalized = normalizeProgressText(event.content);
    if (!normalized) {
      this.auditDenied('empty-content');
      return;
    }
    if (this.sentCount >= this.options.limits.maxMessages) {
      this.auditDenied('max-messages');
      return;
    }
    const now = Date.now();
    if (
      this.sentCount > 0 &&
      this.options.limits.minIntervalMs > 0 &&
      now - this.lastSentAt < this.options.limits.minIntervalMs
    ) {
      this.auditDenied('min-interval');
      return;
    }
    if (normalized.toLowerCase() === this.lastNormalized) {
      this.auditDenied('duplicate');
      return;
    }
    if (isLowSignalProgress(normalized)) {
      this.auditDenied('low-signal');
      return;
    }

    const content = truncateProgressText(normalized, this.options.limits.maxChars);
    const bytes = Buffer.byteLength(content, 'utf8');
    this.options.onProgress?.({
      content,
      timestampMs: now,
      bytes,
      visible: !!this.options.send,
    });
    if (!this.options.send) {
      this.sentCount += 1;
      this.lastSentAt = now;
      this.lastNormalized = normalized.toLowerCase();
      void audit('codex_exec_progress', this.options.caller, this.auditArgs({ bytes, visible: false }), 'ok');
      return;
    }
    try {
      await this.options.send(content);
      this.sentCount += 1;
      this.lastSentAt = now;
      this.lastNormalized = normalized.toLowerCase();
      void audit('codex_exec_progress', this.options.caller, this.auditArgs({ bytes, visible: true }), 'ok');
    } catch (err) {
      logSafeError('[codex-exec-progress] send failed:', err);
      void audit('codex_exec_progress', this.options.caller, this.auditArgs({ bytes, visible: true }), 'error');
    }
  }

  private auditDenied(reason: ProgressRejectReason): void {
    void audit('codex_exec_progress', this.options.caller, this.auditArgs({ reason }), 'denied');
  }

  private auditArgs(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      message_id: this.options.messageId,
      chat_id: this.options.chatId,
      thread_id: this.options.threadId,
      sent_count: this.sentCount,
      stopped: this.stopped,
      ...extra,
    };
  }
}

export async function createCodexExecProgressSink(
  options: CodexExecProgressSinkOptions,
): Promise<CodexExecProgressSink | null> {
  if (!options.limits.enabled) return null;
  try {
    const parentDir = progressParentDir(options.baseDir);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await fs.chmod(parentDir, 0o700);
    await cleanupCodexExecProgressFiles(options.baseDir).catch((err) => {
      logSafeError('[codex-exec-progress] cleanup before setup failed:', err);
    });
    const dir = await fs.mkdtemp(path.join(parentDir, 'turn-'));
    await fs.chmod(dir, 0o700);
    const sink = new CodexExecProgressSink(dir, options);
    await sink.prepare();
    return sink;
  } catch (err) {
    logSafeError('[codex-exec-progress] disabled because progress file setup failed:', err);
    return null;
  }
}

export async function cleanupCodexExecProgressFiles(
  baseDir: string,
  options: CodexExecProgressCleanupOptions = {},
): Promise<CodexExecProgressCleanupResult> {
  const progressDir = progressParentDir(baseDir);
  const maxAgeMs = options.maxAgeMs ?? CODEX_EXEC_PROGRESS_RETENTION_MS;
  const nowMs = options.nowMs ?? Date.now();
  const result: CodexExecProgressCleanupResult = { progressDir, removed: 0, kept: 0, errors: 0 };

  let entries: Array<{ name: string }>;
  try {
    entries = await fs.readdir(progressDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return result;
    result.errors += 1;
    logSafeError('[codex-exec-progress] cleanup failed to read progress dir:', err);
    return result;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith('turn-')) continue;
    const entryPath = path.join(progressDir, entry.name);
    try {
      const entryStat = await fs.lstat(entryPath);
      if (nowMs - entryStat.mtimeMs <= maxAgeMs) {
        result.kept += 1;
        continue;
      }
      await fs.rm(entryPath, { recursive: true, force: true });
      result.removed += 1;
    } catch (err) {
      result.errors += 1;
      logSafeError(`[codex-exec-progress] cleanup failed for ${entryPath}:`, err);
    }
  }

  return result;
}

export function startCodexExecProgressRetention(
  baseDir: string,
  options: CodexExecProgressCleanupOptions & { intervalMs?: number } = {},
): NodeJS.Timeout | null {
  const intervalMs = options.intervalMs ?? CODEX_EXEC_PROGRESS_CLEANUP_INTERVAL_MS;
  const cleanup = () => {
    void cleanupCodexExecProgressFiles(baseDir, options).catch((err) => {
      logSafeError('[codex-exec-progress] retention cleanup failed:', err);
    });
  };
  cleanup();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(cleanup, intervalMs);
  timer.unref?.();
  return timer;
}

export function buildCodexExecProgressPrompt(info: CodexExecProgressPromptInfo | null): string[] {
  if (!info?.enabled) return [];
  return [
    'Progress updates (optional, for long-running tasks only):',
    `- Append newline-delimited JSON to ${info.filePath}.`,
    `- Use token ${info.token}.`,
    `- You may emit at most ${info.maxMessages} progress messages; each must be ${info.maxChars} characters or fewer.`,
    `- Wait at least ${Math.ceil(info.minIntervalMs / 1000)} seconds between progress messages.`,
    '- Emit only user-visible milestone facts, blockers, or handoff status. Do not emit thinking, generic "working on it" updates, internal reasoning, or repeated filler.',
    '- For cronjob/report tasks, emit milestone progress when starting or completing external data fetches, report generation, and final delivery preparation so timeout diagnostics can identify the stuck stage.',
    '- Do not include chat_id, thread_id, open_id, user_id, caller, or created_by; the parent Lark bridge derives identity.',
    `- JSONL schema: {"version":1,"token":"${info.token}","type":"emit_lark_message","mode":"progress","content":"Stage completed; starting verification."}`,
  ];
}

function normalizeProgressText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateProgressText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isLowSignalProgress(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 4) return true;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}
