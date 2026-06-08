import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AckReactionTracker, revokeAllAckReactions } from '../src/ack-reactions.js';
import { LarkChannel } from '../src/channel.js';
import { sendFeishuReply } from '../src/reply-sender.js';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import type { MemoryStore } from '../src/memory/file.js';
import type { LarkChannel } from '../src/channel.js';
import { appConfig } from '../src/config.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const tracker = new AckReactionTracker({
  recentInboundTtlMs: 100,
  pendingRevokeTtlMs: 100,
  maxTrackedMessages: 10,
});

// 1. Revoke-before-set races are closed by deleting the late ack immediately.
tracker.recordInbound('om_race', 0);
assert.equal(tracker.markSatisfied('om_race', 10), null);
assert.equal(tracker.hasPendingRevoke('om_race', 20), true);
const lateStore = tracker.storeReaction('om_race', 'reaction_late', 30);
assert.equal(lateStore.action, 'delete-now');
assert.deepEqual(
  lateStore.action === 'delete-now' ? lateStore.reaction : null,
  { messageId: 'om_race', reactionId: 'reaction_late' },
);
assert.equal(tracker.activeCount, 0);
assert.equal(tracker.pendingCount, 0);

// 2. Non-inbound and stale ids cannot fill the pending-revoke set.
tracker.markSatisfied('om_never_seen', 40);
assert.equal(tracker.hasPendingRevoke('om_never_seen', 40), false);
tracker.recordInbound('om_stale', 0);
tracker.markSatisfied('om_stale', 2_000);
assert.equal(tracker.hasPendingRevoke('om_stale', 2_000), false);

// 3. Active ack handles survive inbound TTL cleanup so long-running turns can revoke them.
tracker.recordInbound('om_active_after_ttl', 0);
tracker.storeReaction('om_active_after_ttl', 'reaction_after_ttl', 10);
assert.deepEqual(tracker.markSatisfied('om_active_after_ttl', 2_000), {
  messageId: 'om_active_after_ttl',
  reactionId: 'reaction_after_ttl',
});

// 4. Active ack handles are not evicted when recent inbound capacity trims markers.
const cappedTracker = new AckReactionTracker({ maxTrackedMessages: 1 });
cappedTracker.recordInbound('om_active_trimmed');
cappedTracker.storeReaction('om_active_trimmed', 'reaction_active_trimmed');
cappedTracker.recordInbound('om_newer_marker');
assert.deepEqual(cappedTracker.markSatisfied('om_active_trimmed'), {
  messageId: 'om_active_trimmed',
  reactionId: 'reaction_active_trimmed',
});

// 5. Bulk revoke attempts every active ack even when one delete fails.
tracker.clear();
tracker.recordInbound('om_bulk_1');
tracker.recordInbound('om_bulk_2');
tracker.storeReaction('om_bulk_1', 'reaction_bulk_1');
tracker.storeReaction('om_bulk_2', 'reaction_bulk_2');
const bulkDeletes: any[] = [];
const bulkClient = {
  im: {
    v1: {
      messageReaction: {
        delete: async (args: any) => {
          bulkDeletes.push(args);
          if (bulkDeletes.length === 1) throw new Error('simulated delete failure');
          return {};
        },
      },
    },
  },
};
revokeAllAckReactions(bulkClient as any, tracker, 'ack_smoke.bulk');
await flushMicrotasks();
assert.equal(bulkDeletes.length, 2);
assert.equal(tracker.activeCount, 0);

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

const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;

function makeTools(client: any, ackReactions: AckReactionTracker) {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const fakeServer = {
    registerTool(name: string, _config: any, handler: any) {
      handlers.set(name, handler);
    },
  };
  registerTools(
    fakeServer as any,
    client,
    noopMemory,
    new IdentitySession(() => null),
    fakeChannel,
    undefined,
    ackReactions,
    { add() {}, has: () => false, get: () => undefined } as any,
    undefined,
  );
  return handlers;
}

