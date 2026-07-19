import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LarkMessage } from '../src/lark-message.js';
import type { ReplyRequest } from '../src/reply-sender.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { ContinuationService } from '../src/continuation/service.js';
import { ContinuationInputStore } from '../src/continuation/input-store.js';
import { handleContinuationCommand } from '../src/continuation/command-handler.js';
import type { ContinuationCheckpointV2 } from '../src/domain/continuation.js';

const root = await mkdtemp(path.join(tmpdir(), 'continuation-command-'));
const now = new Date('2026-07-17T08:00:00.000Z');
const repository = await SqliteContinuationRepository.open({
  databasePath: path.join(root, 'jobs.sqlite'),
  artifactsDir: path.join(root, 'artifacts'),
  jitter: () => 0,
});
const service = new ContinuationService({
  repository,
  allowedWorkingRoot: root,
  filesystemMode: 'workspace-write',
  maxAttempts: 5,
  maxRetries: 3,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  clock: { now: () => new Date(now) },
});

const replies: ReplyRequest[] = [];
const commentReplies: Array<{
  doc_token: string;
  comment_id: string;
  file_type: string;
  content: string;
}> = [];

function taskCheckpoint(completed = true): ContinuationCheckpointV2 {
  return {
    schemaVersion: 2,
    summary: completed ? 'Task completed with evidence.' : 'Task could not be completed.',
    currentStepId: 'complete-task',
    completedStepIds: completed ? ['complete-task'] : [],
    completedCriterionIds: completed ? ['task_complete'] : [],
    completedDeliverableIds: completed ? ['result'] : [],
    remainingSteps: completed ? [] : [{ id: 'complete-task', description: 'Complete the task.' }],
    artifacts: [],
    evidence: completed ? [{
      id: 'result-evidence-entry',
      requirementId: 'result_evidence',
      criterionIds: ['task_complete'],
      reference: 'terminal-result',
    }] : [],
    sideEffects: [],
    constraints: [],
    decisions: [],
    nextAction: completed ? null : { id: 'complete-task', description: 'Complete the task.' },
    stopReason: completed ? 'Acceptance criteria verified.' : 'Smoke-test failure.',
  };
}

function message(overrides: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: 'om_task_command',
    chatId: 'oc_task_chat',
    chatType: 'group',
    senderId: 'ou_creator',
    senderName: 'Creator',
    text: '/task list',
    messageType: 'text',
    rawContent: '{"text":"/task list"}',
    threadId: 'omt_task_thread',
    botMentioned: true,
    ...overrides,
  };
}

async function createJob(
  sourceMessageId: string,
  senderId = 'ou_creator',
  title = `Task ${sourceMessageId}`,
  sourceInputs: Array<{
    sourcePath: string;
    fileName: string;
    kind: 'message_image' | 'message_attachment';
  }> = [],
  targetService = service,
) {
  return (await targetService.createFromMessage({
    title,
    objective: `Complete ${title}`,
    deliverables: [{ id: 'result', description: 'The completed task result.', required: true }],
    acceptance_criteria: [{
      id: 'task_complete',
      description: 'The task is complete.',
      deliverable_ids: ['result'],
    }],
    verification_requirements: [{
      id: 'result_evidence',
      description: 'Reference evidence for the completed result.',
      kind: 'evidence_reference',
    }],
    context_snapshot: {
      summary: 'Foreground work stopped at a durable boundary.',
      completed_steps: [],
      remaining_steps: ['Complete the task.'],
      constraints: [],
      decisions: [],
      references: [],
    },
    required_tools: [],
  }, message({
    messageId: sourceMessageId,
    senderId,
    text: 'Create a background task.',
    rawContent: '{"text":"Create a background task."}',
  }), undefined, undefined, sourceInputs)).job;
}

async function run(commandMessage: LarkMessage): Promise<boolean> {
  return handleContinuationCommand({
    message: commandMessage,
    service,
    ownerOpenId: 'ou_owner',
    sendReply: async (request) => {
      replies.push(request);
      return { sentCount: 1 };
    },
    sendDocCommentReply: async (request) => {
      commentReplies.push(request);
      return { replyId: `reply_${commentReplies.length}` };
    },
    auditCommand: async () => {},
  });
}

