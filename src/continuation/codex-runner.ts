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
  continuationAttemptPhase,
  partialOutcomeFromCheckpoint,
  type ContinuationCheckpointV2,
  type ContinuationClaim,
  type ContinuationExecutionResult,
  type ContinuationFilesystemMode,
  type ContinuationStepOutcome,
  type ContinuationToolRequest,
} from '../domain/continuation.js';
import type {
  ContinuationExecutor,
  ContinuationInputStorePort,
  ContinuationToolInvoker,
} from '../ports/continuation.js';
import { untrustedDataBlock } from '../prompts.js';
import { ContinuationArtifactStore } from './artifact-store.js';
import { redactContinuationText } from './redaction.js';
import { decideRecovery } from './recovery-policy.js';
import type { DurableRunFailure } from '../domain/durable-run.js';
import {
  ContinuationWorkingDirectoryError,
  validateContinuationWorkingDirectory,
} from './working-directory.js';

const ARTIFACT_MONITOR_INTERVAL_MS = 100;

export interface ContinuationCodexExecutorOptions {
  artifactStore: ContinuationArtifactStore;
  inputStore?: ContinuationInputStorePort;
  configuredSandbox: CodexExecSandbox;
  currentWorkingRoot: string;
  runCodexExec?: CodexExecRunner;
  command?: string;
  toolInvoker?: ContinuationToolInvoker;
  canUseTrustedPersonalWorkspace?: (actorOpenId: string) => boolean;
}

const compactString = z.string().max(CONTINUATION_LIMITS.objectiveBytes);
const compactStringList = z.array(compactString).max(CONTINUATION_LIMITS.acceptanceCriteriaCount);
const contractId = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
const checkpointStepSchema = z.object({
  id: contractId,
  description: compactString.min(1),
}).strict();
const checkpointSchema = z.object({
  schema_version: z.literal(2),
  summary: compactString,
  current_step_id: contractId,
  completed_step_ids: z.array(contractId).max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  completed_criterion_ids: z.array(contractId).max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  completed_deliverable_ids: z.array(contractId).max(CONTINUATION_LIMITS.deliverableCount),
  remaining_steps: z.array(checkpointStepSchema).max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  artifacts: z.array(z.object({
    id: contractId,
    deliverable_id: contractId,
    path: compactString.min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict()).max(CONTINUATION_LIMITS.artifactCount),
  evidence: z.array(z.object({
    id: contractId,
    requirement_id: contractId,
    criterion_ids: z.array(contractId).max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
    artifact_id: contractId.nullable(),
    reference: compactString.nullable(),
  }).strict()).max(CONTINUATION_LIMITS.verificationRequirementCount),
  side_effects: z.array(z.object({
    id: contractId,
    description: compactString.min(1),
    idempotency_key: compactString.min(1),
  }).strict()).max(CONTINUATION_LIMITS.acceptanceCriteriaCount),
  constraints: compactStringList,
  decisions: compactStringList,
  next_action: checkpointStepSchema.nullable(),
  stop_reason: compactString,
}).strict();

const continueSchema = z.object({
  outcome: z.literal('continue'),
  checkpoint: checkpointSchema,
  resume_after_seconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
}).strict();

const completedSchema = z.object({
  outcome: z.literal('completed'),
  checkpoint: checkpointSchema,
  final_message: z.string().max(CONTINUATION_LIMITS.finalMessageBytes),
  result_summary: compactString.optional(),
  artifacts: z.array(compactString).max(CONTINUATION_LIMITS.artifactCount),
}).strict();

const partialSchema = z.object({
  outcome: z.literal('partial'),
  checkpoint: checkpointSchema,
  completed_work: compactStringList,
  key_findings: compactStringList,
  unperformed_work: compactStringList,
  risks: compactStringList,
  next_steps: compactStringList,
  artifacts: z.array(compactString).max(CONTINUATION_LIMITS.artifactCount),
}).strict();

const failedSchema = z.object({
  outcome: z.literal('failed'),
  checkpoint: checkpointSchema,
  error_code: z.string().min(1).max(128),
  error_summary: compactString,
  retryable: z.boolean(),
  completed_work: compactStringList,
  unperformed_work: compactStringList,
}).strict();

const blockedSchema = z.object({
  outcome: z.literal('blocked'),
  checkpoint: checkpointSchema,
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
  partialSchema,
  failedSchema,
  blockedSchema,
  toolRequestSchema,
]);

const wireOutcomeSchema = z.object({
  outcome: z.enum(['continue', 'completed', 'partial', 'failed', 'blocked', 'tool_request']),
  checkpoint: checkpointSchema.nullable(),
  resume_after_seconds: z.number().int().min(0).max(24 * 60 * 60).nullable(),
  final_message: z.string().max(CONTINUATION_LIMITS.finalMessageBytes).nullable(),
  result_summary: compactString.nullable(),
  artifacts: z.array(compactString).max(CONTINUATION_LIMITS.artifactCount),
  error_code: z.string().min(1).max(128).nullable(),
  error_summary: compactString.nullable(),
  retryable: z.boolean().nullable(),
  required_capability: compactString.nullable(),
  completed_work: compactStringList,
  key_findings: compactStringList,
  unperformed_work: compactStringList,
  risks: compactStringList,
  next_steps: compactStringList,
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).nullable(),
  args: z.array(z.string().max(8 * 1024)).max(128),
}).strict();

const checkpointJsonSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'schema_version',
    'summary',
    'current_step_id',
    'completed_step_ids',
    'completed_criterion_ids',
    'completed_deliverable_ids',
    'remaining_steps',
    'artifacts',
    'evidence',
    'side_effects',
    'constraints',
    'decisions',
    'next_action',
    'stop_reason',
  ],
  properties: {
    schema_version: { type: 'integer', enum: [2] },
    summary: { type: 'string' },
    current_step_id: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$' },
    completed_step_ids: { type: 'array', items: { type: 'string' } },
    completed_criterion_ids: { type: 'array', items: { type: 'string' } },
    completed_deliverable_ids: { type: 'array', items: { type: 'string' } },
    remaining_steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: { id: { type: 'string' }, description: { type: 'string' } },
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'deliverable_id', 'path', 'sha256'],
        properties: {
          id: { type: 'string' },
          deliverable_id: { type: 'string' },
          path: { type: 'string' },
          sha256: { type: 'string' },
        },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'requirement_id', 'criterion_ids', 'artifact_id', 'reference'],
        properties: {
          id: { type: 'string' },
          requirement_id: { type: 'string' },
          criterion_ids: { type: 'array', items: { type: 'string' } },
          artifact_id: { type: ['string', 'null'] },
          reference: { type: ['string', 'null'] },
        },
      },
    },
    side_effects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description', 'idempotency_key'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          idempotency_key: { type: 'string' },
        },
      },
    },
    constraints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    next_action: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['id', 'description'],
      properties: { id: { type: 'string' }, description: { type: 'string' } },
    },
    stop_reason: { type: 'string' },
  },
} as const;

