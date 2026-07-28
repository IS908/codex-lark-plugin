import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  formatConfigureDoctorReport,
  runConfigureDoctor,
  type ConfigureDoctorRemoteProbe,
} from './configure-doctor.js';

const silentLogger: Lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

const remoteProbe: ConfigureDoctorRemoteProbe = async ({ appId, appSecret }) => {
  const client = new Lark.Client({
    appId,
    appSecret,
    logger: silentLogger,
    loggerLevel: Lark.LoggerLevel.error,
    source: 'codex-lark-plugin-doctor',
  });
  const [scopeResponse, applicationResponse] = await Promise.all([
    client.application.scope.list({}),
    client.application.application.get({
      params: { lang: 'en_us' },
      path: { app_id: appId },
    }),
  ]);
  assertApiSuccess(scopeResponse);
  assertApiSuccess(applicationResponse);

  const app = applicationResponse.data?.app;
  return {
    appName: app?.app_name,
    appStatus: app?.status,
    callbackType: app?.callback_info?.callback_type,
    grantedScopes: (scopeResponse.data?.scopes ?? [])
      .filter((scope) => scope.grant_status === 1 && scope.scope_type === 'tenant')
      .map((scope) => scope.scope_name),
    ...(app?.event?.subscribed_events
      ? { subscribedEvents: app.event.subscribed_events }
      : {}),
  };
};

function assertApiSuccess(response: { code?: number; msg?: string }): void {
  if ((response.code ?? 0) === 0) return;
  throw Object.assign(new Error('Lark API request failed.'), { code: response.code });
}

const report = await runConfigureDoctor({
  configPath: path.join(os.homedir(), '.codex', 'channels', 'lark', '.env'),
  remoteProbe,
});
process.stderr.write(`${formatConfigureDoctorReport(report)}\n`);
process.exitCode = report.exitCode;
