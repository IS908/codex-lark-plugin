import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const {
  SessionHealthMonitor,
  buildSessionHealthNudgeText,
} = await import('../src/session-health.js');

// 1. Disabled monitors, including missing-owner setups, are inert.
{
  const sent: any[] = [];
  const disabled = new SessionHealthMonitor({
    enabled: false,
    ownerOpenId: 'ou_owner',
    turnThreshold: 1,
    promptBytesThreshold: 1,
    quietDelayMs: 0,
    baseCooldownMs: 1000,
    maxCooldownMs: 4000,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  disabled.recordTurn({
    sessionKey: 'chat:oc_1',
    chatId: 'oc_1',
    sessionId: 'session_1',
    resumed: true,
    promptBytes: 10,
    responseBytes: 10,
  }, 1_000);
  assert.equal(await disabled.checkNow('chat:oc_1', 1_000), false);

  const missingOwner = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: null,
    turnThreshold: 1,
    promptBytesThreshold: 1,
    quietDelayMs: 0,
    baseCooldownMs: 1000,
    maxCooldownMs: 4000,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  missingOwner.recordTurn({
    sessionKey: 'chat:oc_1',
    chatId: 'oc_1',
    sessionId: 'session_1',
    resumed: true,
    promptBytes: 10,
    responseBytes: 10,
  }, 1_000);
  assert.equal(await missingOwner.checkNow('chat:oc_1', 1_000), false);
  assert.equal(sent.length, 0);
}

// 2. Thresholded nudges wait for all quiet gates.
{
  const sent: any[] = [];
  let quiet = { queueIdle: false, ackQuiet: true, turnQuiet: true };
  const monitor = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: 'ou_owner',
    turnThreshold: 2,
    promptBytesThreshold: 10_000,
    quietDelayMs: 0,
    baseCooldownMs: 1000,
    maxCooldownMs: 4000,
    maxNudges: 3,
    quiet: () => quiet,
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  monitor.recordTurn({
    sessionKey: 'chat:oc_1:thread:t1',
    chatId: 'oc_1',
    threadId: 't1',
    sessionId: 'session_1',
    resumed: false,
    promptBytes: 100,
    responseBytes: 20,
  }, 1_000);
  monitor.recordTurn({
    sessionKey: 'chat:oc_1:thread:t1',
    chatId: 'oc_1',
    threadId: 't1',
    sessionId: 'session_1',
    resumed: true,
    promptBytes: 100,
    responseBytes: 20,
  }, 2_000);

  assert.equal(await monitor.checkNow('chat:oc_1:thread:t1', 2_000), false);
  quiet = { queueIdle: true, ackQuiet: true, turnQuiet: true };
  assert.equal(await monitor.checkNow('chat:oc_1:thread:t1', 2_000), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].turnCount, 2);
  assert.equal(sent[0].reason, 'turn_threshold');
}

// 3. Repeated nudges back off exponentially and respect max nudges per episode.
{
  const sent: any[] = [];
  const monitor = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: 'ou_owner',
    turnThreshold: 1,
    promptBytesThreshold: 10_000,
    quietDelayMs: 10_000,
    baseCooldownMs: 100,
    maxCooldownMs: 250,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  const input = {
    sessionKey: 'chat:oc_2',
    chatId: 'oc_2',
    sessionId: 'session_2',
    resumed: true,
    promptBytes: 100,
    responseBytes: 20,
  };
  monitor.recordTurn(input, 1_000);
  assert.equal(await monitor.checkNow('chat:oc_2', 1_000), true);
  assert.equal(await monitor.checkNow('chat:oc_2', 1_050), false);
  monitor.recordTurn(input, 1_100);
  assert.equal(await monitor.checkNow('chat:oc_2', 1_100), true);
  assert.equal(sent[1].cooldownMs, 200);
  monitor.recordTurn(input, 1_400);
  assert.equal(await monitor.checkNow('chat:oc_2', 1_400), false);
  assert.equal(sent.length, 2);
}

// 4. A zero quiet delay still schedules an immediate quiet-gated nudge.
{
  const sent: any[] = [];
  const monitor = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: 'ou_owner',
    turnThreshold: 1,
    promptBytesThreshold: 10_000,
    quietDelayMs: 0,
    baseCooldownMs: 100,
    maxCooldownMs: 250,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  monitor.recordTurn({
    sessionKey: 'chat:oc_immediate',
    chatId: 'oc_immediate',
    sessionId: 'session_immediate',
    resumed: true,
    promptBytes: 100,
    responseBytes: 20,
  }, 1_000);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionKey, 'chat:oc_immediate');
}

