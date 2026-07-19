import type * as Lark from '@larksuiteoapi/node-sdk';
import type { LarkTransport } from './lark-transport-contracts.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker } from './message-trackers.js';
import { JobScheduler } from './scheduler.js';
import type { CronRunAdmission } from './cron/run-admission.js';
import type { DurableRunRuntime } from './durable-run/runtime.js';

export interface ChannelServicesPorts {
  getClient(): Lark.Client;
  getLarkTransport(): LarkTransport;
  getBotMessageTracker(): BotMessageTracker;
  getLatestMessageTracker(): LatestMessageTracker;
}

export interface ChannelServicesOptions {
  channel: ChannelServicesPorts;
  buffer: ConversationBuffer;
  durableRunRuntime: DurableRunRuntime | null;
  cronAdmission: CronRunAdmission | null;
  onSchedulerReady?: (scheduler: Pick<JobScheduler, 'runJobNow'>) => void;
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
  await options.buffer.rearmFromDisk();
  if (!options.durableRunRuntime || !options.cronAdmission) {
    console.error('[scheduler] Durable Run persistence unavailable; Cron scheduler was not started.');
    console.error('[index] codex-lark-plugin channel services started without durable background runs');
    return;
  }

  const scheduler = new JobScheduler({ admission: options.cronAdmission });
  options.onSchedulerReady?.(scheduler);
  options.durableRunRuntime.start();
  try {
    await scheduler.start();
  } catch (error) {
    await options.durableRunRuntime.stop();
    throw error;
  }
  console.error('[index] codex-lark-plugin channel services started');
}
