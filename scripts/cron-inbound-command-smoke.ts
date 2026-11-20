import assert from 'node:assert/strict';
import type { JobFile } from '../src/job-contracts.js';
import type { LarkMessage } from '../src/lark-message.js';
import type { ReplyRequest } from '../src/reply-sender.js';
import { handleCronInboundCommand } from '../src/cron/inbound-command.js';

function message(overrides: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: 'om_user_command',
    chatId: 'oc_target',
    chatType: 'group',
    senderId: 'ou_owner',
    text: '暂停这个',
    currentUserText: '暂停这个',
    messageType: 'text',
    parentId: 'om_cron_report',
    rawContent: '{}',
    ...overrides,
  };
}

function job(id: string, name: string, prompt: string): JobFile {
  return {
    meta: {
      id,
      revision: 1,
      name,
      type: 'prompt',
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      timezone: 'Asia/Singapore',
      prompt,
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_target',
      status: 'active',
      created_by: 'ou_owner',
      created_at: '2026-11-01T00:00:00.000Z',
    },
    runtime: {
      last_run_at: '2026-11-15T01:00:00.000Z',
      next_run_at: '2026-11-16T01:00:00.000Z',
      run_count: 3,
      last_error: null,
    },
  };
}

const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
const replies: ReplyRequest[] = [];
const service = {
  async pause(input: Record<string, unknown>) {
    calls.push({ action: 'pause', input });
    if (input.jobId === 'other-owner') {
      return { ok: false, code: 'owner_mismatch', message: '只有任务创建者可以暂停该任务。' } as const;
    }
    return { ok: true, code: 'paused', message: '已暂停「Daily report」。' } as const;
  },
  async view(input: Record<string, unknown>) {
    calls.push({ action: 'view', input });
    return { ok: true, code: 'details', message: '任务：Daily report\nID：daily-report' } as const;
  },
  async runNow(input: Record<string, unknown>) {
    calls.push({ action: 'run_now', input });
    return { ok: true, code: 'started', message: '已开始运行「Daily report」。' } as const;
  },
};

async function handle(input: LarkMessage, candidates: JobFile[] = []) {
  return handleCronInboundCommand({
    message: input,
    service: service as any,
    listVisibleJobs: async () => ({ ok: true as const, jobs: candidates }),
    isPrivateChat: (chatId) => chatId.startsWith('oc_p2p'),
    sendReply: async (request) => {
      replies.push(request);
      return { sentCount: 1, statusText: 'sent' };
    },
  });
}

assert.equal(await handle(message({
  quotedCronJobId: 'daily-report',
  quotedCronJobOrigin: {
    messageId: 'om_cron_report',
    chatId: 'oc_target',
    jobId: 'daily-report',
    runId: 'cron_run_001',
    jobName: 'Daily report',
    jobCreatedAt: '2026-11-01T00:00:00.000Z',
    recordedAt: '2026-11-15T01:00:00.000Z',
  },
})), true);
assert.deepEqual(calls[0], {
  action: 'pause',
  input: {
    caller: 'ou_owner',
    chatId: 'oc_target',
    jobId: 'daily-report',
    expectedCreatedAt: '2026-11-01T00:00:00.000Z',
  },
});
assert.equal(replies.at(-1)?.reply_to, 'om_user_command');
assert.match(replies.at(-1)?.text ?? '', /已暂停/);

assert.equal(await handle(message({
  messageId: 'om_view',
  text: '查看这个任务',
  currentUserText: '查看这个任务',
  quotedCronJobId: 'daily-report',
})), true);
assert.equal(calls.at(-1)?.action, 'view');

assert.equal(await handle(message({
  messageId: 'om_run',
  text: '立即运行这个任务',
  currentUserText: '立即运行这个任务',
  quotedCronJobId: 'daily-report',
})), true);
assert.equal(calls.at(-1)?.action, 'run_now');

assert.equal(await handle(message({
  messageId: 'om_run_again',
  text: '再运行一次',
  currentUserText: '再运行一次',
  quotedCronJobId: 'daily-report',
})), true);
assert.equal(calls.at(-1)?.action, 'run_now');

const callsBeforeMissing = calls.length;
const privatePrompt = 'secret holdings and account numbers';
assert.equal(await handle(message({
  messageId: 'om_missing_mapping',
  quotedCronJobId: undefined,
  quotedCronJobOrigin: undefined,
}), [job('daily-report', 'Daily report', privatePrompt)]), true);
assert.equal(calls.length, callsBeforeMissing, 'missing mapping must never guess even one candidate');
const candidateReply = replies.at(-1)?.text ?? '';
assert.match(candidateReply, /无法确认引用消息对应的任务/);
assert.match(candidateReply, /Daily report/);
assert.match(candidateReply, /daily-report/);
assert.doesNotMatch(candidateReply, new RegExp(privatePrompt));

