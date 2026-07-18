import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkMessage } from '../src/lark-message.js';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
const root = await mkdtemp(join(tmpdir(), 'continuation-action-'));
process.env.LARK_AUDIT_LOG = join(root, 'audit.log');
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
    deliverables: [
      { id: 'report', description: 'A completed report.', required: true },
    ],
    acceptance_criteria: [
      { id: 'report_exists', description: 'The report exists.', deliverable_ids: ['report'] },
      { id: 'checks_pass', description: 'All report checks pass.', deliverable_ids: ['report'] },
    ],
    verification_requirements: [
      { id: 'report_file', description: 'Verify that the report file exists.', kind: 'artifact_exists' },
      { id: 'report_hash', description: 'Record the report checksum.', kind: 'artifact_sha256' },
      { id: 'report_evidence', description: 'Reference the report validation evidence.', kind: 'evidence_reference' },
    ],
    context_snapshot: {
      summary: 'Inputs were inspected.',
      completed_steps: ['inspect inputs'],
      remaining_steps: ['write report'],
      constraints: ['do not publish'],
      decisions: ['use local sources'],
      references: ['notes.md'],
    },
    required_tools: [],
    working_directory: '.',
    ...overrides,
  };
}

function parse(actions: unknown[]) {
  return parseCodexExecActionEnvelope({ version: 1, actions });
}

