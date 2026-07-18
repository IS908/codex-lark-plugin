import { createHash } from 'node:crypto';
import {
  LocalCliToolAbortedError,
  runConfiguredLocalCliToolAsCaller,
  type RunConfiguredLocalCliToolAsCallerOptions,
  type RunConfiguredLocalCliToolResult,
} from '../local-cli-tools.js';
import {
  CONTINUATION_LIMITS,
  type ContinuationClaim,
  type ContinuationToolRequest,
  type ContinuationToolResult,
} from '../domain/continuation.js';
import type {
  DurableRunFailure,
  DurableRunFailureCategory,
  DurableRunOperationRisk,
} from '../domain/durable-run.js';
import type {
  ContinuationRepository,
  ContinuationToolInvocationResult,
  ContinuationToolInvoker,
  ContinuationToolRecoveryResult,
} from '../ports/continuation.js';
import { redactContinuationText } from './redaction.js';

export interface ContinuationLocalCliToolInvokerOptions {
  repository: ContinuationRepository;
  configPath?: string;
  now?: () => Date;
  runTool?: (
    options: RunConfiguredLocalCliToolAsCallerOptions,
  ) => Promise<RunConfiguredLocalCliToolResult>;
}

class ContinuationLocalCliToolInvoker implements ContinuationToolInvoker {
  private readonly runTool: NonNullable<ContinuationLocalCliToolInvokerOptions['runTool']>;
  private readonly now: () => Date;

  constructor(private readonly options: ContinuationLocalCliToolInvokerOptions) {
    this.runTool = options.runTool ?? runConfiguredLocalCliToolAsCaller;
    this.now = options.now ?? (() => new Date());
  }

  async recover(
    claim: ContinuationClaim,
  ): Promise<ContinuationToolRecoveryResult | null> {
    const recovery = await this.options.repository.inspectToolCall(claim);
    if (!recovery) return null;
    if (recovery.status === 'completed') {
      if (!recovery.result.ok && recovery.result.failure) {
        if (claim.job.recovery?.failure.fingerprint === recovery.result.failure.fingerprint) return null;
        return { status: 'failed', tool: recovery.tool, failure: recovery.result.failure };
      }
      return recovery;
    }
    return {
      status: 'blocked',
      tool: recovery.tool,
      errorCode: 'continuation_tool_outcome_unknown',
      errorSummary:
        'The previous local CLI invocation may have completed; it will not be replayed automatically.',
    };
  }

  async invoke(
    claim: ContinuationClaim,
    request: ContinuationToolRequest,
    signal: AbortSignal,
  ): Promise<ContinuationToolInvocationResult> {
    if (!claim.job.requiredTools.includes(request.tool)) {
      return blocked(
        'continuation_tool_not_declared',
        `Local CLI tool "${request.tool}" was not declared in required_tools.`,
      );
    }
    if (signal.aborted) throw new LocalCliToolAbortedError();

    const decision = await this.options.repository.beginToolCall(
      claim,
      request,
      this.now().toISOString(),
    );
    if (decision.status === 'replay') {
      return { status: 'completed', result: decision.result };
    }
    if (decision.status === 'unknown') {
      return blocked(
        'continuation_tool_outcome_unknown',
        'The previous local CLI invocation may have completed; it will not be replayed automatically.',
      );
    }
    if (decision.status === 'conflict') {
      return blocked(
        'continuation_tool_request_conflict',
        'This continuation step already recorded a different local CLI request.',
      );
    }

    const rawResult = await this.runTool({
      caller: claim.job.creatorOpenId,
      tool: request.tool,
      args: request.args,
      configPath: this.options.configPath,
      abortSignal: signal,
      auditContext: {
        job_id: claim.job.jobId,
        attempt_id: claim.attempt.attemptId,
      },
    });
    const failure = rawResult.ok ? undefined : normalizeLocalCliFailure(rawResult, {
      failedStep: claim.job.checkpoint?.nextAction?.id
        ?? claim.job.checkpoint?.currentStepId
        ?? 'initial-step',
      operationRisk: operationRiskForClaim(claim),
    });
    const result = boundToolResult(rawResult, failure);
    try {
      await this.options.repository.completeToolCall(
        claim,
        decision.callId,
        result,
        this.now().toISOString(),
      );
    } catch (error) {
      if (signal.aborted || error instanceof LocalCliToolAbortedError) throw error;
      return blocked(
        'continuation_tool_outcome_unknown',
        'The local CLI invocation finished but its result could not be committed; it will not be replayed automatically.',
      );
    }
    return failure
      ? { status: 'failed', failure }
      : { status: 'completed', result };
  }
}

export function createContinuationLocalCliToolInvoker(
  options: ContinuationLocalCliToolInvokerOptions,
): ContinuationToolInvoker {
  return new ContinuationLocalCliToolInvoker(options);
}