const callsBeforeNamed = calls.length;
assert.equal(await handle(message({
  messageId: 'om_named_pause',
  parentId: undefined,
  text: '暂停 Daily report',
  currentUserText: '暂停 Daily report',
  quotedCronJobId: undefined,
  quotedCronJobOrigin: undefined,
}), [job('daily-report', 'Daily report', privatePrompt)]), true);
assert.equal(calls.length, callsBeforeNamed + 1);
assert.deepEqual(calls.at(-1), {
  action: 'pause',
  input: {
    caller: 'ou_owner',
    chatId: 'oc_target',
    jobId: 'daily-report',
    expectedCreatedAt: '2026-11-01T00:00:00.000Z',
  },
});

const callsBeforeAmbiguous = calls.length;
assert.equal(await handle(message({
  messageId: 'om_ambiguous_pause',
  parentId: undefined,
  text: '暂停 Daily report',
  currentUserText: '暂停 Daily report',
  quotedCronJobId: undefined,
  quotedCronJobOrigin: undefined,
}), [
  job('daily-report-a', 'Daily report', privatePrompt),
  job('daily-report-b', 'Daily report', privatePrompt),
]), true);
assert.equal(calls.length, callsBeforeAmbiguous);
assert.match(replies.at(-1)?.text ?? '', /无法唯一确认/);
assert.doesNotMatch(replies.at(-1)?.text ?? '', new RegExp(privatePrompt));

const quotedReport = {
  quotedCronJobId: 'daily-report',
  quotedCronJobOrigin: {
    messageId: 'om_cron_report',
    chatId: 'oc_target',
    jobId: 'daily-report',
    runId: 'cron_run_001',
    jobName: 'Daily report',
    jobCreatedAt: '2026-11-01T00:00:00.000Z',
    recordedAt: '2026-11-15T01:00:00.000Z',
  },
};
const quotedJob = job('daily-report', 'Daily report', privatePrompt);
const explicitJob = job('weekly-report', 'Weekly report', privatePrompt);
explicitJob.meta.created_at = '2026-11-02T00:00:00.000Z';
for (const [verb, action] of [['暂停', 'pause'], ['查看', 'view'], ['运行', 'run_now']]) {
  for (const reference of ['weekly-report', 'Weekly report']) {
    const command = `${verb} ${reference}`;
    const start = calls.length;
    assert.equal(await handle(message({ ...quotedReport, text: command, currentUserText: command }),
      [quotedJob, explicitJob, job('same-as-id', 'weekly-report', privatePrompt)]), true);
    assert.equal(calls.length, start + 1);
    assert.equal(calls.at(-1)?.action, action);
    assert.equal(calls.at(-1)?.input.jobId, explicitJob.meta.id);
    assert.equal(calls.at(-1)?.input.expectedCreatedAt, explicitJob.meta.created_at);
  }
}

for (const reference of ['missing-task', 'Weekly report']) {
  const start = calls.length;
  const command = `暂停 ${reference}`;
  assert.equal(await handle(message({ ...quotedReport, text: command, currentUserText: command }),
    [quotedJob, explicitJob, job('duplicate', 'Weekly report', privatePrompt)]), true);
  assert.equal(calls.length, start, 'missing or ambiguous explicit reference must not fall back');
  assert.match(replies.at(-1)?.text ?? '', /未执行任何操作/);
}

const deniedCommand = '暂停 other-owner';
const deniedStart = calls.length;
assert.equal(await handle(message({ ...quotedReport, text: deniedCommand, currentUserText: deniedCommand }),
  [quotedJob, job('other-owner', 'Other owner', privatePrompt)]), true);
assert.deepEqual(calls.slice(deniedStart).map((call) => call.input.jobId), ['other-owner']);
assert.match(replies.at(-1)?.text ?? '', /只有任务创建者/);

assert.equal(await handle(message({
  messageId: 'om_not_quoted',
  parentId: undefined,
  quotedCronJobId: undefined,
})), false, 'generic unquoted text should continue to Codex');

const callsBeforeSkip = calls.length;
assert.equal(await handle(message({
  messageId: 'om_skip',
  text: '跳过这一次',
  currentUserText: '跳过这一次',
  quotedCronJobId: 'daily-report',
})), true);
assert.equal(calls.length, callsBeforeSkip, 'skip-once must not pause the schedule');
assert.match(replies.at(-1)?.text ?? '', /不会暂停整个周期任务/);
assert.match(replies.at(-1)?.text ?? '', /不会取消已开始的执行/);

console.log('cron inbound command smoke: PASS');
