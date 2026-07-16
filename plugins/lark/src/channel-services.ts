import type * as Lark from '@larksuiteoapi/node-sdk';
import type { CodexExecActionDispatcher } from './codex-exec-actions.js';
import { deliverMessageViaCodexExec } from './codex-exec-delivery.js';
import type { CodexDeliverySessionHealth } from './codex-delivery-wiring.js';
import {
  createReplySender,
  recordAssistantMessage,
} from './codex-delivery-wiring.js';
import type { CodexExecSessionStore } from './codex-session-store.js';
import type { IdentitySession } from './identity-session.js';
import type { LarkMessage } from './lark-message.js';
import type { LarkTransport } from './lark-transport-contracts.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker } from './message-trackers.js';
import { JobScheduler } from './scheduler.js';
import type { TurnObligationTracker } from './turn-obligation.js';

export interface ChannelServicesPorts {
  getClient(): Lark.Client;
  getLarkTransport(): LarkTransport;
  getBotMessageTracker(): BotMessageTracker;
  getLatestMessageTracker(): LatestMessageTracker;
}

export interface ChannelServicesOptions {
  channel: ChannelServicesPorts;
  buffer: ConversationBuffer;
  identitySession: IdentitySession;
  sessionStore: CodexExecSessionStore;
  sessionHealth: CodexDeliverySessionHealth | null;
  turnObligations: TurnObligationTracker;
  actionDispatcher: CodexExecActionDispatcher | null;
}

export function createChannelServicesStarter(options: ChannelServicesOptions): () => Promise<void> {
  let channelServicesStart: Promise<void> | null = null;
  return () => {
    if (channelServicesStart) return channelServicesStart;
    channelServicesStart = startChannelServices(options);
    return channelServicesStart;
  };
}

async function startChannelServices(options: ChannelServicesOptions): Promise<void> {
  const {
    channel,
    buffer,
    identitySession,
    sessionStore,
    sessionHealth,
    turnObligations,
    actionDispatcher,
  } = options;

  await buffer.rearmFromDisk();
  const sendReplyViaFeishu = createReplySender({
    client: () => channel.getClient(),
    transport: () => channel.getLarkTransport(),
    conversationBuffer: buffer,
    botMessageTracker: channel.getBotMessageTracker(),
    latestMessageTracker: channel.getLatestMessageTracker(),
    turnObligations,
  });

  const scheduler = new JobScheduler({
    client: channel.getClient(),
    transport: channel.getLarkTransport(),
    identitySession,
    botMessageTracker: channel.getBotMessageTracker(),
    promptRunner: async ({ job, jobThreadId, promptContent, diagnostics, runId }) => {
      let deliveredReport = '';
      let lifecycleGuardReason: string | null = null;
      const message: LarkMessage = {
        messageId: jobThreadId,
        chatId: job.meta.target_chat_id,
        chatType: 'cronjob',
        senderId: job.meta.created_by,
        senderName: `CronJob ${job.meta.name}`,
        text: promptContent,
        messageType: 'cronjob',
        rawContent: promptContent,
        threadId: jobThreadId,
      };
      await deliverMessageViaCodexExec({
        message,
        displayLabel: `CronJob · ${job.meta.name}`,
        sessionStore,
        traceLogId: job.meta.id,
        traceRunId: runId,
        sendReply: async (request) => {
          diagnostics.startStage('send_lark');
          try {
            const result = await sendReplyViaFeishu({ ...request, reply_to: undefined });
            if (result.isError) throw new Error(result.errorText ?? result.statusText);
            if (result.sentCount > 0) deliveredReport = request.text;
            diagnostics.completeStage('send_lark');
            return result;
          } catch (err) {
            diagnostics.failStage('send_lark', err);
            throw err;
          }
        },
        recordAssistantMessage: (message) => recordAssistantMessage(buffer, message),
        sessionHealth: sessionHealth ?? undefined,
        actionDispatcher: actionDispatcher ?? undefined,
        progressVisible: false,
        onProgress: (event) => {
          diagnostics.recordProgress(event.content, event.timestampMs, event.bytes);
        },
        onLifecycleGuard: (reason) => {
          lifecycleGuardReason = reason;
        },
      });
      return {
        report: deliveredReport,
        ...(lifecycleGuardReason
          ? {
              runStatus: 'failed' as const,
              failureReason: `Lifecycle guard blocked output: ${lifecycleGuardReason}`,
            }
          : {}),
      };
    },
  });
  await scheduler.start();
  console.error('[index] codex-lark-plugin channel services started');
}
