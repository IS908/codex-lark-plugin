import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const {
  createCodexExecRuntimeMetricsCollector,
  extractCodexExecUsage,
  formatCodexExecRuntimeMetricsFooter,
  mergeCardFooterWithRuntimeMetrics,
} = await import('../src/codex-exec-metrics.js');

const collector = createCodexExecRuntimeMetricsCollector(0);
collector.recordLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread_001' }));
collector.recordLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'item_13',
    type: 'command_execution',
    command: 'npm test',
  },
}));
collector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_13',
    type: 'command_execution',
    command: 'npm test',
  },
}));
collector.recordLine(JSON.stringify({
  type: 'mcp_tool_call.started',
  id: 'mcp_1',
  name: 'github.get_issue',
}));
collector.recordLine(JSON.stringify({
  type: 'mcp_tool_call.completed',
  id: 'mcp_1',
  name: 'github.get_issue',
}));
collector.recordLine(JSON.stringify({
  type: 'skill.started',
  id: 'skill_1',
  name: 'gh-issue-closed-loop',
}));
collector.recordLine(JSON.stringify({
  type: 'subagent.started',
  id: 'agent_1',
  name: 'subagent-reviewer',
}));
collector.recordLine(JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 62400,
    cached_input_tokens: 48200,
    output_tokens: 1300,
    total_tokens: 1,
    context_window: 200000,
  },
}));

const metrics = collector.finish(18_400);
assert.equal(metrics.toolCalls, 2);
assert.equal(metrics.skillUsages, 1);
assert.equal(metrics.subagents, 1);
assert.equal(metrics.elapsedMs, 18_400);
assert.deepEqual(metrics.usage, {
  inputTokens: 62400,
  cachedInputTokens: 48200,
  outputTokens: 1300,
  totalTokens: 63700,
  contextWindowTokens: 200000,
});

assert.deepEqual(
  extractCodexExecUsage(
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        input_tokens_details: { cached_tokens: 4 },
      },
    }),
  ),
  {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 5,
    totalTokens: 15,
  },
);

assert.equal(
  formatCodexExecRuntimeMetricsFooter(metrics, 20_000),
  '🔧2 · 🧩1 · 🤖1 · ⏱18s · 📊 I62.4k(C48.2k) O1.3k T63.7k',
);
assert.equal(
  formatCodexExecRuntimeMetricsFooter(metrics, 70_000),
  '🔧2 · 🧩1 · 🤖1 · ⏱18s',
);
assert.equal(
  formatCodexExecRuntimeMetricsFooter({
    elapsedMs: 250,
    toolCalls: 0,
    skillUsages: 0,
    subagents: 0,
  }, 20_000),
  '⏱250ms',
);

assert.equal(
  mergeCardFooterWithRuntimeMetrics('Data updated at 10:30', '🔧2 · ⏱18s'),
  'Data updated at 10:30\n🔧2 · ⏱18s',
);
assert.equal(
  mergeCardFooterWithRuntimeMetrics('Data updated at 10:30\n🔧1 · ⏱3s', '🔧2 · ⏱18s'),
  'Data updated at 10:30\n🔧2 · ⏱18s',
);
assert.equal(
  mergeCardFooterWithRuntimeMetrics('Data window ⏱3s ago', '🔧2 · ⏱18s'),
  'Data window ⏱3s ago\n🔧2 · ⏱18s',
);
assert.equal(
  mergeCardFooterWithRuntimeMetrics(undefined, '⏱3s'),
  '⏱3s',
);
assert.equal(
  mergeCardFooterWithRuntimeMetrics('Business footer', undefined),
  'Business footer',
);
assert.equal(
  mergeCardFooterWithRuntimeMetrics(`${'x'.repeat(1000)}\n🔧1 · ⏱3s`, '🔧2 · ⏱18s'),
  'x'.repeat(1000),
);

console.log('codex-exec-metrics smoke: PASS');
