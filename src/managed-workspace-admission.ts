import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodexExecSandbox } from './codex-exec.js';
import type { ManagedRunAllocation, ManagedRunOwner } from './domain/managed-workspace.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import type { LarkMessage } from './lark-message.js';
import type { ManagedWorkspaceRecord, ManagedWorkspaceStore } from './ports/managed-workspace.js';
import { ManagedWorkspaceStorageError, readManagedWorkspaceRoots } from './managed-workspace-storage.js';
import { assertManagedWorkspaceSandbox } from './managed-workspace-exec.js';

export function managedForegroundRunOwner(message: LarkMessage, sessionKey: string): ManagedRunOwner {
  const identity = JSON.stringify([
    sessionKey, message.messageId, message.senderId, message.messageType,
    ...(message.reaction ? [message.reaction.emojiType, message.timestampMs] : []),
  ]);
  return { kind: 'foreground', runId: createHash('sha256').update(identity).digest('hex') };
}

export async function admitManagedForegroundRun(options: {
  owner: ManagedRunOwner;
  sessionKey: string;
  store?: ManagedWorkspaceStore;
  recorded?: ManagedWorkspaceRecord | null;
  configPath: string;
  authorizedRoot: string;
  sourceRegistryPath?: string;
  sandbox: CodexExecSandbox;
  project?: WorkspaceProjectBinding;
}): Promise<ManagedRunAllocation | undefined> {
  const { store, recorded, project, owner } = options;
  const authorizedRoots = [options.authorizedRoot] as const;
  const roots = recorded?.allocation.roots ?? await readManagedWorkspaceRoots({
    configPath: options.configPath, authorizedRoots, project, sourceRegistryPath: options.sourceRegistryPath,
  });
  if (!roots) {
    if (store) store.rememberUnmanagedForeground(owner.runId, {
      sessionKey: options.sessionKey,
      ...(project ? { project } : { fallbackCwd: path.resolve(options.authorizedRoot) }),
    });
    return undefined;
  }
  assertManagedWorkspaceSandbox(options.sandbox, project);
  if (!store) throw new ManagedWorkspaceStorageError('allocation_failed');
  const now = new Date().toISOString();
  return store.ensure({
    owner, roots, authorizedRoots, project, sourceRegistryPath: options.sourceRegistryPath,
    foregroundSessionKey: options.sessionKey,
    createdAt: recorded?.allocation.createdAt ?? now,
    usedAt: now,
  });
}
