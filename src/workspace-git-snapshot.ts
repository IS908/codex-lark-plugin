import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { resolveSystemGit } from './managed-git-launcher.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities,
  readWorkspaceMountTable, workspaceMountLayoutSupported } from './managed-workspace-ancestry.js';
import { MANAGED_GIT_CHECKOUT_LEAF, mkdirGitCheckoutInsidePinnedRun } from './managed-workspace-mkdir.js';
import { pinWorkspacePath, validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const exec = promisify(execFile);
const bareGit = ['--bare', '--git-dir=.', '-c', 'core.warnAmbiguousRefs=false', '-c', 'core.multiPackIndex=false'];
const cacheGit = [...bareGit, '-c', 'core.deltaBaseCacheLimit=16m', '-c', 'core.packedGitLimit=64m'];
// Linux mounts read-only paths as directories when absent. Keep Git's protected file paths explicit.
const readonlyCheckoutFiles = [['commondir', '.\n'], ['config.worktree', '']] as const;
const maxCachePackBytes = 256n * 1024n * 1024n;
const maxCacheIndexBytes = 32n * 1024n * 1024n;
const maxCacheObjects = 250_000;
const maxCheckoutEntries = 25_000;
const maxCheckoutBytes = 256n * 1024n * 1024n;
const maxDependencyInputBytes = 8 * 1024 * 1024;
const repositoryIdentity = z.strictObject({
  // Digest of a trusted repository identity, not a credential-bearing remote URL.
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
type RepositoryIdentity = z.infer<typeof repositoryIdentity>;
type ObjectFormat = 'sha1' | 'sha256';
type SnapshotIdentity = RepositoryIdentity & { objectFormat: ObjectFormat };
type SnapshotRequest = RepositoryIdentity & {
  gitDirectory: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
};

export class WorkspaceGitSnapshotError extends Error {
  constructor(readonly code: 'invalid_snapshot' | 'git_directory_not_self_contained' | 'git_commit_unavailable' | 'git_unavailable'
    | 'git_cache_invalid' | 'git_cache_mismatch' | 'git_checkout_overlap' | 'git_checkout_mount_unsupported' | 'git_checkout_failed'
    | 'git_checkout_changed' | 'git_dependency_input_unavailable') {
    const messages = {
      invalid_snapshot: 'A Git snapshot requires a full commit ID and a valid repository scope.',
      git_directory_not_self_contained: 'The pinned Git directory is not a supported self-contained object store.',
      git_commit_unavailable: 'The exact commit is unavailable in the pinned local Git directory.',
      git_unavailable: 'A trusted local Git executable is unavailable.',
      git_cache_invalid: 'The pinned Git cache is incomplete, contains unexpected objects or metadata, or changed during validation.',
      git_cache_mismatch: 'The local Git cache no longer matches the selected cache identity.',
      git_checkout_overlap: 'The run scratch, source, and Git cache must be separate directories.',
      git_checkout_mount_unsupported: 'The Git checkout does not support nested mounts or mounted subtrees in the selected paths.',
      git_checkout_failed: 'The isolated Git checkout could not be prepared within the supported bounds.',
      git_checkout_changed: 'The isolated Git checkout metadata no longer matches the selected object store.',
      git_dependency_input_unavailable: 'A selected dependency input is not an available, bounded, regular file at the exact Git commit.',
    };
    super(messages[code]);
    this.name = 'WorkspaceGitSnapshotError';
  }
}

export function gitSnapshotKey(identity: SnapshotIdentity): string {
  const { repositoryId, scope, commit, objectFormat } = identity;
  if (!repositoryIdentity.safeParse({ repositoryId, scope, commit }).success
    || (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    || commit.length !== (objectFormat === 'sha1' ? 40 : 64)) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  return createHash('sha256').update(JSON.stringify(['git-snapshot-v1', repositoryId, scope, objectFormat, commit])).digest('hex');
}

// Read-only preflight. Cache provenance and full reachable-object verification belong to the provider.
export async function inspectWorkspaceGitSnapshot(input: SnapshotRequest): Promise<SnapshotIdentity & { key: string }> {
  const { repositoryId, scope, commit } = input;
  if (!repositoryIdentity.safeParse({ repositoryId, scope, commit }).success) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  const binding = await validateWorkspaceProject(input.authorizedRoots, input.gitDirectory);
  await assertProtectedWorkspacePath(binding);
  await requireSelfContainedObjectStore(binding.directory, commit);
  const executable = await trustedGitExecutable();

  let objectFormat: string;
  try {
    const config = (await git(executable, '/', ['--git-dir=/dev/null', 'config',
      '--file', path.join(binding.directory, 'config'), '--no-includes', '--null', '--list'])).toString('utf8');
    if (config.split('\0').some((entry) => /^(?:include(?:if)?\.|core\.worktree\b|extensions\.partialclone\b|remote\..+\.promisor\b)/i.test(entry))) {
      throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
    }
    objectFormat = (await git(executable, binding.directory, [...bareGit, 'rev-parse', '--show-object-format'])).toString('utf8').trim();
  } catch {
    throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
  }
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
  const identity = { repositoryId, scope, commit, objectFormat } satisfies SnapshotIdentity;
  const key = gitSnapshotKey(identity);
  try {
    const result = await git(executable, binding.directory,
      [...bareGit, 'cat-file', '--batch'], `${commit}\n`);
    const separator = result.indexOf(10);
    if (separator < 0) throw new WorkspaceGitSnapshotError('git_commit_unavailable');
    const [returnedId, kind, sizeText] = result.subarray(0, separator).toString('ascii').split(' ');
    const size = Number(sizeText);
    if (returnedId !== commit || kind !== 'commit' || !/^\d+$/.test(sizeText ?? '') || size !== result.length - separator - 2
      || result.at(-1) !== 10 || createHash(objectFormat).update(`commit ${size}\0`)
        .update(result.subarray(separator + 1, -1)).digest('hex') !== commit) throw new WorkspaceGitSnapshotError('git_commit_unavailable');
  } catch {
    throw new WorkspaceGitSnapshotError('git_commit_unavailable');
  }
  await validateWorkspaceProject(input.authorizedRoots, binding);
  await assertProtectedWorkspacePath(binding);
  return { ...identity, key };
}

// The producer must authorize the cache separately and normalize it to one exact commit closure.
export async function verifyWorkspaceGitCache(input: SnapshotRequest): Promise<VerifiedGitCache> {
  return verifyCache(input);
}

type VerifiedGitCache = SnapshotIdentity & {
  key: string;
  storeFingerprint: string;
};

// Admission records the exact local footprint. Full object verification belongs to allocation and launch.
export async function readWorkspaceGitCacheIdentity(input: SnapshotRequest): Promise<VerifiedGitCache> {
  const { repositoryId, scope, commit } = input;
  const objectFormat: ObjectFormat = commit.length === 40 ? 'sha1' : 'sha256';
  const identity = { repositoryId, scope, commit, objectFormat };
  const key = gitSnapshotKey(identity);
  const binding = await validateWorkspaceProject(input.authorizedRoots, input.gitDirectory);
  const { storeFingerprint } = await fingerprintCache(binding, commit, objectFormat).catch(() => {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  });
  return { ...identity, key, storeFingerprint };
}

// Reject stale selections before a caller reserves a run or takes ownership of the cache key.
export async function assertWorkspaceGitCacheIdentity(input: {
  cache: WorkspaceProjectBinding;
  commit: string;
  objectFormat: ObjectFormat;
  storeFingerprint: string;
}, authorizedRoots: SnapshotRequest['authorizedRoots']): Promise<void> {
  const binding = await validateWorkspaceProject(authorizedRoots, input.cache);
  const measured = await fingerprintCache(binding, input.commit, input.objectFormat).catch(() => {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  });
  if (measured.storeFingerprint !== input.storeFingerprint) throw new WorkspaceGitSnapshotError('git_cache_mismatch');
}

export async function readWorkspaceGitDependencyInputs(request: SnapshotRequest,
  expected: Pick<VerifiedGitCache, 'key' | 'storeFingerprint'>, files: readonly string[]): Promise<ReadonlyMap<string, Buffer>> {
  const unavailable = () => new WorkspaceGitSnapshotError('git_dependency_input_unavailable');
  if (files.length < 1 || files.length > 3 || new Set(files).size !== files.length || files.some((file) => file.length > 240
    || !file.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)))) throw unavailable();
  const { gitDirectory, authorizedRoots, commit } = request;
  await assertWorkspaceGitCheckoutMounts([gitDirectory]);
  const measured = await readWorkspaceGitCacheIdentity(request);
  if (measured.key !== expected.key || measured.storeFingerprint !== expected.storeFingerprint) throw new WorkspaceGitSnapshotError('git_cache_mismatch');
  const executable = await trustedGitExecutable();
  const selected = new Map<string, Buffer>();
  for (const file of files) {
    try {
      const entry = await verifyCacheGit(executable, gitDirectory.directory, ['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', file]);
      const separator = entry.indexOf(9);
      if (separator < 0 || entry.at(-1) !== 0 || !entry.subarray(separator + 1, -1).equals(Buffer.from(file))) throw unavailable();
      const fields = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)$/.exec(entry.subarray(0, separator).toString('ascii'));
      if (!fields || fields[1].length !== commit.length) throw unavailable();
      const size = Number(fields[2]);
      if (!Number.isSafeInteger(size) || size > maxDependencyInputBytes) throw unavailable();
      const content = await boundedGit(executable, gitDirectory.directory, [...cacheGit, 'cat-file', 'blob', fields[1]], maxDependencyInputBytes);
      if (content.length !== size || createHash(measured.objectFormat).update(`blob ${size}\0`).update(content).digest('hex') !== fields[1]) throw unavailable();
      selected.set(file, content);
    } catch { throw unavailable(); }
  }
  await assertWorkspaceGitCacheIdentity({ cache: gitDirectory, commit, objectFormat: measured.objectFormat,
    storeFingerprint: expected.storeFingerprint }, authorizedRoots);
  return selected;
}

export async function assertWorkspaceGitCheckoutMounts(bindings: WorkspaceProjectBinding[]): Promise<void> {
  assertLinuxCheckoutMounts(bindings.map(({ directory }) => directory));
}

async function verifyCache(input: SnapshotRequest, trustedExecutable?: string): Promise<VerifiedGitCache> {
  if (!repositoryIdentity.safeParse({ repositoryId: input.repositoryId, scope: input.scope, commit: input.commit }).success) {
    throw new WorkspaceGitSnapshotError('invalid_snapshot');
  }
  const binding = await validateWorkspaceProject(input.authorizedRoots, input.gitDirectory);
  const executable = trustedExecutable ?? await trustedGitExecutable();
  const objectFormat = input.commit.length === 40 ? 'sha1' : 'sha256';
  try {
    const { storeFingerprint, packPath } = await fingerprintCache(binding, input.commit, objectFormat);
    await verifyCacheGit(executable, binding.directory, ['index-pack', '--verify', '--threads=1', packPath]);
    const type = await verifyCacheGit(executable, binding.directory, ['cat-file', '-t', input.commit]);
    if (type.toString('ascii') !== 'commit\n') throw new WorkspaceGitSnapshotError('git_cache_invalid');
    const unreachable = await verifyCacheGit(executable, binding.directory, ['fsck', '--full', '--strict',
      '--no-reflogs', '--no-progress', '--unreachable', input.commit]);
    if (unreachable.length || storeFingerprint !== (await fingerprintCache(binding, input.commit, objectFormat)).storeFingerprint) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
    await validateWorkspaceProject(input.authorizedRoots, binding);
    const identity = { repositoryId: input.repositoryId, scope: input.scope, commit: input.commit, objectFormat } satisfies SnapshotIdentity;
    return { ...identity, key: gitSnapshotKey(identity), storeFingerprint };
  } catch {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
}

interface CheckoutSelection {
  cache: SnapshotRequest;
  expected: { key: string; storeFingerprint: string };
  source: WorkspaceProjectBinding;
  scratch: WorkspaceProjectBinding;
  protectedRoots?: WorkspaceProjectBinding[];
}

async function inspectCheckoutSelection({ cache, expected, source, scratch, protectedRoots = [] }: CheckoutSelection) {
  const { authorizedRoots, gitDirectory } = cache;
  const bindings = await Promise.all([source, scratch, gitDirectory].map((binding) => validateWorkspaceProject(authorizedRoots, binding)));
  await Promise.all([assertProtectedWorkspacePath(source), assertProtectedWorkspacePath(scratch, true), assertProtectedWorkspacePath(gitDirectory)]);
  const ancestors = await Promise.all(bindings.map(({ directory }) => readWorkspaceAncestorIdentities(directory)));
  if (bindings.some((left, index) => bindings.some((right, other) => index !== other && (
    ancestors[other].has(`${left.device}:${left.inode}`) || workspacePathContains(left.directory, right.directory))))) {
    throw new WorkspaceGitSnapshotError('git_checkout_overlap');
  }
  const exclusions = [...bindings, ...await Promise.all(protectedRoots.map((binding) => validateWorkspaceProject(authorizedRoots, binding)))];
  assertLinuxCheckoutMounts(exclusions.map(({ directory }) => directory));
  const objectsPath = path.join(gitDirectory.directory, 'objects');
  if (/[\u0000-\u001f\u007f]/.test(objectsPath)) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  const executable = await trustedGitExecutable();
  const snapshot = await verifyCache(cache, executable);
  if (snapshot.key !== expected.key || snapshot.storeFingerprint !== expected.storeFingerprint) {
    throw new WorkspaceGitSnapshotError('git_cache_mismatch');
  }
  return { bindings, objectsPath, executable, snapshot };
}

// Only initializes a new run-owned directory. The caller must exclude the cache from all run writable roots.
// Git alternates share object access but do not make the cache read-only.
export async function createWorkspaceGitCheckout(selection: CheckoutSelection) {
  const { cache: { authorizedRoots, gitDirectory }, scratch } = selection;
  const { bindings, objectsPath, executable, snapshot } = await inspectCheckoutSelection(selection);

  const checkoutGit = ['--git-dir=.git', '--work-tree=.', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', '-c', 'core.autocrlf=false',
    '-c', 'core.deltaBaseCacheLimit=16m', '-c', 'core.packedGitLimit=64m'];
  let tree: CheckoutTree;
  try {
    tree = readCheckoutTree(await boundedGit(executable, gitDirectory.directory,
      [...cacheGit, 'ls-tree', '-rltz', '--full-tree', snapshot.commit], 8 * 1024 * 1024));
  } catch {
    throw new WorkspaceGitSnapshotError('git_checkout_failed');
  }

  const checkout = await mkdirGitCheckoutInsidePinnedRun(scratch);
  try {
    await validateWorkspaceProject(authorizedRoots, checkout);
    await assertProtectedWorkspacePath(checkout, true);
    await boundedGit(executable, checkout.directory,
      [...checkoutGit, 'init', '--quiet', '--template=', `--object-format=${snapshot.objectFormat}`]);
    const localGit = await pinWorkspacePath(checkout.directory, '.git');
    if (localGit.directory !== path.join(checkout.directory, '.git')) throw new WorkspaceGitSnapshotError('git_checkout_failed');
    const localInfo = await pinWorkspacePath(localGit.directory, 'objects/info');
    if (localInfo.directory !== path.join(localGit.directory, 'objects', 'info')) throw new WorkspaceGitSnapshotError('git_checkout_failed');
    await assertProtectedWorkspacePath(localInfo, true);
    await fs.writeFile(path.join(localInfo.directory, 'alternates'), `${objectsPath}\n`, { flag: 'wx', mode: 0o600 });
    for (const [file, contents] of readonlyCheckoutFiles) {
      await fs.writeFile(path.join(localGit.directory, file), contents, { flag: 'wx', mode: 0o600 });
    }
    if (tree.hasAttributes) await assertCheckoutConversionsWithinBounds(executable, checkout.directory, checkoutGit, snapshot.commit, tree);
    await reserveCheckoutNames(checkout.directory, tree.names);
    await boundedGit(executable, checkout.directory,
      [...checkoutGit, 'checkout', '--detach', '--force', '--quiet', '--no-recurse-submodules', snapshot.commit]);
    await validateCheckoutFiles(checkout, localGit, tree.files.length);
    const head = await boundedGit(executable, checkout.directory, [...checkoutGit, 'rev-parse', '--verify', 'HEAD']);
    if (head.toString('ascii') !== `${snapshot.commit}\n`
      || (await fingerprintCache(gitDirectory, snapshot.commit, snapshot.objectFormat)).storeFingerprint !== snapshot.storeFingerprint) {
      throw new WorkspaceGitSnapshotError('git_checkout_failed');
    }
    await Promise.all([...bindings, checkout, localGit].map((binding) => validateWorkspaceProject(authorizedRoots, binding)));
    return { checkout, gitDirectory: localGit, snapshot };
  } catch {
    // Uncertain directories are left in place for the run owner to reconcile; never overwrite or clean them here.
    throw new WorkspaceGitSnapshotError('git_checkout_failed');
  }
}

export async function validateWorkspaceGitCheckout(selection: CheckoutSelection, allocation: {
  checkout: WorkspaceProjectBinding;
  gitDirectory: WorkspaceProjectBinding;
}): Promise<void> {
  const { checkout, gitDirectory } = allocation;
  const roots = selection.cache.authorizedRoots;
  if (checkout.directory !== path.join(selection.scratch.directory, MANAGED_GIT_CHECKOUT_LEAF)
    || gitDirectory.directory !== path.join(checkout.directory, '.git')) throw new WorkspaceGitSnapshotError('git_checkout_changed');
  await Promise.all([checkout, gitDirectory].map((binding) => validateWorkspaceProject(roots, binding)));
  const { objectsPath, snapshot } = await inspectCheckoutSelection(selection);
  try {
    // Local HEAD, index and config are run-owned. Never invoke host Git in a resumed checkout.
    const info = await pinWorkspacePath(gitDirectory.directory, 'objects/info');
    if (info.directory !== path.join(gitDirectory.directory, 'objects', 'info')) throw new Error('Displaced object metadata.');
    await assertProtectedWorkspacePath(info, true);
    const hasHttpAlternates = await fs.lstat(path.join(info.directory, 'http-alternates')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (hasHttpAlternates) throw new Error('Unexpected Git metadata indirection.');
    for (const [name, contents] of [...readonlyCheckoutFiles, ['objects/info/alternates', `${objectsPath}\n`]]) {
      const file = path.join(gitDirectory.directory, name);
      const stat = await fs.lstat(file, { bigint: true });
      const payload = Buffer.from(contents);
      if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(payload.length)
        || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o022n) !== 0n) throw new Error('Invalid fixed Git metadata.');
      await assertDenyOnlyWorkspaceAcls([file]);
      if (!(await readPinnedCachePrefix(file, stat, payload.length)).equals(payload)) throw new Error('Changed fixed Git metadata.');
    }
    const { gitDirectory: cache } = selection.cache;
    if ((await fingerprintCache(cache, snapshot.commit, snapshot.objectFormat)).storeFingerprint !== snapshot.storeFingerprint) {
      throw new WorkspaceGitSnapshotError('git_cache_mismatch');
    }
  } catch (error) {
    if (error instanceof WorkspaceGitSnapshotError && error.code === 'git_cache_mismatch') throw error;
    throw new WorkspaceGitSnapshotError('git_checkout_changed');
  }
  await Promise.all([checkout, gitDirectory].map((binding) => validateWorkspaceProject(roots, binding)));
}

interface CheckoutTree {
  files: { name: string; bytes: bigint }[];
  names: { path: string; directory: boolean }[];
  hasAttributes: boolean;
}

function readCheckoutTree(result: Buffer): CheckoutTree {
  if (result.length && result.at(-1) !== 0) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  const entries = result.toString('latin1').split('\0');
  if (entries.length > maxCheckoutEntries + 1) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  const files: CheckoutTree['files'] = [];
  const names: CheckoutTree['names'] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let hasAttributes = false;
  let rawBytes = 0n;
  for (const entry of entries.slice(0, -1)) {
    const tab = entry.indexOf('\t');
    const fields = /^([0-7]{6}) (blob|commit|tree) [a-f0-9]+ +([0-9]+|-)$/u.exec(entry.slice(0, tab));
    if (tab < 0 || !fields) throw new WorkspaceGitSnapshotError('git_checkout_failed');
    const name = entry.slice(tab + 1);
    const decodedPath = decoder.decode(Buffer.from(name, 'latin1'));
    if (decodedPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new WorkspaceGitSnapshotError('git_checkout_failed');
    }
    const directory = (fields[1] === '160000' && fields[2] === 'commit' || fields[1] === '040000' && fields[2] === 'tree') && fields[3] === '-';
    names.push({ path: decodedPath, directory });
    if (directory) continue;
    if (!['100644', '100755', '120000'].includes(fields[1]) || fields[2] !== 'blob' || fields[3] === '-') {
      throw new WorkspaceGitSnapshotError('git_checkout_failed');
    }
    const bytes = BigInt(fields[3]);
    hasAttributes ||= /(^|\/)\.gitattributes$/i.test(name);
    rawBytes += bytes;
    if (rawBytes > maxCheckoutBytes) throw new WorkspaceGitSnapshotError('git_checkout_failed');
    files.push({ name, bytes });
  }
  return { files, names, hasAttributes };
}

async function reserveCheckoutNames(root: string, names: CheckoutTree['names']): Promise<void> {
  // Exclusive, empty entries let the destination filesystem detect equivalent names before any blob is written.
  const directories = [root];
  const knownAttributes = new Set<string>();
  for (const entry of names) {
    const destination = path.join(root, entry.path);
    if (entry.directory) {
      await fs.mkdir(destination, { mode: 0o700 });
      directories.push(destination);
    } else {
      await (await fs.open(destination, 'wx', 0o600)).close();
      if (path.basename(destination) === '.gitattributes') knownAttributes.add(destination);
    }
  }
  for (const directory of directories) {
    const attributes = path.join(directory, '.gitattributes');
    if (knownAttributes.has(attributes)) continue;
    const alias = await fs.lstat(attributes).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (alias) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  }
}

function assertLinuxCheckoutMounts(workspaces: string[]): void {
  try {
    const mounts = readWorkspaceMountTable();
    if (!workspaceMountLayoutSupported(workspaces, mounts)) throw new Error('Unsupported workspace mount.');
  } catch {
    throw new WorkspaceGitSnapshotError('git_checkout_mount_unsupported');
  }
}

async function assertCheckoutConversionsWithinBounds(
  executable: string, directory: string, checkoutGit: string[], commit: string, tree: CheckoutTree,
): Promise<void> {
  await boundedGit(executable, directory, [...checkoutGit, 'read-tree', commit]);
  const attributes = await boundedGit(executable, directory, [...checkoutGit, 'check-attr', '--cached', '-z', '--stdin',
    'ident', 'working-tree-encoding'], 24 * 1024 * 1024, Buffer.from(`${tree.files.map(({ name }) => name).join('\0')}\0`, 'latin1'));
  const values = attributes.toString('latin1').split('\0');
  if (values.length !== tree.files.length * 6 + 1) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  let worstCase = 0n;
  const switchedOff = (value: string) => value === 'unspecified' || value === 'unset';
  for (const [index, { name, bytes }] of tree.files.entries()) {
    const [first, identAttr, ident, second, encodingAttr, encoding] = values.slice(index * 6, index * 6 + 6);
    if (first !== name || second !== name || identAttr !== 'ident' || encodingAttr !== 'working-tree-encoding' || !switchedOff(encoding)) {
      throw new WorkspaceGitSnapshotError('git_checkout_failed');
    }
    // CRLF can double bytes; expanding each $Id$ to a full SHA-256 identity costs less than 24x.
    worstCase += bytes * (switchedOff(ident) ? 2n : 48n);
    if (worstCase > maxCheckoutBytes) throw new WorkspaceGitSnapshotError('git_checkout_failed');
  }
}

async function validateCheckoutFiles(checkout: WorkspaceProjectBinding, gitDirectory: WorkspaceProjectBinding, expected: number): Promise<void> {
  const pending = [checkout.directory];
  let entries = 0;
  let files = 0;
  let actualBytes = 0n;
  while (pending.length) {
    const parent = pending.pop()!;
    for await (const entry of await fs.opendir(parent)) {
      const child = path.join(parent, entry.name);
      if (child === gitDirectory.directory) continue;
      if (++entries > maxCheckoutEntries) throw new WorkspaceGitSnapshotError('git_checkout_failed');
      const info = await fs.lstat(child, { bigint: true });
      if (info.isDirectory()) pending.push(child);
      else if (info.isFile()) {
        files++;
        actualBytes += info.size;
      } else if (info.isSymbolicLink()) {
        const target = await fs.readlink(child);
        const resolved = path.resolve(parent, target);
        if (path.isAbsolute(target) || !workspacePathContains(checkout.directory, resolved)) {
          throw new WorkspaceGitSnapshotError('git_checkout_failed');
        }
        const canonical = await fs.realpath(child);
        if (!workspacePathContains(checkout.directory, canonical) || workspacePathContains(gitDirectory.directory, canonical)) {
          throw new WorkspaceGitSnapshotError('git_checkout_failed');
        }
        const targetInfo = await fs.stat(canonical);
        const ancestors = await readWorkspaceAncestorIdentities(targetInfo.isDirectory() ? canonical : path.dirname(canonical));
        if (ancestors.has(`${gitDirectory.device}:${gitDirectory.inode}`)) throw new WorkspaceGitSnapshotError('git_checkout_failed');
        files++;
        actualBytes += info.size;
      } else throw new WorkspaceGitSnapshotError('git_checkout_failed');
      if (actualBytes > maxCheckoutBytes) throw new WorkspaceGitSnapshotError('git_checkout_failed');
    }
  }
  if (files !== expected) throw new WorkspaceGitSnapshotError('git_checkout_failed');
}

async function fingerprintCache(binding: WorkspaceProjectBinding, commit: string, format: ObjectFormat): Promise<{
  storeFingerprint: string;
  packPath: string;
}> {
  const { directory, device, inode } = binding;
  await assertProtectedWorkspacePath(binding);
  const stamp: string[][] = [];
  const uid = process.geteuid?.();
  if (uid === undefined) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const record = async (relative: string, isDirectory: boolean) => {
    const file = path.join(directory, relative);
    const info = await fs.lstat(file, { bigint: true });
    if ((isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
      || String(info.dev) !== device || (info.uid !== 0n && info.uid !== BigInt(uid)) || (info.mode & 0o022n) !== 0n) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
    await assertDenyOnlyWorkspaceAcls([file]);
    stamp.push([relative, ...[info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs].map(String)]);
    return info;
  };
  const names = async (relative: string, max: number) => {
    const entries: string[] = [];
    for await (const entry of await fs.opendir(path.join(directory, relative))) {
      if (entries.length >= max) throw new WorkspaceGitSnapshotError('git_cache_invalid');
      entries.push(entry.name);
    }
    return entries.sort().join('\n');
  };
  if (String((await record('.', true)).ino) !== inode || await names('.', 4) !== 'HEAD\nconfig\nobjects\nrefs') {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  await record('refs', true);
  await record('objects', true);
  await record('objects/pack', true);
  if (await names('refs', 0) !== '' || await names('objects', 1) !== 'pack') {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  const pack = new RegExp(`^pack-([a-f0-9]{${commit.length}})\\.idx\\npack-\\1\\.pack$`)
    .exec(await names('objects/pack', 2));
  if (!pack) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const packPath = `objects/pack/pack-${pack[1]}.pack`;
  const idx = await record(`objects/pack/pack-${pack[1]}.idx`, false);
  const packInfo = await record(packPath, false);
  if (idx.size > maxCacheIndexBytes || packInfo.size > maxCachePackBytes) throw new WorkspaceGitSnapshotError('git_cache_invalid');
  const header = await readPinnedCachePrefix(path.join(directory, packPath), packInfo, 12);
  if (header.subarray(0, 4).toString('ascii') !== 'PACK' || header.readUInt32BE(8) > maxCacheObjects) {
    throw new WorkspaceGitSnapshotError('git_cache_invalid');
  }
  const config = format === 'sha1' ? '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'
    : '[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n';
  for (const [file, expected] of [['HEAD', `${commit}\n`], ['config', config]]) {
    const info = await record(file, false);
    if (info.size !== BigInt(expected.length)
      || (await readPinnedCachePrefix(path.join(directory, file), info, expected.length)).toString('utf8') !== expected) {
      throw new WorkspaceGitSnapshotError('git_cache_invalid');
    }
  }
  return { storeFingerprint: createHash('sha256').update(JSON.stringify(['git-cache-footprint-v1', stamp])).digest('hex'), packPath };
}

async function readPinnedCachePrefix(file: string, expected: BigIntStats, length: number): Promise<Buffer> {
  const fd = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await fd.stat({ bigint: true });
    if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size
      || info.mtimeNs !== expected.mtimeNs || info.ctimeNs !== expected.ctimeNs) throw new WorkspaceGitSnapshotError('git_cache_invalid');
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await fd.read(bytes, 0, length, 0);
    if (bytesRead !== length) throw new WorkspaceGitSnapshotError('git_cache_invalid');
    return bytes;
  } finally {
    await fd.close();
  }
}

async function requireSelfContainedObjectStore(directory: string, commit: string): Promise<void> {
  const objects = path.join(directory, 'objects');
  const info = path.join(objects, 'info');
  const pack = path.join(objects, 'pack');
  const loose = path.join(objects, commit.slice(0, 2));
  const exists = (file: string) => fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const requireStore = async () => {
    const uid = process.geteuid?.();
    if (uid === undefined) return false;
    const safeFiles: string[] = [];
    const trusted = (entry: NonNullable<Awaited<ReturnType<typeof exists>>>) =>
      (entry.uid === uid || entry.uid === 0) && (entry.mode & 0o022) === 0;
    const check = async (file: string, type: 'file' | 'directory', optional = false) => {
      const entry = await exists(file);
      if (!entry) return optional;
      if (!trusted(entry) || (type === 'file' ? !entry.isFile() : !entry.isDirectory())) return false;
      if (type === 'directory') await assertDenyOnlyWorkspaceAcls([file]);
      else safeFiles.push(file);
      return true;
    };
    for (const file of ['HEAD', 'config']) if (!await check(path.join(directory, file), 'file')) return false;
    if (!await check(path.join(directory, 'packed-refs'), 'file', true) || !await check(objects, 'directory')) return false;
    for (const child of [info, pack, loose]) {
      if (!await check(child, 'directory', true)) return false;
    }
    for (const redirected of [path.join(directory, 'commondir'), path.join(directory, 'config.worktree'),
      path.join(info, 'alternates'), path.join(info, 'http-alternates')]) {
      if (await exists(redirected)) return false;
    }
    if (!await check(path.join(loose, commit.slice(2)), 'file', true)) return false;
    if (await exists(pack)) {
      let count = 0;
      for await (const entry of await fs.opendir(pack)) {
        if (++count > 2048 || !await check(path.join(pack, entry.name), 'file')) return false;
      }
    }
    const refs = path.join(directory, 'refs');
    if (!await check(refs, 'directory', true)) return false;
    const pending = await exists(refs) ? [refs] : [];
    let refCount = 0;
    while (pending.length) {
      const root = pending.pop()!;
      for await (const entry of await fs.opendir(root)) {
        const child = path.join(root, entry.name);
        if (++refCount > 4096 || !await check(child, entry.isDirectory() ? 'directory' : 'file')) return false;
        if (entry.isDirectory()) pending.push(child);
      }
    }
    for (let index = 0; index < safeFiles.length; index += 64) {
      await assertDenyOnlyWorkspaceAcls(safeFiles.slice(index, index + 64));
    }
    return true;
  };
  if (!await requireStore().catch(() => false)) throw new WorkspaceGitSnapshotError('git_directory_not_self_contained');
}

async function trustedGitExecutable(): Promise<string> {
  return resolveSystemGit().catch(() => { throw new WorkspaceGitSnapshotError('git_unavailable'); });
}

function verifyCacheGit(executable: string, cwd: string, args: string[]): Promise<Buffer> {
  return boundedGit(executable, cwd, [...cacheGit, ...args]);
}

function boundedGit(executable: string, cwd: string, args: string[], maxBuffer?: number, input?: Buffer): Promise<Buffer> {
  // Darwin does not support this address-space limit; still bound input, allocations, and time there.
  if (process.platform === 'linux') {
    return git('/bin/sh', cwd, ['-c', 'ulimit -v 786432 || exit 125; exec "$@"', 'lark-git-verifier',
      executable, ...args], input, 60_000, maxBuffer);
  }
  return git(executable, cwd, args, input, 60_000, maxBuffer);
}

async function git(executable: string, cwd: string, args: string[], input?: string | Buffer, timeout = 10_000, maxBuffer = 256 * 1024): Promise<Buffer> {
  const running = exec(executable, args, {
    cwd, timeout, killSignal: 'SIGKILL', maxBuffer, encoding: 'buffer',
    env: {
      PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOC_LIMIT: '67108864',
      GIT_ATTR_NOSYSTEM: '1',
    },
  });
  running.child.stdin?.on('error', () => {});
  running.child.stdin?.end(input);
  return (await running).stdout;
}
