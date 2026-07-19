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
  durableRunRuntime: Pick<DurableRunRuntime, 'start' | 'stop'> | null;
  cronAdmission: CronRunAdmission | null;
  onSchedulerReady?: (scheduler: Pick<JobScheduler, 'runJobNow'>) => void;
  schedulerFactory?: (admission: CronRunAdmission) => SchedulerHandle;
}

export interface ChannelServicesStarter {
  (): Promise<void>;
  stop(): Promise<void>;
}

interface SchedulerHandle extends Pick<JobScheduler, 'start' | 'runJobNow'> {
  stop(): void | Promise<void>;
}

type ActiveScheduler = Pick<SchedulerHandle, 'stop' | 'runJobNow'>;

export function createChannelServicesStarter(options: ChannelServicesOptions): ChannelServicesStarter {
  let channelServicesStart: Promise<void> | null = null;
  let activeScheduler: ActiveScheduler | null = null;
  let stopping = false;
  const starter = (() => {
    if (stopping) return Promise.resolve();
    if (channelServicesStart) return channelServicesStart;
    const attempt = startChannelServices(options).then(async (scheduler) => {
      if (stopping && scheduler && options.durableRunRuntime) {
        await scheduler.stop();
        await options.durableRunRuntime.stop();
        return;
      }
      activeScheduler = scheduler;
    });
    const tracked = attempt.catch((error) => {
      if (channelServicesStart === tracked) channelServicesStart = null;
      throw error;
    });
    channelServicesStart = tracked;
    return tracked;
  }) as ChannelServicesStarter;
  starter.stop = async () => {
    stopping = true;
    await channelServicesStart?.catch(() => undefined);
    const scheduler = activeScheduler;
    activeScheduler = null;
    await scheduler?.stop();
    if (scheduler && options.durableRunRuntime) await options.durableRunRuntime.stop();
  };
  return starter;
}

async function startChannelServices(options: ChannelServicesOptions): Promise<ActiveScheduler | null> {
  await options.buffer.rearmFromDisk();
  if (!options.durableRunRuntime || !options.cronAdmission) {
    console.error('[scheduler] Durable Run persistence unavailable; Cron scheduler was not started.');
    console.error('[index] codex-lark-plugin channel services started without durable background runs');
    return null;
  }

  const scheduler = options.schedulerFactory?.(options.cronAdmission)
    ?? new JobScheduler({ admission: options.cronAdmission });
  let workerStartAttempted = false;
  try {
    await scheduler.start();
    workerStartAttempted = true;
    options.durableRunRuntime.start();
    options.onSchedulerReady?.(scheduler);
  } catch (error) {
    await scheduler.stop();
    if (workerStartAttempted) await options.durableRunRuntime.stop();
    throw error;
  }
  console.error('[index] codex-lark-plugin channel services started');
  return scheduler;
}
