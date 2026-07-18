import { createHash } from 'node:crypto';
import type {
  ContinuationAttemptDelta,
  ContinuationCheckpointV2,
  ContinuationVerificationVerdict,
} from '../domain/continuation.js';

export type ContinuationProgressDecision =
  | 'continue'
  | 'complete'
  | 'recover'
  | 'fail_stalled'
  | 'finish_partial';

export interface ContinuationProgressEvaluation {
  decision: ContinuationProgressDecision;
  delta: ContinuationAttemptDelta;
  noProgressCount: number;
}

export function evaluateContinuationProgress(input: {
  previous: ContinuationCheckpointV2 | null;
  candidate: ContinuationCheckpointV2;
  requestedOutcome: 'continue' | 'completed';
  verification: ContinuationVerificationVerdict;
  budget: {
    attemptOrdinal: number;
    maxAttempts: number;
    noProgressCount: number;
    maxNoProgressAttempts: number;
  };
}): ContinuationProgressEvaluation {
  const candidateDelta = createAttemptDelta(input.previous, input.candidate);
  const delta = input.verification.status === 'accepted'
    ? candidateDelta
    : rejectedAttemptDelta(candidateDelta);
  const noProgressCount = delta.stateChanged ? 0 : input.budget.noProgressCount + 1;

  if (input.verification.status === 'revision_required') {
    return {
      decision: input.budget.attemptOrdinal >= input.budget.maxAttempts
        ? 'finish_partial'
        : 'recover',
      delta,
      noProgressCount,
    };
  }
  if (input.requestedOutcome === 'completed') {
    return { decision: 'complete', delta, noProgressCount };
  }
  if (!input.candidate.nextAction) {
    return {
      decision: input.budget.attemptOrdinal >= input.budget.maxAttempts
        ? 'finish_partial'
        : 'recover',
      delta,
      noProgressCount,
    };
  }
  if (noProgressCount >= input.budget.maxNoProgressAttempts) {
    return { decision: 'fail_stalled', delta, noProgressCount };
  }
  if (input.budget.attemptOrdinal >= input.budget.maxAttempts) {
    return { decision: 'finish_partial', delta, noProgressCount };
  }
  return { decision: 'continue', delta, noProgressCount };
}

export function rejectedAttemptDelta(
  delta: ContinuationAttemptDelta,
): ContinuationAttemptDelta {
  return {
    ...delta,
    stateChanged: false,
    newCompletedStepIds: [],
    newCompletedCriterionIds: [],
    newCompletedDeliverableIds: [],
    newArtifactIds: [],
    newEvidenceIds: [],
    newSideEffectIds: [],
  };
}

export function createAttemptDelta(
  previous: ContinuationCheckpointV2 | null,
  candidate: ContinuationCheckpointV2,
): ContinuationAttemptDelta {
  const previousStepIds = new Set(previous?.completedStepIds ?? []);
  const previousCriterionIds = new Set(previous?.completedCriterionIds ?? []);
  const previousDeliverableIds = new Set(previous?.completedDeliverableIds ?? []);
  const previousArtifactIds = new Set(previous?.artifacts.map((artifact) => artifact.id) ?? []);
  const previousEvidenceIds = new Set(previous?.evidence.map((evidence) => evidence.id) ?? []);
  const previousSideEffectIds = new Set(previous?.sideEffects.map((effect) => effect.id) ?? []);
  const material = materialProjection(candidate);
  const previousMaterial = previous ? materialProjection(previous) : emptyMaterialProjection();
  return {
    schemaVersion: 1,
    stepId: candidate.currentStepId,
    checkpointHash: hashCanonical(candidate),
    materialHash: hashCanonical(material),
    stateChanged: hashCanonical(previousMaterial) !== hashCanonical(material),
    newCompletedStepIds: candidate.completedStepIds.filter((id) => !previousStepIds.has(id)),
    newCompletedCriterionIds: candidate.completedCriterionIds.filter((id) => !previousCriterionIds.has(id)),
    newCompletedDeliverableIds: candidate.completedDeliverableIds.filter((id) => !previousDeliverableIds.has(id)),
    newArtifactIds: candidate.artifacts.map((artifact) => artifact.id).filter((id) => !previousArtifactIds.has(id)),
    newEvidenceIds: candidate.evidence.map((evidence) => evidence.id).filter((id) => !previousEvidenceIds.has(id)),
    newSideEffectIds: candidate.sideEffects.map((effect) => effect.id).filter((id) => !previousSideEffectIds.has(id)),
    ...(candidate.nextAction ? { nextActionStepId: candidate.nextAction.id } : {}),
  };
}

function emptyMaterialProjection(): unknown {
  return {
    completedStepIds: [],
    completedCriterionIds: [],
    completedDeliverableIds: [],
    artifacts: [],
    evidence: [],
    sideEffects: [],
  };
}

function materialProjection(checkpoint: ContinuationCheckpointV2): unknown {
  return {
    completedStepIds: sorted(checkpoint.completedStepIds),
    completedCriterionIds: sorted(checkpoint.completedCriterionIds),
    completedDeliverableIds: sorted(checkpoint.completedDeliverableIds),
    artifacts: [...checkpoint.artifacts]
      .map(({ id, deliverableId, path, sha256 }) => ({ id, deliverableId, path, sha256 }))
      .sort(compareId),
    evidence: [...checkpoint.evidence]
      .map((entry) => ({
        id: entry.id,
        requirementId: entry.requirementId,
        criterionIds: sorted(entry.criterionIds),
        artifactId: entry.artifactId ?? null,
        reference: entry.reference ?? null,
      }))
      .sort(compareId),
    sideEffects: [...checkpoint.sideEffects]
      .map((entry) => ({
        id: entry.id,
        description: entry.description,
        idempotencyKey: entry.idempotencyKey,
      }))
      .sort(compareId),
  };
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function compareId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
