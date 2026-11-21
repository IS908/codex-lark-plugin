import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from './managed-workspace-ancestry.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const maxEntries = 4096;
const maxDepth = 32;
const maxBytes = 128n * 1024n * 1024n;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const linuxLocalFilesystems = new Set([0xef53n, 0x58465342n, 0x9123683en]); // ext2/3/4, XFS, Btrfs
const appleData = '/System/Volumes/Data';
const nativeOptions = { env: { LC_ALL: 'C' }, timeout: 3000, maxBuffer: 256 * 1024 };

export interface WorkspaceCleanupEpoch { host: string; boot: string }

export function parseWorkspaceCleanupEpoch(host: unknown, boot: unknown): WorkspaceCleanupEpoch | undefined {
  return typeof host === 'string' && digest.test(host) && typeof boot === 'string' && digest.test(boot) ? { host, boot } : undefined;
}

export function wasUsedOnPriorHostBoot(recorded?: WorkspaceCleanupEpoch, current?: WorkspaceCleanupEpoch): boolean {
  return !!recorded && !!current && recorded.host === current.host && recorded.boot !== current.boot;
}

let epoch: Promise<WorkspaceCleanupEpoch | undefined> | undefined;
export function readWorkspaceCleanupEpoch() { return epoch ??= measureEpoch(); }

export async function hasLocalWorkspaceCleanupStorage(directories: readonly string[]): Promise<boolean> {
  try {
    const mounts = await readWorkspaceDependencyMountPolicy();
    for (const directory of directories) {
      if (!path.isAbsolute(directory) || !mounts.supports(directory)) return false;
      if (process.platform === 'linux' && !linuxLocalFilesystems.has((await fs.statfs(directory, { bigint: true })).type)) return false;
    }
    return true;
  } catch { return false; }
}

let physicalAppleData: Promise<boolean> | undefined;
export async function hasExclusiveWorkspaceCleanupStorage(directories: readonly string[]): Promise<boolean> {
  // A logical machine ID or filesystem magic does not identify the backing hardware.
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !await hasLocalWorkspaceCleanupStorage(directories)) return false;
  if (!await (physicalAppleData ??= provePhysicalAppleData())) return false;
  try {
    const data = await fs.stat(appleData, { bigint: true });
    for (const directory of directories) if ((await fs.stat(directory, { bigint: true })).dev !== data.dev) return false;
    return true;
  } catch { return false; }
}

async function diskInfo(device: string): Promise<Record<string, unknown>> {
  const { stdout: plist } = await exec('/usr/sbin/diskutil', ['info', '-plist', device], nativeOptions);
  const convert = exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], nativeOptions);
  convert.child.stdin?.on('error', () => {});
  convert.child.stdin?.end(plist);
  return JSON.parse((await convert).stdout);
}

async function provePhysicalAppleData(): Promise<boolean> {
  try {
    const model = (await exec('/usr/sbin/sysctl', ['-n', 'hw.model'], nativeOptions)).stdout.trim();
    if (!/^(?:Mac|MacBookAir|MacBookPro|Macmini|iMac)\d+,\d+$/.test(model)) return false;
    const volume = await diskInfo(appleData);
    if (volume.MountPoint !== appleData || volume.Internal !== true || volume.BusProtocol !== 'Apple Fabric'
      || !Array.isArray(volume.APFSPhysicalStores) || volume.APFSPhysicalStores.length !== 1) return false;
    const partition = volume.APFSPhysicalStores[0]?.APFSPhysicalStore;
    if (typeof partition !== 'string' || !/^disk\d+s\d+$/.test(partition)) return false;
    const physical = await diskInfo(partition);
    return physical.DeviceIdentifier === partition && physical.Internal === true && physical.BusProtocol === 'Apple Fabric'
      && typeof physical.DeviceTreePath === 'string'
      && /^IODeviceTree:\/arm-io@[^/]+\/ans@[^/]+\/.+\/AppleANS[0-9A-Za-z]+$/.test(physical.DeviceTreePath);
  } catch { return false; }
}

