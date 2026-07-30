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
assert.deepEqual(metrics.toolCalls, { value: 2, status: 'complete' });
assert.deepEqual(metrics.skillsLoaded, { value: 1, status: 'partial' });
assert.deepEqual(metrics.subagentsSpawned, { value: 1, status: 'partial' });
assert.equal(metrics.elapsedMs, 18_400);
assert.deepEqual(metrics.usage, {
  inputTokens: 62400,
  cachedInputTokens: 48200,
  outputTokens: 1300,
  totalTokens: 63700,
  contextWindowTokens: 200000,
});

const skillCollector = createCodexExecRuntimeMetricsCollector(0);
for (const [id, command, status = 'completed'] of [
  ['skill-read-1', "cat '/Users/test/.agents/skills/optix/SKILL.md'"],
  ['skill-read-2', 'sed -n 1,80p /Users/test/.agents/skills/optix/SKILL.md'],
  ['skill-read-failed', 'cat /Users/test/.agents/skills/failed/SKILL.md', 'failed'],
] as const) {
  skillCollector.recordLine(JSON.stringify({
    type: 'item.started',
    item: { id, type: 'command_execution', command },
  }));
  skillCollector.recordLine(JSON.stringify({
    type: 'item.completed',
    item: { id, type: 'command_execution', command, status },
  }));
}
skillCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'skill-read-file',
    type: 'file_read',
    path: '/Users/test/.codex/skills/configure/SKILL.md',
    status: 'completed',
  },
}));
skillCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'skill-read-space',
    type: 'file_read',
    path: '/Users/Test User/.codex/skills/space-skill/SKILL.md',
    status: 'completed',
  },
}));
skillCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'skill-read-nonzero',
    type: 'command_execution',
    command: 'cat /Users/test/.agents/skills/nonzero/SKILL.md',
    status: 'completed',
    exit_code: 1,
  },
}));
skillCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
const skillMetrics = skillCollector.finish(100);
assert.deepEqual(skillMetrics.toolCalls, { value: 6, status: 'complete' });
assert.deepEqual(skillMetrics.skillsLoaded, { value: 3, status: 'partial' });
assert.deepEqual(skillMetrics.subagentsSpawned, { value: null, status: 'unavailable' });

const failedLegacySkillCollector = createCodexExecRuntimeMetricsCollector(0);
failedLegacySkillCollector.recordLine(JSON.stringify({
  type: 'skill.started',
  id: 'legacy-skill-failed',
  name: 'failed-legacy',
}));
failedLegacySkillCollector.recordLine(JSON.stringify({
  type: 'skill.failed',
  id: 'legacy-skill-failed',
}));
failedLegacySkillCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
assert.deepEqual(failedLegacySkillCollector.finish(100).skillsLoaded, {
  value: null,
  status: 'unavailable',
});

const subagentCollector = createCodexExecRuntimeMetricsCollector(0);
subagentCollector.recordLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'spawn-1',
    type: 'collab_tool_call',
    tool: 'spawn_agent',
  },
}));
subagentCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'spawn-1',
    type: 'collab_tool_call',
    tool: 'spawn_agent',
    status: 'completed',
    agent_id: 'agent-1',
  },
}));
subagentCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'spawn-1',
    type: 'collab_tool_call',
    tool: 'spawn_agent',
    status: 'completed',
    agent_id: 'agent-1',
  },
}));
for (const id of ['spawn-2', 'spawn-3']) {
  subagentCollector.recordLine(JSON.stringify({
    type: 'item.completed',
    item: {
      id,
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      status: 'completed',
    },
  }));
}
subagentCollector.recordLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'spawn-failed',
    type: 'collab_tool_call',
    tool: 'spawn_agent',
  },
}));
subagentCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'spawn-failed',
    type: 'collab_tool_call',
    tool: 'spawn_agent',
    status: 'failed',
  },
}));
subagentCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
const subagentMetrics = subagentCollector.finish(100);
assert.deepEqual(subagentMetrics.toolCalls, { value: 4, status: 'complete' });
assert.deepEqual(subagentMetrics.skillsLoaded, { value: null, status: 'unavailable' });
assert.deepEqual(subagentMetrics.subagentsSpawned, { value: 3, status: 'partial' });

const crossTypeCollector = createCodexExecRuntimeMetricsCollector(0);
crossTypeCollector.recordLine(JSON.stringify({
  type: 'mcp_tool_call.started',
  id: 'cross-type-1',
  name: 'github.get_issue',
}));
crossTypeCollector.recordLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'cross-type-1',
    type: 'function_call',
    name: 'github.get_issue',
    status: 'completed',
  },
}));
crossTypeCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
assert.deepEqual(crossTypeCollector.finish(100).toolCalls, { value: 1, status: 'complete' });

const uncertainCollector = createCodexExecRuntimeMetricsCollector(0);
for (const [id, status] of [
  ['known-success', 'completed'],
  ['known-failed', 'failed'],
  ['known-cancelled', 'cancelled'],
] as const) {
  uncertainCollector.recordLine(JSON.stringify({
    type: 'item.started',
    item: { id, type: 'command_execution', command: 'true' },
  }));
  uncertainCollector.recordLine(JSON.stringify({
    type: 'item.completed',
    item: { id, type: 'command_execution', command: 'true', status },
  }));
}
uncertainCollector.recordLine(JSON.stringify({
  type: 'item.started',
  item: { id: 'future-1', type: 'future_tool_kind' },
}));
uncertainCollector.recordLine(JSON.stringify({
  type: 'future_tool.started',
  id: 'future-2',
}));
uncertainCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
const uncertainMetrics = uncertainCollector.finish(100);
assert.deepEqual(uncertainMetrics.toolCalls, { value: 3, status: 'partial' });

const incompleteCollector = createCodexExecRuntimeMetricsCollector(0);
incompleteCollector.recordLine(JSON.stringify({
  type: 'item.started',
  item: { id: 'partial-1', type: 'command_execution', command: 'true' },
}));
assert.deepEqual(incompleteCollector.finish(100).toolCalls, { value: 1, status: 'partial' });

const anonymousCollector = createCodexExecRuntimeMetricsCollector(0);
anonymousCollector.recordLine(JSON.stringify({
  type: 'mcp_tool_call.started',
  name: 'github.get_issue',
  arguments: { issue: 325 },
}));
anonymousCollector.recordLine(JSON.stringify({
  type: 'mcp_tool_call.completed',
  name: 'github.get_issue',
}));
anonymousCollector.recordLine(JSON.stringify({ type: 'turn.completed' }));
assert.deepEqual(anonymousCollector.finish(100).toolCalls, { value: 1, status: 'partial' });

const unavailableMetrics = createCodexExecRuntimeMetricsCollector(0).finish(250);
assert.deepEqual(unavailableMetrics.toolCalls, { value: null, status: 'unavailable' });
assert.deepEqual(unavailableMetrics.skillsLoaded, { value: null, status: 'unavailable' });
assert.deepEqual(unavailableMetrics.subagentsSpawned, { value: null, status: 'unavailable' });

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
  formatCodexExecRuntimeMetricsFooter(unavailableMetrics, 20_000),
  '⏱250ms',
);
assert.equal(
  formatCodexExecRuntimeMetricsFooter({
    elapsedMs: 250,
    toolCalls: { value: 0, status: 'complete' },
    skillsLoaded: { value: null, status: 'unavailable' },
    subagentsSpawned: { value: null, status: 'unavailable' },
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
