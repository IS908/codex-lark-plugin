import { z } from 'zod';
import {
  CodexExecAbortedError,
  CodexExecProcessError,
  diagnoseCodexExecFailure,
  isCodexExecTimeoutError,
  normalizeCodexExecResult,
  runCodexExecCommand,
  type CodexExecRequest,
  type CodexExecRunner,
  type CodexExecSandbox,
} from '../codex-exec.js';
import {
  CONTINUATION_LIMITS,
  ContinuationExecutionError,
  type ContinuationCheckpoint,
  type ContinuationClaim,
  type ContinuationExecutionResult,
  type ContinuationFilesystemMode,
  type ContinuationJob,
  type ContinuationStepOutcome,
  type ContinuationToolRequest,
} from '../domain/continuation.js';
import type { ContinuationExecutor, ContinuationToolInvoker } from '../ports/continuation.js';
import { untrustedDataBlock } from '../prompts.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { redactContinuationText } from './redaction.js';
import {
  ContinuationWorkingDirectoryError,
  validateContinuationWorkingDirectory,
} from './working-directory.js';

export interface ContinuationCodexExecutorOptions {
  artifactStore: ContinuationArtifactStore;
  configuredSandbox: CodexExecSandbox;
  currentWorkingRoot: string;
  runCodexExec?: CodexExecRunner;
  command?: string;
  toolInvoker?: ContinuationToolInvoker;
}

const compactString = z.string().max(CONTINUATION_LIMITS.objectiveBytes);
const compactStringList = z.array(compactString).max(CONTINUATION_LIMITS.acceptanceCriteriaCount);
const checkpointSchema = z.object({
  summary: compactString,
  completed_steps: compactStringList,
  remaining_steps: compactStringList,
  constraints: compactStringList,
  decisions: compactStringList,
  references: compactStringList,
}).strict();

const continueSchema = z.object({
  outcome: z.literal('continue'),
  checkpoint: checkpointSchema,
  next_step: compactString.min(1),
  resume_after_seconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
}).strict();

const completedSchema = z.object({
  outcome: z.literal('completed'),
  final_message: z.string().max(CONTINUATION_LIMITS.finalMessageBytes),
  result_summary: compactString.optional(),
  artifacts: z.array(compactString).max(CONTINUATION_LIMITS.artifactCount),
}).strict();

const failedSchema = z.object({
  outcome: z.literal('failed'),
  error_code: z.string().min(1).max(128),
  error_summary: compactString,
  retryable: z.boolean(),
  completed_work: compactStringList,
  unperformed_work: compactStringList,
}).strict();

const blockedSchema = z.object({
  outcome: z.literal('blocked'),
  error_code: z.string().min(1).max(128),
  error_summary: compactString,
  required_capability: compactString.min(1),
  completed_work: compactStringList,
  unperformed_work: compactStringList,
}).strict();

const toolRequestSchema = z.object({
  outcome: z.literal('tool_request'),
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  args: z.array(z.string().max(8 * 1024)).max(128),
}).strict();

const outcomeSchema = z.discriminatedUnion('outcome', [
  continueSchema,
  completedSchema,
  failedSchema,
  blockedSchema,
  toolRequestSchema,
]);

const wireOutcomeSchema = z.object({
  outcome: z.enum(['continue', 'completed', 'failed', 'blocked', 'tool_request']),
  checkpoint: checkpointSchema.nullable(),
  next_step: compactString.nullable(),
  resume_after_seconds: z.number().int().min(0).max(24 * 60 * 60).nullable(),
  final_message: z.string().max(CONTINUATION_LIMITS.finalMessageBytes).nullable(),
  result_summary: compactString.nullable(),
  artifacts: z.array(compactString).max(CONTINUATION_LIMITS.artifactCount),
  error_code: z.string().min(1).max(128).nullable(),
  error_summary: compactString.nullable(),
  retryable: z.boolean().nullable(),
  required_capability: compactString.nullable(),
  completed_work: compactStringList,
  unperformed_work: compactStringList,
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).nullable(),
  args: z.array(z.string().max(8 * 1024)).max(128),
}).strict();

const checkpointJsonSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'summary',
    'completed_steps',
    'remaining_steps',
    'constraints',
    'decisions',
    'references',
  ],
  properties: {
    summary: { type: 'string' },
    completed_steps: { type: 'array', items: { type: 'string' } },
    remaining_steps: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    references: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const CONTINUATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'checkpoint',
    'next_step',
    'resume_after_seconds',
    'final_message',
    'result_summary',
    'artifacts',
    'error_code',
    'error_summary',
    'retryable',
    'required_capability',
    'completed_work',
    'unperformed_work',
    'tool',
    'args',
  ],
  properties: {
    outcome: {
      type: 'string',
      enum: ['continue', 'completed', 'failed', 'blocked', 'tool_request'],
    },
    checkpoint: checkpointJsonSchema,
    next_step: { type: ['string', 'null'] },
    resume_after_seconds: { type: ['integer', 'null'], minimum: 0, maximum: 86_400 },
    final_message: { type: ['string', 'null'] },
    result_summary: { type: ['string', 'null'] },
    artifacts: { type: 'array', items: { type: 'string' } },
    error_code: { type: ['string', 'null'] },
    error_summary: { type: ['string', 'null'] },
    retryable: { type: ['boolean', 'null'] },
    required_capability: { type: ['string', 'null'] },
    completed_work: { type: 'array', items: { type: 'string' } },
    unperformed_work: { type: 'array', items: { type: 'string' } },
    tool: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_.-]{1,80}$' },
    args: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', maxLength: 8192 },
    },
  },
};

class ContinuationCodexExecutor implements ContinuationExecutor {
  private readonly runCodexExec: CodexExecRunner;

  constructor(private readonly options: ContinuationCodexExecutorOptions) {
    this.runCodexExec = options.runCodexExec ?? runCodexExecCommand;
  }

  async execute(
    claim: ContinuationClaim,
    signal: AbortSignal,
  ): Promise<ContinuationExecutionResult> {
    try {
      if (claim.job.permissions.approval.mode !== 'never') {
        return {
          outcome: blockedCapabilityOutcome({
            errorCode: 'continuation_approval_unavailable',
            errorSummary: 'Interactive approval is reserved but is not enabled for continuation tasks.',
            requiredCapability: 'approval.interactive',
            unperformedWork: ['Obtain one-time interactive approval for this continuation step.'],
          }),
        };
      }
      let workingDirectory: string;
      try {
        workingDirectory = await validateContinuationWorkingDirectory(
          [claim.job.permissions.filesystem.root, this.options.currentWorkingRoot],
          claim.job.workingDirectory,
        );
      } catch (error) {
        if (!(error instanceof ContinuationWorkingDirectoryError)) throw error;
        return {
          outcome: blockedCapabilityOutcome({
            errorCode: 'continuation_working_directory_denied',
            errorSummary: 'The continuation working directory is no longer authorized by its snapshot and current operator policy.',
            requiredCapability: 'filesystem.workspace',
            unperformedWork: ['Use an authorized continuation working directory.'],
          }),
        };
      }
      const artifactDir = await this.options.artifactStore.ensure(claim.job.jobId);
      const request: CodexExecRequest = {
        prompt: buildContinuationPrompt(claim.job, artifactDir),
        ...(this.options.command ? { command: this.options.command } : {}),
        cwd: workingDirectory,
        timeoutMs: claim.job.timeoutSeconds * 1_000,
        sandbox: effectiveSandbox(
          claim.job.permissions.filesystem.mode,
          this.options.configuredSandbox,
        ),
        model: claim.job.model ?? null,
        profile: null,
        ignoreUserConfig: true,
        skipGitRepoCheck: true,
        resumeSessionId: claim.job.executionSessionId ?? null,
        outputSchema: CONTINUATION_OUTPUT_SCHEMA,
        abortSignal: signal,
        configOverrides: [
          'approval_policy="never"',
          'sandbox_workspace_write.network_access=false',
        ],
        additionalWritableDirs: [artifactDir],
        traceLogId: claim.job.jobId,
        traceRunId: claim.attempt.attemptId,
      };

      const recovery = await this.options.toolInvoker?.recover(claim);
      if (recovery?.status === 'blocked') {
        return {
          outcome: blockedToolOutcome(
            recovery.errorCode,
            recovery.errorSummary,
            recovery.tool,
          ),
        };
      }
      if (recovery?.status === 'completed') {
        if (!recovery.result.ok) {
          return {
            outcome: blockedToolOutcome(
              'continuation_tool_denied',
              redactContinuationText(recovery.result.message),
              recovery.tool,
            ),
          };
        }
        return await this.executeWithToolResult(
          claim,
          request,
          { tool: recovery.tool, args: [] },
          recovery.result.message,
          claim.job.executionSessionId,
          false,
          true,
          signal,
        );
      }

      const { result, replacedSession } = await this.executeWithResumeFallback(request);
      const outcome = await parseOutcome(
        result.text,
        claim.job.jobId,
        this.options.artifactStore,
      );
      if (outcome.outcome === 'tool_request') {
        return await this.executeToolRequest(
          claim,
          request,
          outcome,
          result.sessionId,
          replacedSession,
          signal,
        );
      }
      return {
        ...executionSessionPatch(result.sessionId, replacedSession),
        outcome,
      };
    } catch (error) {
      throw mapExecutorError(error);
    }
  }

