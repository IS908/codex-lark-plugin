import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runStart(extraEnv: Record<string, string>, args: string[] = ['--dry-run']) {
  const home = mkdtempSync(join(tmpdir(), 'lark-sdk-scaffold-home-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        LARK_APP_ID: 'cli_test_app_id',
        LARK_APP_SECRET: 'test_app_secret',
        ...extraEnv,
      },
      timeout: 10_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runOptions(extraEnv: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'lark-sdk-scaffold-home-'));
  try {
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          const { buildSdkChannelOptions } = await import('./src/sdk-channel-scaffold.js');
          const options = buildSdkChannelOptions();
          console.log(JSON.stringify({
            transport: options.transport,
            requireMention: options.policy?.requireMention,
            includeRawEvent: options.includeRawEvent,
            source: options.source
          }));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          LARK_APP_ID: 'cli_test_app_id',
          LARK_APP_SECRET: 'test_app_secret',
          ...extraEnv,
        },
        timeout: 10_000,
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const sdkOptions = runOptions({});
assert.equal(sdkOptions.status, 0, sdkOptions.stderr + sdkOptions.stdout);
const parsedOptions = JSON.parse(sdkOptions.stdout);
assert.equal(parsedOptions.transport, 'websocket');
assert.equal(parsedOptions.requireMention, false);
assert.equal(parsedOptions.includeRawEvent, true);
assert.equal(parsedOptions.source, 'codex-lark-plugin');

const sdkDryRun = runStart({});
assert.equal(sdkDryRun.status, 0, sdkDryRun.stderr + sdkDryRun.stdout);
assert.equal(sdkDryRun.stdout, '');
assert.match(sdkDryRun.stderr, /\[dry-run\] Channel runtime: sdk/);
assert.match(sdkDryRun.stderr, /\[sdk-channel\] SDK scaffold validated/);

console.log('sdk-channel-scaffold smoke: PASS');
