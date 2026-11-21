import type { Stats } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

type WorkspaceRole = 'exec' | 'continuation';
type StorageCategory = 'dependencies' | 'gitMetadata' | 'runtimeControl' | 'links' | 'other';
type ScanIssue = { path: string; reason: string };

interface Usage {
  entries: number;
  apparentBytes: number;
  allocatedBytes: number | null;
}

interface WorkspaceRoot {
  role: WorkspaceRole;
  directory: string;
}

interface InventoryOptions {
  maxEntries?: number;
  maxDepth?: number;
}

export interface WorkspaceInventory {
  directory: string;
  roles: WorkspaceRole[];
  status: 'complete' | 'partial' | 'unavailable';
  total: Usage | null;
  categories: Record<StorageCategory, Usage>;
  largestEntries: Array<Usage & { path: string }>;
  duplicateHardLinks: number;
  issueCount: number;
  issues: ScanIssue[];
}

function usage(): Usage {
  return { entries: 0, apparentBytes: 0, allocatedBytes: 0 };
}

function newInventory(directory: string, role: WorkspaceRole): WorkspaceInventory {
  return {
    directory,
    roles: [role],
    status: 'complete',
    total: null,
    categories: {
      dependencies: usage(),
      gitMetadata: usage(),
      runtimeControl: usage(),
      links: usage(),
      other: usage(),
    },
    largestEntries: [],
    duplicateHardLinks: 0,
    issueCount: 0,
    issues: [],
  };
}

function errorReason(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? 'filesystem_error';
}

function issue(inventory: WorkspaceInventory, relative: string, reason: string): void {
  if (inventory.status === 'complete') inventory.status = 'partial';
  inventory.issueCount++;
  if (inventory.issues.length < 50) inventory.issues.push({ path: relative || '.', reason });
}

function categoryFor(name: string, parent: StorageCategory, depth: number): StorageCategory {
  if (parent !== 'other') return parent;
  if (depth === 1 && (name === '.lark-actions' || name === '.lark-progress')) return 'runtimeControl';
  if (name === '.git') return 'gitMetadata';
  if (name === 'node_modules' || name === 'venv' || name === '.venv' || /^\..+-venv$/.test(name)) {
    return 'dependencies';
  }
  return 'other';
}

function addUsage(target: Usage, stats: Stats, duplicate: boolean): void {
  target.entries++;
  if (duplicate) return;
  if (stats.isFile() || stats.isSymbolicLink()) target.apparentBytes += stats.size;
  if (target.allocatedBytes !== null) {
    target.allocatedBytes = Number.isFinite(stats.blocks) && stats.blocks >= 0
      ? target.allocatedBytes + stats.blocks * 512
      : null;
  }
}

async function scan(
  inventory: WorkspaceInventory,
  rootStats: Stats,
  { maxEntries = 1_000_000, maxDepth = 96 }: InventoryOptions,
): Promise<void> {
  const total = usage();
  inventory.total = total;
  const seenHardLinks = new Set<number>();
  let visited = 0;
  let entryLimit = false;

  async function visit(
    absolute: string,
    relative: string,
    category: StorageCategory,
    depth: number,
    group?: Usage,
    knownStats?: Stats,
  ): Promise<void> {
    if (visited >= maxEntries) {
      entryLimit = true;
      issue(inventory, relative, 'entry_limit');
      return;
    }
    visited++;
    try {
      const stats = knownStats ?? await lstat(absolute);
      if (stats.dev !== rootStats.dev) {
        issue(inventory, relative, 'other_filesystem');
        return;
      }
      if (stats.isSymbolicLink()) category = 'links';
      const hardLink = !stats.isDirectory() && stats.nlink > 1;
      const duplicate = hardLink && seenHardLinks.has(stats.ino);
      if (hardLink) seenHardLinks.add(stats.ino);
      if (duplicate) inventory.duplicateHardLinks++;
      addUsage(total, stats, duplicate);
      addUsage(inventory.categories[category], stats, duplicate);
      if (group) addUsage(group, stats, duplicate);
      if (!stats.isDirectory()) return;
      if (depth >= maxDepth) {
        issue(inventory, relative, 'depth_limit');
        return;
      }
      // Detect paths replaced by a symlink before opening the directory.
      if (await realpath(absolute) !== absolute) {
        issue(inventory, relative, 'directory_changed');
        return;
      }
      const entries = await opendir(absolute);
      for await (const entry of entries) {
        const child = path.join(relative, entry.name);
        const childGroup = group ?? usage();
        await visit(
          path.join(absolute, entry.name),
          child,
          categoryFor(entry.name, category, depth + 1),
          depth + 1,
          childGroup,
        );
        if (!group && childGroup.entries > 0) {
          inventory.largestEntries.push({ path: child, ...childGroup });
          inventory.largestEntries.sort((a, b) =>
            (b.allocatedBytes ?? b.apparentBytes) - (a.allocatedBytes ?? a.apparentBytes)
            || b.apparentBytes - a.apparentBytes
            || a.path.localeCompare(b.path));
          if (inventory.largestEntries.length > 20) inventory.largestEntries.pop();
        }
        if (entryLimit) break;
      }
    } catch (error) {
      issue(inventory, relative, errorReason(error));
    }
  }

  await visit(inventory.directory, '', 'other', 0, undefined, rootStats);
}