  private async executeToolRequest(
    claim: ContinuationClaim,
    baseRequest: CodexExecRequest,
    toolRequest: ContinuationToolRequest & { outcome: 'tool_request' },
    firstSessionId: string | null | undefined,
    firstReplacedSession: boolean,
    signal: AbortSignal,
  ): Promise<ContinuationExecutionResult> {
    const firstSessionPatch = executionSessionPatch(firstSessionId, firstReplacedSession);
    if (
      !claim.job.requiredTools.includes(toolRequest.tool)
      || !claim.job.permissions.hostTools.includes(toolRequest.tool)
    ) {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(
          'continuation_tool_not_declared',
          `Local CLI tool "${toolRequest.tool}" was not declared in required_tools.`,
          toolRequest.tool,
        ),
      };
    }
    if (!this.options.toolInvoker) {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(
          'continuation_tool_unavailable',
          `Local CLI tool "${toolRequest.tool}" is unavailable to continuation tasks.`,
          toolRequest.tool,
        ),
      };
    }

    const invocation = await this.options.toolInvoker.invoke(
      claim,
      { tool: toolRequest.tool, args: toolRequest.args },
      signal,
    );
    if (invocation.status === 'blocked') {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(
          invocation.errorCode,
          invocation.errorSummary,
          toolRequest.tool,
        ),
      };
    }
    if (!invocation.result.ok) {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(
          'continuation_tool_denied',
          redactContinuationText(invocation.result.message),
          toolRequest.tool,
        ),
      };
    }

    return await this.executeWithToolResult(
      claim,
      baseRequest,
      toolRequest,
      invocation.result.message,
      firstSessionId,
      firstReplacedSession,
      false,
      signal,
    );
  }

  private async executeWithToolResult(
    claim: ContinuationClaim,
    baseRequest: CodexExecRequest,
    toolRequest: ContinuationToolRequest,
    resultMessage: string,
    previousSessionId: string | null | undefined,
    previousReplacedSession: boolean,
    includeJobContext: boolean,
    signal: AbortSignal,
  ): Promise<ContinuationExecutionResult> {
    const toolResultPrompt = buildContinuationToolResultPrompt(toolRequest, resultMessage);
    const followupRequest: CodexExecRequest = {
      ...baseRequest,
      prompt: includeJobContext
        ? `${baseRequest.prompt}\n\n${toolResultPrompt}`
        : toolResultPrompt,
      resumeSessionId: previousSessionId ?? baseRequest.resumeSessionId ?? null,
      abortSignal: signal,
    };
    const followup = await this.executeWithResumeFallback(followupRequest);
    const followupOutcome = await parseOutcome(
      followup.result.text,
      claim.job.jobId,
      this.options.artifactStore,
    );
    if (followupOutcome.outcome === 'tool_request') {
      return {
        ...combinedExecutionSessionPatch(
          followup.result.sessionId,
          followup.replacedSession,
          previousSessionId,
          previousReplacedSession,
        ),
        outcome: blockedToolOutcome(
          'continuation_tool_call_limit',
          'Only one local CLI tool request is allowed per continuation step.',
          followupOutcome.tool,
        ),
      };
    }
    return {
      ...combinedExecutionSessionPatch(
        followup.result.sessionId,
        followup.replacedSession,
        previousSessionId,
        previousReplacedSession,
      ),
      outcome: followupOutcome,
    };
  }

  private async executeWithResumeFallback(request: CodexExecRequest) {
    try {
      return {
        result: normalizeCodexExecResult(await this.runCodexExec(request)),
        replacedSession: false,
      };
    } catch (error) {
      if (
        !request.resumeSessionId
        || error instanceof CodexExecAbortedError
        || isCodexExecTimeoutError(error)
        || !isResumeUnavailableError(error)
      ) {
        throw error;
      }
      return {
        result: normalizeCodexExecResult(
          await this.runCodexExec({ ...request, resumeSessionId: null }),
        ),
        replacedSession: true,
      };
    }
  }
}

