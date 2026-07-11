import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'access_control_test_app_id';
process.env.LARK_APP_SECRET ||= 'access_control_test_secret';

const { appConfig } = await import('../src/config.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { AccessControlStore, accessControlStore } = await import('../src/runtime-access-control.js');
const { registerAccessControlTools } = await import('../src/tools/access-control.js');

const root = mkdtempSync(join(tmpdir(), 'access-control-'));
const configPath = join(root, 'runtime-config', 'access-control.json');
const auditPath = join(root, 'audit.log');

const originalOwner = appConfig.ownerOpenId;
const originalAuditLog = appConfig.auditLogPath;
const originalStoreSnapshot = accessControlStore.snapshot();

try {
  const store = new AccessControlStore(configPath);

  const missing = await store.load();
  assert.equal(missing.revision, 0);
  assert.equal(store.allowsMessage('ou_any', 'oc_any'), true);

  process.env.LARK_ALLOWED_USER_IDS = 'ou_old_env';
  mkdirSync(join(root, 'runtime-config'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      revision: 7,
      allowed_user_ids: ['ou_new_file'],
      allowed_chat_ids: [],
      group_no_mention_chat_ids: [],
    }),
  );
  await store.load();
  assert.equal(store.allowsMessage('ou_old_env', 'oc_other'), false, 'old env allowlist must be ignored');
  assert.equal(store.allowsMessage('ou_new_file', 'oc_other'), true);

  writeFileSync(configPath, JSON.stringify({ version: 99 }));
  await assert.rejects(() => store.load(), /Unsupported access-control\.json version/);
  assert.equal(store.snapshot().revision, 7, 'invalid reload must keep last known-good snapshot');

  const result = await store.mutate({
    action: 'add',
    list: 'group_no_mention_chat_ids',
    value: 'oc_trusted',
    updatedBy: 'ou_owner',
  });
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.revision, 8);
  assert.equal(store.allowsNoMentionChat('oc_trusted'), true);
  assert.equal(existsSync(configPath), true);
  assert.match(readFileSync(configPath, 'utf8'), /oc_trusted/);

  await accessControlStore.load(configPath);
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = 'ou_owner';
  (appConfig as { auditLogPath: string }).auditLogPath = auditPath;

  const handlers = new Map<string, (args: any) => Promise<any>>();
  const validatedChats: string[] = [];
  registerAccessControlTools({
    server: {
      registerTool(name: string, _config: unknown, handler: any) {
        handlers.set(name, handler);
      },
    },
    client: {
      im: {
        v1: {
          chat: {
            get: async ({ path }: any) => {
              validatedChats.push(path.chat_id);
              if (path.chat_id === 'oc_missing') return { code: 230001, msg: 'chat not found' };
              return { code: 0, data: { name: 'Test Chat' } };
            },
          },
        },
      },
    },
    channel: {
      isPrivateChat: (chatId: string) => chatId === 'ou_p2p_chat',
    },
    resolveCaller(_toolName: string, chatId: string | undefined, threadId: string | undefined) {
      const caller = identity.getCaller(chatId ?? '', threadId);
      return caller
        ? { caller }
        : { error: { isError: true as const, content: [{ type: 'text' as const, text: 'no caller' }] } };
    },
  } as any);

  const identity = new IdentitySession(() => 'ou_owner');
  identity.setCaller('chat_owner', 'thread_owner', 'ou_owner');
  identity.setCaller('chat_other', 'thread_other', 'ou_other');
  identity.setCaller('oc_current_group', 'thread_owner', 'ou_owner');
  identity.setCaller('ou_p2p_chat', 'thread_owner', 'ou_owner');

  const manage = handlers.get('manage_access_control');
  assert.ok(manage, 'manage_access_control registered');

  const denied = await manage!({
    action: 'add',
    list: 'allowed_user_ids',
    value: 'ou_denied',
    chat_id: 'chat_other',
    thread_id: 'thread_other',
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /owner-only/);

  const added = await manage!({
    action: 'add',
    list: 'allowed_user_ids',
    value: 'ou_allowed_live',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  assert.equal(added.isError, undefined);
  assert.equal(accessControlStore.isAllowedUserId('ou_allowed_live'), true);

  const currentChat = await manage!({
    action: 'add',
    list: 'allowed_chat_ids',
    value: 'current',
    chat_id: 'oc_current_group',
    thread_id: 'thread_owner',
  });
  assert.equal(currentChat.isError, undefined);
  assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_current_group'), true);
  assert.deepEqual(validatedChats.at(-1), 'oc_current_group');
  assert.match(currentChat.content[0].text, /resolved_from_current_chat/);

  const p2pCurrent = await manage!({
    action: 'add',
    list: 'allowed_chat_ids',
    value: 'current',
    chat_id: 'ou_p2p_chat',
    thread_id: 'thread_owner',
  });
  assert.equal(p2pCurrent.isError, true);
  assert.match(p2pCurrent.content[0].text, /group chat/);

  const invalidChat = await manage!({
    action: 'add',
    list: 'allowed_chat_ids',
    value: 'not-a-chat',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  assert.equal(invalidChat.isError, true);
  assert.match(invalidChat.content[0].text, /oc_\.\.\. format/);

  const missingChat = await manage!({
    action: 'add',
    list: 'allowed_chat_ids',
    value: 'oc_missing',
    chat_id: 'chat_owner',
    thread_id: 'thread_owner',
  });
  assert.equal(missingChat.isError, true);
  assert.match(missingChat.content[0].text, /does not exist|not accessible/);

  const listed = await manage!({ action: 'list', chat_id: 'chat_owner', thread_id: 'thread_owner' });
  assert.equal(listed.isError, undefined);
  assert.match(listed.content[0].text, /ou_allowed_live/);
  assert.match(readFileSync(auditPath, 'utf8'), /manage_access_control/);

  console.log('access-control smoke: PASS');
} finally {
  delete process.env.LARK_ALLOWED_USER_IDS;
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = originalOwner;
  (appConfig as { auditLogPath: string }).auditLogPath = originalAuditLog;
  accessControlStore.replaceForTest(originalStoreSnapshot);
  rmSync(root, { recursive: true, force: true });
}
