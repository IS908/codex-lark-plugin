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
    if (recovery.status === 'completed') return recovery;
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
    const result = boundToolResult(rawResult);
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
    return { status: 'completed', result };
  }
}

export function createContinuationLocalCliToolInvoker(
  options: ContinuationLocalCliToolInvokerOptions,
): ContinuationToolInvoker {
  return new ContinuationLocalCliToolInvoker(options);
}

function blocked(
  errorCode: string,
  errorSummary: string,
): ContinuationToolInvocationResult {
  return { status: 'blocked', errorCode, errorSummary };
}

function boundToolResult(result: RunConfiguredLocalCliToolResult): ContinuationToolResult {
  const redacted = redactContinuationText(result.message);
  const fits = (message: string) => Buffer.byteLength(
    JSON.stringify({ ok: result.ok, message }),
    'utf-8',
  ) <= CONTINUATION_LIMITS.toolResultBytes;
  if (fits(redacted)) return { ok: result.ok, message: redacted };

  const characters = Array.from(redacted);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(`${characters.slice(0, middle).join('')}...`)) low = middle;
    else high = middle - 1;
  }
  return { ok: result.ok, message: `${characters.slice(0, low).join('')}...` };
}