const ownedQueued = await createJob('om_owned_queued', 'ou_creator', 'Owned queued task');
const otherQueued = await createJob('om_other_queued', 'ou_other', 'Other private task');
const completedInputPath = path.join(root, 'completed-input.txt');
await writeFile(completedInputPath, 'completed task input', 'utf8');
const completed = await createJob('om_completed', 'ou_creator', 'Completed task', [{
  sourcePath: completedInputPath,
  fileName: 'completed-input.txt',
  kind: 'message_attachment',
}]);
await rm(completedInputPath);
const completedClaim = await repository.claimDue(
  'worker-complete',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(completedClaim?.job.jobId, ownedQueued.jobId);
await repository.completeStep(completedClaim!, {
  outcome: {
    outcome: 'completed',
    checkpoint: taskCheckpoint(),
    finalMessage: 'Owned queued task is complete.',
    artifacts: [],
  },
}, now.toISOString());

// The oldest due job was completed above; complete the intended retry source too.
const otherClaim = await repository.claimDue(
  'worker-other',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(otherClaim?.job.jobId, otherQueued.jobId);
await repository.completeStep(otherClaim!, {
  outcome: {
    outcome: 'completed',
    checkpoint: taskCheckpoint(),
    finalMessage: 'Other task is complete.',
    artifacts: [],
  },
}, now.toISOString());
const completedSourceClaim = await repository.claimDue(
  'worker-source',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(completedSourceClaim?.job.jobId, completed.jobId);
await repository.completeStep(completedSourceClaim!, {
  outcome: {
    outcome: 'failed',
    checkpoint: taskCheckpoint(false),
    errorCode: 'test_failure',
    errorSummary: 'The task failed in the smoke test.',
    retryable: false,
    completedWork: [],
    unperformedWork: ['Complete the task.'],
  },
}, now.toISOString());

// Clear earlier terminal deliveries so the ambiguous state belongs to its source Job.
for (;;) {
  const claim = await repository.claimPendingDelivery('delivery-drain', now.toISOString());
  if (!claim) break;
  await repository.markDeliveryResult(claim, {
    status: 'delivered',
    messageId: `om_delivered_${claim.jobId}`,
  }, now.toISOString());
}

const running = await createJob('om_running', 'ou_creator', 'Running task');
const runningClaim = await repository.claimDue(
  'worker-running',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(runningClaim?.job.jobId, running.jobId);

const ambiguous = await createJob('om_ambiguous', 'ou_creator', 'Ambiguous delivery task');
// Running blocks later claims, but SQLite claims another due job independently.
const ambiguousClaim = await repository.claimDue(
  'worker-ambiguous',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(ambiguousClaim?.job.jobId, ambiguous.jobId);
await repository.completeStep(ambiguousClaim!, {
  outcome: {
    outcome: 'completed',
    checkpoint: taskCheckpoint(),
    finalMessage: 'Ambiguous delivery task is complete.',
    artifacts: [],
  },
}, now.toISOString());
const deliveryClaim = await repository.claimPendingDelivery('delivery-worker', now.toISOString());
assert.ok(deliveryClaim);
await repository.markDeliveryResult(deliveryClaim!, {
  status: 'delivery_unknown',
  errorCode: 'ambiguous_send',
  errorSummary: 'The provider result was ambiguous.',
}, now.toISOString());
const pendingFilter = await createJob(
  'om_pending_filter',
  'ou_creator',
  'Pending filter task',
);
const recoveringClaim = await repository.claimDue(
  'worker-recovering-filter',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(recoveringClaim?.job.jobId, pendingFilter.jobId);
await repository.completeStep(recoveringClaim!, {
  outcome: {
    outcome: 'completed',
    checkpoint: taskCheckpoint(false),
    finalMessage: 'This unverified completion must be revised.',
    artifacts: [],
  },
}, now.toISOString());
assert.equal((await repository.get(pendingFilter.jobId))?.status, 'recovering');

assert.equal(await run(message({
  messageId: 'om_list_creator',
  text: '@ASH /task list',
  rawContent: '{"text":"@_user_1 /task list"}',
})), true);
assert.match(replies.at(-1)?.text ?? '', /Owned queued task/);
assert.match(replies.at(-1)?.text ?? '', /Completed task/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Other private task/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Foreground work stopped/);
assert.match(replies.at(-1)?.text ?? '', /Attempts:/);
assert.match(replies.at(-1)?.text ?? '', /Delivery:/);

assert.equal(await run(message({
  messageId: 'om_list_filtered',
  text: '/task list --status pending, failed',
  rawContent: '{"text":"/task list --status pending, failed"}',
})), true);
assert.match(replies.at(-1)?.text ?? '', /Pending filter task/);
assert.match(replies.at(-1)?.text ?? '', /recovering/);
assert.match(replies.at(-1)?.text ?? '', /Completed task/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Owned queued task/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Ambiguous delivery task/);

assert.equal(await run(message({
  messageId: 'om_list_owner',
  senderId: 'ou_owner',
  text: '/task list',
  rawContent: '{"text":"/task list"}',
})), true);
assert.match(replies.at(-1)?.text ?? '', /Other private task/);

assert.equal(await run(message({
  messageId: 'om_status_other_as_owner',
  senderId: 'ou_owner',
  text: `/task status ${otherQueued.jobId}`,
  rawContent: `{"text":"/task status ${otherQueued.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', /Title: Other private task/);

assert.equal(await run(message({
  messageId: 'om_delete_other_as_owner',
  senderId: 'ou_owner',
  text: `/task delete ${otherQueued.jobId}`,
  rawContent: `{"text":"/task delete ${otherQueued.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', /Task deleted/);
assert.equal((await repository.get(otherQueued.jobId))?.deletedAt, now.toISOString());

assert.equal(await run(message({
  messageId: 'om_status_denied',
  senderId: 'ou_intruder',
  text: `/task status ${ownedQueued.jobId}`,
  rawContent: `{"text":"/task status ${ownedQueued.jobId}"}`,
})), true);
assert.equal(replies.at(-1)?.text, 'Task not found or not accessible.');
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Completed task/);

assert.equal(await run(message({
  messageId: 'om_status_owner',
  senderId: 'ou_owner',
  text: `/task status ${ownedQueued.jobId}`,
  rawContent: `{"text":"/task status ${ownedQueued.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', new RegExp(ownedQueued.jobId));
assert.match(replies.at(-1)?.text ?? '', /State: completed/);
assert.match(replies.at(-1)?.text ?? '', /Execution: completed/);
assert.match(replies.at(-1)?.text ?? '', /Artifact: verified/);
assert.match(replies.at(-1)?.text ?? '', /Delivery: delivered/);
assert.match(replies.at(-1)?.text ?? '', /Resume available: no/);
assert.match(replies.at(-1)?.text ?? '', /Attempts: 1 \/ 5/);
assert.match(replies.at(-1)?.text ?? '', /Completed:/);
assert.match(replies.at(-1)?.text ?? '', /Delivery events:/);
assert.match(replies.at(-1)?.text ?? '', /terminal \| delivered \| attempts 1/);

assert.equal(await run(message({
  messageId: 'om_status_ambiguous',
  text: `/task status ${ambiguous.jobId}`,
  rawContent: `{"text":"/task status ${ambiguous.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', /terminal \| delivery_unknown \| attempts 1/);
assert.match(replies.at(-1)?.text ?? '', /Error: ambiguous_send: The provider result was ambiguous\./);

assert.equal(await run(message({
  messageId: 'om_retain_denied',
  senderId: 'ou_intruder',
  text: `/task retain ${pendingFilter.jobId} on`,
  rawContent: `{"text":"/task retain ${pendingFilter.jobId} on"}`,
})), true);
assert.equal(replies.at(-1)?.text, 'Task not found or not accessible.');

assert.equal(await run(message({
  messageId: 'om_retain_on',
  text: `/task retain ${pendingFilter.jobId} on`,
  rawContent: `{"text":"/task retain ${pendingFilter.jobId} on"}`,
})), true);
assert.equal(replies.at(-1)?.text, `Task retention enabled.\nJob ID: ${pendingFilter.jobId}`);
assert.equal((await repository.get(pendingFilter.jobId))?.retained, true);

assert.equal(await run(message({
  messageId: 'om_retain_off_owner',
  senderId: 'ou_owner',
  text: `/task retain ${pendingFilter.jobId} off`,
  rawContent: `{"text":"/task retain ${pendingFilter.jobId} off"}`,
})), true);
assert.equal(replies.at(-1)?.text, `Task retention disabled.\nJob ID: ${pendingFilter.jobId}`);
assert.equal((await repository.get(pendingFilter.jobId))?.retained, false);

assert.equal(await run(message({
  messageId: 'om_delete_running',
  text: `/task delete ${running.jobId}`,
  rawContent: `{"text":"/task delete ${running.jobId}"}`,
})), true);
assert.equal(replies.at(-1)?.text, 'Only terminal tasks can be deleted. Cancel the task first.');

assert.equal(await run(message({
  messageId: 'om_cancel_running',
  text: `/task cancel ${running.jobId}`,
  rawContent: `{"text":"/task cancel ${running.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', /Cancellation requested/);
assert.equal((await repository.get(running.jobId))?.status, 'cancel_requested');

assert.equal(await run(message({
  messageId: 'om_retry_completed',
  text: `/task retry ${completed.jobId}`,
  rawContent: `{"text":"/task retry ${completed.jobId}"}`,
})), true);
const retryText = replies.at(-1)?.text ?? '';
assert.match(retryText, /Retry task created/);
assert.doesNotMatch(retryText, new RegExp(`Job ID: ${completed.jobId}$`, 'm'));
const retriedJob = (await repository.listAll(100)).find((job) => job.retryOfJobId === completed.jobId);
assert.ok(retriedJob);
assert.equal(retriedJob.sourceFacts.inputs.length, 1);
assert.deepEqual(
  await new ContinuationInputStore(path.join(root, 'inputs')).verify(
    retriedJob.jobId,
    retriedJob.sourceFacts.inputs,
  ),
  { ok: true },
);

assert.equal(await run(message({
  messageId: 'om_retry_ambiguous',
  text: `/task retry ${ambiguous.jobId}`,
  rawContent: `{"text":"/task retry ${ambiguous.jobId}"}`,
})), true);
assert.equal(
  replies.at(-1)?.text,
  'This task has an unknown delivery outcome. Retrying could duplicate completed work, so it was not started.',
);

assert.equal(await run(message({
  messageId: 'om_delete_completed',
  text: `/task delete ${ownedQueued.jobId}`,
  rawContent: `{"text":"/task delete ${ownedQueued.jobId}"}`,
})), true);
assert.match(replies.at(-1)?.text ?? '', /Task deleted/);
assert.equal((await repository.get(ownedQueued.jobId))?.deletedAt, now.toISOString());

assert.equal(await run(message({
  messageId: 'om_list_after_delete',
  senderId: 'ou_owner',
  text: '/task list',
  rawContent: '{"text":"/task list"}',
})), true);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Owned queued task/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', /Other private task/);

assert.equal(await run(message({
  messageId: 'om_invalid_task',
  text: '/task retry',
  rawContent: '{"text":"/task retry"}',
})), true);
assert.match(replies.at(-1)?.text ?? '', /Usage:/);
assert.match(replies.at(-1)?.text ?? '', /\/task status <job_id>/);

assert.equal(await run(message({
  messageId: 'om_not_task',
  text: 'Please list tasks.',
  rawContent: '{"text":"Please list tasks."}',
})), false);

for (let index = 0; index < 8; index += 1) {
  await createJob(
    `om_long_${index}`,
    'ou_creator',
    `Long task ${index} ${'x'.repeat(170)}`,
  );
}
const commentReplyCountBeforeList = commentReplies.length;
assert.equal(await run(message({
  messageId: 'om_doc_task',
  chatId: 'doc_file_token',
  chatType: 'doc_comment',
  senderId: 'ou_creator',
  threadId: undefined,
  text: '/task list',
  rawContent: '{"text":"/task list"}',
  docComment: {
    fileToken: 'doc_file_token',
    commentId: 'comment_123',
    fileType: 'docx',
  },
})), true);
assert.ok(commentReplies.length > commentReplyCountBeforeList + 1);
assert.ok(commentReplies.slice(commentReplyCountBeforeList).every((reply) => reply.content.length <= 1_000));
assert.equal(commentReplies.at(-1)?.doc_token, 'doc_file_token');
assert.equal(commentReplies.at(-1)?.comment_id, 'comment_123');
assert.equal(commentReplies.at(-1)?.file_type, 'docx');
assert.equal(replies.at(-1)?.chat_id, 'oc_task_chat');

repository.close();

const resumeRoot = await mkdtemp(path.join(tmpdir(), 'continuation-command-resume-'));
const resumeRepository = await SqliteContinuationRepository.open({
  databasePath: path.join(resumeRoot, 'jobs.sqlite'),
  artifactsDir: path.join(resumeRoot, 'artifacts'),
  jitter: () => 0,
});
const resumeService = new ContinuationService({
  repository: resumeRepository,
  allowedWorkingRoot: resumeRoot,
  filesystemMode: 'workspace-write',
  maxAttempts: 5,
  maxRetries: 3,
  maxTotalMinutes: 30,
  timeoutMs: 60_000,
  clock: { now: () => new Date(now) },
});
const resumeReplies: ReplyRequest[] = [];
const runResume = (commandMessage: LarkMessage) => handleContinuationCommand({
  message: commandMessage,
  service: resumeService,
  ownerOpenId: 'ou_owner',
  sendReply: async (request) => {
    resumeReplies.push(request);
    return { sentCount: 1 };
  },
  auditCommand: async () => {},
});

async function cancelAndDeliverTask(jobId: string, suffix: string): Promise<void> {
  assert.equal(await resumeRepository.requestCancel(jobId, now.toISOString()), 'cancelled');
  const delivery = await resumeRepository.claimPendingDelivery(
    `delivery-cancelled-${suffix}`,
    now.toISOString(),
  );
  assert.equal(delivery?.jobId, jobId);
  assert.equal(delivery?.kind, 'terminal');
  await resumeRepository.markDeliveryResult(
    delivery!,
    { status: 'delivered', messageId: `om_cancelled_${suffix}` },
    now.toISOString(),
  );
}

async function createWaitingTask(suffix: string, commitDelivery = true): Promise<{
  jobId: string;
  interruptMessageId: string;
  interruptPayload: string;
}> {
  const job = await createJob(
    `om_waiting_${suffix}`,
    'ou_creator',
    `Waiting task ${suffix}`,
    [],
    resumeService,
  );
  const claim = await resumeRepository.claimDue(
    `worker-waiting-${suffix}`,
    now.toISOString(),
    new Date(now.getTime() + 60_000).toISOString(),
  );
  assert.equal(claim?.job.jobId, job.jobId);
  await resumeRepository.completeStep(claim!, {
    outcome: {
      outcome: 'waiting_user',
      checkpoint: taskCheckpoint(false),
      failure: {
        category: 'permission_required',
        retrySafety: 'unsafe',
        capabilityAvailable: true,
        operationRisk: 'external_side_effect',
        hints: ['Authorize the requested operation.'],
        failedStep: 'complete-task',
        diagnostic: 'The operation requires user authorization.',
        fingerprint: `permission-required-${suffix}`,
      },
      prompt: 'Authorize the requested operation, then resume the task.',
      reason: 'The operation requires user authorization.',
    },
  }, now.toISOString());
  const delivery = await resumeRepository.claimPendingDelivery(
    `delivery-waiting-${suffix}`,
    now.toISOString(),
  );
  assert.equal(delivery?.kind, 'interrupt');
  const interruptMessageId = `om_interrupt_${suffix}`;
  if (commitDelivery) {
    await resumeRepository.markDeliveryResult(
      delivery!,
      { status: 'delivered', messageId: interruptMessageId },
      now.toISOString(),
    );
  }
  return {
    jobId: job.jobId,
    interruptMessageId,
    interruptPayload: delivery!.payload,
  };
}

const explicitResume = await createWaitingTask('explicit');
assert.equal(await runResume(message({
  messageId: 'om_status_waiting',
  text: `/task status ${explicitResume.jobId}`,
  rawContent: `{"text":"/task status ${explicitResume.jobId}"}`,
})), true);
assert.match(resumeReplies.at(-1)?.text ?? '', /Recovery: permission_required \| step complete-task \| wait_user/);
assert.match(resumeReplies.at(-1)?.text ?? '', /Action needed: Authorize the requested operation/);
assert.equal(await runResume(message({
  messageId: 'om_resume_wrong_actor',
  senderId: 'ou_intruder',
  text: `/task resume ${explicitResume.jobId} approved`,
  rawContent: `{"text":"/task resume ${explicitResume.jobId} approved"}`,
})), true);
assert.equal(resumeReplies.at(-1)?.text, 'Task not found or not accessible.');
assert.equal(await runResume(message({
  messageId: 'om_resume_wrong_route',
  chatId: 'oc_other_chat',
  text: `/task resume ${explicitResume.jobId} approved`,
  rawContent: `{"text":"/task resume ${explicitResume.jobId} approved"}`,
})), true);
assert.equal(resumeReplies.at(-1)?.text, 'Task not found or not accessible.');
assert.equal(await runResume(message({
  messageId: 'om_resume_explicit',
  text: `/task resume ${explicitResume.jobId} approved`,
  rawContent: `{"text":"/task resume ${explicitResume.jobId} approved"}`,
})), true);
assert.match(resumeReplies.at(-1)?.text ?? '', /Task resumed/);
assert.equal((await resumeRepository.get(explicitResume.jobId))?.status, 'recovering');
assert.equal(
  (await resumeRepository.get(explicitResume.jobId))?.recovery?.userInput,
  'approved',
);
assert.equal(await runResume(message({
  messageId: 'om_resume_duplicate',
  text: `/task resume ${explicitResume.jobId} second input`,
  rawContent: `{"text":"/task resume ${explicitResume.jobId} second input"}`,
})), true);
assert.equal(resumeReplies.at(-1)?.text, 'This task is not waiting for user input.');
assert.equal(
  (await resumeRepository.get(explicitResume.jobId))?.recovery?.userInput,
  'approved',
);
await cancelAndDeliverTask(explicitResume.jobId, 'explicit');

const quotedResume = await createWaitingTask('quoted');
assert.equal(await runResume(message({
  messageId: 'om_resume_quote_wrong_route',
  chatId: 'oc_other_chat',
  parentId: quotedResume.interruptMessageId,
  text: 'approved from wrong route',
  currentUserText: 'approved from wrong route',
  rawContent: '{"text":"approved from wrong route"}',
})), false);
assert.equal(await runResume(message({
  messageId: 'om_resume_quote',
  parentId: quotedResume.interruptMessageId,
  text: 'approved from quoted reply',
  currentUserText: 'approved from quoted reply',
  rawContent: '{"text":"approved from quoted reply"}',
})), true);
assert.match(resumeReplies.at(-1)?.text ?? '', /Task resumed/);
assert.equal(
  (await resumeRepository.get(quotedResume.jobId))?.recovery?.userInput,
  'approved from quoted reply',
);
await cancelAndDeliverTask(quotedResume.jobId, 'quoted');

const fastQuotedResume = await createWaitingTask('fast-quoted', false);
assert.equal(await runResume(message({
  messageId: 'om_resume_quote_before_commit',
  parentId: fastQuotedResume.interruptMessageId,
  parentContent: fastQuotedResume.interruptPayload,
  text: 'approved before delivery commit',
  currentUserText: 'approved before delivery commit',
  rawContent: '{"text":"approved before delivery commit"}',
})), true);
assert.equal((await resumeRepository.get(fastQuotedResume.jobId))?.status, 'recovering');
assert.equal(
  (await resumeRepository.get(fastQuotedResume.jobId))?.recovery?.userInput,
  'approved before delivery commit',
);

resumeRepository.close();
console.log('continuation command smoke: PASS');
