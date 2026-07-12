import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import { redactDiagnosticString, truncateDiagnosticString } from './diagnostic-log-format.js';
import { formatTraceRunIdForDisplay } from './trace-run-id.js';

export interface RunTraceQueryOptions {
  logId: string;
  runId?: string | null;
  withinHours?: number | null;
  now?: Date;
  logPath?: string;
  maxFiles?: number;
  maxToolCalls?: number;
  maxSummaryChars?: number;
  enabled?: boolean;
}

export interface RunTraceToolCall {
  run_id: string;
  name: string;
  status: string;
  call_id?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  summary?: string;
  error?: string;
}

export interface RunTraceQueryResult {
  status: 'ok' | 'disabled' | 'not_found' | 'expired' | 'invalid_request';
  log_id: string;
  run_id?: string;
  run_ids?: string[];
  within_hours: number;
  started_at?: string;
  completed_at?: string;
  tools: RunTraceToolCall[];
  truncated: boolean;
  message?: string;
}

interface ParsedTraceLine {
  timestamp: string;
  timestampMs: number;
  logId: string;
  runId: string;
  tool: string;
  status: string;
  callId: string;
  durationMs?: number;
  summary?: string;
}

const DEFAULT_WITHIN_HOURS = 12;
const MAX_WITHIN_HOURS = 168;
const DEFAULT_MAX_TOOL_CALLS = 50;
const DEFAULT_MAX_SUMMARY_CHARS = 500;

export async function queryRunTrace(options: RunTraceQueryOptions): Promise<RunTraceQueryResult> {
  const enabled = options.enabled ?? appConfig.codexExecToolTraceEnabled;
  const logId = options.logId.trim();
  const withinHours = normalizeWithinHours(options.withinHours);
  if (!enabled) {
    return {
      status: 'disabled',
      log_id: logId || '-',
      within_hours: withinHours,
      tools: [],
      truncated: false,
      message: 'Codex exec tool tracing is disabled.',
    };
  }
  if (!logId) {
    return {
      status: 'invalid_request',
      log_id: '-',
      within_hours: withinHours,
      tools: [],
      truncated: false,
      message: 'log_id is required.',
    };
  }

  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - withinHours * 60 * 60 * 1000;
  const parsed = await readTraceLines({
    logPath: options.logPath ?? appConfig.codexExecTraceLogPath,
    maxFiles: options.maxFiles ?? appConfig.logMaxFiles,
  });
  const matching = parsed
    .filter((line) => line.logId === logId)
    .filter((line) => line.timestampMs >= cutoffMs && line.timestampMs <= now.getTime() + 60_000)
    .filter((line) => matchesRequestedRunId(line.runId, options.runId))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (matching.length === 0) {
    const hadLogId = parsed.some((line) => line.logId === logId && matchesRequestedRunId(line.runId, options.runId));
    return {
      status: hadLogId ? 'expired' : 'not_found',
      log_id: logId,
      ...(options.runId ? { run_id: options.runId } : {}),
      within_hours: withinHours,
      tools: [],
      truncated: false,
      message: hadLogId
        ? 'Trace records exist for this run, but not within the requested time window.'
        : 'No matching trace records were found.',
    };
  }

  return buildRunTraceResult({
    logId,
    runId: options.runId ?? undefined,
    withinHours,
    lines: matching,
    maxToolCalls: options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    maxSummaryChars: options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
  });
}

async function readTraceLines(options: { logPath: string; maxFiles: number }): Promise<ParsedTraceLine[]> {
  const files = traceLogFiles(options.logPath, options.maxFiles);
  const out: ParsedTraceLine[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8').catch((err: any) => {
      if (err?.code === 'ENOENT') return '';
      throw err;
    });
    for (const rawLine of text.split(/\r?\n/)) {
      const parsed = parseCompactTraceLine(rawLine);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function traceLogFiles(logPath: string, maxFiles: number): string[] {
  const files: string[] = [];
  for (let i = Math.max(0, maxFiles); i >= 1; i--) files.push(`${logPath}.${i}`);
  files.push(logPath);
  return files;
}

function parseCompactTraceLine(rawLine: string): ParsedTraceLine | null {
  const line = rawLine.trim();
  if (!line) return null;
  const fullMatch = line.match(/^(\S+)\s\s(\S+)\s\s(\S+)\s\strace\s\sfull\s\s(\S+)\s\s(\S+)\s\s(\S+)\s\s-\s\s-\s\s(.*)$/);
  if (fullMatch) {
    const [, timestamp, logId, runId, eventType, tool, status, rawSummary] = fullMatch;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) return null;
    return {
      timestamp,
      timestampMs,
      logId: unquoteField(logId),
      runId: unquoteField(runId),
      tool: unquoteField(tool),
      status: normalizeStatus(unquoteField(status)),
      callId: unquoteField(eventType),
      summary: normalizeSummary(rawSummary),
    };
  }

  const match = line.match(/^(\S+)\s\s(\S+)\s\s(\S+)\s\s(\S+)\s\s(\S+)\s\s(\S+)\s\s(\S+)\s\s(.*)$/);
  if (!match) return null;
  const [, timestamp, logId, runId, tool, status, callId, duration, rawSummary] = match;
  // Ignore legacy full-format records from releases before run_id existed:
  // <time> <log_id> trace full <event_type> ...
  if (runId === 'trace' || runId === 'metrics') return null;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return {
    timestamp,
    timestampMs,
    logId: unquoteField(logId),
    runId: unquoteField(runId),
    tool: unquoteField(tool),
    status: normalizeStatus(unquoteField(status)),
    callId: unquoteField(callId),
    ...(duration.endsWith('ms') ? { durationMs: Number(duration.slice(0, -2)) } : {}),
    summary: normalizeSummary(rawSummary),
  };
}