export function normalizeLocalCliFailure(
  result: RunConfiguredLocalCliToolResult,
  context: { failedStep: string; operationRisk: DurableRunOperationRisk },
): DurableRunFailure {
  const envelope = parseRecord(result.message);
  const structuredError = result.failure
    ?? parseStructuredError(result.execution?.stderr)
    ?? parseStructuredError(envelope?.stderr)
    ?? parseStructuredError(envelope);
  const type = lowerString(structuredError?.type);
  const subtype = lowerString(structuredError?.subtype);
  const timedOut = result.execution?.timedOut === true || envelope?.timedOut === true;
  const message = firstString(structuredError?.message, result.message);
  const category = failureCategory({ type, subtype, timedOut, message });
  const hints = stringArray(structuredError?.hints).slice(0, 8);
  const diagnostic = boundedDiagnostic(message);
  const retrySafety = normalizedRetrySafety(
    result.failure?.retrySafe,
    result.failure?.phase,
    category,
    context.operationRisk,
  );
  const capabilityAvailable = category !== 'capability_unavailable';
  const fingerprint = createHash('sha256').update(JSON.stringify({
    category,
    failedStep: context.failedStep,
    type,
    subtype,
    diagnostic,
  })).digest('hex').slice(0, 32);
  return {
    category,
    retrySafety,
    capabilityAvailable,
    operationRisk: context.operationRisk,
    hints,
    failedStep: context.failedStep,
    diagnostic,
    fingerprint,
  };
}

function operationRiskForClaim(claim: ContinuationClaim): DurableRunOperationRisk {
  const { permissions } = claim.job;
  if (permissions.externalSideEffects === 'allowed') return 'external_side_effect';
  if (permissions.network === 'none' && permissions.filesystem.mode === 'read-only') {
    return 'read_only';
  }
  return 'unknown';
}

function normalizedRetrySafety(
  adapterRetrySafe: unknown,
  adapterPhase: unknown,
  category: DurableRunFailureCategory,
  operationRisk: DurableRunOperationRisk,
): DurableRunFailure['retrySafety'] {
  if (adapterRetrySafe === true) return 'safe';
  if (adapterRetrySafe === false) return 'unsafe';
  if (category === 'invalid_invocation' && adapterPhase === 'pre_execution') return 'safe';
  if (
    (category === 'invalid_invocation' || category === 'transient' || category === 'unknown')
    && (operationRisk === 'pure' || operationRisk === 'read_only')
  ) return 'safe';
  if (
    category === 'invalid_invocation'
    || category === 'transient'
    || category === 'unknown'
  ) return 'unknown';
  return 'unsafe';
}

function blocked(
  errorCode: string,
  errorSummary: string,
): ContinuationToolInvocationResult {
  return { status: 'blocked', errorCode, errorSummary };
}

function boundToolResult(
  result: RunConfiguredLocalCliToolResult,
  failure?: DurableRunFailure,
): ContinuationToolResult {
  const redacted = redactContinuationText(result.message);
  const fits = (message: string) => Buffer.byteLength(
    JSON.stringify({ ok: result.ok, message, ...(failure ? { failure } : {}) }),
    'utf-8',
  ) <= CONTINUATION_LIMITS.toolResultBytes;
  if (fits(redacted)) return { ok: result.ok, message: redacted, ...(failure ? { failure } : {}) };

  const characters = Array.from(redacted);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(`${characters.slice(0, middle).join('')}...`)) low = middle;
    else high = middle - 1;
  }
  return {
    ok: result.ok,
    message: `${characters.slice(0, low).join('')}...`,
    ...(failure ? { failure } : {}),
  };
}

function parseRecord(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function parseStructuredError(value: unknown): Record<string, any> | null {
  const record = parseRecord(value);
  return parseRecord(record?.error) ?? record;
}

function failureCategory(input: {
  type: string;
  subtype: string;
  timedOut: boolean;
  message: string;
}): DurableRunFailureCategory {
  if (input.timedOut || ['transient', 'rate_limit', 'timeout', 'upstream'].includes(input.type)) {
    return 'transient';
  }
  if (
    input.type === 'validation'
    || ['invalid_argument', 'invalid_invocation', 'unknown_command'].includes(input.subtype)
  ) return 'invalid_invocation';
  if (['authentication', 'unauthenticated', 'login_required'].includes(input.type)) {
    return 'authentication_required';
  }
  if (['permission', 'forbidden', 'approval_required'].includes(input.type)) {
    return 'permission_required';
  }
  if (['unavailable', 'missing_dependency', 'not_found'].includes(input.type)) {
    return 'capability_unavailable';
  }
  if (['terminal', 'invariant', 'internal'].includes(input.type)) return 'terminal';
  if (/\b(?:not configured|executable not found|missing dependency)\b/i.test(input.message)) {
    return 'capability_unavailable';
  }
  return 'unknown';
}

function boundedDiagnostic(value: string): string {
  const redacted = redactContinuationText(value)
    .replace(/"?tool"?\s*:\s*"[^"]+"\s*,?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(redacted || 'The tool invocation failed without structured diagnostic detail.')
    .slice(0, 1_000)
    .join('');
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?? 'The tool invocation failed without structured diagnostic detail.';
}

function lowerString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => boundedDiagnostic(item))
    : [];
}