export function createContinuationCodexExecutor(
  options: ContinuationCodexExecutorOptions,
): ContinuationExecutor {
  return new ContinuationCodexExecutor(options);
}

async function parseOutcome(
  text: string,
  jobId: string,
  artifactStore: ContinuationArtifactStore,
): Promise<ContinuationStepOutcome | (ContinuationToolRequest & { outcome: 'tool_request' })> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ContinuationExecutionError(
      'invalid_continuation_output',
      'Continuation Codex output was not valid JSON.',
      true,
    );
  }
  const wire = wireOutcomeSchema.safeParse(raw);
  const candidate = wire.success ? compactWireOutcome(wire.data) : raw;
  const parsed = outcomeSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new ContinuationExecutionError(
      'invalid_continuation_output',
      `Continuation Codex output did not match the required schema: ${detail}`,
      true,
    );
  }

  const value = parsed.data;
  if (value.outcome === 'tool_request') {
    assertByteLimit('tool request', value, CONTINUATION_LIMITS.contextSnapshotBytes);
    return { outcome: 'tool_request', tool: value.tool, args: value.args };
  }
  if (value.outcome === 'continue') {
    assertByteLimit('checkpoint', value.checkpoint, CONTINUATION_LIMITS.checkpointBytes);
    return {
      outcome: 'continue',
      checkpoint: mapCheckpoint(value.checkpoint),
      nextStep: value.next_step,
      ...(value.resume_after_seconds === undefined
        ? {}
        : { resumeAfterSeconds: value.resume_after_seconds }),
    };
  }
  if (value.outcome === 'completed') {
    assertByteLimit('final message', value.final_message, CONTINUATION_LIMITS.finalMessageBytes);
    if (value.result_summary !== undefined) {
      assertByteLimit('result summary', value.result_summary, CONTINUATION_LIMITS.objectiveBytes);
    }
    const artifacts = await artifactStore.canonicalizeReferences(jobId, value.artifacts);
    return {
      outcome: 'completed',
      finalMessage: redactContinuationText(value.final_message),
      ...(value.result_summary === undefined
        ? {}
        : { resultSummary: redactContinuationText(value.result_summary) }),
      artifacts,
    };
  }
  if (value.outcome === 'failed') {
    return {
      outcome: 'failed',
      errorCode: redactContinuationText(value.error_code),
      errorSummary: redactContinuationText(value.error_summary),
      retryable: value.retryable,
      completedWork: value.completed_work.map(redactContinuationText),
      unperformedWork: value.unperformed_work.map(redactContinuationText),
    };
  }
  return {
    outcome: 'blocked',
    errorCode: redactContinuationText(value.error_code),
    errorSummary: redactContinuationText(value.error_summary),
    requiredCapability: redactContinuationText(value.required_capability),
    completedWork: value.completed_work.map(redactContinuationText),
    unperformedWork: value.unperformed_work.map(redactContinuationText),
  };
}

