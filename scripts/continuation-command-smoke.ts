import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LarkMessage } from '../src/lark-message.js';
import type { ReplyRequest } from '../src/reply-sender.js';
import { SqliteContinuationRepository } from '../src/continuation/sqlite-repository.js';
import { ContinuationService } from '../src/continuation/service.js';
import { handleContinuationCommand } from '../src/continuation/command-handler.js';

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
  maxSteps: 12,
  maxRetries: 3,
  maxAgeHours: 24,
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
) {
  return (await service.createFromMessage({
    title,
    objective: `Complete ${title}`,
    acceptance_criteria: ['The task is complete.'],
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
  }))).job;
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
const completed = await createJob('om_completed', 'ou_creator', 'Completed task');
const completedClaim = await repository.claimDue(
  'worker-complete',
  now.toISOString(),
  new Date(now.getTime() + 60_000).toISOString(),
);
assert.equal(completedClaim?.job.jobId, ownedQueued.jobId);
await repository.completeStep(completedClaim!, {
  outcome: {
    outcome: 'completed',
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
assert.match(replies.at(-1)?.text ?? '', /Completed:/);

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
console.log('continuation command smoke: PASS');
