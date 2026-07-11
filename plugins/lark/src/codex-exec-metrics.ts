import { appConfig } from './config.js';
import { debugLog } from './debug-log.js';
import { formatDiagnosticLine, formatZonedDiagnosticTime } from './diagnostic-log-format.js';
import { appendRotatingLine } from './resource-governance.js';

export interface CodexExecUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
}

export interface CodexExecRuntimeMetrics {
  elapsedMs: number;
  toolCalls: number;
  skillUsages: number;
  subagents: number;
  usage?: CodexExecUsage | null;
}

export interface CodexExecRuntimeMetricsCollector {
  recordLine(line: string): void;
  finish(endedAtMs?: number): CodexExecRuntimeMetrics;
}

const START_PATTERN = /\b(start|started|begin|began|running|in_progress|created|requested)\b/i;
const TOOL_PATTERN = /(tool|function[_\s.-]?call|mcp|connector|command[_\s.-]?execution|command|exec|shell|bash|web[_\s.-]?(search|fetch)|browser|apply_patch|patch|file[_\s.-]?(read|write|edit)|edit_file|read_file|write_file)/i;
const SKILL_PATTERN = /(^|[._:\-\s])skills?($|[._:\-\s])|skill[_\s.-]?(use|usage|call|invocation|started|completed)/i;
const SUBAGENT_PATTERN = /(sub[_\s.-]?agent|multi[_\s.-]?agent|agent[_\s.-]?(spawn|delegate|dispatch))/i;
const RUNTIME_FOOTER_SEGMENT =
  /^(?:🔧\d+|🧩\d+|🤖\d+|⏱(?:\d+ms|\d+s|\d+m(?:\d{2}s)?)|📊\s+I[0-9.]+k?(?:\(C[0-9.]+k?\))?\s+O[0-9.]+k?\s+T[0-9.]+k?)$/;
const MAX_MERGED_FOOTER_CHARS = 1000;

type RuntimeMetricKind = 'tool' | 'skill' | 'subagent';

class JsonlCodexExecRuntimeMetricsCollector implements CodexExecRuntimeMetricsCollector {
  private usage: CodexExecUsage | null = null;
  private readonly countedKeys = new Set<string>();
  private sequence = 0;
  private toolCalls = 0;
  private skillUsages = 0;
  private subagents = 0;

  constructor(private readonly startedAtMs: number) {}

  recordLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    this.usage = mergeCodexExecUsage(this.usage, extractUsageFromObject(event));
    this.recordRuntimeMetric(event);
  }

  finish(endedAtMs = Date.now()): CodexExecRuntimeMetrics {
    return {
      elapsedMs: Math.max(0, endedAtMs - this.startedAtMs),
      toolCalls: this.toolCalls,
      skillUsages: this.skillUsages,
      subagents: this.subagents,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private recordRuntimeMetric(event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    const nested = firstObject(record, ['item', 'tool', 'call', 'function', 'data']) ?? {};
    const eventType = firstString(record, ['type', 'event', 'event_type', 'eventType']) ?? '';
    const status = firstString(record, ['status', 'state', 'result']) ?? firstString(nested, ['status', 'state', 'result']) ?? '';
    if (!isStartEvent(eventType, status)) return;

    const kind = inferRuntimeMetricKind(record, nested, eventType);
    if (!kind) return;
    const id = inferMetricId(record, nested) ?? `anonymous-${++this.sequence}`;
    const key = `${kind}:${id}`;
    if (this.countedKeys.has(key)) return;
    this.countedKeys.add(key);

    if (kind === 'tool') this.toolCalls++;
    if (kind === 'skill') this.skillUsages++;
    if (kind === 'subagent') this.subagents++;
  }
}

export function createCodexExecRuntimeMetricsCollector(startedAtMs = Date.now()): CodexExecRuntimeMetricsCollector {
  return new JsonlCodexExecRuntimeMetricsCollector(startedAtMs);
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function firstNumber(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = finiteNonNegativeNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function extractUsageFromObject(source: unknown): CodexExecUsage | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const record = source as Record<string, unknown>;
  const usageSource =
    (record.usage && typeof record.usage === 'object' ? record.usage : null) ??
    (record.token_usage && typeof record.token_usage === 'object' ? record.token_usage : null) ??
    (record.tokenUsage && typeof record.tokenUsage === 'object' ? record.tokenUsage : null) ??
    record;
  if (!usageSource || typeof usageSource !== 'object' || Array.isArray(usageSource)) return null;
  const usageRecord = usageSource as Record<string, unknown>;

  const inputTokens = firstNumber(usageRecord, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
  ]);
  const cachedInputTokens =
    firstNumber(usageRecord, [
      'cached_input_tokens',
      'cachedInputTokens',
      'cached_prompt_tokens',
      'cachedPromptTokens',
    ]) ??
    firstNumber(firstObject(usageRecord, ['input_tokens_details', 'inputTokensDetails', 'prompt_tokens_details', 'promptTokensDetails']), [
      'cached_tokens',
      'cachedTokens',
    ]);
  const outputTokens = firstNumber(usageRecord, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ]);
  const explicitTotalTokens = firstNumber(usageRecord, ['total_tokens', 'totalTokens']);
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : explicitTotalTokens;
  const contextWindowTokens = firstNumber(usageRecord, [
    'context_window',
    'context_window_tokens',
    'contextWindow',
    'contextWindowTokens',
  ]);

  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    contextWindowTokens === undefined
  ) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

