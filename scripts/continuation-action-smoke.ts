import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkMessage } from '../src/lark-message.js';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
const root = await mkdtemp(join(tmpdir(), 'continuation-action-'));
const { IdentitySession } = await import('../src/identity-session.js');
const { MemoryStore } = await import('../src/memory/file.js');
const { SqliteContinuationRepository } = await import('../src/continuation/sqlite-repository.js');
const { ContinuationService } = await import('../src/continuation/service.js');
const {
  createCodexExecActionDispatcher,
  parseCodexExecActionEnvelope,
} = await import('../src/codex-exec-actions.js');

function action(overrides: Record<string, unknown> = {}) {
  return {
    type: 'create_continuation_job',
    title: 'Finish report',
    objective: 'Finish the report and verify the result.',
    acceptance_criteria: ['report exists', 'checks pass'],
    context_snapshot: {
      summary: 'Inputs were inspected.',
      completed_steps: ['inspect inputs'],
      remaining_steps: ['write report'],
      constraints: ['do not publish'],
      decisions: ['use local sources'],
      references: ['notes.md'],
    },
    required_tools: ['local filesystem'],
    working_directory: '.',
    ...overrides,
  };
}

function parse(actions: unknown[]) {
  return parseCodexExecActionEnvelope({ version: 1, actions });
}

assert.equal(parse([action()]).ok, true);
for (const forbidden of [
  { chat_id: 'oc_forged' },
  { open_id: 'ou_forged' },
  { job_id: 'job_forged' },
  { working_directory: '/tmp/outside' },
  { working_directory: '../outside' },
]) {
  const result = parse([action(forbidden)]);
  assert.equal(result.ok, false, `forbidden fields must fail: ${JSON.stringify(forbidden)}`);
}
const duplicateCreation = parse([action({ title: 'First' }), action({ title: 'Second' })]);
assert.equal(duplicateCreation.ok, false);
if (!duplicateCreation.ok) assert.match(duplicateCreation.error, /one continuation/i);

const repository = await SqliteContinuationRepository.open({
  databasePath: join(root, 'runtime', 'jobs.sqlite'),
  artifactsDir: join(root, 'runtime', 'artifacts'),
  jitter: () => 0,
});
const clock = { now: () => new Date('2026-07-17T00:00:00.000Z') };
const childWorkingDirectory = join(root, 'repo-a');
await mkdir(childWorkingDirectory);
const service = new ContinuationService({
  repository,
  allowedWorkingRoot: root,
  filesystemMode: 'workspace-write',
  maxSteps: 24,
  maxRetries: 3,
  maxAgeHours: 24,
  timeoutMs: 600_000,
  defaultModel: 'gpt-5.4',
  clock,
});

function message(
  suffix: string,
  overrides: Partial<LarkMessage> = {},
): LarkMessage {
  return {
    messageId: `om_${suffix}`,
    chatId: `oc_${suffix}`,
    chatType: 'p2p',
    senderId: `ou_${suffix}`,
    text: 'continue this work',
    messageType: 'text',
    rawContent: '{}',
    ...overrides,
  };
}

const identity = new IdentitySession(() => 'ou_owner');
const dispatcher = createCodexExecActionDispatcher({
  memoryStore: new MemoryStore(join(root, 'memories')),
  identitySession: identity,
  continuationService: service,
});
const p2p = message('p2p');
identity.setCaller(p2p.chatId, p2p.threadId, p2p.senderId);
const first = await dispatcher.execute({
  message: p2p,
  actions: [action()] as any,
  parentSessionId: 'session-parent',
  model: 'gpt-5.3-codex',
});
assert.equal(first.length, 1);
assert.equal(first[0].ok, true);
assert.equal(first[0].action, 'create_continuation_job');
assert.match(first[0].message, /^Background task created: Finish report\nJob ID: job_/);
assert.ok(first[0].continuation);
const firstJob = await repository.get(first[0].continuation!.jobId);
assert.equal(firstJob?.creatorOpenId, p2p.senderId);
assert.equal(firstJob?.route.kind, 'message_thread');
assert.equal(firstJob?.parentSessionId, 'session-parent');
assert.equal(firstJob?.model, 'gpt-5.3-codex');
assert.equal(firstJob?.workingDirectory, await realpath(root));
assert.deepEqual(firstJob?.permissions, {
  filesystem: { root: await realpath(root), mode: 'workspace-write' },
  hostTools: ['local filesystem'],
  network: 'none',
  approval: { mode: 'never' },
});

const childCreated = await service.createFromMessage(
  action({ working_directory: 'repo-a' }) as any,
  message('child-root'),
);
assert.equal(childCreated.job.workingDirectory, await realpath(childWorkingDirectory));
assert.equal(childCreated.job.permissions.filesystem.root, await realpath(root));

const deduplicatedTools = await service.createFromMessage(
  action({ required_tools: ['local filesystem', 'local filesystem'] }) as any,
  message('deduplicated-tools'),
);
assert.deepEqual(deduplicatedTools.job.requiredTools, ['local filesystem']);
assert.deepEqual(deduplicatedTools.job.permissions.hostTools, ['local filesystem']);

const duplicate = await dispatcher.execute({
  message: p2p,
  actions: [action()] as any,
  parentSessionId: 'session-parent',
  model: 'gpt-5.3-codex',
});
assert.equal(duplicate[0].continuation?.jobId, first[0].continuation?.jobId);
assert.equal((await repository.listAll(100)).length, 3);

const group = message('group', {
  chatType: 'group',
  chatId: 'oc_group',
  senderId: 'ou_group_creator',
  threadId: 'omt_group',
});
const groupCreated = await service.createFromMessage(action() as any, group);
assert.equal(groupCreated.job.creatorOpenId, 'ou_group_creator');
assert.deepEqual(groupCreated.job.route, {
  kind: 'message_thread',
  conversationId: 'oc_group',
  sourceMessageId: 'om_group',
  threadId: 'omt_group',
});

const redacted = await service.createFromMessage(action({
  objective: 'Use token=super-secret-value to finish the local report.',
}) as any, message('redacted'));
assert.doesNotMatch(redacted.job.objective, /super-secret-value/);
assert.match(redacted.job.objective, /\[redacted\]/);

const comment = message('comment', {
  chatType: 'doc_comment',
  chatId: 'doc:dox_report',
  senderId: 'ou_comment_creator',
  threadId: 'cmt_report',
  docComment: {
    fileToken: 'dox_report',
    commentId: 'cmt_report',
    fileType: 'docx',
  },
});
const commentCreated = await service.createFromMessage(action() as any, comment);
assert.deepEqual(commentCreated.job.route, {
  kind: 'comment_thread',
  documentToken: 'dox_report',
  commentId: 'cmt_report',
  fileType: 'docx',
});

await assert.rejects(
  service.createFromMessage(action() as any, message('reaction', {
    messageType: 'reaction',
    reaction: {
      emojiType: 'OK',
      operatorId: 'ou_reaction',
      targetMessageId: 'om_target',
      source: 'sdk',
    },
  })),
  /not available for reaction/i,
);
await assert.rejects(
  service.createFromMessage(action() as any, message('cron', { chatType: 'cronjob' })),
  /not available for cronjob/i,
);
await assert.rejects(
  service.createFromMessage(action({ working_directory: '../outside' }) as any, message('outside')),
  /working directory/i,
);

repository.close();
console.log('continuation action smoke: PASS');
