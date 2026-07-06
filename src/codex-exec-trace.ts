import { appConfig } from './config.js';
import { appendRotatingLine } from './resource-governance.js';

export type CodexExecToolTraceMode = 'compact' | 'full' | 'hidden';

export interface CodexExecToolTraceConfig {
  enabled: boolean;
  mode: CodexExecToolTraceMode;
  logPath: string;
  maxBytes: number;
  maxFiles: number;
}

export interface CodexExecToolTraceWriter {
  recordLine(line: string): void;
  flush(): Promise<void>;
}

const TOOL_HINT_PATTERN = /(tool|function|mcp|connector|command|exec|shell|bash|apply_patch|patch|file[_\s.-]?(read|write|edit)|edit_file|read_file|write_file)/i;
const START_PATTERN = /\b(start|started|begin|began|running|in_progress|created|call|requested)\b/i;
const END_PATTERN = /\b(end|ended|complete|completed|finish|finished|success|succeeded|failed|error|errored|cancel|cancelled)\b/i;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|refresh[_-]?token|credential|approval)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];
const MAX_FULL_STRING = 500;
const MAX_COMPACT_STRING = 160;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;

export function createCodexExecToolTraceWriter(
  config: CodexExecToolTraceConfig = {
    enabled: appConfig.codexExecToolTraceEnabled,
    mode: appConfig.codexExecToolTraceMode,
    logPath: appConfig.codexExecTraceLogPath,
    maxBytes: appConfig.logMaxBytes,
    maxFiles: appConfig.logMaxFiles,
  },
): CodexExecToolTraceWriter | null {
  if (!config.enabled) return null;
  return new FileCodexExecToolTraceWriter(config);
}

class FileCodexExecToolTraceWriter implements CodexExecToolTraceWriter {
  private readonly startedAtById = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly config: CodexExecToolTraceConfig) {}

  recordLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => this.recordLineUnlocked(raw))
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }

  private async recordLineUnlocked(line: string): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!shouldTraceCodexExecToolEvent(event)) return;

    const now = Date.now();
    const record = this.config.mode === 'full'
      ? buildFullTraceRecord(event, now)
      : buildCompactTraceRecord(event, now, this.startedAtById, this.config.mode);
    await appendRotatingLine(this.config.logPath, `${JSON.stringify(record)}\n`, {
      maxBytes: this.config.maxBytes,
      maxFiles: this.config.maxFiles,
    });
  }
}

export function shouldTraceCodexExecToolEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  const candidates = collectStringCandidates(record);
  return candidates.some((value) => TOOL_HINT_PATTERN.test(value));
}

function buildFullTraceRecord(event: unknown, now: number): Record<string, unknown> {
  return {
    at: new Date(now).toISOString(),
    kind: 'trace',
    mode: 'full',
    event: sanitizeForTrace(event, { maxString: MAX_FULL_STRING }),
  };
}

