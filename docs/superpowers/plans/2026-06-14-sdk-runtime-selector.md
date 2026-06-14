# SDK Runtime Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first disabled-by-default SDK-backed channel scaffold for the 1.2.0 migration without changing the live legacy runtime.

**Architecture:** Add `LARK_CHANNEL_RUNTIME=legacy|sdk` with `legacy` as the default. The SDK path validates `@larksuite/channel` construction during dry-run, but live startup fails closed until identity/security and message-delivery parity land in later issues.

**Tech Stack:** TypeScript ESM, `@larksuite/channel`, existing smoke-test scripts via `node --import tsx`, npm lockfiles for the root package and `plugins/lark`.

---

## File Structure

- Modify `src/config.ts` and `plugins/lark/src/config.ts`: add `channelRuntime` from `LARK_CHANNEL_RUNTIME`.
- Create `src/sdk-channel-scaffold.ts` and `plugins/lark/src/sdk-channel-scaffold.ts`: construct the SDK channel with stderr-only logging and expose dry-run validation.
- Modify `src/index.ts` and `plugins/lark/src/index.ts`: validate SDK dry-run and fail closed for live SDK runtime.
- Create `scripts/sdk-channel-scaffold-smoke.ts`: smoke tests for runtime selection, dry-run validation, and live fail-closed behavior.
- Modify `scripts/config-validation-smoke.ts`: cover default and invalid runtime config.
- Modify `scripts/test.sh`: run the new scaffold smoke.
- Modify `package.json`, `package-lock.json`, `plugins/lark/package.json`, and `plugins/lark/package-lock.json`: add `@larksuite/channel`.

## Task 1: Runtime Selector Red Test

- [ ] **Step 1: Extend config smoke before production code**

Add assertions to `scripts/config-validation-smoke.ts`:

```ts
const defaultPaths = expectOk({});
assert.equal(defaultPaths.channelRuntime, 'legacy');

const sdkRuntime = expectOk({ LARK_CHANNEL_RUNTIME: 'sdk' });
assert.equal(sdkRuntime.channelRuntime, 'sdk');

expectFail({ LARK_CHANNEL_RUNTIME: 'claude' }, /LARK_CHANNEL_RUNTIME.*legacy, sdk/i);
```

Also include `channelRuntime: appConfig.channelRuntime` in the JSON printed by the test helper.

- [ ] **Step 2: Verify red**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run typecheck
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node --import tsx scripts/config-validation-smoke.ts
```

Expected: the config smoke fails because `appConfig.channelRuntime` does not exist.

- [ ] **Step 3: Implement the selector**

Add to both config files:

```ts
channelRuntime: optionalChoice(
  'LARK_CHANNEL_RUNTIME',
  'legacy',
  ['legacy', 'sdk'] as const,
),
```

- [ ] **Step 4: Verify green for config**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run typecheck
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm test
```

Expected: typecheck and config smoke pass.

## Task 2: SDK Scaffold Red Test

- [ ] **Step 1: Add scaffold smoke before production code**

Create `scripts/sdk-channel-scaffold-smoke.ts`:

```ts
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

const legacyDryRun = runStart({});
assert.equal(legacyDryRun.status, 0, legacyDryRun.stderr + legacyDryRun.stdout);
assert.equal(legacyDryRun.stdout, '');
assert.match(legacyDryRun.stderr, /\[dry-run\] Channel runtime: legacy/);

const sdkDryRun = runStart({ LARK_CHANNEL_RUNTIME: 'sdk' });
assert.equal(sdkDryRun.status, 0, sdkDryRun.stderr + sdkDryRun.stdout);
assert.equal(sdkDryRun.stdout, '');
assert.match(sdkDryRun.stderr, /\[dry-run\] Channel runtime: sdk/);
assert.match(sdkDryRun.stderr, /\[sdk-channel\] SDK scaffold validated/);

const sdkLive = runStart({ LARK_CHANNEL_RUNTIME: 'sdk' }, []);
assert.notEqual(sdkLive.status, 0, 'live SDK runtime must fail closed');
assert.equal(sdkLive.stdout, '');
assert.match(sdkLive.stderr, /SDK-backed channel runtime is dry-run only/i);

console.log('sdk-channel-scaffold smoke: PASS');
```

Add it to `scripts/test.sh` after the dry-run stdout check:

```bash
echo ""
echo "=== SDK channel scaffold checks ==="
node --import tsx scripts/sdk-channel-scaffold-smoke.ts
```

- [ ] **Step 2: Verify red**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm test
```

Expected: the new smoke fails because the dry-run runtime logs and SDK scaffold module do not exist.

- [ ] **Step 3: Implement scaffold**

Create `src/sdk-channel-scaffold.ts` and mirror it to `plugins/lark/src/sdk-channel-scaffold.ts`:

```ts
import { createLarkChannel } from '@larksuite/channel';
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

export function createSdkChannelScaffold() {
  return createLarkChannel({
    appId: appConfig.appId,
    appSecret: appConfig.appSecret,
    transport: 'websocket',
    logger: makeSdkChannelLogger('lark-channel-sdk'),
    loggerLevel: LoggerLevel.info,
    source: 'codex-lark-plugin',
  });
}

export function validateSdkChannelScaffold(): void {
  const channel = createSdkChannelScaffold();
  void channel;
  console.error('[sdk-channel] SDK scaffold validated.');
}
```

Modify both `src/index.ts` files so dry-run logs the selected runtime, SDK dry-run validates the scaffold, and live SDK runtime throws before connecting stdio or Lark:

```ts
import { validateSdkChannelScaffold } from './sdk-channel-scaffold.js';

if (isDryRun) {
  console.error(`[dry-run] Channel runtime: ${appConfig.channelRuntime}`);
  if (appConfig.channelRuntime === 'sdk') validateSdkChannelScaffold();
  console.error('[dry-run] All modules loaded successfully.');
  console.error('[dry-run] Tools registered. Exiting.');
  process.exit(0);
}

if (appConfig.channelRuntime === 'sdk') {
  throw new Error('SDK-backed channel runtime is dry-run only until #62 and #65 preserve identity and message parity.');
}
```

- [ ] **Step 4: Add dependency and verify green**

Run for root and plugin package:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm install @larksuite/channel@^0.1.2 --package-lock-only
cd plugins/lark && PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm install @larksuite/channel@^0.1.2 --package-lock-only
```

Then run:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run typecheck
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm test
```

Expected: all checks pass, SDK dry-run prints scaffold validation to stderr only, and live SDK startup fails closed.

## Task 3: PR Review

- [ ] **Step 1: Review diff**

Run:

```bash
git diff --check
git diff --stat main...HEAD
git diff main...HEAD -- src/config.ts src/index.ts src/sdk-channel-scaffold.ts scripts/config-validation-smoke.ts scripts/sdk-channel-scaffold-smoke.ts scripts/test.sh
```

Expected: no whitespace errors, no unrelated files, and no runtime behavior change for default `legacy`.

- [ ] **Step 2: Commit, push, PR**

Commit message:

```bash
git commit -m "Add SDK runtime scaffold"
```

PR title:

```text
[codex] Add SDK runtime scaffold
```

PR body must include `Closes #61` and the verification commands.
