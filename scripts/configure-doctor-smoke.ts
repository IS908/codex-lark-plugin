import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatConfigureDoctorReport,
  runConfigureDoctor,
  type ConfigureDoctorRemoteProbe,
} from '../src/configure-doctor.js';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lark-configure-doctor-'));
const configPath = path.join(tempDir, '.env');
const validSecret = 'doctor-test-secret';

await writeFile(
  configPath,
  `LARK_APP_ID=cli_doctortest\nLARK_APP_SECRET=${validSecret}\n`,
  'utf8',
);

const grantedScopes = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:send_as_bot',
  'im:resource',
  'im:message.reactions:write_only',
  'im:message.reactions:read',
  'docs:document.comment:read',
  'docs:document.comment:create',
  'drive:drive.metadata:readonly',
];

const successfulProbe: ConfigureDoctorRemoteProbe = async () => ({
  appName: 'Doctor Test Bot',
  appStatus: 0,
  callbackType: 'websocket',
  grantedScopes,
});

const success = await runConfigureDoctor({
  configPath,
  env: {},
  nodeVersion: '24.15.0',
  remoteProbe: successfulProbe,
});
assert.equal(success.exitCode, 0);
assert.equal(success.checks.some((check) => check.status === 'FAIL'), false);
assert.equal(
  success.checks.find((check) => check.id === 'event_subscriptions')?.status,
  'WARN',
);
assert.match(formatConfigureDoctorReport(success), /PASS\s+permissions/);
assert.match(formatConfigureDoctorReport(success), /WARN\s+event_subscriptions/);
assert.doesNotMatch(formatConfigureDoctorReport(success), new RegExp(validSecret));

const missingPermission = await runConfigureDoctor({
  configPath,
  env: {},
  nodeVersion: '24.15.0',
  remoteProbe: async () => ({
    appName: 'Doctor Test Bot',
    callbackType: 'websocket',
    grantedScopes: grantedScopes.filter((scope) => scope !== 'im:message:send_as_bot'),
  }),
});
assert.equal(missingPermission.exitCode, 1);
assert.match(
  missingPermission.checks.find((check) => check.id === 'permissions')?.detail ?? '',
  /im:message:send_as_bot/,
);

const secretInError = 'secret-that-must-not-leak';
const credentialFailure = await runConfigureDoctor({
  configPath,
  env: { LARK_APP_SECRET: secretInError },
  nodeVersion: '24.15.0',
  remoteProbe: async () => {
    throw Object.assign(new Error(`invalid credential ${secretInError}`), {
      code: 99991663,
      response: {
        data: {
          msg: `authorization header contains ${secretInError}`,
          tenant_access_token: secretInError,
        },
      },
    });
  },
});
const failureOutput = formatConfigureDoctorReport(credentialFailure);
assert.equal(credentialFailure.exitCode, 1);
assert.match(failureOutput, /FAIL\s+credentials/);
assert.match(failureOutput, /99991663/);
assert.doesNotMatch(failureOutput, new RegExp(secretInError));
assert.doesNotMatch(failureOutput, /tenant_access_token/i);
assert.doesNotMatch(failureOutput, /authorization header/i);

const missingConfig = await runConfigureDoctor({
  configPath: path.join(tempDir, 'missing.env'),
  env: {},
  nodeVersion: '24.15.0',
  remoteProbe: successfulProbe,
});
assert.equal(missingConfig.exitCode, 1);
assert.equal(missingConfig.checks.find((check) => check.id === 'configuration')?.status, 'FAIL');

const envOnly = await runConfigureDoctor({
  configPath: path.join(tempDir, 'missing.env'),
  env: {
    LARK_APP_ID: 'cli_environmentonly',
    LARK_APP_SECRET: 'environment-only-secret',
  },
  nodeVersion: '24.15.0',
  remoteProbe: successfulProbe,
});
assert.equal(envOnly.exitCode, 0);
assert.match(
  envOnly.checks.find((check) => check.id === 'configuration')?.detail ?? '',
  /process environment/,
);

const oldNode = await runConfigureDoctor({
  configPath,
  env: {},
  nodeVersion: '22.0.0',
  remoteProbe: successfulProbe,
});
assert.equal(oldNode.exitCode, 1);
assert.equal(oldNode.checks.find((check) => check.id === 'runtime')?.status, 'FAIL');

console.log('configure-doctor smoke: PASS');