// 6. Ack create failures do not leave active/pending ack state or block delivery.
{
  const originalAllowedUserIds = appConfig.allowedUserIds;
  const originalAllowedChatIds = appConfig.allowedChatIds;
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = [];
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = [];
  const channel = new LarkChannel();
  let delivered = 0;
  try {
    channel.setMessageHandler(async () => {
      delivered++;
    });
    (channel as any).nameCache.set('ou_ack_create_fail', 'Ack Tester');
    (channel as any).client = {
      im: {
        v1: {
          messageReaction: {
            create: async () => {
              throw new Error('simulated ack create failure');
            },
            delete: async () => ({}),
          },
        },
      },
    };

    await (channel as any).handleMessageEvent({
      message: {
        message_id: 'om_ack_create_fail',
        chat_id: 'oc_ack_create_fail',
        chat_type: 'p2p',
        content: JSON.stringify({ text: 'hello' }),
        message_type: 'text',
      },
      sender: { sender_id: { open_id: 'ou_ack_create_fail' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    assert.equal(delivered, 1);
    assert.equal(channel.getAckReactions().activeCount, 0);
    assert.equal(channel.getAckReactions().pendingCount, 0);
  } finally {
    (appConfig as { allowedUserIds: string[] }).allowedUserIds = originalAllowedUserIds;
    (appConfig as { allowedChatIds: string[] }).allowedChatIds = originalAllowedChatIds;
  }
}

// 7. A partial multi-chunk reply still revokes ack after the first visible send.
{
  const originalLimit = appConfig.textChunkLimit;
  (appConfig as { textChunkLimit: number }).textChunkLimit = 5;
  try {
    const calls: any[] = [];
    const ackReactions = new AckReactionTracker({ maxTrackedMessages: 10 });
    ackReactions.recordInbound('om_partial_reply');
    ackReactions.storeReaction('om_partial_reply', 'reaction_partial_reply');
    const client = {
      im: {
        v1: {
          message: {
            reply: async (args: any) => {
              calls.push({ method: 'message.reply', args });
              return { data: { message_id: 'om_first_visible_reply' } };
            },
            create: async (args: any) => {
              calls.push({ method: 'message.create', args });
              throw new Error('simulated follow-up failure');
            },
          },
          messageReaction: {
            delete: async (args: any) => {
              calls.push({ method: 'reaction.delete', args });
              return {};
            },
          },
        },
      },
    };
    await assert.rejects(
      sendFeishuReply(
        { client: client as any, ackReactions },
        {
          chat_id: 'oc_partial_reply',
          reply_to: 'om_partial_reply',
          text: 'abcdefghijklmno',
        },
      ),
      /simulated follow-up failure/,
    );
    await flushMicrotasks();
    assert.equal(calls.filter((c) => c.method === 'message.reply').length, 1);
    assert.equal(calls.filter((c) => c.method === 'message.create').length, 1);
    assert.equal(calls.filter((c) => c.method === 'reaction.delete').length, 1);
    assert.equal(ackReactions.activeCount, 0);
  } finally {
    (appConfig as { textChunkLimit: number }).textChunkLimit = originalLimit;
  }
}

// 8. react is a non-text satisfier and revokes the inbound ack on success.
{
  const calls: any[] = [];
  const ackReactions = new AckReactionTracker({ maxTrackedMessages: 10 });
  ackReactions.recordInbound('om_react');
  ackReactions.storeReaction('om_react', 'reaction_ack_react');
  const client = {
    im: {
      v1: {
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
  };
  const react = makeTools(client, ackReactions).get('react');
  assert.ok(react);
  await react({ message_id: 'om_react', emoji: 'OK' });
  await flushMicrotasks();
  assert.equal(calls.filter((c) => c.method === 'reaction.create').length, 1);
  assert.equal(calls.filter((c) => c.method === 'reaction.delete').length, 1);
  assert.equal(ackReactions.activeCount, 0);
}

// 9. download_attachment is also a non-text satisfier on successful write.
{
  const tmpInbox = mkdtempSync(join(tmpdir(), 'ack-download-'));
  const originalInboxDir = appConfig.inboxDir;
  (appConfig as { inboxDir: string }).inboxDir = tmpInbox;
  try {
    const calls: any[] = [];
    const ackReactions = new AckReactionTracker({ maxTrackedMessages: 10 });
    ackReactions.recordInbound('om_download');
    ackReactions.storeReaction('om_download', 'reaction_ack_download');
    const client = {
      im: {
        v1: {
          messageReaction: {
            create: async () => ({}),
            delete: async (args: any) => {
              calls.push({ method: 'reaction.delete', args });
              return {};
            },
          },
          messageResource: {
            get: async () => Buffer.from('downloaded'),
          },
        },
      },
    };
    const download = makeTools(client, ackReactions).get('download_attachment');
    assert.ok(download);
    const result = await download({
      message_id: 'om_download',
      file_key: 'file_ack',
      file_name: 'ack.txt',
    });
    await flushMicrotasks();
    assert.equal(result.isError, undefined);
    assert.equal(calls.filter((c) => c.method === 'reaction.delete').length, 1);
    assert.equal(ackReactions.activeCount, 0);
  } finally {
    (appConfig as { inboxDir: string }).inboxDir = originalInboxDir;
    rmSync(tmpInbox, { recursive: true, force: true });
  }
}

console.log('PASS');
