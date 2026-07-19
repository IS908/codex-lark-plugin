import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const root = await mkdtemp(join(tmpdir(), 'codex-exec-trace-'));
const integrationTraceLog = join(root, 'integration-trace.log');
const debugLogPath = join(root, 'debug.log');
process.env.LARK_CODEX_EXEC_TOOL_TRACE = 'true';
process.env.LARK_CODEX_EXEC_TOOL_TRACE_MODE = 'compact';
process.env.LARK_CODEX_EXEC_TRACE_LOG = integrationTraceLog;
process.env.LARK_CRON_TIMEZONE = 'Asia/Singapore';
process.env.LARK_DEBUG_LOG = debugLogPath;

const {
  createCodexExecToolTraceWriter,
  shouldTraceCodexExecToolEvent,
} = await import('../src/codex-exec-trace.js');
const {
  TRACE_RUN_ID_DISPLAY_LENGTH,
  formatTraceRunIdForDisplay,
} = await import('../src/trace-run-id.js');
const { CodexExecPreStartError, runCodexExecCommand } = await import('../src/codex-exec.js');
const { queryRunTrace } = await import('../src/run-trace-query.js');
const { debugLog } = await import('../src/debug-log.js');

function lines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf-8').trim().split(/\r?\n/).filter(Boolean)
    : [];
}

