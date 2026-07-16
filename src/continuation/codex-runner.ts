import { z } from 'zod';
import {
  CodexExecAbortedError,
  CodexExecProcessError,
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
  type ContinuationJob,
  type ContinuationStepOutcome,
} from '../domain/continuation.js';
import type { ContinuationExecutor } from '../ports/continuation.js';
import { untrustedDataBlock } from '../prompts.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { redactContinuationText } from './redaction.js';

export interface ContinuationCodexExecutorOptions {
  artifactStore: ContinuationArtifactStore;
  configuredSandbox: CodexExecSandbox;
  runCodexExec?: CodexExecRunner;
  command?: string;
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

const outcomeSchema = z.discriminatedUnion('outcome', [
  continueSchema,
  completedSchema,
  failedSchema,
  blockedSchema,
]);

const checkpointJsonSchema = {
  type: 'object',
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

const workProperties = {
  error_code: { type: 'string' },
  error_summary: { type: 'string' },
  completed_work: { type: 'array', items: { type: 'string' } },
  unperformed_work: { type: 'array', items: { type: 'string' } },
} as const;

export const CONTINUATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'checkpoint', 'next_step'],
      properties: {
        outcome: { const: 'continue' },
        checkpoint: checkpointJsonSchema,
        next_step: { type: 'string' },
        resume_after_seconds: { type: 'integer', minimum: 0, maximum: 86_400 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'final_message', 'artifacts'],
      properties: {
        outcome: { const: 'completed' },
        final_message: { type: 'string' },
        result_summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'outcome',
        'error_code',
        'error_summary',
        'retryable',
        'completed_work',
        'unperformed_work',
      ],
      properties: {
        outcome: { const: 'failed' },
        ...workProperties,
        retryable: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'outcome',
        'error_code',
        'error_summary',
        'required_capability',
        'completed_work',
        'unperformed_work',
      ],
      properties: {
        outcome: { const: 'blocked' },
        ...workProperties,
        required_capability: { type: 'string' },
      },
    },
  ],
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
      const artifactDir = await this.options.artifactStore.ensure(claim.job.jobId);
      const request: CodexExecRequest = {
        prompt: buildContinuationPrompt(claim.job, artifactDir),
        ...(this.options.command ? { command: this.options.command } : {}),
        cwd: claim.job.workingDirectory,
        timeoutMs: claim.job.timeoutSeconds * 1_000,
        sandbox: boundedSandbox(this.options.configuredSandbox),
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

      const { result, replacedSession } = await this.executeWithResumeFallback(request);
      const outcome = await parseOutcome(
        result.text,
        claim.job.jobId,
        this.options.artifactStore,
      );
      return {
        ...(result.sessionId
          ? { executionSessionId: result.sessionId }
          : replacedSession
            ? { executionSessionId: null }
            : {}),
        outcome,
      };
    } catch (error) {
      throw mapExecutorError(error);
    }
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
): Promise<ContinuationStepOutcome> {
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
  const parsed = outcomeSchema.safeParse(raw);
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
    'Do not request approval, send messages, create jobs, or perform source-control publishing actions.',
    'If a required capability is unavailable, return a blocked outcome instead of weakening the execution boundary.',
    `Workspace: ${job.workingDirectory}`,
    `Managed artifact directory: ${artifactDir}`,
    'Artifact references in a completed outcome must be relative files inside the managed artifact directory.',
    '',
    untrustedDataBlock('continuation-job-brief', JSON.stringify(brief, null, 2)),
  ].join('\n');
}

function boundedSandbox(configured: CodexExecSandbox): Extract<CodexExecSandbox, 'read-only' | 'workspace-write'> {
  return configured === 'read-only' ? 'read-only' : 'workspace-write';
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
    return new ContinuationExecutionError(
      'codex_process_failed',
      'The Codex process failed before producing a valid continuation outcome.',
      true,
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
