import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CODEX_EXEC_TOOL_TRACE = 'true';
process.env.LARK_CRON_TIMEZONE = 'Asia/Singapore';

const { queryRunTrace } = await import('../src/run-trace-query.js');

const root = mkdtempSync(join(tmpdir(), 'run-trace-query-'));
const traceLog = join(root, 'trace.log');

writeFileSync(traceLog, [
  '2026-07-12T08:50:00.000+08:00  job_daily  run_old  command_execution  started  item_old  -  {"cmd":"old"}',
  '2026-07-12T08:50:01.000+08:00  job_daily  run_old  command_execution  completed  item_old  1000ms  -',
  '2026-07-12T09:50:00.000+08:00  job_daily  run_new  command_execution  started  item_new  -  {"cmd":"new"}',
  '2026-07-12T09:50:02.500+08:00  job_daily  run_new  command_execution  completed  item_new  2500ms  -',
  '2026-07-12T10:00:00.000+08:00  om_msg  run_msg_1  exec_command  started  call_1  -  {"cmd":"npm test","authorization":"Bearer should-not-appear"}',
  '2026-07-12T10:00:02.000+08:00  om_msg  run_msg_1  exec_command  completed  call_1  2000ms  -',
  '2026-07-12T10:01:00.000+08:00  om_msg  run_msg_1  mcp.github.issue_create  failed  call_2  500ms  {"error":"Bearer should-not-appear"}',
  '2026-07-12T10:01:30.000+08:00  om_msg  run_msg_2  exec_command  started  call_1  -  {"cmd":"npm run typecheck"}',
  '2026-07-12T10:01:32.000+08:00  om_msg  run_msg_2  exec_command  completed  call_1  2000ms  -',
  '2026-07-12T10:01:33.000+08:00  om_msg  metrics  elapsed_ms=93000  tool_calls=3  skill_usages=0  input_tokens=100  output_tokens=20',
  '2026-07-12T10:02:00.000+08:00  om_full  run_full  trace  full  tool_call.completed  github.get_issue  completed  -  -  {"issue":248}',
  '2026-07-11T08:00:00.000+08:00  om_old  run_old_1  exec_command  completed  call_old  1000ms  -',
  'not a trace line',
  '',
].join('\n'));

writeFileSync(`${traceLog}.1`, [
  '2026-07-12T09:30:00.000+08:00  om_rotated  run_rotated_1  exec_command  completed  call_rotated  1000ms  {"cmd":"from rotated log"}',
  '',
].join('\n'));

const now = new Date('2026-07-12T02:05:00.000Z');

const messageResult = await queryRunTrace({
  logId: 'om_msg',
  now,
  logPath: traceLog,
  maxFiles: 1,
});
assert.equal(messageResult.status, 'ok');
assert.deepEqual(messageResult.run_ids, ['run_msg_1', 'run_msg_2']);
assert.equal(messageResult.run_id, undefined);
assert.equal(messageResult.tools.length, 3);
assert.deepEqual(messageResult.tools[0], {
  run_id: 'run_msg_1',
  name: 'exec_command',
  status: 'completed',
  call_id: 'call_1',
  started_at: '2026-07-12T10:00:00.000+08:00',
  completed_at: '2026-07-12T10:00:02.000+08:00',
  duration_ms: 2000,
  summary: '{"cmd":"npm test","authorization":"[redacted]"}',
});
assert.equal(messageResult.tools[1].status, 'failed');
assert.match(messageResult.tools[1].error ?? '', /\[redacted\]/);
assert.equal(messageResult.tools[2].run_id, 'run_msg_2');
assert.equal(messageResult.tools[2].call_id, 'call_1');
assert.equal(messageResult.tools[2].summary, '{"cmd":"npm run typecheck"}');
assert.equal(messageResult.tools.some((tool) => tool.name.startsWith('elapsed_ms=')), false);
assert.doesNotMatch(JSON.stringify(messageResult), /should-not-appear/);

const allCronResult = await queryRunTrace({
  logId: 'job_daily',
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(allCronResult.status, 'ok');
assert.deepEqual(allCronResult.run_ids, ['run_old', 'run_new']);
assert.equal(allCronResult.tools.length, 2);
assert.equal(allCronResult.tools[1].duration_ms, 2500);

const explicitCronResult = await queryRunTrace({
  logId: 'job_daily',
  runId: 'run_old',
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(explicitCronResult.status, 'ok');
assert.equal(explicitCronResult.run_id, 'run_old');
assert.equal(explicitCronResult.tools[0].summary, '{"cmd":"old"}');

const rotatedResult = await queryRunTrace({
  logId: 'om_rotated',
  now,
  logPath: traceLog,
  maxFiles: 1,
});
assert.equal(rotatedResult.status, 'ok');
assert.deepEqual(rotatedResult.run_ids, ['run_rotated_1']);
assert.equal(rotatedResult.tools[0].summary, '{"cmd":"from rotated log"}');

const fullResult = await queryRunTrace({
  logId: 'om_full',
  runId: 'run_full',
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(fullResult.status, 'ok');
assert.equal(fullResult.tools[0].name, 'github.get_issue');
assert.equal(fullResult.tools[0].status, 'completed');
assert.equal(fullResult.tools[0].summary, '{"issue":248}');

const expiredResult = await queryRunTrace({
  logId: 'om_old',
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(expiredResult.status, 'expired');
assert.equal(expiredResult.tools.length, 0);

const notFoundResult = await queryRunTrace({
  logId: 'om_missing',
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(notFoundResult.status, 'not_found');

const disabledResult = await queryRunTrace({
  logId: 'om_msg',
  enabled: false,
  now,
  logPath: traceLog,
  maxFiles: 0,
});
assert.equal(disabledResult.status, 'disabled');
assert.equal(disabledResult.tools.length, 0);

const truncatedResult = await queryRunTrace({
  logId: 'om_msg',
  now,
  logPath: traceLog,
  maxFiles: 0,
  maxToolCalls: 1,
});
assert.equal(truncatedResult.status, 'ok');
assert.equal(truncatedResult.truncated, true);
assert.equal(truncatedResult.tools.length, 1);

const fractionalWindowResult = await queryRunTrace({
  logId: 'om_msg',
  now,
  logPath: traceLog,
  maxFiles: 0,
  withinHours: 0.5,
});
assert.equal(fractionalWindowResult.within_hours, 1);

assert.ok(existsSync(traceLog));
assert.doesNotMatch(readFileSync(traceLog, 'utf-8'), /this text is never written/);