function assertNotJsonl(line: string): void {
  assert.doesNotMatch(line, /^\s*\{/);
  assert.throws(() => JSON.parse(line));
}

async function waitForLine(path: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const found = lines(path).find((line) => pattern.test(line));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${pattern} in ${path}`);
}

assert.equal(shouldTraceCodexExecToolEvent({ type: 'thread.started', thread_id: 't1' }), false);
assert.equal(shouldTraceCodexExecToolEvent({ type: 'tool_call.started', tool_name: 'mcp.github.issue' }), true);
assert.equal(TRACE_RUN_ID_DISPLAY_LENGTH, 16);
assert.equal(
  formatTraceRunIdForDisplay('run_01234567-89ab-cdef-0123-456789abcdef'),
  '0123456789abcdef',
);
assert.equal(formatTraceRunIdForDisplay('run_trace_001'), 'runtrace001');
assert.equal(
  createCodexExecToolTraceWriter({
    enabled: false,
    mode: 'compact',
    logPath: join(root, 'disabled.log'),
    maxBytes: 1024 * 1024,
    maxFiles: 2,
  }),
  null,
);
assert.equal(existsSync(join(root, 'disabled.log')), false);

const compactLog = join(root, 'compact.log');
const compact = createCodexExecToolTraceWriter({
  enabled: true,
  mode: 'compact',
  logPath: compactLog,
  maxBytes: 1024 * 1024,
  maxFiles: 2,
  logId: 'om_trace_001',
  runId: 'run_trace_001',
});
assert.ok(compact);
compact.recordLine(JSON.stringify({
  type: 'tool_call.started',
  id: 'call-1',
  tool_name: 'mcp.github.issue_create',
  arguments: {
    query: 'look up current release state',
    authorization: 'Bearer should-not-appear',
    body: 'long body '.repeat(60),
  },
}));
compact.recordLine(JSON.stringify({
  type: 'tool_call.completed',
  id: 'call-1',
  tool_name: 'mcp.github.issue_create',
  status: 'completed',
}));
await compact.flush();
const compactLines = lines(compactLog);
assert.equal(compactLines.length, 2);
compactLines.forEach(assertNotJsonl);
assert.match(compactLines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00  om_trace_001  runtrace001  mcp\.github\.issue_create  started  call-1  -  /);
assert.match(compactLines[0], /\[redacted\]/);
assert.match(compactLines[0], /\(600 chars\)/);
assert.match(compactLines[1], /om_trace_001  runtrace001  mcp\.github\.issue_create  completed  call-1  [0-9]+ms  -/);
assert.doesNotMatch(compactLines[0], /trace  compact|tool_call\.started/);
assert.doesNotMatch(compactLines[1], /trace  compact|tool_call\.completed/);
assert.doesNotMatch(readFileSync(compactLog, 'utf-8'), /should-not-appear/);

const compactCommandLog = join(root, 'compact-command.log');
const compactCommand = createCodexExecToolTraceWriter({
  enabled: true,
  mode: 'compact',
  logPath: compactCommandLog,
  maxBytes: 1024 * 1024,
  maxFiles: 2,
  logId: 'om_command_001',
  runId: 'run_command_001',
});
assert.ok(compactCommand);
compactCommand.recordLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'item_13',
    type: 'command_execution',
    command: "/bin/zsh -lc 'bash /Users/kevin/.agents/skills/optix/bin/optix.sh premarket --format json'",
  },
}));
compactCommand.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_13',
    type: 'command_execution',
    command: "/bin/zsh -lc 'bash /Users/kevin/.agents/skills/optix/bin/optix.sh premarket --format json'",
  },
}));
await compactCommand.flush();
const compactCommandLines = lines(compactCommandLog);
assert.equal(compactCommandLines.length, 2);
compactCommandLines.forEach(assertNotJsonl);
assert.match(compactCommandLines[1], /om_command_001  runcommand001  command_execution  completed  item_13  [0-9]+ms  "\/bin\/zsh -lc/);
assert.doesNotMatch(compactCommandLines[1], /trace  compact|item\.completed/);

const fullLog = join(root, 'full.log');
const full = createCodexExecToolTraceWriter({
  enabled: true,
  mode: 'full',
  logPath: fullLog,
  maxBytes: 1024 * 1024,
  maxFiles: 2,
  logId: 'Nightly Review',
  runId: 'run_full_001',
});
assert.ok(full);
full.recordLine(JSON.stringify({
  type: 'command_execution',
  item: {
    type: 'shell',
    command: 'curl -H "Authorization: Bearer should-not-appear" https://example.test',
    access_token: 'should-not-appear',
    source: 'source line '.repeat(100),
  },
}));
await full.flush();
const fullLines = lines(fullLog);
assert.equal(fullLines.length, 1);
assertNotJsonl(fullLines[0]);
assert.match(fullLines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00  "Nightly Review"  runfull001  trace  full  command_execution  shell  event/);
assert.match(fullLines[0], /\[redacted\]/);
assert.match(fullLines[0], /\(1200 chars\)/);
assert.doesNotMatch(readFileSync(fullLog, 'utf-8'), /should-not-appear/);

const hiddenLog = join(root, 'hidden.log');
const hidden = createCodexExecToolTraceWriter({
  enabled: true,
  mode: 'hidden',
  logPath: hiddenLog,
  maxBytes: 1024 * 1024,
  maxFiles: 2,
});
assert.ok(hidden);
hidden.recordLine(JSON.stringify({ type: 'mcp_tool_call.started', name: 'lark.im.reply' }));
await hidden.flush();
const hiddenLines = lines(hiddenLog);
assert.equal(hiddenLines.length, 1);
assertNotJsonl(hiddenLines[0]);
assert.match(hiddenLines[0], /-  [a-f0-9]{16}  lark\.im\.reply  started  -  -/);
assert.doesNotMatch(hiddenLines[0], /trace  hidden|mcp_tool_call\.started/);

debugLog('[channel] compact debug line');
const debugLine = await waitForLine(debugLogPath, /compact debug line/);
assert.match(debugLine, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00 channel compact debug line$/);

const fakeCodex = join(root, 'fake-codex.js');
await writeFile(fakeCodex, [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'const args = process.argv.slice(2);',
  'const outputFile = args[args.indexOf("--output-last-message") + 1];',
  'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_trace" }));',
  'console.log(JSON.stringify({ type: "mcp_tool_call.started", id: "mcp-1", name: "github.get_issue", args: { token: "should-not-appear", issue: 195 } }));',
  'console.log(JSON.stringify({ type: "mcp_tool_call.completed", id: "mcp-1", name: "github.get_issue", status: "ok" }));',
  'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 50 } }));',
  'fs.writeFileSync(outputFile, "final answer only");',
].join('\n'), 'utf-8');
await chmod(fakeCodex, 0o755);

const result = await runCodexExecCommand({
  prompt: 'hello',
  command: fakeCodex,
  cwd: root,
  timeoutMs: 5000,
  ignoreUserConfig: true,
  skipGitRepoCheck: true,
  traceLogId: 'om_integration_001',
});
assert.equal(result.text, 'final answer only');
assert.equal(result.sessionId, 'thread_trace');
assert.deepEqual(result.runtimeMetrics?.usage, {
  inputTokens: 1500,
  cachedInputTokens: 1000,
  outputTokens: 50,
  totalTokens: 1550,
});
assert.equal(result.runtimeMetrics?.toolCalls, 1);
const integrationLog = readFileSync(integrationTraceLog, 'utf-8');
const integrationLines = lines(integrationTraceLog);
assert.ok(integrationLines.length >= 3);
const integrationToolLines = integrationLines.filter((line) => /github\.get_issue/.test(line));
assert.equal(integrationToolLines.length, 2);
integrationToolLines.forEach((line) => {
  assertNotJsonl(line);
  assert.match(line, /om_integration_001  [a-f0-9]{16}  github\.get_issue  /);
  assert.doesNotMatch(line, /trace  compact|mcp_tool_call\.(started|completed)/);
});
const metricsLine = integrationLines.find((line) => /om_integration_001  metrics  /.test(line));
assert.ok(metricsLine);
assertNotJsonl(metricsLine);
assert.match(metricsLine, /elapsed_ms=\d+  tool_calls=1  skill_usages=0  subagents=0  input_tokens=1500  cached_input_tokens=1000  output_tokens=50  total_tokens=1550/);
const metricsDebugLine = await waitForLine(debugLogPath, /codex-exec-metrics log_id=om_integration_001/);
assert.match(metricsDebugLine, /input_tokens=1500 .* total_tokens=1550/);
assert.match(integrationLog, /github\.get_issue/);
assert.doesNotMatch(integrationLog, /should-not-appear/);
assert.doesNotMatch(integrationLog, /final answer only/);

await assert.rejects(
  runCodexExecCommand({
    prompt: 'must not start',
    command: join(root, 'missing-codex-command'),
    cwd: root,
    timeoutMs: 5000,
  }),
  (error: unknown) => error instanceof CodexExecPreStartError && error.code === 'ENOENT',
);

await assert.rejects(
  runCodexExecCommand({
    prompt: 'x'.repeat(16 * 1024 * 1024),
    command: '/usr/bin/true',
    cwd: root,
    timeoutMs: 5000,
  }),
  (error: unknown) => !(error instanceof CodexExecPreStartError),
);

const failedCodex = join(root, 'failed-codex.js');
await writeFile(failedCodex, [
  '#!/usr/bin/env node',
  'process.stderr.write(JSON.stringify({ error: { code: "invalid_json_schema", message: "secret prompt must not appear" } }));',
  'process.exit(1);',
].join('\n'), 'utf-8');
await chmod(failedCodex, 0o755);
await assert.rejects(runCodexExecCommand({
  prompt: 'sensitive continuation prompt',
  command: failedCodex,
  cwd: root,
  timeoutMs: 5000,
  traceLogId: 'job_trace_failure',
  traceRunId: 'att_trace_failure',
}));
const processFailureLine = await waitForLine(integrationTraceLog, /job_trace_failure/);
assertNotJsonl(processFailureLine);
assert.match(
  processFailureLine,
  /job_trace_failure  atttracefailure  codex_exec  failed  process  -  .*output_schema_validation.*codex_output_schema_rejected/,
);
assert.doesNotMatch(processFailureLine, /secret prompt must not appear|sensitive continuation prompt/);
const processFailureQuery = await queryRunTrace({
  logId: 'job_trace_failure',
  runId: 'att_trace_failure',
  logPath: integrationTraceLog,
  enabled: true,
});
assert.equal(processFailureQuery.status, 'ok');
assert.deepEqual(processFailureQuery.tools.map((tool) => ({
  name: tool.name,
  status: tool.status,
  call_id: tool.call_id,
})), [{
  name: 'codex_exec',
  status: 'failed',
  call_id: 'process',
}]);
assert.match(processFailureQuery.tools[0].error ?? '', /codex_output_schema_rejected/);

console.log('codex-exec-trace smoke: PASS');