export function mergeCodexExecUsage(previous: CodexExecUsage | null, next: CodexExecUsage | null): CodexExecUsage | null {
  if (!next) return previous;
  return { ...(previous ?? {}), ...next };
}

export function extractCodexExecUsageFromJsonLine(line: string): CodexExecUsage | null {
  try {
    return extractUsageFromObject(JSON.parse(line));
  } catch {
    return null;
  }
}

export function extractCodexExecUsage(jsonl: string): CodexExecUsage | null {
  let usage: CodexExecUsage | null = null;
  for (const line of jsonl.split(/\r?\n/)) {
    usage = line.trim() ? mergeCodexExecUsage(usage, extractCodexExecUsageFromJsonLine(line)) : usage;
  }
  return usage;
}

function isStartEvent(eventType: string, status: string): boolean {
  return START_PATTERN.test(status) || START_PATTERN.test(eventType);
}

function inferRuntimeMetricKind(
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
  eventType: string,
): RuntimeMetricKind | null {
  const candidates = [
    eventType,
    firstString(record, ['type', 'event', 'event_type', 'eventType', 'name', 'tool_name', 'toolName']),
    firstString(nested, ['type', 'kind', 'name', 'tool_name', 'toolName']),
    nestedFunctionName(record),
    nestedFunctionName(nested),
  ].filter(Boolean).join(' ');

  if (SUBAGENT_PATTERN.test(candidates)) return 'subagent';
  if (SKILL_PATTERN.test(candidates)) return 'skill';
  if (TOOL_PATTERN.test(candidates)) return 'tool';
  if (
    record.tool !== undefined ||
    record.call !== undefined ||
    record.function !== undefined ||
    nested.command !== undefined ||
    nested.arguments !== undefined ||
    nested.args !== undefined
  ) {
    return 'tool';
  }
  return null;
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

function nestedFunctionName(record: Record<string, unknown>): string | undefined {
  const fn = firstObject(record, ['function']);
  return fn ? firstString(fn, ['name']) : undefined;
}

function inferMetricId(record: Record<string, unknown>, nested: Record<string, unknown>): string | undefined {
  return firstString(record, ['id', 'call_id', 'callId', 'tool_call_id', 'toolCallId', 'invocation_id', 'invocationId']) ??
    firstString(nested, ['id', 'call_id', 'callId', 'tool_call_id', 'toolCallId', 'invocation_id', 'invocationId']);
}

export function formatCodexExecRuntimeMetricsFooter(
  metrics: CodexExecRuntimeMetrics | null | undefined,
  tokenUsageThreshold: number,
): string | undefined {
  if (!metrics) return undefined;
  const parts: string[] = [];
  if (metrics.toolCalls > 0) parts.push(`🔧${metrics.toolCalls}`);
  if (metrics.skillUsages > 0) parts.push(`🧩${metrics.skillUsages}`);
  if (metrics.subagents > 0) parts.push(`🤖${metrics.subagents}`);
  parts.push(`⏱${formatElapsed(metrics.elapsedMs)}`);

  const usage = metrics.usage ?? null;
  if (usage?.totalTokens !== undefined && usage.totalTokens > tokenUsageThreshold) {
    parts.push(formatUsageFooterSegment(usage));
  }
  return parts.join(' · ');
}

function formatUsageFooterSegment(usage: CodexExecUsage): string {
  const input = usage.inputTokens !== undefined ? formatTokenCount(usage.inputTokens) : '-';
  const cached = usage.cachedInputTokens !== undefined ? `(C${formatTokenCount(usage.cachedInputTokens)})` : '';
  const output = usage.outputTokens !== undefined ? formatTokenCount(usage.outputTokens) : '-';
  const total = usage.totalTokens !== undefined ? formatTokenCount(usage.totalTokens) : '-';
  return `📊 I${input}${cached} O${output} T${total}`;
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${minutes}m`;
}

export function mergeCardFooterWithRuntimeMetrics(
  businessFooter: string | undefined,
  runtimeFooter: string | undefined,
): string | undefined {
  const runtime = runtimeFooter?.trim();
  const business = businessFooter?.trim();
  if (!runtime) return business || undefined;
  if (!business) return runtime;

  const preservedBusiness = business
    .split(/\r?\n/)
    .filter((line) => !isRuntimeMetricsFooterLine(line))
    .join('\n')
    .trim();
  const merged = preservedBusiness ? `${preservedBusiness}\n${runtime}` : runtime;
  if (merged.length > MAX_MERGED_FOOTER_CHARS && preservedBusiness) return preservedBusiness;
  return merged;
}

function isRuntimeMetricsFooterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const segments = trimmed.split(/\s*·\s*/);
  return segments.length > 0 && segments.every((segment) => RUNTIME_FOOTER_SEGMENT.test(segment));
}

export async function logCodexExecRuntimeMetrics(
  metrics: CodexExecRuntimeMetrics,
  opts: { logId?: string | null } = {},
): Promise<void> {
  const logId = opts.logId || '-';
  const fields = runtimeMetricsLogFields(metrics);
  debugLog(`[codex-exec-metrics] log_id=${logId} ${fields.join(' ')}`);
  if (!appConfig.codexExecToolTraceEnabled) return;

  await appendRotatingLine(
    appConfig.codexExecTraceLogPath,
    formatDiagnosticLine([
      formatZonedDiagnosticTime(new Date(), appConfig.cronTimezone),
      logId,
      'metrics',
      ...fields,
    ]),
    {
      maxBytes: appConfig.logMaxBytes,
      maxFiles: appConfig.logMaxFiles,
      archiveRetentionMonths: appConfig.logArchiveRetentionMonths,
    },
  );
}

function runtimeMetricsLogFields(metrics: CodexExecRuntimeMetrics): string[] {
  const usage = metrics.usage ?? null;
  return [
    `elapsed_ms=${metrics.elapsedMs}`,
    `tool_calls=${metrics.toolCalls}`,
    `skill_usages=${metrics.skillUsages}`,
    `subagents=${metrics.subagents}`,
    `input_tokens=${usage?.inputTokens ?? 'unavailable'}`,
    `cached_input_tokens=${usage?.cachedInputTokens ?? 'unavailable'}`,
    `output_tokens=${usage?.outputTokens ?? 'unavailable'}`,
    `total_tokens=${usage?.totalTokens ?? 'unavailable'}`,
  ];
}
