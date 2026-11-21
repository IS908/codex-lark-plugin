import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertDenyOnlyWorkspaceAcls, readWorkspaceMountTable, workspaceBackingAliases,
  workspaceMountLayoutSupported } from './managed-workspace-ancestry.js';
import { workspacePathContains } from './workspace-projects.js';

const exec = promisify(execFile);
const DATA = '/System/Volumes/Data';
const FIRMLINKS = '/usr/share/firmlinks';

export interface WorkspaceDependencyMountPolicy {
  aliases(directory: string): string[];
  supports(directory: string): boolean;
  contains(root: string, directory: string): boolean;
}

export async function readWorkspaceDependencyMountPolicy(): Promise<WorkspaceDependencyMountPolicy> {
  if (process.platform === 'linux') {
    const mounts = readWorkspaceMountTable();
    return { aliases: (directory) => workspaceBackingAliases(directory, mounts),
      supports: (directory) => workspaceMountLayoutSupported([directory], mounts), contains: workspacePathContains };
  }
  if (process.platform !== 'darwin') return unsupported();
  const { stdout, stderr } = await exec('/sbin/mount', [], { timeout: 5000, maxBuffer: 1024 * 1024, env: { LC_ALL: 'C' } });
  if (stderr) return unsupported();
  return createDarwinDependencyMountPolicy(stdout, await readVerifiedFirmlinks());
}

export function createDarwinDependencyMountPolicy(table: string, firmlinks: readonly (readonly [string, string])[]): WorkspaceDependencyMountPolicy {
  if (!table.endsWith('\n') || Buffer.byteLength(table) > 1024 * 1024) return unsupported();
  const mounts = table.slice(0, -1).split('\n').map((line) => {
    const i = line.lastIndexOf(' (');
    const from = line.slice(0, i).split(' on ');
    const flags = line.slice(i + 2, -1).split(', ');
    if (i < 0 || !line.endsWith(')') || from.length !== 2 || !from[0] || !absolute(from[1])
      || !/^[a-zA-Z0-9_+-]+$/.test(flags[0]) || /[\u0000-\u001f\u007f]/.test(line)) return unsupported();
    return { directory: from[1], flags };
  });
  const system = mounts.filter(({ directory }) => directory === '/');
  const data = mounts.filter(({ directory }) => directory === DATA);
  if (system.length !== 1 || data.length !== 1 || system[0].flags[0] !== 'apfs' || data[0].flags[0] !== 'apfs'
    || !system[0].flags.includes('sealed') || !system[0].flags.includes('read-only')
    || !data[0].flags.includes('local') || !data[0].flags.includes('root data')) return unsupported();

  function aliases(directory: string): string[] {
    const aliases = new Set([directory]);
    for (const [visible, backing] of firmlinks) {
      for (const [from, to] of [[visible, backing], [backing, visible]]) {
        if (contains(from, directory)) aliases.add(path.join(to, ...directory.split('/').slice(from.split('/').length)));
      }
    }
    return [...aliases];
  }
  const unmodeled = mounts.filter(({ directory }) => directory !== '/' && directory !== DATA).flatMap(({ directory }) => aliases(directory));
  return { aliases, contains, supports: (directory) => {
    const candidates = aliases(directory);
    // Only an identified Data volume path with no overlapping mount has a proven local backing layout.
    return candidates.some((alias) => contains(DATA, alias)) && !candidates.some((alias) =>
      unmodeled.some((mount) => contains(alias, mount) || contains(mount, alias)));
  } };
}

async function readVerifiedFirmlinks(): Promise<Array<[string, string]>> {
  const file = await fs.open(FIRMLINKS, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size < 1 || info.size > 64 * 1024) return unsupported();
    await assertDenyOnlyWorkspaceAcls([FIRMLINKS]);
    bytes = Buffer.alloc(info.size);
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) return unsupported();
  } finally { await file.close(); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) return unsupported();
  const mappings: Array<[string, string]> = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const [visible, relative, ...extra] = line.split('\t');
    if (extra.length || !absolute(visible) || visible === '/' || !relative || path.isAbsolute(relative)
      || relative.split('/').some((part) => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(relative)) return unsupported();
    const backing = path.join(DATA, relative);
    const [first, second] = await Promise.all([directoryIdentity(visible), directoryIdentity(backing)]);
    if (!first && !second) continue;
    if (!first || first !== second) return unsupported();
    mappings.push([visible, backing]);
  }
  if (!mappings.length) return unsupported();
  return mappings;
}

async function directoryIdentity(directory: string): Promise<string | undefined> {
  try {
    const info = await fs.lstat(directory, { bigint: true });
    if (!info.isDirectory()) return unsupported();
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function absolute(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function contains(root: string, entry: string): boolean {
  // Case-fold conservatively even when booted from a case-sensitive data volume.
  return workspacePathContains(root.normalize('NFD').toLowerCase(), entry.normalize('NFD').toLowerCase());
}

function unsupported(): never { throw new Error('Unsupported dependency workspace mount layout.'); }
