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

export type CodexExecMetricStatus = 'complete' | 'partial' | 'unavailable';

export type CodexExecCountMetric =
  | { value: number; status: Exclude<CodexExecMetricStatus, 'unavailable'> }
  | { value: null; status: 'unavailable' };

export interface CodexExecRuntimeMetrics {
  elapsedMs: number;
  toolCalls: CodexExecCountMetric;
  skillsLoaded: CodexExecCountMetric;
  subagentsSpawned: CodexExecCountMetric;
  usage?: CodexExecUsage | null;
}

export interface CodexExecRuntimeMetricsCollector {
  recordLine(line: string): void;
  finish(endedAtMs?: number): CodexExecRuntimeMetrics;
}

const RUNTIME_FOOTER_SEGMENT =
  /^(?:🔧\d+|🧩\d+|🤖\d+|⏱(?:\d+ms|\d+s|\d+m(?:\d{2}s)?)|📊\s+I[0-9.]+k?(?:\(C[0-9.]+k?\))?\s+O[0-9.]+k?\s+T[0-9.]+k?)$/;
const MAX_MERGED_FOOTER_CHARS = 1000;

type EventPhase = 'started' | 'completed' | 'failed' | 'cancelled' | 'unknown';

const TOOL_ITEM_TYPES = new Set([
  'collab_tool_call',
  'command_execution',
  'computer_tool_call',
  'file_change',
  'file_read',
  'function_call',
  'mcp_tool_call',
  'read_file',
  'tool_call',
  'web_search',
  'web_search_call',
]);
const NON_TOOL_ITEM_TYPES = new Set([
  'agent_message',
  'error',
  'image_generation',
  'reasoning',
  'skill',
  'subagent',
  'todo_list',
]);
const KNOWN_EVENT_BASE_TYPES = new Set([
  'agent',
  'item',
  'skill',
  'skill_call',
  'skill_invocation',
  'skill_usage',
  'skill_use',
  'subagent',
  'thread',
  'turn',
]);
const READ_TOOL_NAMES = new Set([
  'file_read',
  'filesystem_read_file',
  'filesystem_read_text_file',
  'get_file_content',
  'read_file',
  'read_text_file',
]);
const SUBAGENT_SPAWN_TOOL_NAMES = new Set([
  'create_agent',
  'delegate_agent',
  'dispatch_agent',
  'spawn_agent',
]);
const EXPLICIT_SUBAGENT_START_EVENTS = new Set([
  'agent_spawn',
  'agent_spawned',
  'subagent_spawn',
  'subagent_spawned',
  'subagent_started',
]);
const READ_COMMAND_PATTERN =
  /(?:^|[\s;&|('"`])(?:cat|sed|head|tail|less|bat|awk|grep|rg|type|read|get-content)\b/i;

class JsonlCodexExecRuntimeMetricsCollector implements CodexExecRuntimeMetricsCollector {
  private usage: CodexExecUsage | null = null;
  private readonly toolCallKeys = new Set<string>();
  private readonly skillReadKeys = new Set<string>();
  private readonly explicitSkillKeys = new Set<string>();
  private readonly explicitSkillKeysById = new Map<string, string>();
  private readonly subagentKeys = new Set<string>();
  private readonly anonymousStarted = new Map<string, number>();
  private parsedEvents = 0;
  private sawTurnCompleted = false;
  private toolObservationUncertain = false;
  private sequence = 0;

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
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;

    this.parsedEvents++;
    this.usage = mergeCodexExecUsage(this.usage, extractUsageFromObject(event));
    this.recordRuntimeMetric(event);
  }

  finish(endedAtMs = Date.now()): CodexExecRuntimeMetrics {
    const skillKeys = new Set([...this.skillReadKeys, ...this.explicitSkillKeys]);
    const toolCalls =
      this.parsedEvents === 0
        ? unavailableMetric()
        : observedMetric(
            this.toolCallKeys.size,
            this.sawTurnCompleted && !this.toolObservationUncertain ? 'complete' : 'partial',
          );
    return {
      elapsedMs: Math.max(0, endedAtMs - this.startedAtMs),
      toolCalls,
      skillsLoaded:
        skillKeys.size > 0
          ? observedMetric(skillKeys.size, 'partial')
          : unavailableMetric(),
      subagentsSpawned:
        this.subagentKeys.size > 0
          ? observedMetric(this.subagentKeys.size, 'partial')
          : unavailableMetric(),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private recordRuntimeMetric(event: unknown): void {
    const record = event as Record<string, unknown>;
    const nested = firstObject(record, ['item', 'tool', 'call', 'function', 'data']) ?? {};
    const eventType = normalizeMetricIdentifier(
      firstString(record, ['type', 'event', 'event_type', 'eventType']) ?? '',
    );
    const status =
      firstString(nested, ['status', 'state', 'result']) ??
      firstString(record, ['status', 'state', 'result']) ??
      '';
    const phase = inferEventPhase(eventType, status);
    const baseType = stripLifecycleSuffix(eventType);
    const nestedType = normalizeMetricIdentifier(firstString(nested, ['type', 'kind']) ?? '');
    const itemType = baseType === 'item' ? nestedType : baseType;
    const toolName = normalizeMetricIdentifier(
      firstString(nested, ['tool', 'name', 'tool_name', 'toolName']) ??
        firstString(record, ['tool', 'name', 'tool_name', 'toolName']) ??
        nestedFunctionName(nested) ??
        nestedFunctionName(record) ??
        '',
    );

    if (eventType === 'turn_completed') this.sawTurnCompleted = true;
    if (
      baseType === 'item' &&
      nestedType &&
      !TOOL_ITEM_TYPES.has(nestedType) &&
      !NON_TOOL_ITEM_TYPES.has(nestedType)
    ) {
      this.toolObservationUncertain = true;
    }
    if (
      baseType !== 'item' &&
      phase !== 'unknown' &&
      !TOOL_ITEM_TYPES.has(baseType) &&
      !KNOWN_EVENT_BASE_TYPES.has(baseType)
    ) {
      this.toolObservationUncertain = true;
    }

    if (TOOL_ITEM_TYPES.has(itemType) && phase !== 'unknown') {
      this.recordToolCall(itemType, toolName, phase, record, nested);
    }

    if (isExplicitSkillEvent(itemType, eventType)) {
      this.recordExplicitSkillEvent(phase, record, nested);
    }
    if (phase === 'completed' && isSkillRead(itemType, toolName, record, nested)) {
      for (const skillKey of extractSkillKeys(record, nested)) {
        this.skillReadKeys.add(skillKey);
      }
    }

    if (EXPLICIT_SUBAGENT_START_EVENTS.has(eventType)) {
      this.subagentKeys.add(inferNamedMetricKey(record, nested, 'subagent', ++this.sequence));
    }
    if (
      phase === 'completed' &&
      isSubagentSpawnOperation(itemType, toolName)
    ) {
      this.subagentKeys.add(inferSubagentKey(record, nested, ++this.sequence));
    }
  }

  private recordExplicitSkillEvent(
    phase: EventPhase,
    record: Record<string, unknown>,
    nested: Record<string, unknown>,
  ): void {
    const id = inferMetricId(record, nested);
    const key =
      (id ? this.explicitSkillKeysById.get(id) : undefined) ??
      inferNamedMetricKey(record, nested, 'skill', ++this.sequence);
    if (phase === 'failed' || phase === 'cancelled') {
      this.explicitSkillKeys.delete(key);
      if (id) this.explicitSkillKeysById.delete(id);
      return;
    }
    if (!isObservedStartOrSuccess(phase)) return;
    this.explicitSkillKeys.add(key);
    if (id) this.explicitSkillKeysById.set(id, key);
  }

  private recordToolCall(
    itemType: string,
    toolName: string,
    phase: EventPhase,
    record: Record<string, unknown>,
    nested: Record<string, unknown>,
  ): void {
    const id = inferMetricId(record, nested);
    if (id) {
      this.toolCallKeys.add(`tool:${id}`);
      return;
    }

    const fingerprint = anonymousToolFingerprint(itemType, toolName);
    if (phase === 'started') {
      this.toolCallKeys.add(`${fingerprint}:anonymous-${++this.sequence}`);
      this.anonymousStarted.set(fingerprint, (this.anonymousStarted.get(fingerprint) ?? 0) + 1);
      this.toolObservationUncertain = true;
      return;
    }

    const pending = this.anonymousStarted.get(fingerprint) ?? 0;
    if (pending > 0) {
      this.anonymousStarted.set(fingerprint, pending - 1);
      return;
    }
    this.toolCallKeys.add(`${fingerprint}:anonymous-terminal-${++this.sequence}`);
    this.toolObservationUncertain = true;
  }
}

export function createCodexExecRuntimeMetricsCollector(startedAtMs = Date.now()): CodexExecRuntimeMetricsCollector {
  return new JsonlCodexExecRuntimeMetricsCollector(startedAtMs);
}

function observedMetric(
  value: number,
  status: Exclude<CodexExecMetricStatus, 'unavailable'>,
): CodexExecCountMetric {
  return { value, status };
}

function unavailableMetric(): CodexExecCountMetric {
  return { value: null, status: 'unavailable' };
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

function normalizeMetricIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function stripLifecycleSuffix(eventType: string): string {
  return eventType.replace(/_(?:started|completed|failed|cancelled|canceled|spawned)$/, '');
}

function inferEventPhase(eventType: string, rawStatus: string): EventPhase {
  const status = normalizeMetricIdentifier(rawStatus);
  if (['error', 'failed', 'failure'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['complete', 'completed', 'ok', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['created', 'in_progress', 'requested', 'running', 'start', 'started'].includes(status)) {
    return 'started';
  }
  if (eventType.endsWith('_failed')) return 'failed';
  if (eventType.endsWith('_cancelled') || eventType.endsWith('_canceled')) return 'cancelled';
  if (eventType.endsWith('_completed')) return 'completed';
  if (
    eventType.endsWith('_started') ||
    eventType.endsWith('_spawned') ||
    eventType.endsWith('_spawn')
  ) {
    return 'started';
  }
  return 'unknown';
}

function isObservedStartOrSuccess(phase: EventPhase): boolean {
  return phase === 'started' || phase === 'completed';
}

function isExplicitSkillEvent(itemType: string, eventType: string): boolean {
  if (itemType === 'skill') return true;
  const baseType = stripLifecycleSuffix(eventType);
  return ['skill', 'skill_call', 'skill_invocation', 'skill_usage', 'skill_use'].includes(baseType);
}

function inferNamedMetricKey(
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
  kind: 'skill' | 'subagent',
  sequence: number,
): string {
  const name =
    firstString(nested, ['skill_name', 'skillName', 'agent_name', 'agentName', 'name']) ??
    firstString(record, ['skill_name', 'skillName', 'agent_name', 'agentName', 'name']);
  if (name) return `${kind}:name:${normalizeMetricIdentifier(name)}`;
  const id = inferMetricId(record, nested);
  return id ? `${kind}:id:${id}` : `${kind}:anonymous-${sequence}`;
}

function inferSubagentKey(
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
  sequence: number,
): string {
  const agentId =
    firstString(nested, ['agent_id', 'agentId', 'subagent_id', 'subagentId']) ??
    firstString(record, ['agent_id', 'agentId', 'subagent_id', 'subagentId']);
  if (agentId) return `subagent:id:${agentId}`;
  const invocationId = inferMetricId(record, nested);
  if (invocationId) return `subagent:invocation:${invocationId}`;
  return inferNamedMetricKey(record, nested, 'subagent', sequence);
}

function anonymousToolFingerprint(
  itemType: string,
  toolName: string,
): string {
  return `${itemType}:${toolName || '-'}`;
}

function serializeMetricValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isSkillRead(
  itemType: string,
  toolName: string,
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
): boolean {
  if (extractSkillKeys(record, nested).length === 0) return false;
  if (itemType === 'file_read' || itemType === 'read_file' || READ_TOOL_NAMES.has(toolName)) {
    return true;
  }
  if (itemType !== 'command_execution') return false;
  if (!hasSuccessfulCommandOutcome(record, nested)) return false;
  const command =
    firstString(nested, ['command', 'cmd']) ??
    firstString(record, ['command', 'cmd']) ??
    '';
  return READ_COMMAND_PATTERN.test(command);
}

function hasSuccessfulCommandOutcome(
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
): boolean {
  const exitCode =
    finiteNonNegativeNumber(nested.exit_code ?? nested.exitCode) ??
    finiteNonNegativeNumber(record.exit_code ?? record.exitCode);
  return exitCode === undefined || exitCode === 0;
}

function extractSkillKeys(
  record: Record<string, unknown>,
  nested: Record<string, unknown>,
): string[] {
  const payloads = [
    ...collectMetricStrings(record),
    ...collectMetricStrings(nested),
  ];
  const keys = new Set<string>();
  const quotedPattern =
    /(["'])((?:[a-z]:)?[^"'`\r\n]*?[\\/]skills[\\/][^"'`\\/]+[\\/]skill\.md)\1/gi;
  const unquotedPattern =
    /(?:^|[\s"'`=:(])((?:[a-z]:)?(?:[^"'`\s|;&<>]*[\\/])?skills[\\/][^"'`\s|;&<>]+[\\/]skill\.md)(?=$|[\s"'`),;|&<>])/gi;
  for (const payload of payloads) {
    for (const match of payload.matchAll(quotedPattern)) {
      addSkillPathKey(keys, match[2]);
    }
    for (const match of payload.matchAll(unquotedPattern)) {
      addSkillPathKey(keys, match[1]);
    }
  }
  return [...keys];
}

function addSkillPathKey(keys: Set<string>, rawPath: string): void {
  const normalizedPath = rawPath.replace(/\\/g, '/');
  const identity = normalizedPath.match(/(?:^|\/)skills\/([^/]+)\/skill\.md$/i)?.[1];
  if (identity) keys.add(`skill:name:${normalizeMetricIdentifier(identity)}`);
}

function collectMetricStrings(record: Record<string, unknown>): string[] {
  const values = [
    ...['command', 'cmd', 'path', 'file_path', 'filePath'].map((key) => record[key]),
    record.arguments,
    record.args,
    record.input,
  ];
  return values.map(serializeMetricValue).filter(Boolean);
}

function isSubagentSpawnOperation(itemType: string, toolName: string): boolean {
  return (
    SUBAGENT_SPAWN_TOOL_NAMES.has(toolName) &&
    (itemType === 'collab_tool_call' || TOOL_ITEM_TYPES.has(itemType))
  );
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
  if ((metrics.toolCalls.value ?? 0) > 0) parts.push(`🔧${metrics.toolCalls.value}`);
  if ((metrics.skillsLoaded.value ?? 0) > 0) parts.push(`🧩${metrics.skillsLoaded.value}`);
  if ((metrics.subagentsSpawned.value ?? 0) > 0) {
    parts.push(`🤖${metrics.subagentsSpawned.value}`);
  }
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
    ...formatCountMetricLogFields('tool_calls', metrics.toolCalls),
    ...formatCountMetricLogFields('skills_loaded', metrics.skillsLoaded),
    ...formatCountMetricLogFields('subagents_spawned', metrics.subagentsSpawned),
    `input_tokens=${usage?.inputTokens ?? 'unavailable'}`,
    `cached_input_tokens=${usage?.cachedInputTokens ?? 'unavailable'}`,
    `output_tokens=${usage?.outputTokens ?? 'unavailable'}`,
    `total_tokens=${usage?.totalTokens ?? 'unavailable'}`,
  ];
}

function formatCountMetricLogFields(name: string, metric: CodexExecCountMetric): string[] {
  return [
    `${name}=${metric.value ?? 'unavailable'}`,
    `${name}_status=${metric.status}`,
  ];
}