function buildCompactTraceRecord(
  event: unknown,
  now: number,
  startedAtById: Map<string, number>,
  mode: 'compact' | 'hidden',
): Record<string, unknown> {
  const record = event && typeof event === 'object' && !Array.isArray(event)
    ? event as Record<string, unknown>
    : {};
  const eventType = firstString(record, ['type', 'event', 'event_type', 'eventType']) ?? 'unknown';
  const nested = firstObject(record, ['item', 'tool', 'call', 'function', 'data']) ?? {};
  const toolName = inferToolName(record, nested);
  const status = inferStatus(record, nested, eventType);
  const traceId = inferTraceId(record, nested);
  const args = compactArgs(record, nested);
  const error = compactError(record, nested);
  const startedAt = traceId ? startedAtById.get(traceId) : undefined;
  if (traceId && isStartStatus(status, eventType)) startedAtById.set(traceId, now);
  if (traceId && isEndStatus(status, eventType)) startedAtById.delete(traceId);
  const durationMs = startedAt !== undefined && isEndStatus(status, eventType)
    ? Math.max(0, now - startedAt)
    : undefined;
  return {
    at: new Date(now).toISOString(),
    kind: 'trace',
    mode,
    event_type: eventType,
    tool: toolName,
    status,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function collectStringCandidates(record: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  function visit(value: unknown, depth: number): void {
    if (depth > 2 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
        candidates.push(key);
        visit(nested, depth + 1);
      }
    }
  }
  visit(record, 0);
  return candidates;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function firstObject(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function inferToolName(record: Record<string, unknown>, nested: Record<string, unknown>): string {
  const direct =
    firstString(record, ['tool_name', 'toolName', 'name']) ??
    firstString(nested, ['tool_name', 'toolName', 'name']) ??
    nestedFunctionName(record) ??
    nestedFunctionName(nested);
  if (direct) return truncateString(redactSecretString(direct), 120);
  const nestedType = firstString(nested, ['type', 'kind']);
  if (nestedType) return truncateString(redactSecretString(nestedType), 120);
  return truncateString(redactSecretString(firstString(record, ['type']) ?? 'tool'), 120);
}

function nestedFunctionName(record: Record<string, unknown>): string | undefined {
  const fn = firstObject(record, ['function']);
  return fn ? firstString(fn, ['name']) : undefined;
}

function inferTraceId(record: Record<string, unknown>, nested: Record<string, unknown>): string | undefined {
  const id = firstString(record, ['id', 'call_id', 'callId', 'tool_call_id', 'toolCallId', 'invocation_id', 'invocationId']) ??
    firstString(nested, ['id', 'call_id', 'callId', 'tool_call_id', 'toolCallId', 'invocation_id', 'invocationId']);
  return id ? truncateString(redactSecretString(id), 120) : undefined;
}

function inferStatus(record: Record<string, unknown>, nested: Record<string, unknown>, eventType: string): string {
  const explicit = firstString(record, ['status', 'state', 'result']) ?? firstString(nested, ['status', 'state', 'result']);
  if (explicit) return truncateString(redactSecretString(explicit), 80);
  if (END_PATTERN.test(eventType)) return /fail|error|cancel/i.test(eventType) ? 'error' : 'completed';
  if (START_PATTERN.test(eventType)) return 'started';
  return 'event';
}

function isStartStatus(status: string, eventType: string): boolean {
  return START_PATTERN.test(status) || START_PATTERN.test(eventType);
}

function isEndStatus(status: string, eventType: string): boolean {
  return END_PATTERN.test(status) || END_PATTERN.test(eventType);
}

function compactArgs(record: Record<string, unknown>, nested: Record<string, unknown>): unknown {
  const source =
    record.arguments ?? record.args ?? record.input ?? record.parameters ??
    nested.arguments ?? nested.args ?? nested.input ?? nested.parameters ?? nested.command;
  if (source === undefined) return undefined;
  return summarizeForCompact(source);
}

function compactError(record: Record<string, unknown>, nested: Record<string, unknown>): unknown {
  const source = record.error ?? record.error_message ?? record.errorMessage ?? nested.error ?? nested.error_message ?? nested.errorMessage;
  if (source === undefined) return undefined;
  return summarizeForCompact(source);
}

function summarizeForCompact(value: unknown): unknown {
  return sanitizeForTrace(value, { maxString: MAX_COMPACT_STRING, maxDepth: 2, maxArrayItems: 6, maxObjectKeys: 10 });
}

function sanitizeForTrace(
  value: unknown,
  opts: { maxString: number; maxDepth?: number; maxArrayItems?: number; maxObjectKeys?: number },
  depth = 0,
  key = '',
): unknown {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxArrayItems = opts.maxArrayItems ?? MAX_ARRAY_ITEMS;
  const maxObjectKeys = opts.maxObjectKeys ?? MAX_OBJECT_KEYS;
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[redacted]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(redactSecretString(value), opts.maxString);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (depth >= maxDepth) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) => sanitizeForTrace(item, opts, depth + 1, key));
    if (value.length > maxArrayItems) items.push(`... ${value.length - maxArrayItems} more`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, maxObjectKeys);
    for (const [childKey, childValue] of entries) {
      out[childKey] = sanitizeForTrace(childValue, opts, depth + 1, childKey);
    }
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > maxObjectKeys) out.__truncated_keys = totalKeys - maxObjectKeys;
    return out;
  }
  return String(value);
}

function redactSecretString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

function truncateString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}... (${value.length} chars)`;
}
