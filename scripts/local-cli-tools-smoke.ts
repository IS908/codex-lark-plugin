import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { registerLocalCliTools } = await import('../src/local-cli-tools.js');
const { IdentitySession, SYSTEM_FLUSH_CALLER } = await import('../src/identity-session.js');
const { appConfig } = await import('../src/config.js');
const { accessControlStore } = await import('../src/runtime-access-control.js');

const tmpDir = mkdtempSync(join(tmpdir(), 'local-cli-tools-'));
const configPath = join(tmpDir, 'local-cli-tools.json');
const auditPath = join(tmpDir, 'audit.log');
const helperPath = join(tmpDir, 'helper.js');

writeFileSync(
  helperPath,
  [
    'const args = process.argv.slice(2);',
    'if (args.includes("--sleep")) setTimeout(() => {}, 1000);',
    'else if (args[0] === "--print-env") console.log(`${args[1]}=${process.env[args[1]] ?? "<missing>"}`);',
    'else if (args[0] === "--has-env") console.log(`env-present=${process.env[args[1]] === undefined ? "no" : "yes"}`);',
    'else {',
    '  console.log(args.join("|"));',
    '  console.error("stderr token=should-hide");',
    '}',
  ].join('\n'),
);
chmodSync(helperPath, 0o755);

const originalConfigPath = appConfig.localCliToolsConfigPath;
const originalAuditLog = appConfig.auditLogPath;
const originalOwner = appConfig.ownerOpenId;
const originalAccessControl = accessControlStore.snapshot();

(appConfig as { localCliToolsConfigPath: string }).localCliToolsConfigPath = configPath;
(appConfig as { auditLogPath: string }).auditLogPath = auditPath;
(appConfig as { ownerOpenId: string | null }).ownerOpenId = 'ou_owner';
accessControlStore.replaceForTest({ allowed_user_ids: ['ou_allowed'] });

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};
const identity = new IdentitySession(() => 'ou_owner');
identity.setCaller('chat_owner', 'thread_owner', 'ou_owner');
identity.setCaller('chat_allowed', 'thread_allowed', 'ou_allowed');
identity.setCaller('chat_other', 'thread_other', 'ou_other');
identity.setCaller('chat_flush', 'thread_flush', SYSTEM_FLUSH_CALLER);

function writeConfig(config: unknown): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function text(result: any): string {
  return result.content?.[0]?.text ?? '';
}

