import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../src/config.js';
import { AckReactionTracker } from '../src/ack-reactions.js';
import { IdentitySession } from '../src/identity-session.js';
import { LatestMessageTracker } from '../src/channel.js';
import type { LarkChannel } from '../src/channel.js';
import type { MemoryStore } from '../src/memory/file.js';
import { sendFeishuReply } from '../src/reply-sender.js';
import { registerTools } from '../src/tools.js';
import {
  findLarkDeferSentinel,
  TurnObligationTracker,
} from '../src/turn-obligation.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'turn-obligation-'));
const originalAuditLog = appConfig.auditLogPath;
(appConfig as { auditLogPath: string }).auditLogPath = join(tmpDir, 'audit.log');

const noopMemory = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async () => {},
} as unknown as MemoryStore;

function makeClient(opts: { reply?: (args: any) => Promise<any> } = {}) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      im: {
        v1: {
          message: {
            reply: opts.reply ?? (async (args: any) => {
              calls.push({ method: 'message.reply', args });
              return { data: { message_id: 'om_bot_reply' } };
            }),
            create: async (args: any) => {
              calls.push({ method: 'message.create', args });
              return { data: { message_id: 'om_bot_create' } };
            },
            patch: async (args: any) => {
              calls.push({ method: 'message.patch', args });
              return {};
            },
          },
          messageReaction: {
            create: async (args: any) => {
              calls.push({ method: 'reaction.create', args });
              return {};
            },
            delete: async (args: any) => {
              calls.push({ method: 'reaction.delete', args });
              return {};
            },
          },
        },
      },
    },
  };
}

function begin(tracker: TurnObligationTracker, messageId = 'om_turn'): void {
  tracker.begin({
    messageId,
    chatId: 'oc_turn',
    caller: 'ou_turn',
    mode: 'exec',
  });
}

