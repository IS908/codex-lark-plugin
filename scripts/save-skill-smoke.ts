import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'save_skill_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const tmp = mkdtempSync(join(tmpdir(), 'save-skill-smoke-'));
process.env.LARK_AUDIT_LOG = join(tmp, 'audit.log');
process.env.LARK_OWNER_OPEN_ID = 'ou_owner';

const { registerTools } = await import('../src/tools.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { appConfig } = await import('../src/config.js');

const saved: Array<{ name: string; description: string; content: string }> = [];
const memoryStore = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async (name: string, description: string, content: string) => {
    saved.push({ name, description, content });
  },
};

const fakeClient = {
  im: {
    v1: {
      message: { create: async () => ({}), reply: async () => ({}), patch: async () => ({}) },
      messageReaction: { create: async () => ({}), delete: async () => ({}) },
      image: { create: async () => ({ data: { image_key: 'img' } }), get: async () => Buffer.from('x') },
      file: { create: async () => ({ data: { file_key: 'file' } }) },
      messageResource: { get: async () => Buffer.from('x') },
    },
  },
};

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

const originalOwner = appConfig.ownerOpenId;
(appConfig as { ownerOpenId: string | null }).ownerOpenId = 'ou_owner';

async function waitForAuditLog(path: string, expected: RegExp[] = []): Promise<string> {
  let last = '';
  for (let i = 0; i < 20; i++) {
    if (existsSync(path)) {
      last = readFileSync(path, 'utf-8');
      if (expected.every((pattern) => pattern.test(last))) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return last || readFileSync(path, 'utf-8');
}

{
  const raceAuditLog = join(tmp, 'race-audit.log');
  writeFileSync(raceAuditLog, '2026-06-15T00:00:00.000Z  save_skill          denied   caller=-\n');
  const timer = setTimeout(() => {
    appendFileSync(raceAuditLog, '2026-06-15T00:00:00.030Z  save_skill          ok       caller=ou_owner\n');
  }, 30);
  try {
    const auditLog = await waitForAuditLog(raceAuditLog, [/ok/, /ou_owner/]);
    assert.match(auditLog, /ok/);
    assert.match(auditLog, /ou_owner/);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const identity = new IdentitySession(() => 'ou_owner');
  identity.setCaller('chat_owner', 'thread_owner', 'ou_owner');
  identity.setCaller('chat_other', 'thread_other', 'ou_other');

  registerTools(
    fakeServer as any,
    fakeClient as any,
    memoryStore as any,
    identity,
    { isPrivateChat: () => true } as any,
  );

  const saveSkill = handlers.get('save_skill');
  assert.ok(saveSkill, 'save_skill handler registered');

  // 1. chat_id is required so Codex cannot write a global skill without a server-derived caller.
  {
    const result = await saveSkill!({
      name: 'unsafe',
      description: 'missing caller context',
      content: 'do unsafe thing',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /chat_id is required/i);
    assert.equal(saved.length, 0);
  }

  // 2. Non-owner callers are denied because skills are global across all users/chats.
  {
    const result = await saveSkill!({
      name: 'unsafe',
      description: 'non-owner write',
      content: 'do unsafe thing',
      chat_id: 'chat_other',
      thread_id: 'thread_other',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /owner-only/i);
    assert.equal(saved.length, 0);
  }

  // 3. Owner-scoped calls save the skill and write an audit ok line.
  {
    const result = await saveSkill!({
      name: 'release-checklist',
      description: 'Release checklist',
      content: 'Run tests, tag, publish.',
      chat_id: 'chat_owner',
      thread_id: 'thread_owner',
    });
    assert.equal(result.isError, undefined);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'release-checklist');
  }

  const auditLog = await waitForAuditLog(process.env.LARK_AUDIT_LOG!, [/save_skill/, /denied/, /ok/, /ou_owner/]);
  assert.match(auditLog, /save_skill/);
  assert.match(auditLog, /denied/);
  assert.match(auditLog, /ok/);
  assert.match(auditLog, /ou_owner/);
} finally {
  (appConfig as { ownerOpenId: string | null }).ownerOpenId = originalOwner;
  rmSync(tmp, { recursive: true, force: true });
}

console.log('save-skill smoke: PASS');
