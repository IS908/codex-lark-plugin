import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.LARK_APP_ID = process.env.LARK_APP_ID || 'cli_test_app_id';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET || 'test_app_secret';
process.env.LARK_QUOTED_CARD_USER_FETCH_ENABLED = 'true';
process.env.LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS = '1000';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-user-fetch-'));
const fakeCli = path.join(tmpDir, 'fake-lark-cli');
await fs.writeFile(fakeCli, `#!/bin/sh
if [ "$FAKE_LARK_CLI_MODE" = "slow" ]; then
  sleep 2
  printf '%s\\n' '{"messages":[],"total":0}'
  exit 0
fi
if [ "$FAKE_LARK_CLI_MODE" = "empty" ]; then
  printf '%s\\n' '{"messages":[],"total":0}'
  exit 0
fi
if [ "$FAKE_LARK_CLI_MODE" = "fail" ]; then
  echo 'token=supersecret failure' >&2
  exit 7
fi
if [ "$FAKE_LARK_CLI_MODE" = "malformed" ]; then
  printf '%s\\n' '{"messages":['
  exit 0
fi
printf '%s\\n' '{"messages":[{"message_id":"om_cli_user_card","msg_type":"interactive","content":"{\\"header\\":{\\"title\\":{\\"tag\\":\\"plain_text\\",\\"content\\":\\"CLI User Card\\"}},\\"elements\\":[{\\"tag\\":\\"div\\",\\"text\\":{\\"tag\\":\\"plain_text\\",\\"content\\":\\"Fetched by fake user cli\\"}}]}"}],"total":1}'
`);
await fs.chmod(fakeCli, 0o755);

process.env.LARK_QUOTED_CARD_USER_FETCH_COMMAND = fakeCli;

const { createLarkCliUserMessageFetcher } = await import('../src/lark-user-message-fetch.js');
const fetcher = createLarkCliUserMessageFetcher();
assert.ok(fetcher, 'fetcher should be enabled');

{
  delete process.env.FAKE_LARK_CLI_MODE;
  const result = await fetcher.fetchMessage('om_cli_user_card');
  assert.equal((result?.item as any)?.message_id, 'om_cli_user_card');
  assert.equal((result?.item as any)?.msg_type, 'interactive');
  assert.match((result?.item as any)?.content, /CLI User Card/);
}

{
  process.env.FAKE_LARK_CLI_MODE = 'empty';
  const result = await fetcher.fetchMessage('om_missing_card');
  assert.equal(result?.item, undefined);
  assert.equal(result?.fetchResult, 'empty');
  assert.equal(result?.diagnostic, 'empty_response');
}

{
  process.env.FAKE_LARK_CLI_MODE = 'slow';
  const startedAt = Date.now();
  const result = await fetcher.fetchMessage('om_slow_card');
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result?.item, undefined);
  assert.equal(result?.fetchResult, 'timeout');
  assert.equal(result?.diagnostic, 'timeout_ms=1000');
  assert.ok(elapsedMs < 1800, `timeout should return promptly, elapsed=${elapsedMs}ms`);
}

{
  process.env.FAKE_LARK_CLI_MODE = 'malformed';
  const result = await fetcher.fetchMessage('om_cli_user_card');
  assert.equal(result?.item, undefined);
  assert.equal(result?.fetchResult, 'error');
  assert.match(result?.diagnostic ?? '', /json_parse_error=/);
}

{
  process.env.FAKE_LARK_CLI_MODE = 'fail';
  const result = await fetcher.fetchMessage('om_cli_user_card');
  assert.equal(result?.item, undefined);
  assert.equal(result?.fetchResult, 'error');
  assert.match(result?.diagnostic ?? '', /exit_code=7/);
  assert.doesNotMatch(result?.diagnostic ?? '', /supersecret/);
  assert.match(result?.diagnostic ?? '', /token=\[redacted\]/);
}

{
  const unavailableCommand = path.join(tmpDir, 'missing-lark-cli');
  const code = `
    process.env.LARK_APP_ID = 'cli_test_app_id';
    process.env.LARK_APP_SECRET = 'test_app_secret';
    process.env.LARK_QUOTED_CARD_USER_FETCH_ENABLED = 'true';
    process.env.LARK_QUOTED_CARD_USER_FETCH_COMMAND = ${JSON.stringify(unavailableCommand)};
    const { createLarkCliUserMessageFetcher } = await import('./src/lark-user-message-fetch.js');
    const result = await createLarkCliUserMessageFetcher().fetchMessage('om_missing_cli');
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpDir,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.item, undefined);
  assert.equal(parsed.fetchResult, 'unavailable');
  assert.match(parsed.diagnostic, /spawn_error=ENOENT/);
}

console.log('lark-user-message-fetch smoke: PASS');
