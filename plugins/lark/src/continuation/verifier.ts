import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  AsyncTaskContract,
  ContinuationCheckpointV2,
  ContinuationJob,
  ContinuationVerificationVerdict,
} from '../domain/continuation.js';
import { CONTINUATION_CONTRACT_ID_PATTERN } from '../domain/continuation.js';
import { ContinuationArtifactStore } from './artifact-store.js';

const MAX_FINDINGS = 20;

export class ContinuationVerifier {
  constructor(private readonly artifacts: ContinuationArtifactStore) {}

  async verify(input: {
    job: ContinuationJob;
    previous: ContinuationCheckpointV2 | null;
    candidate: ContinuationCheckpointV2;
    requestedOutcome: 'continue' | 'completed' | 'partial' | 'failed' | 'blocked';
    resultArtifacts?: string[];
  }): Promise<ContinuationVerificationVerdict> {
    const findings: string[] = [];
    const add = (finding: string): void => {
      if (findings.length < MAX_FINDINGS && !findings.includes(finding)) findings.push(finding);
    };
    try {
      validateShape(input.candidate, add);
      validateContractReferences(input.job.taskContract, input.candidate, input.requestedOutcome, add);
      if (input.resultArtifacts) {
        const checkpointPaths = input.candidate.artifacts.map((artifact) => artifact.path).sort();
        const resultPaths = [...new Set(input.resultArtifacts)].sort();
        if (JSON.stringify(checkpointPaths) !== JSON.stringify(resultPaths)) {
          add('Terminal result artifacts must exactly match verified checkpoint artifacts.');
        }
      }
      validateContinuity(
        input.previous,
        input.candidate,
        input.requestedOutcome !== 'blocked' && input.requestedOutcome !== 'failed',
        add,
      );
    } catch {
      add('Checkpoint structure is invalid.');
    }
    if (findings.length === 0) {
      await this.validateArtifacts(input.job.jobId, input.candidate, add);
    }
    return findings.length === 0
      ? { status: 'accepted', findings: [] }
      : { status: 'revision_required', findings };
  }

  private async validateArtifacts(
    jobId: string,
    checkpoint: ContinuationCheckpointV2,
    add: (finding: string) => void,
  ): Promise<void> {
    if (checkpoint.artifacts.length === 0) return;
    try {
      const paths = checkpoint.artifacts.map((artifact) => artifact.path);
      const canonical = await this.artifacts.canonicalizeReferences(jobId, paths);
      if (canonical.length !== paths.length) {
        add('Checkpoint artifact paths must be unique.');
        return;
      }
      for (let index = 0; index < checkpoint.artifacts.length; index += 1) {
        const artifact = checkpoint.artifacts[index];
        if (canonical[index] !== artifact.path) {
          add(`Artifact ${artifact.id} does not use its canonical path.`);
          continue;
        }
        const content = await fs.readFile(this.artifacts.resolve(jobId, artifact.path));
        const actual = createHash('sha256').update(content).digest('hex');
        if (actual !== artifact.sha256.toLowerCase()) {
          add(`Artifact ${artifact.id} checksum does not match persisted content.`);
        }
      }
    } catch {
      add('One or more checkpoint artifacts are missing or invalid.');
    }
  }
}

function validateShape(
  checkpoint: ContinuationCheckpointV2,
  add: (finding: string) => void,
): void {
  if (checkpoint.schemaVersion !== 2) add('Checkpoint schema version must be 2.');
  if (!CONTINUATION_CONTRACT_ID_PATTERN.test(checkpoint.currentStepId)) {
    add('Current step id is invalid.');
  }
  for (const [name, values] of [
    ['completed step', checkpoint.completedStepIds],
    ['completed criterion', checkpoint.completedCriterionIds],
    ['completed deliverable', checkpoint.completedDeliverableIds],
  ] as const) {
    validateIds(name, values, add);
  }
  validateEntityIds('remaining step', checkpoint.remainingSteps, add);
  validateEntityIds('artifact', checkpoint.artifacts, add);
  validateEntityIds('evidence', checkpoint.evidence, add);
  validateEntityIds('side effect', checkpoint.sideEffects, add);
  if (checkpoint.nextAction) {
    if (!CONTINUATION_CONTRACT_ID_PATTERN.test(checkpoint.nextAction.id)) {
      add('Next action step id is invalid.');
    }
    if (!checkpoint.nextAction.description.trim()) add('Next action description is empty.');
    if (checkpoint.completedStepIds.includes(checkpoint.nextAction.id)) {
      add('Next action cannot already be a completed step.');
    }
  }
  if (
    checkpoint.sideEffects.some((effect) => !effect.idempotencyKey.trim())
    || new Set(checkpoint.sideEffects.map((effect) => effect.idempotencyKey)).size
      !== checkpoint.sideEffects.length
  ) {
    add('Checkpoint side effects require unique non-empty idempotency keys.');
  }
  for (const evidence of checkpoint.evidence) {
    validateIds(`criterion ids for evidence ${evidence.id}`, evidence.criterionIds, add);
  }
}

