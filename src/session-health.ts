import * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { feishuApiCall } from './feishu-retry.js';

export type SessionHealthNudgeReason = 'turn_threshold' | 'prompt_bytes_threshold';

export interface SessionHealthQuietStatus {
  queueIdle: boolean;
  ackQuiet: boolean;
  turnQuiet: boolean;
}

export interface SessionHealthTurn {
  sessionKey: string;
  chatId: string;
  threadId?: string;
  sessionId?: string | null;
  resumed: boolean;
  promptBytes: number;
  responseBytes: number;
}

export interface SessionHealthNudge {
  sessionKey: string;
  chatId: string;
  threadId?: string;
  sessionId?: string | null;
  turnCount: number;
  promptBytes: number;
  responseBytes: number;
  reason: SessionHealthNudgeReason;
  nudgeCount: number;
  cooldownMs: number;
}

export interface SessionHealthSnapshot {
  sessionKey: string;
  chatId: string;
  threadId?: string;
  sessionId?: string | null;
  turnCount: number;
  promptBytes: number;
  responseBytes: number;
  nudgeCount: number;
  nextNudgeAt: number;
  lastResetReason?: 'session_id_changed' | 'manual';
}

export interface SessionHealthMonitorOptions {
  enabled: boolean;
  ownerOpenId: string | null | undefined;
  turnThreshold: number;
  promptBytesThreshold: number;
  quietDelayMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  maxNudges: number;
  quiet: () => SessionHealthQuietStatus;
  notifyOwner: (nudge: SessionHealthNudge) => Promise<void>;
}

interface SessionHealthState {
  sessionKey: string;
  chatId: string;
  threadId?: string;
  sessionId?: string | null;
  turnCount: number;
  promptBytes: number;
  responseBytes: number;
  nudgeCount: number;
  nextNudgeAt: number;
  lastResetReason?: 'session_id_changed' | 'manual';
}

