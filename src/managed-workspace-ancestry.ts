import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { WorkspaceProjectError, workspacePathContains } from './workspace-projects.js';

const exec = promisify(execFile);

export interface WorkspaceMount {
  device: string;
  root: string;
  directory: string;
}

export function readWorkspaceMountTable(): WorkspaceMount[] {
  if (process.platform !== 'linux') return [];
  return parseWorkspaceMountTable(readFileSync('/proc/self/mountinfo', 'utf8'));
}

export function parseWorkspaceMountTable(value: string): WorkspaceMount[] {
  if (!value.endsWith('\n') || value.length > 1_048_576) throw new Error('Unsupported mount table.');
  const decode = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  return value.trimEnd().split('\n').map((entry) => {
    const [, , device, root, mount] = entry.split(' ');
    if (!/^\d+:\d+$/.test(device ?? '') || !root?.startsWith('/') || !mount?.startsWith('/')) throw new Error('Unsupported mount table.');
    return { device, root: decode(root), directory: decode(mount) };
  });
}

export function workspaceMountLayoutSupported(workspaces: readonly string[], mounts: readonly WorkspaceMount[]): boolean {
  return !mounts.some(({ directory: mount, root }) => workspaces.some((workspace) =>
    (root !== '/' && workspacePathContains(mount, workspace))
    || (mount !== workspace && workspacePathContains(workspace, mount))));
}

// Include mounts of strict subtrees: their visible ancestors also grant access through the mountpoint.
export function workspaceBackingAliases(directory: string, mounts: WorkspaceMount[]): string[] {
  const aliases = new Set([directory]);
  const paths = new Set([directory, ...mounts.filter((mount) => workspacePathContains(directory, mount.directory)).map((mount) => mount.directory)]);
  for (const visible of paths) {
    const covering = mounts.filter((mount) => workspacePathContains(mount.directory, visible));
    const longest = Math.max(0, ...covering.map((mount) => mount.directory.length));
    for (const origin of covering.filter((mount) => mount.directory.length === longest)) {
      const backing = path.join(origin.root, path.relative(origin.directory, visible));
      for (const target of mounts) {
        if (target.device !== origin.device) continue;
        if (workspacePathContains(target.root, backing)) {
          aliases.add(path.join(target.directory, path.relative(target.root, backing)));
        } else if (workspacePathContains(backing, target.root)) {
          aliases.add(target.directory);
        }
      }
    }
  }
  return [...aliases];
}

export async function readWorkspaceAncestorIdentities(directory: string): Promise<Set<string>> {
  const identities = new Set<string>();
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await fs.stat(current, { bigint: true }).catch(() => undefined);
    if (!info?.isDirectory()) throw new WorkspaceProjectError('unavailable_directory');
    identities.add(`${info.dev}:${info.ino}`);
    if (path.dirname(current) === current) return identities;
  }
}

export async function assertProtectedWorkspacePath(binding: WorkspaceProjectBinding, owned = false): Promise<void> {
  if (!process.geteuid) throw new ManagedWorkspaceStorageError('unprotected_root');
  const uid = BigInt(process.geteuid());
  const ancestry: string[] = [];
  for (let current = binding.directory; ; current = path.dirname(current)) {
    const leaf = ancestry.length === 0;
    const info = await fs.lstat(current, { bigint: true }).catch(() => undefined);
    if (!info?.isDirectory() || (leaf && (String(info.dev) !== binding.device || String(info.ino) !== binding.inode))) {
      throw new WorkspaceProjectError('directory_changed');
    }
    const trustedOwner = info.uid === uid || ((!leaf || !owned) && info.uid === 0n);
    // A trusted sticky ancestor (e.g. /tmp) protects names owned by that ancestor's owner or by this account.
    const protectedNames = (info.mode & 0o022n) === 0n || (!leaf && (info.mode & 0o1000n) !== 0n);
    if (!trustedOwner || !protectedNames) throw new ManagedWorkspaceStorageError('unprotected_root');
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  await assertDenyOnlyWorkspaceAcls(ancestry);
}

// macOS extended ACLs can grant writes that are not reflected in st_mode.
export async function assertDenyOnlyWorkspaceAcls(entries: string[]): Promise<void> {
  if (process.platform !== 'darwin' || !entries.length) return;
  try {
    const { stdout, stderr } = await exec('/bin/ls', ['-ldebn', '--', ...entries], {
      encoding: 'utf8', env: { LC_ALL: 'C' }, timeout: 5000, maxBuffer: 1_000_000,
    });
    const lines = stdout.split('\n').filter(Boolean);
    if (stderr) throw new Error('ACL inspection failed.');
    let headers = 0;
    let needsAcl = false;
    for (const line of lines) {
      const header = /^[-d][rwxstST-]{9}([+@]?)\s/.exec(line);
      if (header && !needsAcl) {
        headers++;
        needsAcl = header[1] === '+';
      } else if (headers && /^\s+\d+: .+ deny [a-z_,]+$/.test(line)) {
        needsAcl = false;
      } else {
        throw new Error('Unsupported ACL.');
      }
    }
    if (needsAcl || headers !== entries.length) throw new Error('Incomplete ACL data.');
  } catch {
    throw new ManagedWorkspaceStorageError('unprotected_root');
  }
}
