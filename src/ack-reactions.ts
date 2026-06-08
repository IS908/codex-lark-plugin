import * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { feishuApiCall } from './feishu-retry.js';

export interface AckReactionDelete {
  messageId: string;
  reactionId: string;
}

export type AckReactionStoreResult =
  | { action: 'stored' }
  | { action: 'delete-now'; reaction: AckReactionDelete }
  | { action: 'ignored' };

export interface AckReactionTrackerOptions {
  recentInboundTtlMs?: number;
  pendingRevokeTtlMs?: number;
  maxTrackedMessages?: number;
}

/**
 * Tracks Feishu ack reactions as a tiny lifecycle state machine.
 *
 * Only recently observed inbound messages may create pending-revoke markers.
 * That keeps arbitrary/stale message ids from filling memory, while still
 * closing the common race where Codex satisfies a turn before Feishu returns
 * the ack reaction id.
 */
export class AckReactionTracker {
  private readonly recentInboundTtlMs: number;
  private readonly pendingRevokeTtlMs: number;
  private readonly maxTrackedMessages: number;
  private active = new Map<string, string>();
  private pendingRevokes = new Map<string, number>();
  private recentInbound = new Map<string, number>();

  constructor(opts: AckReactionTrackerOptions = {}) {
    this.recentInboundTtlMs = Math.max(1_000, opts.recentInboundTtlMs ?? 10 * 60 * 1_000);
    this.pendingRevokeTtlMs = Math.max(
      1_000,
      opts.pendingRevokeTtlMs ?? appConfig.feishuApiTimeoutMs + 5_000,
    );
    this.maxTrackedMessages = Math.max(
      0,
      Math.floor(opts.maxTrackedMessages ?? appConfig.latestMessageTrackerSize),
    );
  }

  get activeCount(): number {
    this.cleanup();
    return this.active.size;
  }

  get pendingCount(): number {
    this.cleanup();
    return this.pendingRevokes.size;
  }

  recordInbound(messageId: string, now = Date.now()): void {
    if (!messageId || this.maxTrackedMessages <= 0) return;
    this.cleanup(now);
    this.recentInbound.delete(messageId);
    this.recentInbound.set(messageId, now);
    this.trim(this.recentInbound);
  }

  hasRecentInbound(messageId: string, now = Date.now()): boolean {
    if (!messageId) return false;
    this.cleanup(now);
    return this.recentInbound.has(messageId);
  }

  storeReaction(messageId: string, reactionId: string, now = Date.now()): AckReactionStoreResult {
    if (!messageId || !reactionId) return { action: 'ignored' };
    this.cleanup(now);

    if (this.pendingRevokes.delete(messageId)) {
      this.active.delete(messageId);
      return { action: 'delete-now', reaction: { messageId, reactionId } };
    }

    if (!this.hasRecentInbound(messageId, now)) {
      return { action: 'delete-now', reaction: { messageId, reactionId } };
    }

    this.active.set(messageId, reactionId);
    return { action: 'stored' };
  }

  markSatisfied(messageId: string, now = Date.now()): AckReactionDelete | null {
    if (!messageId) return null;
    this.cleanup(now);

    const reactionId = this.active.get(messageId);
    if (reactionId) {
      this.active.delete(messageId);
      this.pendingRevokes.delete(messageId);
      return { messageId, reactionId };
    }

    if (!this.hasRecentInbound(messageId, now)) return null;
    this.pendingRevokes.set(messageId, now + this.pendingRevokeTtlMs);
    this.trim(this.pendingRevokes);
    return null;
  }

  drainActive(now = Date.now()): AckReactionDelete[] {
    this.cleanup(now);
    const reactions = Array.from(this.active.entries()).map(([messageId, reactionId]) => ({
      messageId,
      reactionId,
    }));
    this.active.clear();
    return reactions;
  }

  clear(): void {
    this.active.clear();
    this.pendingRevokes.clear();
    this.recentInbound.clear();
  }

  hasPendingRevoke(messageId: string, now = Date.now()): boolean {
    this.cleanup(now);
    return this.pendingRevokes.has(messageId);
  }

  private cleanup(now = Date.now()): void {
    for (const [messageId, timestamp] of this.recentInbound.entries()) {
      if (now - timestamp > this.recentInboundTtlMs) {
        this.recentInbound.delete(messageId);
        this.pendingRevokes.delete(messageId);
      }
    }

    for (const [messageId, expiresAt] of this.pendingRevokes.entries()) {
      if (expiresAt <= now) this.pendingRevokes.delete(messageId);
    }
  }

  private trim<T>(map: Map<string, T>): void {
    while (map.size > this.maxTrackedMessages) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) return;
      map.delete(oldest);
    }
  }
}

export function revokeAckReaction(
  client: Lark.Client,
  tracker: AckReactionTracker | undefined,
  messageId: string | undefined,
  source: string,
): void {
  const reaction = tracker?.markSatisfied(messageId ?? '');
  if (!reaction) return;
  deleteAckReaction(client, reaction, source);
}

export function revokeAllAckReactions(
  client: Lark.Client,
  tracker: AckReactionTracker | undefined,
  source: string,
): void {
  const reactions = tracker?.drainActive() ?? [];
  for (const reaction of reactions) {
    deleteAckReaction(client, reaction, source);
  }
}

export function deleteAckReaction(
  client: Lark.Client,
  reaction: AckReactionDelete,
  source: string,
): void {
  feishuApiCall(`${source}.ackReaction.delete`, () =>
    client.im.v1.messageReaction.delete({
      path: { message_id: reaction.messageId, reaction_id: reaction.reactionId },
    }),
  ).catch((err) => {
    console.error(
      `[ack-reactions] Failed to revoke ack ${reaction.reactionId} on ${reaction.messageId}:`,
      err?.message ?? String(err),
    );
  });
}