function compactWireOutcome(input: z.infer<typeof wireOutcomeSchema>): unknown {
  switch (input.outcome) {
    case 'continue':
      return {
        outcome: input.outcome,
        checkpoint: input.checkpoint,
        next_step: input.next_step,
        ...(input.resume_after_seconds === null
          ? {}
          : { resume_after_seconds: input.resume_after_seconds }),
      };
    case 'completed':
      return {
        outcome: input.outcome,
        final_message: input.final_message,
        ...(input.result_summary === null ? {} : { result_summary: input.result_summary }),
        artifacts: input.artifacts,
      };
    case 'failed':
      return {
        outcome: input.outcome,
        error_code: input.error_code,
        error_summary: input.error_summary,
        retryable: input.retryable,
        completed_work: input.completed_work,
        unperformed_work: input.unperformed_work,
      };
    case 'blocked':
      return {
        outcome: input.outcome,
        error_code: input.error_code,
        error_summary: input.error_summary,
        required_capability: input.required_capability,
        completed_work: input.completed_work,
        unperformed_work: input.unperformed_work,
      };
    case 'tool_request':
      return { outcome: input.outcome, tool: input.tool, args: input.args };
  }
}

function mapCheckpoint(input: z.infer<typeof checkpointSchema>): ContinuationCheckpoint {
  return {
    summary: redactContinuationText(input.summary),
    completedSteps: input.completed_steps.map(redactContinuationText),
    remainingSteps: input.remaining_steps.map(redactContinuationText),
    constraints: input.constraints.map(redactContinuationText),
    decisions: input.decisions.map(redactContinuationText),
    references: input.references.map(redactContinuationText),
  };
}

function buildContinuationPrompt(job: ContinuationJob, artifactDir: string): string {
  const brief = {
    title: job.title,
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    contextSnapshot: job.contextSnapshot,
    checkpoint: job.checkpoint ?? null,
    requiredTools: job.requiredTools,
    stepCount: job.stepCount,
    maxSteps: job.maxSteps,
  };
  return [
    '[Durable Continuation Step]',
    'Execute one bounded unattended slice of the task below.',
    'Return only one JSON object matching the supplied output schema.',
    'Every schema field must be present. Set unused array fields to [] and other unused fields to null.',
    'Do not request approval, send messages, create jobs, or perform source-control publishing actions.',
    'Do not execute a required local CLI directly. When one configured tool is needed, return a tool_request outcome using an exact name from requiredTools; the trusted parent will validate and execute it.',
    'At most one local CLI tool can be requested in this step.',
    'If a required capability is unavailable, return a blocked outcome instead of weakening the execution boundary.',
    `Workspace: ${job.workingDirectory}`,
    `Managed artifact directory: ${artifactDir}`,
    'Artifact references in a completed outcome must be relative files inside the managed artifact directory.',
    '',
    untrustedDataBlock('continuation-job-brief', JSON.stringify(brief, null, 2)),
  ].join('\n');
}

