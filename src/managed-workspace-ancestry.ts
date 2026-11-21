import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { WorkspaceProjectError } from './workspace-projects.js';

const exec = promisify(execFile);

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
