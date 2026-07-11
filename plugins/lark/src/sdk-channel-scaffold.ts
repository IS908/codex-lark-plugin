import { createLarkChannel, type LarkChannelOptions } from '@larksuite/channel';
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { redactErrorForLog } from './safe-log.js';

function makeSdkChannelLogger(prefix: string) {
  return {
    info: (...args: any[]) => console.error(`[${prefix}]`, ...args),
    warn: (...args: any[]) => console.error(`[${prefix}][warn]`, ...args),
    error: (...args: any[]) => console.error(`[${prefix}][error]`, ...args.map(redactErrorForLog)),
    debug: (...args: any[]) => console.error(`[${prefix}][debug]`, ...args),
    trace: (...args: any[]) => console.error(`[${prefix}][trace]`, ...args),
  };
}

export function buildSdkChannelOptions(): LarkChannelOptions {
  return {
    appId: appConfig.appId,
    appSecret: appConfig.appSecret,
    transport: 'websocket',
    policy: {
      requireMention: false,
    },
    logger: makeSdkChannelLogger('lark-channel-sdk'),
    loggerLevel: LoggerLevel.info,
    includeRawEvent: true,
    source: 'codex-lark-plugin',
  };
}

export function createSdkChannelScaffold() {
  return createLarkChannel(buildSdkChannelOptions());
}

export function validateSdkChannelScaffold(): void {
  const channel = createSdkChannelScaffold();
  void channel;
  console.error('[sdk-channel] SDK scaffold validated.');
}
