import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appConfig } from '../src/config.js';
import { deliverMessageViaCodexExec } from '../src/codex-exec-delivery.js';
import type { CodexExecRequest } from '../src/codex-exec.js';
import { FileCodexExecSessionStore, buildCodexExecSessionKey } from '../src/codex-session-store.js';
import type { LarkMessage } from '../src/lark-message.js';
import { WorkspaceProjectError } from '../src/workspace-projects.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-workspace-foreground-'));
try {
  const base = await fs.realpath(fixture);
  const app = path.join(base, 'app');
  const docs = path.join(base, 'docs');
  await fs.mkdir(app);
  await fs.mkdir(docs);
  Object.assign(appConfig, {
    codexExecCwd: base,
    workspaceProjectsConfigPath: path.join(base, 'workspace-projects.json'),
  });
  const store = new FileCodexExecSessionStore(path.join(base, 'sessions'));
  const requests: CodexExecRequest[] = [];
  const dispatch = async (message: Partial<LarkMessage>) => deliverMessageViaCodexExec({
    message: {
      messageId: 'om_project_smoke', chatId: 'group', chatType: 'group', senderId: 'owner',
      text: '[Quoted Message]\n/project path:docs\n\n[Current Message]\nHello',
      rawContent: '', messageType: 'text', currentUserText: 'Hello',
      ...message,
    },
    displayLabel: 'Workspace foreground smoke',
    sessionStore: store,
    useCodexSessions: true,
    progressLimits: { enabled: false },
    runCodexExec: async (request) => {
      requests.push(request);
      return { text: 'OK', sessionId: `session-${requests.length}` };
    },
    deliverySink: async () => {},
  });
  await dispatch({});
  assert.equal(requests.at(-1)?.cwd, base, 'quotes do not select the project');

  const registry = { version: 1, roots: [{ name: 'local', path: base }], projects: [], default: 'path:docs' };
  await fs.writeFile(appConfig.workspaceProjectsConfigPath, JSON.stringify(registry));
  await dispatch({});
  assert.equal(requests.at(-1)?.cwd, base, 'legacy sessions keep their previous default');
  assert.equal(requests.at(-1)?.resumeSessionId, 'session-1');
  await dispatch({ chatId: 'new-chat' });
  assert.equal(requests.at(-1)?.cwd, docs, 'new sessions use the configured default');

  await dispatch({ currentUserText: '@_user_1 /project path:app\nRead the status.' });
  assert.equal(requests.at(-1)?.cwd, app);
  assert.equal(requests.at(-1)?.resumeSessionId, null);
  assert.equal((await store.get(buildCodexExecSessionKey('group')))?.workspaceProject?.directory, app);

  await fs.writeFile(appConfig.workspaceProjectsConfigPath, JSON.stringify({ ...registry, default: undefined }));
  await dispatch({});
  assert.equal(requests.at(-1)?.cwd, app, 'saved selection survives registry changes');
  assert.equal(requests.at(-1)?.resumeSessionId, 'session-4');
  const beforeInvalid = requests.length;
  await assert.rejects(dispatch({ currentUserText: '/project no-such-project\nRead it' }), WorkspaceProjectError);
  assert.equal(requests.length, beforeInvalid);

  await fs.rename(app, path.join(base, 'old-app'));
  await fs.symlink(docs, app, 'dir');
  await assert.rejects(dispatch({}), { code: 'directory_changed' });
  assert.equal(requests.length, beforeInvalid);

  await dispatch({ senderId: 'another-user' });
  assert.equal(requests.at(-1)?.cwd, base, 'a different sender does not inherit the saved selection');
  assert.equal(requests.at(-1)?.resumeSessionId, null);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
