import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const root = await mkdtemp(join(tmpdir(), 'codex-exec-trace-'));
const integrationTraceLog = join(root, 'integration-trace.log');
process.env.LARK_CODEX_EXEC_TOOL_TRACE = 'true';
process.env.LARK_CODEX_EXEC_TOOL_TRACE_MODE = 'compact';
process.env.LARK_CODEX_EXEC_TRACE_LOG = integrationTraceLog;

const {
  createCodexExecToolTraceWriter,
  shouldTraceCodexExecToolEvent,
} = await import('../src/codex-exec-trace.js');
const { runCodexExecCommand } = await import('../src/codex-exec.js');

function jsonl(path: string): any[] {
  return existsSync(path)
    ? readFileSync(path, 'utf-8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

assert.equal(shouldTraceCodexExecToolEvent({ type: 'thread.started', thread_id: 't1' }), false);
assert.equal(shouldTraceCodexExecToolEvent({ type: 'tool_call.started', tool_name: 'mcp.github.issue' }), true);
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
const compactRecords = jsonl(compactLog);
assert.equal(compactRecords.length, 2);
assert.equal(compactRecords[0].kind, 'trace');
assert.equal(compactRecords[0].mode, 'compact');
assert.equal(compactRecords[0].tool, 'mcp.github.issue_create');
assert.equal(compactRecords[0].args.authorization, '[redacted]');
assert.match(compactRecords[0].args.body, /\(600 chars\)$/);
assert.equal(compactRecords[1].status, 'completed');
assert.equal(typeof compactRecords[1].duration_ms, 'number');
assert.doesNotMatch(readFileSync(compactLog, 'utf-8'), /should-not-appear/);

const fullLog = join(root, 'full.log');
const full = createCodexExecToolTraceWriter({
  enabled: true,
  mode: 'full',
  logPath: fullLog,
  maxBytes: 1024 * 1024,
  maxFiles: 2,
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
const fullRecords = jsonl(fullLog);
assert.equal(fullRecords[0].kind, 'trace');
assert.equal(fullRecords[0].mode, 'full');
assert.equal(fullRecords[0].event.item.access_token, '[redacted]');
assert.match(fullRecords[0].event.item.source, /\(1200 chars\)$/);
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
assert.equal(jsonl(hiddenLog)[0].kind, 'trace');
assert.equal(jsonl(hiddenLog)[0].mode, 'hidden');

const fakeCodex = join(root, 'fake-codex.js');
await writeFile(fakeCodex, [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'const args = process.argv.slice(2);',
  'const outputFile = args[args.indexOf("--output-last-message") + 1];',
  'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_trace" }));',
  'console.log(JSON.stringify({ type: "mcp_tool_call.started", id: "mcp-1", name: "github.get_issue", args: { token: "should-not-appear", issue: 195 } }));',
  'console.log(JSON.stringify({ type: "mcp_tool_call.completed", id: "mcp-1", name: "github.get_issue", status: "ok" }));',
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
});
assert.equal(result.text, 'final answer only');
assert.equal(result.sessionId, 'thread_trace');
const integrationLog = readFileSync(integrationTraceLog, 'utf-8');
const integrationRecords = jsonl(integrationTraceLog);
assert.ok(integrationRecords.length >= 2);
assert.ok(integrationRecords.every((record) => record.kind === 'trace'));
assert.match(integrationLog, /github\.get_issue/);
assert.doesNotMatch(integrationLog, /should-not-appear/);
assert.doesNotMatch(integrationLog, /final answer only/);

console.log('codex-exec-trace smoke: PASS');