export const CONTINUATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'checkpoint',
    'resume_after_seconds',
    'final_message',
    'result_summary',
    'artifacts',
    'error_code',
    'error_summary',
    'retryable',
    'required_capability',
    'completed_work',
    'key_findings',
    'unperformed_work',
    'risks',
    'next_steps',
    'tool',
    'args',
  ],
  properties: {
    outcome: {
      type: 'string',
      enum: ['continue', 'completed', 'partial', 'failed', 'blocked', 'tool_request'],
    },
    checkpoint: checkpointJsonSchema,
    resume_after_seconds: { type: ['integer', 'null'], minimum: 0, maximum: 86_400 },
    final_message: { type: ['string', 'null'] },
    result_summary: { type: ['string', 'null'] },
    artifacts: { type: 'array', items: { type: 'string' } },
    error_code: { type: ['string', 'null'] },
    error_summary: { type: ['string', 'null'] },
    retryable: { type: ['boolean', 'null'] },
    required_capability: { type: ['string', 'null'] },
    completed_work: { type: 'array', items: { type: 'string' } },
    key_findings: { type: 'array', items: { type: 'string' } },
    unperformed_work: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
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
      if (
        claim.job.permissions.profile === 'trusted_personal_workspace'
        && !this.options.canUseTrustedPersonalWorkspace?.(claim.job.creatorOpenId)
      ) {
        return {
          outcome: blockedCapabilityOutcome({
            checkpoint: checkpointForClaim(claim),
            errorCode: 'continuation_trusted_profile_revoked',
            errorSummary: 'The creator is no longer eligible for trusted_personal_workspace.',
            requiredCapability: 'trusted_personal_workspace',
            unperformedWork: [
              'Restore owner or allowed_user_ids eligibility, then retry the task.',
            ],
          }),
        };
      }
      if (claim.job.permissions.approval.mode !== 'never') {
        return {
          outcome: blockedCapabilityOutcome({
            checkpoint: checkpointForClaim(claim),
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
            checkpoint: checkpointForClaim(claim),
            errorCode: 'continuation_working_directory_denied',
            errorSummary: 'The continuation working directory is no longer authorized by its snapshot and current operator policy.',
            requiredCapability: 'filesystem.workspace',
            unperformedWork: ['Use an authorized continuation working directory.'],
          }),
        };
      }
      if (claim.job.sourceFacts.inputs.length > 0) {
        if (!this.options.inputStore) {
          throw new Error('Continuation input storage is unavailable for a Job with managed inputs.');
        }
        const verification = await this.options.inputStore.verify(
          claim.job.jobId,
          claim.job.sourceFacts.inputs,
        );
        if (!verification.ok) {
          return {
            outcome: {
              outcome: 'failed',
              checkpoint: checkpointForClaim(claim),
              errorCode: 'continuation_input_integrity_failed',
              errorSummary: 'A managed continuation input failed integrity verification.',
              retryable: false,
              completedWork: [],
              unperformedWork: ['Recreate the task from trusted source inputs.'],
            },
          };
        }
      }
      const artifactDir = await this.options.artifactStore.ensure(claim.job.jobId);
      return await this.executeGuardedStep(claim, workingDirectory, artifactDir, signal);
    } catch (error) {
      throw mapExecutorError(error);
    }
  }

  private async executeGuardedStep(
    claim: ContinuationClaim,
    workingDirectory: string,
    artifactDir: string,
    parentSignal: AbortSignal,
  ): Promise<ContinuationExecutionResult> {
    const artifactGuard = await this.startArtifactGuard(claim.job.jobId, parentSignal);
    try {
      const managedInputs = claim.job.sourceFacts.inputs.map((input) => {
        if (!this.options.inputStore) {
          throw new Error('Continuation input storage is unavailable for a Job with managed inputs.');
        }
        return {
          id: input.id,
          fileName: input.fileName,
          path: this.options.inputStore.resolve(claim.job.jobId, input.relativePath),
          sha256: input.sha256,
          sizeBytes: input.sizeBytes,
        };
      });
      const request: CodexExecRequest = {
        prompt: buildContinuationPrompt(claim, artifactDir, managedInputs),
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
        abortSignal: artifactGuard.signal,
        configOverrides: [
          'approval_policy="never"',
          ...(claim.job.permissions.profile === 'trusted_personal_workspace'
            ? ['sandbox_permissions=["disk-full-read-access"]']
            : []),
          `sandbox_workspace_write.network_access=${claim.job.permissions.network === 'enabled'}`,
        ],
        additionalWritableDirs: [artifactDir],
        traceLogId: claim.job.jobId,
        traceRunId: claim.attempt.attemptId,
        ...(claim.job.permissions.profile === 'trusted_personal_workspace'
          ? { forceToolTrace: true }
          : {}),
      };

      const recovery = await this.options.toolInvoker?.recover(claim);
      if (recovery?.status === 'failed') {
        return {
          outcome: recoveryOutcome(claim, recovery.failure, recovery.tool),
        };
      }
      if (recovery?.status === 'blocked') {
        return {
          outcome: blockedToolOutcome(claim,
            recovery.errorCode,
            recovery.errorSummary,
            recovery.tool,
          ),
        };
      }
      if (recovery?.status === 'completed') {
        if (!recovery.result.ok) {
          return {
            outcome: blockedToolOutcome(claim,
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
          artifactGuard.signal,
        );
      }

      const { result, replacedSession } = await this.executeWithResumeFallback(claim, request);
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
          artifactGuard.signal,
        );
      }
      return {
        ...executionSessionPatch(result.sessionId, replacedSession),
        outcome: enforceAttemptConvergence(claim, outcome),
      };
    } finally {
      await artifactGuard.stop();
    }
  }

  private async startArtifactGuard(
    jobId: string,
    parentSignal: AbortSignal,
  ): Promise<{ signal: AbortSignal; stop: () => Promise<void> }> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) relayAbort();
    else parentSignal.addEventListener('abort', relayAbort, { once: true });

    let violation: ContinuationExecutionError | null = null;
    let pendingCheck: Promise<void> | null = null;
    const check = async (): Promise<void> => {
      if (violation) return;
      try {
        await this.options.artifactStore.assertWithinLimit(jobId);
      } catch (error) {
        violation = new ContinuationExecutionError(
          'continuation_artifact_limit_exceeded',
          'Managed continuation artifacts exceeded their byte, entry, or directory-depth limit.',
          false,
          { cause: error },
        );
        controller.abort(violation);
      }
    };
    await check();
    if (violation) {
      parentSignal.removeEventListener('abort', relayAbort);
      throw violation;
    }
    const timer = setInterval(() => {
      if (pendingCheck) return;
      pendingCheck = check().finally(() => { pendingCheck = null; });
    }, ARTIFACT_MONITOR_INTERVAL_MS);
    timer.unref();

    return {
      signal: controller.signal,
      stop: async () => {
        clearInterval(timer);
        parentSignal.removeEventListener('abort', relayAbort);
        await pendingCheck;
        await check();
        if (violation) throw violation;
      },
    };
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
        outcome: blockedToolOutcome(claim,
          'continuation_tool_not_declared',
          `Local CLI tool "${toolRequest.tool}" was not declared in required_tools.`,
          toolRequest.tool,
        ),
      };
    }
    if (!this.options.toolInvoker) {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(claim,
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
    if (invocation.status === 'failed') {
      return {
        ...firstSessionPatch,
        outcome: recoveryOutcome(claim, invocation.failure, toolRequest.tool),
      };
    }
    if (invocation.status === 'blocked') {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(claim,
          invocation.errorCode,
          invocation.errorSummary,
          toolRequest.tool,
        ),
      };
    }
    if (!invocation.result.ok) {
      return {
        ...firstSessionPatch,
        outcome: blockedToolOutcome(claim,
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
    signal: AbortSignal,
  ): Promise<ContinuationExecutionResult> {
    const toolResultPrompt = buildContinuationToolResultPrompt(claim, toolRequest, resultMessage);
    const freshSessionPrompt = `${baseRequest.prompt}\n\n${toolResultPrompt}`;
    const resumeSessionId = previousSessionId ?? baseRequest.resumeSessionId ?? null;
    const followupRequest: CodexExecRequest = {
      ...baseRequest,
      prompt: resumeSessionId ? toolResultPrompt : freshSessionPrompt,
      resumeSessionId,
      abortSignal: signal,
    };
    const followup = await this.executeWithResumeFallback(
      claim,
      followupRequest,
      freshSessionPrompt,
    );
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
        outcome: blockedToolOutcome(claim,
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
      outcome: enforceAttemptConvergence(claim, followupOutcome),
    };
  }

  private async executeWithResumeFallback(
    claim: ContinuationClaim,
    request: CodexExecRequest,
    freshSessionPrompt = request.prompt,
  ) {
    try {
      await this.verifyManagedInputsBeforeLaunch(claim);
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
      await this.verifyManagedInputsBeforeLaunch(claim);
      return {
        result: normalizeCodexExecResult(
          await this.runCodexExec({
            ...request,
            prompt: freshSessionPrompt,
            resumeSessionId: null,
          }),
        ),
        replacedSession: true,
      };
    }
  }

  private async verifyManagedInputsBeforeLaunch(claim: ContinuationClaim): Promise<void> {
    if (claim.job.sourceFacts.inputs.length === 0) return;
    if (!this.options.inputStore) {
      throw new ContinuationExecutionError(
        'continuation_input_integrity_failed',
        'Managed continuation input storage is unavailable.',
        false,
      );
    }
    const verification = await this.options.inputStore.verify(
      claim.job.jobId,
      claim.job.sourceFacts.inputs,
    );
    if (!verification.ok) {
      throw new ContinuationExecutionError(
        'continuation_input_integrity_failed',
        'A managed continuation input failed integrity verification immediately before execution.',
        false,
      );
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
      checkpoint: mapCheckpoint(value.checkpoint),
      finalMessage: redactContinuationText(value.final_message),
      ...(value.result_summary === undefined
        ? {}
        : { resultSummary: redactContinuationText(value.result_summary) }),
      artifacts,
    };
  }
  if (value.outcome === 'partial') {
    const artifacts = await artifactStore.canonicalizeReferences(jobId, value.artifacts);
    return {
      outcome: 'partial',
      checkpoint: mapCheckpoint(value.checkpoint),
      completedWork: value.completed_work.map(redactContinuationText),
      keyFindings: value.key_findings.map(redactContinuationText),
      unperformedWork: value.unperformed_work.map(redactContinuationText),
      risks: value.risks.map(redactContinuationText),
      nextSteps: value.next_steps.map(redactContinuationText),
      artifacts,
    };
  }
  if (value.outcome === 'failed') {
    return {
      outcome: 'failed',
      checkpoint: mapCheckpoint(value.checkpoint),
      errorCode: redactContinuationText(value.error_code),
      errorSummary: redactContinuationText(value.error_summary),
      retryable: value.retryable,
      completedWork: value.completed_work.map(redactContinuationText),
      unperformedWork: value.unperformed_work.map(redactContinuationText),
    };
  }
  return {
    outcome: 'blocked',
    checkpoint: mapCheckpoint(value.checkpoint),
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
        ...(input.resume_after_seconds === null
          ? {}
          : { resume_after_seconds: input.resume_after_seconds }),
      };
    case 'completed':
      return {
        outcome: input.outcome,
        checkpoint: input.checkpoint,
        final_message: input.final_message,
        ...(input.result_summary === null ? {} : { result_summary: input.result_summary }),
        artifacts: input.artifacts,
      };
    case 'partial':
      return {
        outcome: input.outcome,
        checkpoint: input.checkpoint,
        completed_work: input.completed_work,
        key_findings: input.key_findings,
        unperformed_work: input.unperformed_work,
        risks: input.risks,
        next_steps: input.next_steps,
        artifacts: input.artifacts,
      };
    case 'failed':
      return {
        outcome: input.outcome,
        checkpoint: input.checkpoint,
        error_code: input.error_code,
        error_summary: input.error_summary,
        retryable: input.retryable,
        completed_work: input.completed_work,
        unperformed_work: input.unperformed_work,
      };
    case 'blocked':
      return {
        outcome: input.outcome,
        checkpoint: input.checkpoint,
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

function mapCheckpoint(input: z.infer<typeof checkpointSchema>): ContinuationCheckpointV2 {
  return {
    schemaVersion: 2,
    summary: redactContinuationText(input.summary),
    currentStepId: input.current_step_id,
    completedStepIds: input.completed_step_ids,
    completedCriterionIds: input.completed_criterion_ids,
    completedDeliverableIds: input.completed_deliverable_ids,
    remainingSteps: input.remaining_steps.map((step) => ({
      id: step.id,
      description: redactContinuationText(step.description),
    })),
    artifacts: input.artifacts.map((artifact) => ({
      id: artifact.id,
      deliverableId: artifact.deliverable_id,
      path: artifact.path,
      sha256: artifact.sha256.toLowerCase(),
    })),
    evidence: input.evidence.map((evidence) => ({
      id: evidence.id,
      requirementId: evidence.requirement_id,
      criterionIds: evidence.criterion_ids,
      ...(evidence.artifact_id ? { artifactId: evidence.artifact_id } : {}),
      ...(evidence.reference ? { reference: redactContinuationText(evidence.reference) } : {}),
    })),
    sideEffects: input.side_effects.map((effect) => ({
      id: effect.id,
      description: redactContinuationText(effect.description),
      idempotencyKey: redactContinuationText(effect.idempotency_key),
    })),
    constraints: input.constraints.map(redactContinuationText),
    decisions: input.decisions.map(redactContinuationText),
    nextAction: input.next_action ? {
      id: input.next_action.id,
      description: redactContinuationText(input.next_action.description),
    } : null,
    stopReason: redactContinuationText(input.stop_reason),
  };
}

export function enforceAttemptConvergence(
  claim: ContinuationClaim,
  outcome: ContinuationStepOutcome,
): ContinuationStepOutcome {
  if (outcome.outcome !== 'continue' || claim.attempt.ordinal < claim.job.maxAttempts) {
    return outcome;
  }
  return partialOutcomeFromCheckpoint(outcome.checkpoint);
}

function convergenceInstruction(claim: ContinuationClaim): string {
  const phase = continuationAttemptPhase(claim.attempt.ordinal, claim.job.maxAttempts);
  if (phase === 'verify_and_deliver') {
    return '[Verification and delivery phase] This is the protected final attempt. Continue is forbidden. Do not explore or expand analysis. Verify prepared deliverables and evidence, then return completed; otherwise return an honest partial, blocked, or failed result with exact unmet criteria and the next best action.';
  }
  if (phase === 'finalize') {
    return '[Finalization phase] Protected delivery capacity has started. Stop exploratory work and scope expansion now. Consolidate verified findings, create the minimum required user-facing artifacts, record evidence and side-effect receipts, and prepare one concrete verification or delivery action for the final attempt. Prefer a trustworthy partial artifact over additional analysis.';
  }
  return '[Work phase] Continue only when another bounded attempt is necessary to satisfy the acceptance criteria. Leave the final two attempts for artifact finalization, verification, and delivery.';
}

function buildContinuationPrompt(
  claim: ContinuationClaim,
  artifactDir: string,
  managedInputs: Array<{
    id: string;
    fileName: string;
    path: string;
    sha256: string;
    sizeBytes: number;
  }>,
): string {
  const { job } = claim;
  const brief = {
    title: job.title,
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    contextSnapshot: job.contextSnapshot,
    checkpoint: job.checkpoint ?? null,
    previousAttemptDelta: job.lastAttemptDelta ?? null,
    previousVerification: job.lastVerification ?? null,
    recovery: job.recovery ?? null,
    requiredTools: job.requiredTools,
    attempt: claim.attempt.ordinal,
    maxAttempts: job.maxAttempts,
    executionPhase: continuationAttemptPhase(claim.attempt.ordinal, job.maxAttempts),
    permissions: {
      profile: job.permissions.profile,
      requestedPaths: job.permissions.filesystem.requestedPaths,
      network: job.permissions.network,
      externalSideEffects: job.permissions.externalSideEffects,
    },
    sourceFacts: job.sourceFacts,
    taskContract: job.taskContract,
    managedInputs,
  };
  const authorityLine = job.permissions.profile === 'trusted_personal_workspace'
    ? 'The trusted_personal_workspace profile allows broad local reads, network access, and external side effects required by the objective. Keep all actions within the authenticated user request and leave an accurate command trace.'
    : 'Do not request approval, send messages, create jobs, or perform source-control publishing actions.';
  return [
    '[Durable Continuation Step]',
    'Execute one bounded, highest-priority step of the task using the latest checkpoint.',
    'Return only one JSON object matching the supplied output schema.',
    'Every schema field must be present. Set unused array fields to [] and other unused fields to null.',
    'Every non-tool outcome must include a complete schema_version=2 checkpoint. Preserve prior completed IDs, evidence, artifacts, and side effects exactly.',
    'The current_step_id must continue the prior next_action id. Use stable IDs; never rename completed work between attempts.',
    'Return continue only if measurable progress was made, useful work remains, and another attempt is available. Set exactly one concrete next_action.',
    'Return completed only when every required deliverable, acceptance criterion, and verification requirement has parent-verifiable evidence. Set next_action to null and include a user-facing final summary.',
    'Return partial when useful results exist but the objective cannot be fully completed within the remaining budget.',
    'Return blocked when an external dependency, permission, input, or capability prevents progress; include the blocker and recovery steps.',
    'Return failed only for a non-recoverable execution error; include completed and remaining work.',
    'Do not repeat completed work unless verification is necessary. Do not expand scope.',
    authorityLine,
    'Do not execute a required local CLI directly. When one configured tool is needed, return a tool_request outcome using an exact name from requiredTools; the trusted parent will validate and execute it.',
    'At most one local CLI tool can be requested in this step.',
    'If a required capability is unavailable, return a blocked outcome instead of weakening the execution boundary.',
    `Attempt ${claim.attempt.ordinal} of ${job.maxAttempts}.`,
    convergenceInstruction(claim),
    `Workspace: ${job.workingDirectory}`,
    `Requested paths: ${job.permissions.filesystem.requestedPaths.join(', ') || '(none)'}`,
    `Network access: ${job.permissions.network}`,
    `External side effects: ${job.permissions.externalSideEffects}`,
    `Managed artifact directory: ${artifactDir}`,
    'Checkpoint artifact paths and completed outcome artifact references must be relative files inside the managed artifact directory. Record the exact SHA-256 of each checkpoint artifact.',
    managedInputs.length > 0
      ? 'Managed input files are immutable read-only evidence. Read them from the exact paths in managedInputs; never write to or replace them.'
      : 'Managed input files: (none)',
    '',
    untrustedDataBlock('continuation-job-brief', JSON.stringify(brief, null, 2)),
  ].join('\n');
}

function recoveryOutcome(
  claim: ContinuationClaim,
  failure: DurableRunFailure,
  requiredCapability: string,
): ContinuationStepOutcome {
  const decision = decideRecovery(failure, {
    fingerprintAttempts: claim.job.recoveryFingerprintCounts[failure.fingerprint] ?? 0,
    totalAttempts: claim.job.recoveryTotalCount,
    maxFingerprintAttempts: 2,
    maxTotalAttempts: 4,
  });
  const checkpoint = checkpointForClaim(claim);
  if (decision.action === 'retry') {
    return {
      outcome: 'recovering',
      checkpoint,
      failure,
      delaySeconds: decision.delaySeconds,
      reason: decision.reason,
    };
  }
  if (decision.action === 'wait_user') {
    return {
      outcome: 'waiting_user',
      checkpoint,
      failure,
      prompt: decision.prompt,
      reason: decision.reason,
    };
  }
  if (decision.action === 'block') {
    return {
      ...blockedToolOutcome(
        claim,
        `continuation_${failure.category}`,
        decision.reason,
        requiredCapability,
      ),
      recoveryFailure: failure,
    };
  }
  return {
    outcome: 'failed',
    checkpoint,
    errorCode: 'continuation_recovery_failed',
    errorSummary: decision.reason,
    retryable: false,
    completedWork: checkpoint.completedStepIds,
    unperformedWork: checkpoint.remainingSteps.map((step) => step.description),
    recoveryFailure: failure,
  };
}

function buildContinuationToolResultPrompt(
  claim: ContinuationClaim,
  request: ContinuationToolRequest,
  message: string,
): string {
  return [
    '[Continuation Tool Result]',
    'The trusted parent executed the one allowed local CLI request for this step.',
    'Use the result below to return a continue, completed, partial, failed, or blocked outcome.',
    convergenceInstruction(claim),
    'Do not request another tool in this step.',
    '',
    untrustedDataBlock('continuation-tool-result', JSON.stringify({
      tool: request.tool,
      result: redactContinuationText(message),
    }, null, 2)),
  ].join('\n');
}

function blockedToolOutcome(
  claim: ContinuationClaim,
  errorCode: string,
  errorSummary: string,
  requiredCapability: string,
): Extract<ContinuationStepOutcome, { outcome: 'blocked' }> {
  return {
    outcome: 'blocked',
    checkpoint: checkpointForClaim(claim),
    errorCode: redactContinuationText(errorCode),
    errorSummary: redactContinuationText(errorSummary),
    requiredCapability: redactContinuationText(requiredCapability),
    completedWork: [],
    unperformedWork: ['Invoke the required local CLI tool.'],
  };
}

function blockedCapabilityOutcome(input: {
  checkpoint: ContinuationCheckpointV2;
  errorCode: string;
  errorSummary: string;
  requiredCapability: string;
  unperformedWork: string[];
}): ContinuationStepOutcome {
  return {
    outcome: 'blocked',
    checkpoint: input.checkpoint,
    errorCode: redactContinuationText(input.errorCode),
    errorSummary: redactContinuationText(input.errorSummary),
    requiredCapability: redactContinuationText(input.requiredCapability),
    completedWork: [],
    unperformedWork: input.unperformedWork.map(redactContinuationText),
  };
}

function checkpointForClaim(claim: ContinuationClaim): ContinuationCheckpointV2 {
  if (claim.job.checkpoint) return claim.job.checkpoint;
  const initial = claim.job.taskContract.initialContext;
  const firstRemaining = initial.remainingSteps[0]?.trim();
  return {
    schemaVersion: 2,
    summary: redactContinuationText(initial.summary),
    currentStepId: 'initial',
    completedStepIds: [],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    remainingSteps: initial.remainingSteps.map((description, index) => ({
      id: `legacy-step-${index + 1}`,
      description: redactContinuationText(description),
    })),
    artifacts: [],
    evidence: [],
    sideEffects: [],
    constraints: initial.constraints.map(redactContinuationText),
    decisions: initial.decisions.map(redactContinuationText),
    nextAction: firstRemaining
      ? { id: 'legacy-step-1', description: redactContinuationText(firstRemaining) }
      : null,
    stopReason: 'No prior structured checkpoint was available.',
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