function validateContractReferences(
  contract: AsyncTaskContract,
  checkpoint: ContinuationCheckpointV2,
  requestedOutcome: 'continue' | 'completed' | 'partial' | 'failed' | 'blocked',
  add: (finding: string) => void,
): void {
  const deliverables = new Map(contract.deliverables.map((item) => [item.id, item]));
  const criteria = new Map(contract.acceptanceCriteria.map((item) => [item.id, item]));
  const requirements = new Map(contract.verificationRequirements.map((item) => [item.id, item]));
  const artifacts = new Map(checkpoint.artifacts.map((item) => [item.id, item]));
  const evidenceByRequirement = new Map<string, typeof checkpoint.evidence>();

  for (const id of checkpoint.completedDeliverableIds) {
    if (!deliverables.has(id)) add(`Completed deliverable ${id} is not in the task contract.`);
  }
  for (const id of checkpoint.completedCriterionIds) {
    const criterion = criteria.get(id);
    if (!criterion) {
      add(`Completed criterion ${id} is not in the task contract.`);
      continue;
    }
    for (const deliverableId of criterion.deliverableIds) {
      if (!checkpoint.completedDeliverableIds.includes(deliverableId)) {
        add(`Criterion ${id} requires incomplete deliverable ${deliverableId}.`);
      }
    }
  }
  for (const artifact of checkpoint.artifacts) {
    if (!deliverables.has(artifact.deliverableId)) {
      add(`Artifact ${artifact.id} references unknown deliverable ${artifact.deliverableId}.`);
    }
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) add(`Artifact ${artifact.id} sha256 is invalid.`);
  }
  for (const evidence of checkpoint.evidence) {
    const requirement = requirements.get(evidence.requirementId);
    if (!requirement) {
      add(`Evidence ${evidence.id} references unknown requirement ${evidence.requirementId}.`);
      continue;
    }
    for (const criterionId of evidence.criterionIds) {
      if (!criteria.has(criterionId)) {
        add(`Evidence ${evidence.id} references unknown criterion ${criterionId}.`);
      }
    }
    const list = evidenceByRequirement.get(evidence.requirementId) ?? [];
    list.push(evidence);
    evidenceByRequirement.set(evidence.requirementId, list);
    if (requirement.kind === 'evidence_reference' && !evidence.reference?.trim()) {
      add(`Evidence ${evidence.id} requires a durable reference.`);
    }
    if (requirement.kind !== 'evidence_reference') {
      if (!evidence.artifactId || !artifacts.has(evidence.artifactId)) {
        add(`Evidence ${evidence.id} requires a valid artifact.`);
      }
    }
  }

  if (
    (requestedOutcome === 'continue' || requestedOutcome === 'completed')
    && !checkpoint.completedStepIds.includes(checkpoint.currentStepId)
  ) {
    add(`${requestedOutcome} outcome current step ${checkpoint.currentStepId} is not marked complete.`);
  }

  if (requestedOutcome !== 'completed') return;
  for (const deliverable of contract.deliverables) {
    if (deliverable.required && !checkpoint.completedDeliverableIds.includes(deliverable.id)) {
      add(`Required deliverable ${deliverable.id} is incomplete.`);
    }
  }
  for (const criterion of contract.acceptanceCriteria) {
    if (!checkpoint.completedCriterionIds.includes(criterion.id)) {
      add(`Acceptance criterion ${criterion.id} is not verified.`);
    } else if (!checkpoint.evidence.some((evidence) => evidence.criterionIds.includes(criterion.id))) {
      add(`Acceptance criterion ${criterion.id} has no linked evidence.`);
    }
  }
  for (const requirement of contract.verificationRequirements) {
    if ((evidenceByRequirement.get(requirement.id)?.length ?? 0) === 0) {
      add(`Verification requirement ${requirement.id} has no evidence.`);
    }
  }
  if (checkpoint.nextAction) add('A completed task cannot retain a next action.');
}

function validateContinuity(
  previous: ContinuationCheckpointV2 | null,
  candidate: ContinuationCheckpointV2,
  requireExpectedStep: boolean,
  add: (finding: string) => void,
): void {
  if (!previous) return;
  if (requireExpectedStep && previous.nextAction && candidate.currentStepId !== previous.nextAction.id) {
    add(`Current step ${candidate.currentStepId} does not continue expected step ${previous.nextAction.id}.`);
  }
  requireMonotonic('completed step', previous.completedStepIds, candidate.completedStepIds, add);
  requireMonotonic('completed criterion', previous.completedCriterionIds, candidate.completedCriterionIds, add);
  requireMonotonic('completed deliverable', previous.completedDeliverableIds, candidate.completedDeliverableIds, add);
  requireEntitiesUnchanged('artifact', previous.artifacts, candidate.artifacts, add);
  requireEntitiesUnchanged('evidence', previous.evidence, candidate.evidence, add);
  requireEntitiesUnchanged('side effect', previous.sideEffects, candidate.sideEffects, add);
}

function validateIds(name: string, values: readonly string[], add: (finding: string) => void): void {
  if (new Set(values).size !== values.length) add(`Checkpoint ${name} ids must be unique.`);
  for (const id of values) {
    if (!CONTINUATION_CONTRACT_ID_PATTERN.test(id)) add(`Checkpoint ${name} id ${id} is invalid.`);
  }
}

function validateEntityIds(
  name: string,
  values: readonly { id: string }[],
  add: (finding: string) => void,
): void {
  validateIds(name, values.map((value) => value.id), add);
}

function requireMonotonic(
  name: string,
  previous: readonly string[],
  candidate: readonly string[],
  add: (finding: string) => void,
): void {
  const next = new Set(candidate);
  for (const id of previous) {
    if (!next.has(id)) add(`Previously verified ${name} ${id} was removed.`);
  }
}

function requireEntitiesUnchanged<T extends { id: string }>(
  name: string,
  previous: readonly T[],
  candidate: readonly T[],
  add: (finding: string) => void,
): void {
  const next = new Map(candidate.map((entry) => [entry.id, entry]));
  for (const entry of previous) {
    const candidateEntry = next.get(entry.id);
    if (!candidateEntry) add(`Previously verified ${name} ${entry.id} was removed.`);
    else if (JSON.stringify(candidateEntry) !== JSON.stringify(entry)) {
      add(`Previously verified ${name} ${entry.id} changed.`);
    }
  }
}