function buildContinuationToolResultPrompt(
  request: ContinuationToolRequest,
  message: string,
): string {
  return [
    '[Continuation Tool Result]',
    'The trusted parent executed the one allowed local CLI request for this step.',
    'Use the result below to return a continue, completed, failed, or blocked outcome.',
    'Do not request another tool in this step.',
    '',
    untrustedDataBlock('continuation-tool-result', JSON.stringify({
      tool: request.tool,
      result: redactContinuationText(message),
    }, null, 2)),
  ].join('\n');
}

function blockedToolOutcome(
  errorCode: string,
  errorSummary: string,
  requiredCapability: string,
): ContinuationStepOutcome {
  return {
    outcome: 'blocked',
    errorCode: redactContinuationText(errorCode),
    errorSummary: redactContinuationText(errorSummary),
    requiredCapability: redactContinuationText(requiredCapability),
    completedWork: [],
    unperformedWork: ['Invoke the required local CLI tool.'],
  };
}

function blockedCapabilityOutcome(input: {
  errorCode: string;
  errorSummary: string;
  requiredCapability: string;
  unperformedWork: string[];
}): ContinuationStepOutcome {
  return {
    outcome: 'blocked',
    errorCode: redactContinuationText(input.errorCode),
    errorSummary: redactContinuationText(input.errorSummary),
    requiredCapability: redactContinuationText(input.requiredCapability),
    completedWork: [],
    unperformedWork: input.unperformedWork.map(redactContinuationText),
  };
}

function executionSessionPatch(
  sessionId: string | null | undefined,
  replacedSession: boolean,
): Pick<ContinuationExecutionResult, 'executionSessionId'> | Record<string, never> {
  if (sessionId) return { executionSessionId: sessionId };
  if (replacedSession) return { executionSessionId: null };
  return {};
}

function combinedExecutionSessionPatch(
  sessionId: string | null | undefined,
  replacedSession: boolean,
  previousSessionId: string | null | undefined,
  previousReplacedSession: boolean,
): Pick<ContinuationExecutionResult, 'executionSessionId'> | Record<string, never> {
  if (sessionId) return { executionSessionId: sessionId };
  if (replacedSession) return { executionSessionId: null };
  return executionSessionPatch(previousSessionId, previousReplacedSession);
}

function boundedSandbox(configured: CodexExecSandbox): Extract<CodexExecSandbox, 'read-only' | 'workspace-write'> {
  return configured === 'read-only' ? 'read-only' : 'workspace-write';
}

function effectiveSandbox(
  snapshot: ContinuationFilesystemMode,
  configured: CodexExecSandbox,
): ContinuationFilesystemMode {
  return snapshot === 'read-only' || boundedSandbox(configured) === 'read-only'
    ? 'read-only'
    : 'workspace-write';
}

function isResumeUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:session|thread).*(?:not found|does not exist|invalid|expired|unavailable|failed to resume)|(?:unable|failed) to resume/i
    .test(error.message);
}

function assertByteLimit(name: string, value: unknown, limit: number): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > limit) {
    throw new Error(`Continuation ${name} exceeds ${limit} bytes.`);
  }
}

function mapExecutorError(error: unknown): ContinuationExecutionError {
  if (error instanceof ContinuationExecutionError) return error;
  if (error instanceof CodexExecAbortedError) {
    return new ContinuationExecutionError(
      'continuation_aborted',
      'The continuation step was aborted.',
      true,
      { cause: error },
    );
  }
  if (isCodexExecTimeoutError(error)) {
    return new ContinuationExecutionError(
      'continuation_timeout',
      'The continuation step timed out.',
      true,
      { cause: error },
    );
  }
  if (error instanceof CodexExecProcessError) {
    const diagnostic = diagnoseCodexExecFailure(error);
    return new ContinuationExecutionError(
      diagnostic.errorCode,
      diagnostic.errorSummary,
      diagnostic.retryable,
      { cause: error },
    );
  }
  return new ContinuationExecutionError(
    'continuation_execution_failed',
    'The continuation step failed before producing a valid outcome.',
    true,
    { cause: error },
  );
}