// 5. New Codex session ids reset the heuristic episode.
{
  const sent: any[] = [];
  const monitor = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: 'ou_owner',
    turnThreshold: 2,
    promptBytesThreshold: 10_000,
    quietDelayMs: 0,
    baseCooldownMs: 100,
    maxCooldownMs: 250,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  monitor.recordTurn({
    sessionKey: 'chat:oc_3',
    chatId: 'oc_3',
    sessionId: 'session_old',
    resumed: true,
    promptBytes: 100,
    responseBytes: 20,
  }, 1_000);
  monitor.recordTurn({
    sessionKey: 'chat:oc_3',
    chatId: 'oc_3',
    sessionId: 'session_new',
    resumed: false,
    promptBytes: 100,
    responseBytes: 20,
  }, 1_100);
  const snapshot = monitor.getSnapshot('chat:oc_3');
  assert.equal(snapshot?.sessionId, 'session_new');
  assert.equal(snapshot?.turnCount, 1);
  assert.equal(snapshot?.promptBytes, 100);
  assert.equal(snapshot?.lastResetReason, 'session_id_changed');
  assert.equal(await monitor.checkNow('chat:oc_3', 1_100), false);
}

// 6. Real Codex usage, when present, takes precedence over prompt-byte heuristics.
{
  const sent: any[] = [];
  const monitor = new SessionHealthMonitor({
    enabled: true,
    ownerOpenId: 'ou_owner',
    turnThreshold: 100,
    promptBytesThreshold: 100,
    tokenUsageThreshold: 500,
    quietDelayMs: 0,
    baseCooldownMs: 100,
    maxCooldownMs: 250,
    maxNudges: 2,
    quiet: () => ({ queueIdle: true, ackQuiet: true, turnQuiet: true }),
    notifyOwner: async (nudge: any) => { sent.push(nudge); },
  });
  monitor.recordTurn({
    sessionKey: 'chat:oc_usage',
    chatId: 'oc_usage',
    sessionId: 'session_usage',
    resumed: true,
    promptBytes: 1_000_000,
    responseBytes: 20,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, contextWindowTokens: 2000 },
  }, 1_000);
  assert.equal(await monitor.checkNow('chat:oc_usage', 1_000), false);

  monitor.recordTurn({
    sessionKey: 'chat:oc_usage',
    chatId: 'oc_usage',
    sessionId: 'session_usage',
    resumed: true,
    promptBytes: 1,
    responseBytes: 20,
    usage: { inputTokens: 450, outputTokens: 75, totalTokens: 525, contextWindowTokens: 2000 },
  }, 1_100);
  assert.equal(await monitor.checkNow('chat:oc_usage', 1_100), true);
  assert.equal(sent[0].reason, 'token_usage_threshold');
  assert.equal(sent[0].totalTokens, 525);
  assert.equal(sent[0].contextWindowTokens, 2000);
}

// 7. Nudge text documents real usage when available and avoids implying auto clear/compact.
{
  const text = buildSessionHealthNudgeText({
    sessionKey: 'chat:oc_1',
    chatId: 'oc_1',
    threadId: 't1',
    sessionId: 'session_1',
    turnCount: 10,
    promptBytes: 1234,
    responseBytes: 567,
    reason: 'token_usage_threshold',
    totalTokens: 4567,
    contextWindowTokens: 200000,
    usageSamples: 3,
    missingUsageSamples: 1,
    nudgeCount: 1,
    cooldownMs: 1000,
  });
  assert.match(text, /Codex exec usage/i);
  assert.match(text, /No automatic clear or compact/i);
  assert.match(text, /subagents/i);
}

console.log('session-health smoke: 7/7 PASS');
