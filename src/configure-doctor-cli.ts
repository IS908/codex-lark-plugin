import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import { parse } from 'dotenv';
import { readConfigValues } from './config-schema.js';
import { assertSupportedNodeVersion } from './runtime-version.js';
import {
  formatConfigureDoctorReport,
  runConfigureDoctor,
  type ConfigureDoctorRemoteProbe,
} from './configure-doctor.js';
import { formatWorkspaceStorage, inventoryWorkspaceStorage } from './workspace-storage.js';

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

async function main(args: string[]): Promise<void> {
  const configPath = path.join(os.homedir(), '.codex', 'channels', 'lark', '.env');
  if (args.length === 0) {
    const report = await runConfigureDoctor({ configPath, remoteProbe });
    process.stderr.write(`${formatConfigureDoctorReport(report)}\n`);
    process.exitCode = report.exitCode;
    return;
  }
  if (!args.includes('--workspace-storage') || args.some((arg) =>
    arg !== '--workspace-storage' && arg !== '--json')) {
    process.stderr.write('Usage: npm run doctor -- [--workspace-storage [--json]]\n');
    process.exitCode = 1;
    return;
  }

  try {
    assertSupportedNodeVersion();
    const file = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const fileEnv = parse(file);
    const config = readConfigValues({
      env: {
        LARK_CODEX_EXEC_CWD: process.env.LARK_CODEX_EXEC_CWD ?? fileEnv.LARK_CODEX_EXEC_CWD,
        LARK_CONTINUATION_WORKING_ROOT: process.env.LARK_CONTINUATION_WORKING_ROOT
          ?? fileEnv.LARK_CONTINUATION_WORKING_ROOT,
      },
      dryRun: true,
    });
    const roots = await inventoryWorkspaceStorage([
      { role: 'exec', directory: config.LARK_CODEX_EXEC_CWD },
      { role: 'continuation', directory: config.LARK_CONTINUATION_WORKING_ROOT },
    ]);
    process.stdout.write(`${args.includes('--json')
      ? JSON.stringify({ readOnly: true, roots }, null, 2)
      : formatWorkspaceStorage(roots)}\n`);
    process.exitCode = roots.every(({ status }) => status === 'complete') ? 0 : 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`Workspace storage inventory failed: ${detail}\n`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