export class SessionHealthMonitor {
  private readonly enabled: boolean;
  private readonly turnThreshold: number;
  private readonly promptBytesThreshold: number;
  private readonly quietDelayMs: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxNudges: number;
  private readonly quiet: () => SessionHealthQuietStatus;
  private readonly notifyOwner: (nudge: SessionHealthNudge) => Promise<void>;
  private readonly states = new Map<string, SessionHealthState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: SessionHealthMonitorOptions) {
    this.enabled = options.enabled && !!options.ownerOpenId;
    this.turnThreshold = Math.max(1, Math.floor(options.turnThreshold));
    this.promptBytesThreshold = Math.max(1, Math.floor(options.promptBytesThreshold));
    this.quietDelayMs = Math.max(0, Math.floor(options.quietDelayMs));
    this.baseCooldownMs = Math.max(1, Math.floor(options.baseCooldownMs));
    this.maxCooldownMs = Math.max(this.baseCooldownMs, Math.floor(options.maxCooldownMs));
    this.maxNudges = Math.max(1, Math.floor(options.maxNudges));
    this.quiet = options.quiet;
    this.notifyOwner = options.notifyOwner;
  }

  recordTurn(input: SessionHealthTurn, now = Date.now()): void {
    if (!this.enabled || !input.sessionKey) return;
    const state = this.stateFor(input);

    if (input.sessionId && state.sessionId && state.sessionId !== input.sessionId) {
      this.reset(input.sessionKey, 'session_id_changed');
    }

    const current = this.stateFor(input);
    if (input.sessionId) current.sessionId = input.sessionId;
    current.turnCount += 1;
    current.promptBytes += Math.max(0, Math.floor(input.promptBytes));
    current.responseBytes += Math.max(0, Math.floor(input.responseBytes));

    if (this.reasonFor(current)) this.scheduleQuietCheck(input.sessionKey, now);
  }

  async checkNow(sessionKey: string, now = Date.now()): Promise<boolean> {
    if (!this.enabled) return false;
    const state = this.states.get(sessionKey);
    if (!state) return false;
    const reason = this.reasonFor(state);
    if (!reason) return false;
    if (state.nudgeCount >= this.maxNudges) return false;
    if (now < state.nextNudgeAt) return false;

    const quiet = this.quiet();
    if (!quiet.queueIdle || !quiet.ackQuiet || !quiet.turnQuiet) return false;

    const cooldownMs = Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * (2 ** state.nudgeCount),
    );
    const nudge: SessionHealthNudge = {
      sessionKey: state.sessionKey,
      chatId: state.chatId,
      ...(state.threadId ? { threadId: state.threadId } : {}),
      sessionId: state.sessionId ?? null,
      turnCount: state.turnCount,
      promptBytes: state.promptBytes,
      responseBytes: state.responseBytes,
      reason,
      nudgeCount: state.nudgeCount + 1,
      cooldownMs,
    };

    await this.notifyOwner(nudge);
    state.nudgeCount += 1;
    state.nextNudgeAt = now + cooldownMs;
    return true;
  }

  reset(sessionKey: string, reason: 'session_id_changed' | 'manual' = 'manual'): void {
    const timer = this.timers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionKey);

    const existing = this.states.get(sessionKey);
    if (!existing) return;
    this.states.set(sessionKey, {
      sessionKey,
      chatId: existing.chatId,
      ...(existing.threadId ? { threadId: existing.threadId } : {}),
      turnCount: 0,
      promptBytes: 0,
      responseBytes: 0,
      nudgeCount: 0,
      nextNudgeAt: 0,
      lastResetReason: reason,
    });
  }

  getSnapshot(sessionKey: string): SessionHealthSnapshot | null {
    const state = this.states.get(sessionKey);
    if (!state) return null;
    return { ...state };
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.states.clear();
  }

  private stateFor(input: SessionHealthTurn): SessionHealthState {
    const existing = this.states.get(input.sessionKey);
    if (existing) return existing;
    const created: SessionHealthState = {
      sessionKey: input.sessionKey,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      sessionId: input.sessionId ?? null,
      turnCount: 0,
      promptBytes: 0,
      responseBytes: 0,
      nudgeCount: 0,
      nextNudgeAt: 0,
    };
    this.states.set(input.sessionKey, created);
    return created;
  }

  private reasonFor(state: SessionHealthState): SessionHealthNudgeReason | null {
    if (state.promptBytes >= this.promptBytesThreshold) return 'prompt_bytes_threshold';
    if (state.turnCount >= this.turnThreshold) return 'turn_threshold';
    return null;
  }

  private scheduleQuietCheck(sessionKey: string, now: number): void {
    if (this.quietDelayMs <= 0) {
      void this.checkNow(sessionKey, now).catch((err) => {
        console.error(`[session-health] Failed to send nudge for ${sessionKey}:`, err);
      });
      return;
    }
    if (this.timers.has(sessionKey)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionKey);
      void this.checkNow(sessionKey, now + this.quietDelayMs).catch((err) => {
        console.error(`[session-health] Failed to send nudge for ${sessionKey}:`, err);
      });
    }, this.quietDelayMs);
    timer.unref?.();
    this.timers.set(sessionKey, timer);
  }
}

export function buildSessionHealthNudgeText(nudge: SessionHealthNudge): string {
  const scope = nudge.threadId
    ? `${nudge.chatId} / ${nudge.threadId}`
    : nudge.chatId;
  const reason =
    nudge.reason === 'prompt_bytes_threshold'
      ? 'estimated prompt bytes crossed the configured threshold'
      : 'turn count crossed the configured threshold';

  return [
    '[Codex session health nudge]',
    `Scope: ${scope}`,
    nudge.sessionId ? `Session: ${nudge.sessionId}` : 'Session: unknown',
    `Reason: ${reason}`,
    `Heuristic: ${nudge.turnCount} exec turns, ${nudge.promptBytes} prompt bytes, ${nudge.responseBytes} response bytes observed by the Lark bridge.`,
    `Nudge: ${nudge.nudgeCount}; next cooldown: ${Math.round(nudge.cooldownMs / 1000)}s.`,
    '',
    'Codex exec JSON currently gives this plugin a session id but no stable token/context usage statistic, so this warning is heuristic.',
    'No automatic clear or compact was attempted. Consider finishing the thread, starting a fresh session when safe, or asking Codex to summarize durable state before continuing.',
    'For heavy multi-step work, prefer subagents where available so the main resumed session stays smaller.',
  ].join('\n');
}

export async function sendSessionHealthOwnerDm(
  client: Lark.Client,
  ownerOpenId: string,
  text: string,
): Promise<void> {
  await feishuApiCall('session_health.owner_dm', () =>
    client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: ownerOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid: randomUUID(),
      },
    }),
  );
}
