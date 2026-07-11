/**
 * Stage 2 profile distillation smoke test.
 *
 * Covers:
 *  - default-off / threshold gates
 *  - Codex exec JSON output parsed and persisted into tiered profiles
 *  - L1 + deterministic L2 safety nets for public spillover
 *  - per-user lock + cooldown prevents duplicate dispatches
 *  - audit entry is written for each real dispatch
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'profile-distillation-'));
const l2Path = join(root, 'privacy-rules.md');
process.env.LARK_AUDIT_LOG = join(root, 'audit.log');
writeFileSync(l2Path, '## Always private\n- Project Phoenix\n', 'utf-8');

const { appConfig } = await import('../src/config.js');
(appConfig as { privacyRulesPath: string }).privacyRulesPath = l2Path;
const { MemoryStore } = await import('../src/memory/file.js');
const { ProfileDistillationManager } = await import('../src/profile-distillation.js');

let passed = 0;

// 1. Disabled manager does not run Codex or write profile data.
{
  const s = new MemoryStore(join(root, 'disabled'));
  await s.saveEpisode('chat', 'Alice decided to use TypeScript.', { chatId: 'oc_disabled' });
  let calls = 0;
  const manager = new ProfileDistillationManager({
    enabled: false,
    memoryStore: s,
    minEpisodes: 1,
    maxEpisodes: 5,
    cooldownMs: 0,
    runCodexExec: async () => {
      calls++;
      return { text: '{"public":["should not run"],"private":[]}' };
    },
    audit: async () => {},
  });

  const result = await manager.maybeDispatch({
    userId: 'ou_alice',
    chatId: 'oc_disabled',
    chatType: 'p2p',
  });
  if (result.status !== 'disabled') fail(`1: expected disabled, got ${result.status}`);
  if (calls !== 0) fail(`1: disabled manager should not call Codex, got ${calls}`);
  if (await s.getProfile('ou_alice', 'ou_alice') !== null) fail('1: disabled manager wrote profile');
  passed++;
}

// 2. Min-episode gate blocks until enough episodes exist, then writes profile facts.
{
  const s = new MemoryStore(join(root, 'threshold'));
  const prompts: string[] = [];
  const audits: any[] = [];
  const manager = new ProfileDistillationManager({
    enabled: true,
    memoryStore: s,
    minEpisodes: 2,
    maxEpisodes: 5,
    cooldownMs: 0,
    runCodexExec: async (request: any) => {
      prompts.push(request.prompt);
      return { text: '{"public":["Alice uses TypeScript"],"private":["Alice prefers 1:1 planning notes private"]}' };
    },
    audit: async (...args: any[]) => { audits.push(args); },
  });

  await s.saveEpisode('chat', 'Alice discussed TypeScript migration.', { chatId: 'oc_threshold' });
  const first = await manager.maybeDispatch({
    userId: 'ou_alice',
    chatId: 'oc_threshold',
    chatType: 'p2p',
  });
  if (first.status !== 'insufficient_episodes') fail(`2: expected insufficient_episodes, got ${first.status}`);
  if (prompts.length !== 0) fail(`2: threshold miss should not call Codex, got ${prompts.length}`);

  await s.saveEpisode('chat', 'Alice prefers 1:1 planning notes private.', { chatId: 'oc_threshold' });
  const second = await manager.maybeDispatch({
    userId: 'ou_alice',
    chatId: 'oc_threshold',
    chatType: 'p2p',
  });
  if (second.status !== 'dispatched') fail(`2: expected dispatched, got ${second.status}`);
  if (!prompts[0]?.includes('Target user: ou_alice')) fail('2: prompt should target active user');
  if (!prompts[0]?.includes('Alice discussed TypeScript migration')) fail('2: prompt should include episodes');
  const own = await s.getProfile('ou_alice', 'ou_alice');
  if (!own?.includes('Alice uses TypeScript')) fail(`2: public fact missing from owner profile: ${own}`);
  if (!own?.includes('1:1 planning')) fail(`2: private fact missing from owner profile: ${own}`);
  const other = await s.getProfile('ou_alice', 'ou_bob');
  if (!other?.includes('Alice uses TypeScript')) fail('2: non-owner should see public fact');
  if (other?.includes('1:1 planning')) fail('2: non-owner must not see private fact');
  if (audits.length !== 1 || audits[0][0] !== 'profile_distill' || audits[0][3] !== 'ok') {
    fail(`2: expected one ok audit for dispatch, got ${JSON.stringify(audits)}`);
  }
  passed++;
}

// 3. Public spillover is forced private by L1 and deterministic L2 rules.
{
  const s = new MemoryStore(join(root, 'safety'));
  await s.saveEpisode('chat', 'Alice shared a phone number and Project Phoenix status.', { chatId: 'oc_safety' });
  const manager = new ProfileDistillationManager({
    enabled: true,
    memoryStore: s,
    minEpisodes: 1,
    maxEpisodes: 5,
    cooldownMs: 0,
    runCodexExec: async () => ({
      text: '{"public":["Alice phone 13800138000","Alice works on Project Phoenix"],"private":[]}',
    }),
    audit: async () => {},
  });
  const result = await manager.maybeDispatch({
    userId: 'ou_alice',
    chatId: 'oc_safety',
    chatType: 'group',
  });
  if (result.status !== 'dispatched') fail(`3: expected dispatched, got ${result.status}`);
  const publicView = await s.getProfile('ou_alice', 'ou_bob');
  if (publicView?.includes('13800138000')) fail('3: L1 phone must not remain public');
  if (publicView?.includes('Project Phoenix')) fail('3: L2 private phrase must not remain public');
  const own = await s.getProfile('ou_alice', 'ou_alice');
  if (!own?.includes('13800138000')) fail('3: L1 spillover should be preserved privately');
  if (!own?.includes('Project Phoenix')) fail('3: L2 spillover should be preserved privately');
  passed++;
}

// 4. Same-user concurrent triggers serialize; cooldown prevents duplicate Codex calls.
{
  const s = new MemoryStore(join(root, 'cooldown'));
  await s.saveEpisode('chat', 'Alice wants durable profile extraction.', { chatId: 'oc_cooldown' });
  let now = 10_000;
  let calls = 0;
  const audits: any[] = [];
  const manager = new ProfileDistillationManager({
    enabled: true,
    memoryStore: s,
    minEpisodes: 1,
    maxEpisodes: 5,
    cooldownMs: 60_000,
    now: () => now,
    runCodexExec: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { text: '{"public":["Alice likes concise updates"],"private":[]}' };
    },
    audit: async (...args: any[]) => { audits.push(args); },
  });

  const [a, b] = await Promise.all([
    manager.maybeDispatch({ userId: 'ou_alice', chatId: 'oc_cooldown', chatType: 'p2p' }),
    manager.maybeDispatch({ userId: 'ou_alice', chatId: 'oc_cooldown', chatType: 'p2p' }),
  ]);
  const statuses = [a.status, b.status].sort();
  if (statuses.join(',') !== 'cooldown,dispatched') {
    fail(`4: expected one dispatch and one cooldown, got ${statuses.join(',')}`);
  }
  if (calls !== 1) fail(`4: expected one Codex call, got ${calls}`);
  if (audits.length !== 1) fail(`4: expected one audit entry, got ${audits.length}`);

  now += 60_001;
  const c = await manager.maybeDispatch({ userId: 'ou_alice', chatId: 'oc_cooldown', chatType: 'p2p' });
  if (c.status !== 'dispatched') fail(`4: expected dispatch after cooldown, got ${c.status}`);
  if (calls !== 2) fail(`4: expected second Codex call after cooldown, got ${calls}`);
  passed++;
}

rmSync(root, { recursive: true, force: true });
console.log(`profile-distillation smoke: ${passed}/4 PASS`);
