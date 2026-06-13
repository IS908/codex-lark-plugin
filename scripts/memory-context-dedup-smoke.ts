import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { LarkChannel } = await import('../src/channel.js');
const { appConfig } = await import('../src/config.js');
const {
  MemoryContextDeduper,
  createMemoryDedupScopeKey,
} = await import('../src/memory-context-dedup.js');

function makeBlocks(profileContent = '- likes concise reviews') {
  return [
    {
      key: 'profile:ou_owner',
      kind: 'profile' as const,
      label: '[User Profile]',
      content: profileContent,
    },
    {
      key: 'thread_episode:ep_1',
      kind: 'thread_episode' as const,
      label: '[Thread Context score:0.90 2026-06-08]',
      content: 'prior thread decision',
    },
    {
      key: 'skill:review',
      kind: 'skill' as const,
      label: '[Skill: Review score:0.95]',
      content: 'Use concise review style.\n-> /tmp/review.md',
    },
  ];
}

// 1. Same chat/thread suppresses unchanged memory blocks inside the window.
{
  const deduper = new MemoryContextDeduper({ windowMs: 30 * 60 * 1000 });
  const scope = createMemoryDedupScopeKey('oc_chat', 'thread_1');

  const first = deduper.filter(scope, makeBlocks(), 1_000);
  assert.equal(first.injectedCount, 3);
  assert.equal(first.suppressedCount, 0);
  assert.match(first.memoryContext, /likes concise reviews/);
  assert.match(first.memoryContext, /prior thread decision/);
  assert.match(first.memoryContext, /Use concise review style/);

  const second = deduper.filter(scope, makeBlocks(), 2_000);
  assert.equal(second.injectedCount, 0);
  assert.equal(second.suppressedCount, 3);
  assert(second.bytesSaved > 0);
  assert.match(second.memoryContext, /<memory_context_omitted /);
  assert.match(second.memoryContext, /kind="profile"/);
  assert.doesNotMatch(second.memoryContext, /likes concise reviews/);
  assert.doesNotMatch(second.memoryContext, /prior thread decision/);
  assert.doesNotMatch(second.memoryContext, /Use concise review style/);
}

// 2. Content changes, new scopes, and window expiry re-inject context.
{
  const deduper = new MemoryContextDeduper({ windowMs: 100 });
  const scope = createMemoryDedupScopeKey('oc_chat', 'thread_1');
  deduper.filter(scope, makeBlocks(), 1_000);

  const changed = deduper.filter(scope, makeBlocks('- prefers release notes'), 1_010);
  assert.equal(changed.injectedCount, 1);
  assert.match(changed.memoryContext, /prefers release notes/);

  const otherScope = deduper.filter(createMemoryDedupScopeKey('oc_chat', 'thread_2'), makeBlocks(), 1_020);
  assert.equal(otherScope.injectedCount, 3);
  assert.match(otherScope.memoryContext, /likes concise reviews/);

  const expired = deduper.filter(scope, makeBlocks('- prefers release notes'), 1_200);
  assert.equal(expired.injectedCount, 3);
  assert.match(expired.memoryContext, /prefers release notes/);
  assert.match(expired.memoryContext, /prior thread decision/);
}

// 3. A zero window disables deduplication.
{
  const deduper = new MemoryContextDeduper({ windowMs: 0 });
  const scope = createMemoryDedupScopeKey('oc_chat', 'thread_1');
  deduper.filter(scope, makeBlocks(), 1_000);
  const second = deduper.filter(scope, makeBlocks(), 1_100);
  assert.equal(second.injectedCount, 3);
  assert.equal(second.suppressedCount, 0);
  assert.match(second.memoryContext, /likes concise reviews/);
}

// 4. Delivery failure invalidates the scope so the next turn does not point at unseen context.
{
  const originalWindow = appConfig.memoryDedupWindowMs;
  (appConfig as { memoryDedupWindowMs: number }).memoryDedupWindowMs = 30 * 60 * 1000;
  try {
    const channel = new LarkChannel();
    channel.setMemoryStore({
      getProfile: async () => '- delivery must see this',
      searchEpisodes: async () => [],
      searchSkills: async () => [],
    } as any);

    let calls = 0;
    const handled: any[] = [];
    channel.setMessageHandler(async (msg: any) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated delivery failure');
      handled.push(msg);
    });

    const message = {
      messageId: 'mid_fail_1',
      chatId: 'oc_failure',
      chatType: 'group',
      senderId: 'ou_owner',
      text: 'review this',
      messageType: 'text',
      threadId: 'thread_1',
      rawContent: '{}',
    };

    await assert.rejects(() => (channel as any).processEnqueuedMessage(message), /simulated delivery failure/);
    await (channel as any).processEnqueuedMessage({ ...message, messageId: 'mid_fail_2' });

    assert.equal(handled.length, 1);
    assert.match(handled[0].text, /delivery must see this/);
    assert.doesNotMatch(handled[0].text, /<memory_context_omitted /);
  } finally {
    (appConfig as { memoryDedupWindowMs: number }).memoryDedupWindowMs = originalWindow;
  }
}

console.log('memory-context-dedup smoke: 4/4 PASS');