export async function inventoryWorkspaceStorage(
  roots: readonly WorkspaceRoot[],
  options: InventoryOptions = {},
): Promise<WorkspaceInventory[]> {
  const results = new Map<string, WorkspaceInventory>();
  for (const { role, directory } of roots) {
    let canonical = path.resolve(directory);
    try {
      canonical = await realpath(canonical);
      const existing = results.get(canonical);
      if (existing) {
        existing.roles.push(role);
        continue;
      }
      const stats = await lstat(canonical);
      if (!stats.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
      const inventory = newInventory(canonical, role);
      results.set(canonical, inventory);
      await scan(inventory, stats, options);
    } catch (error) {
      const existing = results.get(canonical);
      if (existing) {
        existing.roles.push(role);
        continue;
      }
      const inventory = newInventory(canonical, role);
      inventory.status = 'unavailable';
      issue(inventory, '', errorReason(error));
      results.set(canonical, inventory);
    }
  }
  return [...results.values()];
}

const categoryLabels: Record<StorageCategory, string> = {
  dependencies: 'Dependency directories',
  gitMetadata: 'Git metadata',
  runtimeControl: 'Lark turn-control files',
  links: 'Symlinks (targets not scanned)',
  other: 'Other / ownership unknown',
};

export function formatWorkspaceStorage(roots: readonly WorkspaceInventory[]): string {
  const formatBytes = (bytes: number | null) => bytes === null ? 'unavailable' : `${bytes} B`;
  const formatUsage = (value: Usage) =>
    `${formatBytes(value.allocatedBytes)} allocated; ${formatBytes(value.apparentBytes)} apparent; ${value.entries} entries`;
  const lines = [
    'Workspace storage inventory (read-only; no cleanup eligibility inferred).',
    'Sizes are per root, not additive for overlapping roots or a reclaim estimate.',
  ];
  for (const root of roots) {
    lines.push('', `${JSON.stringify(root.directory)} [${root.roles.join(', ')}] (${root.status})`);
    if (root.total) {
      lines.push(`  ${formatUsage(root.total)}`);
      for (const [category, value] of Object.entries(root.categories) as Array<[StorageCategory, Usage]>) {
        if (value.entries > 0) lines.push(`  ${categoryLabels[category]}: ${formatUsage(value)}`);
      }
      if (root.largestEntries.length > 0) lines.push('  Largest entries:');
      for (const entry of root.largestEntries) {
        lines.push(`    ${JSON.stringify(entry.path)}: ${formatUsage(entry)}`);
      }
    }
    if (root.issueCount > 0) lines.push(`  Incomplete scan: ${root.issueCount} issue(s).`);
    for (const entry of root.issues) lines.push(`    ${JSON.stringify(entry.path)}: ${entry.reason}`);
  }
  return lines.join('\n');
}
