import assert from 'node:assert/strict';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const {
  buildCodexExecActionChannelPrompt,
  cleanupCodexExecActionChannels,
  createCodexExecActionChannel,
} = await import('../src/codex-exec-action-channel.js');

assert.match(
  buildCodexExecActionChannelPrompt({
    enabled: true,
    filePath: '/tmp/actions',
    token: 'token',
    maxActions: 5,
    continuationEnabled: true,
    continuationWorkingRoot: '/Users/you/workspace',
  }).join('\n'),
  /Configured continuation working root: "\/Users\/you\/workspace"/,
);
const trustedContinuationPrompt = buildCodexExecActionChannelPrompt({
  enabled: true,
  filePath: '/tmp/actions',
  token: 'token',
  maxActions: 5,
  continuationEnabled: true,
  continuationTrustedPersonalWorkspaceAvailable: true,
}).join('\n');
assert.match(trustedContinuationPrompt, /trusted_personal_workspace/);
assert.match(trustedContinuationPrompt, /requested_paths/);
const noHostToolContinuationPrompt = buildCodexExecActionChannelPrompt({
  enabled: true,
  filePath: '/tmp/actions',
  token: 'token',
  maxActions: 5,
  continuationEnabled: true,
}).join('\n');
assert.match(noHostToolContinuationPrompt, /"required_tools":\[\]/);
assert.match(noHostToolContinuationPrompt, /No continuation host CLI tools are configured/);
assert.match(noHostToolContinuationPrompt, /Do not declare standard Codex tools/i);
assert.doesNotMatch(noHostToolContinuationPrompt, /trusted_personal_workspace/);
assert.match(
  buildCodexExecActionChannelPrompt({
    enabled: true,
    filePath: '/tmp/actions',
    token: 'token',
    maxActions: 5,
    continuationEnabled: true,
    localCliToolNames: ['lark_cli'],
  }).join('\n'),
  /required_tools must use exact configured host tool names: lark_cli/,
);
assert.match(
  buildCodexExecActionChannelPrompt({
    enabled: true,
    filePath: '/tmp/actions',
    token: 'token',
    maxActions: 5,
    continuationEnabled: true,
    continuationHostToolNames: ['lark_cli'],
  }).join('\n'),
  /required_tools must use exact configured host tool names: lark_cli/,
);
assert.doesNotMatch(
  buildCodexExecActionChannelPrompt({
    enabled: true,
    filePath: '/tmp/actions',
    token: 'token',
    maxActions: 5,
    continuationEnabled: false,
  }).join('\n'),
  /create_continuation_job/,
);

function modeBits(mode: number): number {
  return mode & 0o777;
}

async function touchAge(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

const baseDir = mkdtempSync(join(tmpdir(), 'lark-action-channel-'));
const channel = await createCodexExecActionChannel({
  baseDir,
  caller: 'ou_action_user',
  messageId: 'om_action_channel',
  chatId: 'oc_action_channel',
  threadId: 'omt_action_channel',
});
assert.ok(channel, 'action channel should be created');
assert.equal(modeBits((await stat(join(baseDir, '.lark-actions'))).mode), 0o700);
assert.equal(modeBits((await stat(channel.filePath)).mode), 0o600);

await writeFile(
  channel.filePath,
  [
    JSON.stringify({
      version: 1,
      token: channel.token,
      type: 'lark_action_request',
      actions: [{ type: 'list_jobs', status: 'all' }],
    }),
    JSON.stringify({
      version: 1,
      token: channel.token,
      type: 'lark_action_request',
      actions: [{ type: 'recall_message', message_id: 'om_bot_reply' }],
    }),
    '',
  ].join('\n'),
  'utf-8',
);
const result = await channel.read();
assert.equal(result.requestCount, 2);
assert.deepEqual(
  result.actions.map((action: any) => action.type),
  ['list_jobs', 'recall_message'],
);
await channel.cleanup();

const rejected = await createCodexExecActionChannel({
  baseDir,
  caller: 'ou_action_user',
  messageId: 'om_action_reject',
  chatId: 'oc_action_channel',
});
assert.ok(rejected, 'rejected action channel should be created');
await writeFile(
  rejected.filePath,
  `${JSON.stringify({
    version: 1,
    token: rejected.token,
    type: 'lark_action_request',
    chat_id: 'oc_hijack',
    actions: [{ type: 'list_jobs' }],
  })}\n`,
  'utf-8',
);
await assert.rejects(() => rejected.read(), /identity-field/);
await rejected.cleanup();

const unknownField = await createCodexExecActionChannel({
  baseDir,
  caller: 'ou_action_user',
  messageId: 'om_action_unknown',
  chatId: 'oc_action_channel',
});
assert.ok(unknownField, 'unknown-field action channel should be created');
await writeFile(
  unknownField.filePath,
  `${JSON.stringify({
    version: 1,
    token: unknownField.token,
    type: 'lark_action_request',
    reply: 'visible text belongs on stdout',
    actions: [{ type: 'list_jobs' }],
  })}\n`,
  'utf-8',
);
await assert.rejects(() => unknownField.read(), /unsupported top-level field "reply"/);
await unknownField.cleanup();

const duplicateContinuation = await createCodexExecActionChannel({
  baseDir,
  caller: 'ou_action_user',
  messageId: 'om_action_duplicate_continuation',
  chatId: 'oc_action_channel',
});
assert.ok(duplicateContinuation);
const continuationAction = {
  type: 'create_continuation_job',
  title: 'Continue',
  objective: 'Finish the current work.',
  acceptance_criteria: ['done'],
  context_snapshot: {
    summary: 'started',
    completed_steps: [],
    remaining_steps: ['finish'],
    constraints: [],
    decisions: [],
    references: [],
  },
  required_tools: [],
};
await writeFile(
  duplicateContinuation.filePath,
  [
    JSON.stringify({
      version: 1,
      token: duplicateContinuation.token,
      type: 'lark_action_request',
      actions: [continuationAction],
    }),
    JSON.stringify({
      version: 1,
      token: duplicateContinuation.token,
      type: 'lark_action_request',
      actions: [{ ...continuationAction, title: 'Continue again' }],
    }),
  ].join('\n'),
  'utf-8',
);
await assert.rejects(() => duplicateContinuation.read(), /duplicate-continuation/);
await duplicateContinuation.cleanup();

const actionDir = join(baseDir, '.lark-actions');
const oldTurn = join(actionDir, 'turn-old');
const freshTurn = join(actionDir, 'turn-fresh');
await mkdir(oldTurn, { recursive: true });
await mkdir(freshTurn, { recursive: true });
await writeFile(join(oldTurn, 'actions.jsonl'), '{}\n', 'utf-8');
await writeFile(join(freshTurn, 'actions.jsonl'), '{}\n', 'utf-8');
await touchAge(oldTurn, 13 * 60 * 60 * 1000);
await touchAge(join(oldTurn, 'actions.jsonl'), 13 * 60 * 60 * 1000);
const cleanup = await cleanupCodexExecActionChannels(baseDir, {
  maxAgeMs: 12 * 60 * 60 * 1000,
});
assert.equal(cleanup.removed, 1);
assert.equal(cleanup.kept, 1);
const remaining = await readdir(actionDir);
assert.equal(remaining.includes('turn-old'), false);
assert.equal(remaining.includes('turn-fresh'), true);

console.log('codex-exec-action-channel smoke: PASS');