async function measureEpoch(): Promise<WorkspaceCleanupEpoch | undefined> {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    const { stdout } = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], nativeOptions);
    const matches = [...stdout.matchAll(/^\s*"IOPlatformUUID" = "([0-9a-f-]+)"\s*$/gim)];
    if (matches.length !== 1 || !uuid.test(matches[0][1])) return;
    const host = matches[0][1].toLowerCase();
    const boot = (await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], nativeOptions)).stdout.trim();
    if (!uuid.test(boot) || /^0+$/.test(boot.replaceAll('-', '')) || /^0+$/.test(host.replaceAll('-', ''))) return;
    const hash = (kind: string, value: string) => createHmac('sha256', `codex-lark-cleanup-${kind}-v1`)
      .update(`${process.platform}\0${value}`).digest('hex');
    return { host: hash('host', host), boot: hash('boot', boot.toLowerCase()) };
  } catch { return undefined; }
}

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

// The baseline covers owned scratch and every checkout entry, including .git and ignored files.
export async function measureWorkspaceCleanupBaseline(root: WorkspaceProjectBinding, signal?: AbortSignal): Promise<string | undefined> {
  const hash = createHash('sha256').update('lark-cleanup-scratch-baseline-v1\0');
  const visited: Array<{ absolute: string; stamp: string }> = [];
  let bytes = 0n;
  const buffer = Buffer.allocUnsafe(128 * 1024);
  try {
    signal?.throwIfAborted();
    if (!process.geteuid || !(await readWorkspaceDependencyMountPolicy()).supports(root.directory)) return;
    const uid = BigInt(process.geteuid());
    await assertProtectedWorkspacePath(root, true);
    await visit('', 0);
    for (let i = 0; i < visited.length; i += 32) {
      signal?.throwIfAborted();
      const group = visited.slice(i, i + 32);
      await assertDenyOnlyWorkspaceAcls(group.map(({ absolute }) => absolute));
      for (const observation of group) {
        if (stamp(await fs.lstat(observation.absolute, { bigint: true })) !== observation.stamp) throw new Error('Unstable entry.');
      }
    }
    await assertProtectedWorkspacePath(root, true);
    signal?.throwIfAborted();
    if (!(await readWorkspaceDependencyMountPolicy()).supports(root.directory)) return;
    return hash.digest('hex');

    async function visit(relative: string, depth: number) {
      signal?.throwIfAborted();
      if (visited.length >= maxEntries || depth > maxDepth) throw new Error('Baseline exceeds scan limits.');
      const absolute = path.join(root.directory, relative);
      const info = await fs.lstat(absolute, { bigint: true });
      if (String(info.dev) !== root.device || (!relative && (String(info.ino) !== root.inode || !info.isDirectory()))
        || info.uid !== uid || (info.mode & 0o7022n) !== 0n || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n))) {
        throw new Error('Unverified entry.');
      }
      const entryStamp = stamp(info);
      visited.push({ absolute, stamp: entryStamp });
      hash.update(JSON.stringify([relative, info.isDirectory() ? 'dir' : 'file', String(info.ino), String(info.mode)]));
      if (info.isDirectory()) {
        if (await fs.realpath(absolute) !== absolute) throw new Error('Aliased entry.');
        const names = new Set<string>();
        for await (const entry of await fs.opendir(absolute, { encoding: 'buffer' as BufferEncoding })) {
          if (names.size + visited.length >= maxEntries) throw new Error('Baseline exceeds scan limits.');
          const raw = entry.name as unknown as Buffer;
          if (!Buffer.isBuffer(raw)) throw new Error('Unverified filename encoding.');
          const name = utf8.decode(raw);
          if (!name || name === '.' || name === '..' || /[\/\\\u0000-\u001f\u007f]/.test(name)
            || !Buffer.from(name).equals(raw) || names.has(name)) throw new Error('Unverified filename.');
          names.add(name);
        }
        for (const name of [...names].sort()) await visit(path.join(relative, name), depth + 1);
      } else {
        if ((bytes += info.size) > maxBytes) throw new Error('Baseline exceeds byte limit.');
        const input = await fs.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          if (stamp(await input.stat({ bigint: true })) !== entryStamp) throw new Error('Changed file.');
          const file = createHash('sha256');
          for (let remaining = Number(info.size); remaining > 0;) {
            signal?.throwIfAborted();
            const { bytesRead } = await input.read(buffer, 0, Math.min(remaining, buffer.length), null);
            if (bytesRead === 0) throw new Error('Changed file.');
            file.update(buffer.subarray(0, bytesRead));
            remaining -= bytesRead;
          }
          if (stamp(await input.stat({ bigint: true })) !== entryStamp) throw new Error('Changed file.');
          hash.update(file.digest());
        } finally { await input.close(); }
      }
    }
  } catch { return undefined; }
}