function buildRunTraceResult(input: {
  logId: string;
  runId?: string;
  withinHours: number;
  lines: ParsedTraceLine[];
  maxToolCalls: number;
  maxSummaryChars: number;
}): RunTraceQueryResult {
  const byKey = new Map<string, RunTraceToolCall & { firstMs: number; lastMs: number }>();
  const orderedKeys: string[] = [];

  for (const line of input.lines) {
    const key = line.callId && line.callId !== '-'
      ? `${line.runId}:${line.callId}`
      : `${line.runId}:${line.tool}:${orderedKeys.length}`;
    let call = byKey.get(key);
    if (!call) {
      call = {
        run_id: input.runId ?? line.runId,
        name: line.tool,
        status: line.status,
        ...(line.callId && line.callId !== '-' ? { call_id: line.callId } : {}),
        started_at: line.timestamp,
        firstMs: line.timestampMs,
        lastMs: line.timestampMs,
      };
      byKey.set(key, call);
      orderedKeys.push(key);
    }
    call.lastMs = Math.max(call.lastMs, line.timestampMs);
    if (isStartStatus(line.status)) call.started_at = call.started_at ?? line.timestamp;
    if (isTerminalStatus(line.status)) {
      call.completed_at = line.timestamp;
      call.status = line.status;
    } else if (!isTerminalStatus(call.status)) {
      call.status = line.status;
    }
    if (line.durationMs !== undefined) call.duration_ms = line.durationMs;
    if (line.summary && line.summary !== '-') {
      const safeSummary = truncateDiagnosticString(redactDiagnosticString(line.summary), input.maxSummaryChars);
      if (isErrorStatus(line.status)) call.error = safeSummary;
      else call.summary = call.summary ?? safeSummary;
    }
  }

  let truncated = false;
  let tools = orderedKeys.map((key) => byKey.get(key)!).sort((a, b) => a.firstMs - b.firstMs);
  if (tools.length > input.maxToolCalls) {
    tools = tools.slice(0, input.maxToolCalls);
    truncated = true;
  }
  const startedAt = input.lines[0]?.timestamp;
  const completedAt = [...input.lines].reverse().find((line) => isTerminalStatus(line.status))?.timestamp ?? input.lines.at(-1)?.timestamp;

  return {
    status: 'ok',
    log_id: input.logId,
    ...(input.runId ? { run_id: input.runId } : { run_ids: uniqueRunIds(input.lines) }),
    within_hours: input.withinHours,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    tools: tools.map(({ firstMs, lastMs, ...tool }) => tool),
    truncated,
  };
}

function matchesRequestedRunId(lineRunId: string, requestedRunId: string | null | undefined): boolean {
  const requested = requestedRunId?.trim();
  if (!requested) return true;
  const lineDisplay = formatTraceRunIdForDisplay(lineRunId);
  const requestedDisplay = formatTraceRunIdForDisplay(requested);
  return (
    lineRunId === requested
    || lineRunId === requestedDisplay
    || lineDisplay === requested
    || lineDisplay === requestedDisplay
  );
}

function uniqueRunIds(lines: ParsedTraceLine[]): string[] {
  return [...new Set(lines.map((line) => line.runId))];
}

function normalizeWithinHours(value: number | null | undefined): number {
  if (value === undefined || value === null) return DEFAULT_WITHIN_HOURS;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WITHIN_HOURS;
  return Math.max(1, Math.min(MAX_WITHIN_HOURS, Math.floor(value)));
}

function normalizeStatus(status: string): string {
  if (/fail|error|cancel/i.test(status)) return 'failed';
  if (/complete|success|succeed/i.test(status)) return 'completed';
  if (/start|running|progress|created|call|requested/i.test(status)) return 'started';
  return status || 'event';
}

function isStartStatus(status: string): boolean {
  return status === 'started';
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed';
}

function isErrorStatus(status: string): boolean {
  return status === 'failed';
}

function normalizeSummary(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '-') return undefined;
  return unquoteField(trimmed);
}

function unquoteField(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}
