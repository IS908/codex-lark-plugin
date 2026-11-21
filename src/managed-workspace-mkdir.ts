import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { workspaceProjectBindingSchema, type WorkspaceProjectBinding } from './domain/workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { WorkspaceProjectError } from './workspace-projects.js';

const exec = promisify(execFile);
const managedLeaf = /^(?:foreground|cron_prompt|async_task)-[a-f0-9]{64}$/;
export const MANAGED_GIT_CHECKOUT_LEAF = 'git-checkout';

// Node has no mkdirat API. The child uses its kernel-held cwd as the directory handle.
const mkdirProgram = String.raw`
  const fs = require('node:fs');
  const [leaf, parentPath, device, inode] = process.argv.slice(1);
  const respond = (value) => process.stdout.write(JSON.stringify(value));
  try {
    const parent = fs.statSync('.', { bigint: true });
    if (String(parent.dev) !== device || String(parent.ino) !== inode || process.cwd() !== parentPath) {
      respond({ error: 'directory_changed' });
    } else if (!process.geteuid || parent.uid !== BigInt(process.geteuid()) || (parent.mode & 0o022n) !== 0n) {
      respond({ error: 'unprotected_root' });
    } else {
      fs.mkdirSync(leaf, { mode: 0o700 });
      const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd, { bigint: true });
        if (!info.isDirectory() || info.uid !== parent.uid || (info.mode & 0o077n) !== 0n) {
          respond({ error: 'directory_changed' });
        } else {
          respond({ device: String(info.dev), inode: String(info.ino) });
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    respond({ error: error.code === 'EEXIST' ? 'allocation_conflict' : 'allocation_failed' });
  }
`;

export async function mkdirInsidePinnedRoot(root: WorkspaceProjectBinding, leaf: string): Promise<WorkspaceProjectBinding> {
  if (!managedLeaf.test(leaf)) throw new ManagedWorkspaceStorageError('invalid_binding');
  return mkdirInsideRoot(root, leaf);
}

export function mkdirGitCheckoutInsidePinnedRun(runRoot: WorkspaceProjectBinding): Promise<WorkspaceProjectBinding> {
  return mkdirInsideRoot(runRoot, MANAGED_GIT_CHECKOUT_LEAF);
}

async function mkdirInsideRoot(root: WorkspaceProjectBinding, leaf: string): Promise<WorkspaceProjectBinding> {
  if (!process.geteuid) throw new ManagedWorkspaceStorageError('unprotected_root');
  let response;
  try {
    const { stdout } = await exec(process.execPath,
      ['--input-type=commonjs', '-e', mkdirProgram, '--', leaf, root.directory, root.device, root.inode], {
        cwd: root.directory, env: {}, maxBuffer: 1024, timeout: 10_000,
      });
    response = JSON.parse(stdout);
  } catch {
    throw new ManagedWorkspaceStorageError('allocation_failed');
  }
  if (response?.error === 'directory_changed') throw new WorkspaceProjectError('directory_changed');
  if (response?.error === 'unprotected_root' || response?.error === 'allocation_conflict') {
    throw new ManagedWorkspaceStorageError(response.error);
  }
  const binding = workspaceProjectBindingSchema.safeParse({ ...response, directory: path.join(root.directory, leaf) });
  if (!binding.success) throw new ManagedWorkspaceStorageError('allocation_failed');
  return binding.data;
}