try {
  registerLocalCliTools({
    server: fakeServer as any,
    identitySession: identity,
  });
  const run = handlers.get('run_local_cli_tool');
  assert.ok(run, 'run_local_cli_tool registered');

  // 1. Configs must choose exactly one parameter filtering mode.
  writeConfig({
    tools: {
      bad: {
        command: process.execPath,
        paramAllowlist: ['--title'],
        paramBlocklist: ['--token'],
        allowedCallers: 'owners',
      },
    },
  });
  {
    const result = await run!({ tool: 'bad', args: [], chat_id: 'chat_owner', thread_id: 'thread_owner' });
    assert.equal(result.isError, true);
    assert.match(text(result), /exactly one/);
  }

  // 2. Caller identity is resolved server-side and owner-only tools deny other users.
  writeConfig({
    tools: {
      owner_echo: {
        command: process.execPath,
        fixedArgs: [helperPath],
        allowedSubcommands: ['doc'],
        paramBlocklist: ['--token'],
        allowedCallers: 'owners',
      },
      public_echo: {
        command: process.execPath,
        fixedArgs: [helperPath],
        paramBlocklist: ['--token'],
        allowedCallers: 'public',
      },
    },
  });
  {
    const denied = await run!({
      tool: 'owner_echo',
      args: ['doc'],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /not authorized/);

    const ok = await run!({
      tool: 'owner_echo',
      args: ['doc', '--title', 'hello; echo hacked'],
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    assert.equal(ok.isError, undefined);
    assert.match(text(ok), /hello; echo hacked/);
    assert.doesNotMatch(text(ok), /\nhacked\n/);
  }

  // 3. Prototype property tool names are treated as unconfigured, not executable configs.
  {
    const denied = await run!({
      tool: 'toString',
      args: [],
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /not configured/);
  }

  // 4. System flush identity cannot execute local CLI tools, even public ones.
  {
    const denied = await run!({
      tool: 'public_echo',
      args: ['doc'],
      chat_id: 'chat_flush',
      thread_id: 'thread_flush',
    });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /System flush identity/);
  }

  // 5. Blocklisted params are denied before execution.
  {
    const blocked = await run!({
      tool: 'owner_echo',
      args: ['doc', '--token', 'abc123'],
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /blocked parameter/);
    assert.doesNotMatch(text(blocked), /abc123/);
  }

  // 6. Allowlist mode permits configured flags and rejects raw positionals.
  writeConfig({
    tools: {
      strict_doc: {
        command: process.execPath,
        fixedArgs: [helperPath, 'doc', 'create'],
        paramAllowlist: ['--title', '--content'],
        allowedCallers: 'lark_allowed_user_ids',
      },
    },
  });
  {
    const ok = await run!({
      tool: 'strict_doc',
      args: ['--title', 'Release notes', '--content=done'],
      chat_id: 'chat_allowed',
      thread_id: 'thread_allowed',
    });
    assert.equal(ok.isError, undefined);
    assert.match(text(ok), /Release notes/);

    const denied = await run!({
      tool: 'strict_doc',
      args: ['raw-position'],
      chat_id: 'chat_allowed',
      thread_id: 'thread_allowed',
    });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /positional argument/);
  }

  // 7. Time and output are bounded; secrets in output are redacted.
  writeConfig({
    tools: {
      bounded: {
        command: process.execPath,
        fixedArgs: [helperPath],
        paramBlocklist: ['--token'],
        allowedCallers: 'public',
        timeoutMs: 20,
        maxOutputBytes: 40,
      },
    },
  });
  {
    const timeout = await run!({
      tool: 'bounded',
      args: ['--sleep'],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(timeout.isError, true);
    assert.match(text(timeout), /timedOut/);

    const capped = await run!({
      tool: 'bounded',
      args: ['doc', '--title', 'x'.repeat(200)],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.match(text(capped), /truncated/);
    assert.doesNotMatch(text(capped), /should-hide/);
  }

  // 8. Local CLI tools do not inherit plugin secrets by default; env must be explicit.
  process.env.LARK_APP_SECRET = 'super-secret-for-env-test';
  writeConfig({
    tools: {
      env_default: {
        command: process.execPath,
        fixedArgs: [helperPath],
        paramBlocklist: ['--token'],
        allowedCallers: 'public',
      },
      env_allowlisted: {
        command: process.execPath,
        fixedArgs: [helperPath],
        paramBlocklist: ['--token'],
        allowedCallers: 'public',
        envAllowlist: ['LARK_APP_SECRET'],
      },
      env_literal: {
        command: process.execPath,
        fixedArgs: [helperPath],
        paramBlocklist: ['--token'],
        allowedCallers: 'public',
        env: { CUSTOM_SAFE: 'ok' },
      },
    },
  });
  {
    const hidden = await run!({
      tool: 'env_default',
      args: ['--has-env', 'LARK_APP_SECRET'],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(hidden.isError, undefined);
    assert.match(text(hidden), /env-present=no/);
    assert.doesNotMatch(text(hidden), /super-secret-for-env-test/);

    const allowlisted = await run!({
      tool: 'env_allowlisted',
      args: ['--has-env', 'LARK_APP_SECRET'],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(allowlisted.isError, undefined);
    assert.match(text(allowlisted), /env-present=yes/);

    const literal = await run!({
      tool: 'env_literal',
      args: ['--print-env', 'CUSTOM_SAFE'],
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(literal.isError, undefined);
    assert.match(text(literal), /CUSTOM_SAFE=ok/);
  }

  const audit = readFileSync(auditPath, 'utf-8');
  assert.match(audit, /run_local_cli_tool/);
  assert.match(audit, /denied/);
  assert.match(audit, /ok|error/);
} finally {
  (appConfig as { localCliToolsConfigPath: string }).localCliToolsConfigPath = originalConfigPath;
  (appConfig as { auditLogPath: string }).auditLogPath = originalAuditLog;
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = originalOwner;
  accessControlStore.replaceForTest(originalAccessControl);
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log('local-cli-tools smoke: PASS');
