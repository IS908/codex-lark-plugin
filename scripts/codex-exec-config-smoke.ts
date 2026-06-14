import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const {
  collectCodexExecConfigDiagnostics,
} = await import('../src/codex-exec-config.js');

const root = mkdtempSync(join(tmpdir(), 'codex-exec-config-'));
try {
  const riskyCwd = join(root, 'repo');
  mkdirSync(riskyCwd, { recursive: true });
  writeFileSync(
    join(riskyCwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        lark: {
          command: 'npm',
          args: ['run', '--silent', 'start'],
          cwd: '.',
        },
      },
    }),
    'utf-8',
  );

  const safeCwd = join(root, 'safe');
  mkdirSync(safeCwd, { recursive: true });
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      '[profiles.lark_bridge]',
      'model = "gpt-5"',
      '',
      '[profiles.lark_bridge.mcp_servers.lark]',
      'command = "npm"',
      'args = ["run", "--silent", "start"]',
    ].join('\n'),
    'utf-8',
  );

  const cwdDiagnostics = await collectCodexExecConfigDiagnostics({
    codexExecCwd: riskyCwd,
    codexExecProfile: null,
    codexExecIgnoreUserConfig: true,
    codexHome,
  });
  assert.equal(cwdDiagnostics.length, 1);
  assert.equal(cwdDiagnostics[0].code, 'codex_exec_cwd_lark_mcp');
  assert.match(cwdDiagnostics[0].message, /recursive/i);

  const profileDiagnostics = await collectCodexExecConfigDiagnostics({
    codexExecCwd: safeCwd,
    codexExecProfile: 'lark_bridge',
    codexExecIgnoreUserConfig: true,
    codexHome,
  });
  assert.equal(profileDiagnostics.length, 1);
  assert.equal(profileDiagnostics[0].code, 'codex_exec_profile_lark_mcp');
  assert.match(profileDiagnostics[0].message, /profile/i);

  const safeDiagnostics = await collectCodexExecConfigDiagnostics({
    codexExecCwd: safeCwd,
    codexExecProfile: null,
    codexExecIgnoreUserConfig: true,
    codexHome: join(root, 'empty-codex-home'),
  });
  assert.deepEqual(safeDiagnostics, []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('codex-exec-config smoke: PASS');