try {
  // 1. Sentinels are line-scoped and ignored inside code fences.
  assert.deepEqual(findLarkDeferSentinel('[LARK_DEFER] waiting')?.marker, 'LARK_DEFER');
  assert.deepEqual(findLarkDeferSentinel('prefix [LARK_DEFER] suffix'), null);
  assert.deepEqual(
    findLarkDeferSentinel('```text\n[LARK_DEFER]\n```\nreal reply'),
    null,
  );
  assert.deepEqual(
    findLarkDeferSentinel('~~~\n[LARK_NO_REPLY]\n~~~\n[LARK_DEFER] later')?.reason,
    'later',
  );

  // 2. Normal reply satisfies the turn obligation.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    begin(tracker, 'om_reply_turn');
    const { client } = makeClient();
    const result = await sendFeishuReply(
      { client: client as any, turnObligations: tracker },
      { chat_id: 'oc_turn', text: 'hello', reply_to: 'om_reply_turn' },
    );
    assert.equal(result.sentCount, 1);
    assert.equal(tracker.getStatus('om_reply_turn'), 'satisfied');
    tracker.requireSatisfiedOrDeferred('om_reply_turn');
    tracker.clear();
  }

  // 3. Withdrawn Feishu reply targets are delivery skips, not Codex failures.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    begin(tracker, 'om_withdrawn_turn');
    const diagnostics: string[] = [];
    const { client, calls } = makeClient({
      reply: async (args: any) => {
        calls.push({ method: 'message.reply.withdrawn', args });
        const err = new Error('The message was withdrawn.') as Error & {
          response?: { data: { code: number; msg: string } };
        };
        err.response = { data: { code: 230011, msg: 'The message was withdrawn.' } };
        throw err;
      },
    });
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      diagnostics.push(args.map(String).join(' '));
    };
    try {
      const result = await sendFeishuReply(
        { client: client as any, turnObligations: tracker },
        { chat_id: 'oc_turn', text: 'hello', reply_to: 'om_withdrawn_turn' },
      );
      assert.equal(result.sentCount, 0);
      assert.equal(result.isError, undefined);
      assert.equal(result.skippedReason, 'withdrawn_message');
      assert.match(result.statusText, /withdrawn/i);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(calls.length, 1);
    assert.equal(tracker.getStatus('om_withdrawn_turn'), 'deferred');
    assert.equal(tracker.get('om_withdrawn_turn')?.marker, 'LARK_NO_REPLY');
    assert.match(tracker.get('om_withdrawn_turn')?.reason ?? '', /withdrawn/i);
    assert.ok(
      diagnostics.some((line) => line.includes('[reply-sender] Skipping reply') && line.includes('230011')),
      `missing withdrawn-message skip diagnostic: ${diagnostics.join('\n')}`,
    );
    tracker.requireSatisfiedOrDeferred('om_withdrawn_turn');
    tracker.clear();
  }

  // 4. Missing reply/defer is mechanically detectable.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    begin(tracker, 'om_missing_turn');
    assert.throws(
      () => tracker.requireSatisfiedOrDeferred('om_missing_turn'),
      /ended without reply/,
    );
    tracker.clear();
  }

  // 5. Active queued turn wins over latest-inbound fallback for interleaved arrivals.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    const latest = new LatestMessageTracker(60_000, 10);
    tracker.begin({
      messageId: 'om_active_a',
      chatId: 'oc_interleaved',
      caller: 'ou_turn',
      mode: 'exec',
    });
    tracker.begin({
      messageId: 'om_latest_b',
      chatId: 'oc_interleaved',
      caller: 'ou_turn',
      mode: 'exec',
    });
    tracker.setActive('oc_interleaved', undefined, 'om_active_a');
    latest.record('oc_interleaved', { messageId: 'om_latest_b', timestamp: Date.now() });
    const { client, calls } = makeClient();
    await sendFeishuReply(
      {
        client: client as any,
        turnObligations: tracker,
        latestMessageTracker: latest,
      },
      { chat_id: 'oc_interleaved', text: 'reply without explicit reply_to' },
    );
    assert.equal(calls[0].method, 'message.reply');
    assert.equal(calls[0].args.path.message_id, 'om_active_a');
    assert.equal(tracker.getStatus('om_active_a'), 'satisfied');
    assert.equal(tracker.getStatus('om_latest_b'), 'pending');
    tracker.clear();
  }

  // 6. Notification lifecycle with multiple pending turns refuses to guess.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    const latest = new LatestMessageTracker(60_000, 10);
    tracker.begin({
      messageId: 'om_notify_a',
      chatId: 'oc_notify',
      caller: 'ou_turn',
      mode: 'exec',
    });
    tracker.begin({
      messageId: 'om_notify_b',
      chatId: 'oc_notify',
      caller: 'ou_turn',
      mode: 'exec',
    });
    latest.record('oc_notify', { messageId: 'om_notify_b', timestamp: Date.now() });
    const { client, calls } = makeClient();
    await assert.rejects(
      sendFeishuReply(
        {
          client: client as any,
          turnObligations: tracker,
          latestMessageTracker: latest,
        },
        { chat_id: 'oc_notify', text: 'ambiguous reply without reply_to' },
      ),
      /reply_to is required: 2 pending Lark turns/,
    );
    assert.equal(calls.length, 0);
    assert.equal(tracker.getStatus('om_notify_a'), 'pending');
    assert.equal(tracker.getStatus('om_notify_b'), 'pending');
    tracker.clear();
  }

  // 7. Notification lifecycle with one pending turn can still auto-fill safely.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    tracker.begin({
      messageId: 'om_single_pending',
      chatId: 'oc_single_pending',
      caller: 'ou_turn',
      mode: 'exec',
    });
    const { client, calls } = makeClient();
    await sendFeishuReply(
      {
        client: client as any,
        turnObligations: tracker,
      },
      { chat_id: 'oc_single_pending', text: 'single pending reply' },
    );
    assert.equal(calls[0].method, 'message.reply');
    assert.equal(calls[0].args.path.message_id, 'om_single_pending');
    assert.equal(tracker.getStatus('om_single_pending'), 'satisfied');
    tracker.clear();
  }

  // 8. Assistant-text defer satisfies only when parsed by the exec path caller.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    begin(tracker, 'om_defer_turn');
    assert.ok(tracker.markDeferredFromText('om_defer_turn', 'exec_assistant_text', '[LARK_NO_REPLY] handled elsewhere'));
    assert.equal(tracker.get('om_defer_turn')?.status, 'deferred');
    assert.equal(tracker.get('om_defer_turn')?.marker, 'LARK_NO_REPLY');
    tracker.clear();
  }

  // 9. Code-block spoofing does not satisfy.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    begin(tracker, 'om_spoof_turn');
    assert.equal(
      tracker.markDeferredFromText('om_spoof_turn', 'exec_assistant_text', '```text\n[LARK_DEFER]\n```'),
      null,
    );
    assert.equal(tracker.getStatus('om_spoof_turn'), 'pending');
    tracker.clear();
  }

  // 10. Tool-result defer is accepted only through the dedicated Lark tool.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 60_000 });
    const ackTracker = new AckReactionTracker({ maxTrackedMessages: 10 });
    tracker.begin({
      messageId: 'om_defer_tool',
      chatId: 'oc_defer_tool',
      caller: 'ou_defer_tool',
      mode: 'exec',
    });
    ackTracker.recordInbound('om_defer_tool');
    ackTracker.storeReaction('om_defer_tool', 'reaction_defer_tool');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool(name: string, _config: any, handler: any) {
        handlers.set(name, handler);
      },
    };
    const { client, calls } = makeClient();
    registerTools(
      fakeServer as any,
      client as any,
      noopMemory,
      new IdentitySession(() => null),
      { isPrivateChat: () => true } as unknown as LarkChannel,
      undefined,
      ackTracker,
      { add() {}, has: () => false, get: () => undefined } as any,
      undefined,
      tracker,
    );
    const deferReply = handlers.get('defer_reply');
    assert.ok(deferReply);
    const result = await deferReply({
      chat_id: 'oc_defer_tool',
      reply_to: 'om_defer_tool',
      marker: 'LARK_DEFER',
      reason: 'waiting for operator',
    });
    await Promise.resolve();
    assert.equal(result.isError, undefined);
    assert.equal(tracker.getStatus('om_defer_tool'), 'deferred');
    assert.equal(calls.filter((c) => c.method === 'reaction.delete').length, 1);
    tracker.clear();
  }

  // 11. Watchdog marks unanswered turns for audit/debugging.
  {
    const tracker = new TurnObligationTracker({ timeoutMs: 5 });
    begin(tracker, 'om_timeout_turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tracker.getStatus('om_timeout_turn'), 'unanswered');
    tracker.clear();
  }
} finally {
  (appConfig as { auditLogPath: string }).auditLogPath = originalAuditLog;
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log('PASS');