assert.equal(parse([action()]).ok, true);
assert.equal(parse([action({ requested_paths: ['/tmp'] })]).ok, true);
assert.equal(parse([action({ capability_profile: 'trusted_personal_workspace' })]).ok, false);
assert.equal(parse([action({ required_tools: ['local filesystem'] })]).ok, false);
for (const invalidContract of [
  { deliverables: [{ id: '', description: 'Missing ID.', required: true }] },
  {
    deliverables: [
      { id: 'report', description: 'First.', required: true },
      { id: 'report', description: 'Duplicate.', required: false },
    ],
  },
  {
    acceptance_criteria: [
      { id: 'unknown_ref', description: 'Unknown deliverable.', deliverable_ids: ['missing'] },
    ],
  },
  {
    deliverables: Array.from({ length: 33 }, (_, index) => ({
      id: `deliverable_${index}`,
      description: 'Bounded deliverable.',
      required: true,
    })),
  },
  {
    verification_requirements: [{
      id: 'oversized',
      description: 'x'.repeat(16 * 1024 + 1),
      kind: 'evidence_reference',
    }],
  },
]) {
  assert.equal(
    parse([action(invalidContract)]).ok,
    false,
    `invalid contract must fail: ${JSON.stringify(invalidContract)}`,
  );
}
for (const credentialShapedId of [
  'github_pat_123456789012345678901234567890',
  'xapp-123456789012345678901234567890',
  'sk-proj-123456789012345678901234567890',
]) {
  assert.equal(
    parse([action({
      deliverables: [{ id: credentialShapedId, description: 'Credential-shaped ID.', required: true }],
      acceptance_criteria: [],
    })]).ok,
    false,
    `credential-shaped contract ID must fail: ${credentialShapedId}`,
  );
}
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
const externalRequestedPath = await mkdtemp(join(tmpdir(), 'continuation-trusted-target-'));
const service = new ContinuationService({
  repository,
  allowedWorkingRoot: root,
  filesystemMode: 'workspace-write',
  maxAttempts: 5,
  maxRetries: 3,
  maxTotalMinutes: 30,
  timeoutMs: 600_000,
  defaultModel: 'gpt-5.4',
  canUseTrustedPersonalWorkspace: (actorOpenId) =>
    actorOpenId === 'ou_owner' || actorOpenId === 'ou_allowed',
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
assert.equal(firstJob?.maxAttempts, 5);
assert.equal(firstJob?.expiresAt, '2026-07-17T00:30:00.000Z');
assert.equal(firstJob?.workingDirectory, await realpath(root));
assert.deepEqual(firstJob?.permissions, {
  profile: 'bounded',
  filesystem: {
    root: await realpath(root),
    mode: 'workspace-write',
    requestedPaths: [await realpath(root)],
  },
  hostTools: [],
  network: 'none',
  externalSideEffects: 'denied',
  approval: { mode: 'never' },
});

const trustedOwner = await service.createFromMessage(action({
  requested_paths: [externalRequestedPath, 'repo-a', externalRequestedPath],
}) as any, message('trusted-owner', { senderId: 'ou_owner' }));
assert.deepEqual(trustedOwner.job.permissions, {
  profile: 'trusted_personal_workspace',
  filesystem: {
    root: await realpath(root),
    mode: 'workspace-write',
    requestedPaths: [await realpath(externalRequestedPath), await realpath(childWorkingDirectory)],
  },
  hostTools: [],
  network: 'enabled',
  externalSideEffects: 'allowed',
  approval: { mode: 'never' },
});

const trustedAllowedUser = await service.createFromMessage(
  action() as any,
  message('trusted-allowed', { senderId: 'ou_allowed' }),
);
assert.equal(trustedAllowedUser.job.permissions.profile, 'trusted_personal_workspace');
assert.deepEqual(
  trustedAllowedUser.job.permissions.filesystem.requestedPaths,
  [await realpath(root)],
);

const boundedChatOnlyUser = await service.createFromMessage(action({
  requested_paths: [externalRequestedPath],
}) as any, message('bounded-chat-only', { senderId: 'ou_chat_only' }));
assert.equal(boundedChatOnlyUser.job.permissions.profile, 'bounded');
assert.deepEqual(
  boundedChatOnlyUser.job.permissions.filesystem.requestedPaths,
  [await realpath(externalRequestedPath)],
);
assert.equal(boundedChatOnlyUser.job.permissions.network, 'none');
assert.equal(boundedChatOnlyUser.job.permissions.externalSideEffects, 'denied');
await assert.rejects(
  service.createFromMessage(action({
    requested_paths: [join(externalRequestedPath, 'missing')],
  }) as any, message('trusted-missing', { senderId: 'ou_owner' })),
  /requested path.*exist/i,
);

const trustedDispatchMessage = message('trusted-dispatch', { senderId: 'ou_owner' });
identity.setCaller(
  trustedDispatchMessage.chatId,
  trustedDispatchMessage.threadId,
  trustedDispatchMessage.senderId,
);
const trustedDispatch = await dispatcher.execute({
  message: trustedDispatchMessage,
  actions: [action({
    requested_paths: [externalRequestedPath],
  })] as any,
});
assert.equal(trustedDispatch[0].ok, true);
let trustedAudit = '';
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    trustedAudit = await readFile(process.env.LARK_AUDIT_LOG, 'utf-8');
  } catch {}
  if (trustedAudit.includes(trustedDispatch[0].continuation!.jobId)) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.match(trustedAudit, /create_continuation_job/);
assert.match(trustedAudit, /trusted_personal_workspace/);
assert.match(trustedAudit, /network.*enabled/);
assert.match(
  trustedAudit,
  new RegExp(`\\s{2}${trustedDispatch[0].continuation!.jobId}\\s{2}audit\\s{2}create_continuation_job`),
);

const childCreated = await service.createFromMessage(
  action({ working_directory: 'repo-a' }) as any,
  message('child-root'),
);
assert.equal(childCreated.job.workingDirectory, await realpath(childWorkingDirectory));
assert.equal(childCreated.job.permissions.filesystem.root, await realpath(root));

const deduplicatedTools = await service.createFromMessage(
  action({ required_tools: ['lark_cli', 'lark_cli'] }) as any,
  message('deduplicated-tools'),
);
assert.deepEqual(deduplicatedTools.job.requiredTools, ['lark_cli']);
assert.deepEqual(deduplicatedTools.job.permissions.hostTools, ['lark_cli']);

const duplicate = await dispatcher.execute({
  message: p2p,
  actions: [action()] as any,
  parentSessionId: 'session-parent',
  model: 'gpt-5.3-codex',
});
assert.equal(duplicate[0].continuation?.jobId, first[0].continuation?.jobId);
assert.equal((await repository.listAll(100)).length, 7);

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
  objective: [
    'Use github_pat_123456789012345678901234567890',
    'xapp-123456789012345678901234567890',
    'sk-proj-123456789012345678901234567890',
    'AWS_SECRET_ACCESS_KEY=aws-secret-access-key-value',
    'AWS_SESSION_TOKEN=aws-session-token-value',
    'to finish the local report.',
  ].join(' '),
}) as any, message('redacted', {
  text: 'Use AWS_SESSION_TOKEN=source-session-secret and finish the report.',
  parentContent: 'Quoted xapp-abcdefghijklmnopqrstuvwxyz1234567890.',
}));
assert.doesNotMatch(
  redacted.job.objective,
  /github_pat_|xapp-|sk-proj-|aws-secret-access-key-value|aws-session-token-value/i,
);
assert.match(redacted.job.objective, /\[redacted\]/);
assert.doesNotMatch(redacted.job.sourceFacts.originalUserText ?? '', /source-session-secret/);
assert.doesNotMatch(redacted.job.sourceFacts.quotedMessageText ?? '', /xapp-/);
assert.match(redacted.job.sourceFacts.originalUserText ?? '', /\[redacted\]/);

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
