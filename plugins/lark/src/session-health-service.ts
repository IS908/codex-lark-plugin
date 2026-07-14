import type { AckReactionTracker } from './ack-reactions.js';
import { appConfig } from './config.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import {
  buildSessionHealthNudgeText,
  sendSessionHealthOwnerDm,
  SessionHealthMonitor,
} from './session-health.js';
import type { TurnObligationTracker } from './turn-obligation.js';

export interface SessionHealthChannelPorts {
  isIdle(): boolean;
  getAckReactions(): AckReactionTracker;
  getLarkTransport(): LarkTransport;
}

export function createConfiguredSessionHealthMonitor(
  channel: SessionHealthChannelPorts,
  turnObligations: TurnObligationTracker,
): SessionHealthMonitor | null {
  const sessionHealthMonitor =
    appConfig.sessionHealthEnabled && appConfig.ownerOpenId
      ? new SessionHealthMonitor({
          enabled: appConfig.codexExecUseSessions,
          ownerOpenId: appConfig.ownerOpenId,
          turnThreshold: appConfig.sessionHealthTurnThreshold,
          promptBytesThreshold: appConfig.sessionHealthPromptBytesThreshold,
          tokenUsageThreshold: appConfig.sessionHealthTokenThreshold,
          quietDelayMs: appConfig.sessionHealthIdleDelayMs,
          baseCooldownMs: appConfig.sessionHealthCooldownMs,
          maxCooldownMs: appConfig.sessionHealthMaxCooldownMs,
          maxNudges: appConfig.sessionHealthMaxNudges,
          quiet: () => ({
            queueIdle: channel.isIdle(),
            ackQuiet:
              channel.getAckReactions().activeCount === 0 &&
              channel.getAckReactions().pendingCount === 0,
            turnQuiet: turnObligations.pendingCount() === 0,
          }),
          notifyOwner: async (nudge) => {
            await sendSessionHealthOwnerDm(
              channel.getLarkTransport(),
              appConfig.ownerOpenId!,
              buildSessionHealthNudgeText(nudge),
            );
          },
        })
      : null;
  if (appConfig.sessionHealthEnabled && !appConfig.ownerOpenId) {
    console.error('[session-health] disabled: LARK_OWNER_OPEN_ID is required');
  } else if (appConfig.sessionHealthEnabled && !appConfig.codexExecUseSessions) {
    console.error('[session-health] disabled: LARK_CODEX_EXEC_USE_SESSIONS=false');
  }
  return sessionHealthMonitor;
}
