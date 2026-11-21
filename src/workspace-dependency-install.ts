import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ManagedRunOwner } from './domain/managed-workspace.js';
import { workspaceDependencyInstallLeaf, workspaceDependencyInstallReceiptSchema, workspaceDependencyOutputName,
  workspaceDependencySelectionSchema, workspaceDependencyToolchainBindingDigest, workspaceDependencyToolchainConfigSchema,
  type WorkspaceDependencyEcosystem, type WorkspaceDependencyInstallReceipt, type WorkspaceDependencySelection,
  type WorkspaceDependencyToolchainConfig } from './domain/workspace-dependency.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities } from './managed-workspace-ancestry.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import { MANAGED_GIT_CHECKOUT_LEAF, mkdirTemporaryInsidePinnedRoot } from './managed-workspace-mkdir.js';
import type { ManagedWorkspaceStore } from './ports/managed-workspace.js';
import type { WorkspaceDependencyExpansionLimits } from './workspace-dependency-archive.js';
import { MAX_WORKSPACE_DEPENDENCY_SNAPSHOT_BYTES, verifyWorkspaceDependencyCache, WorkspaceDependencyCacheError } from './workspace-dependency-cache.js';
import type { WorkspaceDependencyInput } from './workspace-dependency-input.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { runWorkspaceDependencyProcess, WorkspaceDependencyProcessError } from './workspace-dependency-process.js';
import { loadWorkspaceDependencyWriteGuard } from './workspace-dependency-registry.js';
import { prepareWorkspaceDependencySandbox } from './workspace-dependency-sandbox.js';
import { inspectWorkspaceDependencyToolchain, probeWorkspaceDependencyToolchain, workspaceDependencyPipBootstrap } from './workspace-dependency-toolchain.js';
import { pinWorkspacePath, validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const pipInstall = workspaceDependencyPipBootstrap + `
from pip._internal.cli.main import main
raise SystemExit(main(sys.argv[3:]))
`;
const installLimitMs = 45_000;
const outputLimitBytes = 64 * 1024;
const maxInstalledEntries = 200_000;
const maxInstalledBytes = 4n * 1024n ** 3n;
const maxInstalledDepth = 96;
const filesystemUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const exec = promisify(execFile);

export class WorkspaceDependencyInstallError extends Error {
  constructor(readonly code: 'dependency_install_selection_mismatch' | 'dependency_install_storage_invalid'
    | 'dependency_install_failed' | 'dependency_install_timeout' | 'dependency_install_output_limit'
    | 'dependency_install_output_conflict' | 'dependency_installed_output_invalid') {
    super({
      dependency_install_selection_mismatch: 'The offline install inputs do not match the saved dependency selection.',
      dependency_install_storage_invalid: 'The offline installer cannot use the requested private staging location.',
      dependency_install_failed: 'Dependency installation failed in the private offline sandbox.',
      dependency_install_timeout: 'The private offline dependency installation exceeded its time limit.',
      dependency_install_output_limit: 'The private offline dependency installation exceeded its log limit.',
      dependency_install_output_conflict: 'The isolated checkout already contains a node_modules path that cannot be replaced.',
      dependency_installed_output_invalid: 'Installed dependencies failed private output validation.',
    }[code]);
  }
}

/** Produces an owned private candidate only; publication and restart validation are separate. */
export async function installWorkspaceDependencyInStaging(request: {
  codexCommand: string;
  temporaryRoot: WorkspaceProjectBinding;
  authorizedRoots: readonly [string, ...string[]];
  configPath?: string;
  input: WorkspaceDependencyInput;
  artifactManifest: unknown;
  selection: WorkspaceDependencySelection;
  configured: WorkspaceDependencyToolchainConfig;
  expansionLimits?: WorkspaceDependencyExpansionLimits;
  reservedNonce?: string;
}) {
  const selected = workspaceDependencySelectionSchema.safeParse(request.selection);
  const tool = workspaceDependencyToolchainConfigSchema.safeParse(request.configured);
  if (!selected.success || !tool.success || selected.data.identity.ecosystem !== tool.data.ecosystem
    || selected.data.identity.ecosystem !== request.input.ecosystem || !selected.data.toolchainFingerprint
    || !selected.data.toolchainBindingDigest || selected.data.toolchainBindingDigest !== workspaceDependencyToolchainBindingDigest(tool.data)) {
    fail('dependency_install_selection_mismatch');
  }
  const { data: selection } = selected;
  const { data: configured } = tool;
  const input = request.input.ecosystem === 'npm' ? { ...request.input, lock: Buffer.from(request.input.lock), manifest: Buffer.from(request.input.manifest) }
    : { ...request.input, lock: Buffer.from(request.input.lock) };
  const artifactManifest = structuredClone(request.artifactManifest);
  const verifyCache = async (inspectExpansion = false, snapshot?: WorkspaceProjectBinding) => {
    const verified = await verifyWorkspaceDependencyCache({ input, artifactManifest, cache: selection.cache,
      authorizedRoots: request.authorizedRoots, expectedFingerprint: selection.cacheFingerprint, inspectExpansion,
      expansionLimits: request.expansionLimits, snapshot });
    if (verified.identity.key !== selection.identity.key || verified.artifactManifestSha256 !== selection.artifactManifestSha256) {
      fail('dependency_install_selection_mismatch');
    }
    return verified;
  };
  const verified = await verifyCache(true);
  if (verified.bytes > MAX_WORKSPACE_DEPENDENCY_SNAPSHOT_BYTES) throw new WorkspaceDependencyCacheError('dependency_snapshot_limit');
  const mounts = await readWorkspaceDependencyMountPolicy();
  const aliasesOverlap = (left: string, right: string) => mounts.aliases(left).some((a) =>
    mounts.aliases(right).some((b) => mounts.contains(a, b) || mounts.contains(b, a)));
  const cacheAncestors = await readWorkspaceAncestorIdentities(selection.cache.directory);
  for (const readonly of [configured.runtime, configured.installer]) {
    const toolchainAncestors = await readWorkspaceAncestorIdentities(readonly.directory);
    if (cacheAncestors.has(`${readonly.device}:${readonly.inode}`)
      || toolchainAncestors.has(`${selection.cache.device}:${selection.cache.inode}`)
      || aliasesOverlap(selection.cache.directory, readonly.directory)) fail('dependency_install_storage_invalid');
  }
  const guard = await loadWorkspaceDependencyWriteGuard(request.configPath);
  const parent = await validateWorkspaceProject(request.temporaryRoot.directory, request.temporaryRoot);
  await assertProtectedWorkspacePath(parent, false, true);
  const nonce = request.reservedNonce ?? randomBytes(12).toString('hex');
  const leaf = workspaceDependencyInstallLeaf(nonce);
  const snapshotLeaf = `lark-dependency-snapshot-${nonce}`;
  const planned = path.join(parent.directory, leaf);
  const ancestors = await readWorkspaceAncestorIdentities(parent.directory);
  if (!mounts.supports(planned) || [selection.cache, configured.runtime, configured.installer].some((root) =>
    ancestors.has(`${root.device}:${root.inode}`) || aliasesOverlap(root.directory, planned))) fail('dependency_install_storage_invalid');
  await guard?.assertNewDirectory(planned);
  const snapshotPath = path.join(parent.directory, snapshotLeaf);
  if (!mounts.supports(snapshotPath)) fail('dependency_install_storage_invalid');
  await guard?.assertNewDirectory(snapshotPath);
  const inspected = await probeWorkspaceDependencyToolchain({ configured, codexCommand: request.codexCommand,
    temporaryRoot: parent, configPath: request.configPath, expectedFingerprint: selection.toolchainFingerprint });
  const current = inspected.toolchain;
  const recorded = selection.identity.toolchain;
  if (current.runtime !== recorded.runtime || current.installer !== recorded.installer || current.abi !== recorded.abi
    || current.platform !== recorded.platform || current.arch !== recorded.arch || current.platformAbi !== recorded.platformAbi) {
    fail('dependency_install_selection_mismatch');
  }
  let staging: WorkspaceProjectBinding | undefined;
  const snapshot = await mkdirTemporaryInsidePinnedRoot(parent, snapshotLeaf);
  let safeToRemove = true;
  try {
    // Copy from the same descriptors used to authenticate every byte. The installer sees only the admitted snapshot.
    await verifyCache(false, snapshot);
    staging = await mkdirTemporaryInsidePinnedRoot(parent, leaf);
    const cwd = staging.directory;
    const launch = await prepareWorkspaceDependencySandbox({ codexCommand: request.codexCommand, configured, staging,
      artifacts: snapshot, protectedBindings: guard?.protectedBindings });
    const write = (name: string, bytes: string | Uint8Array) => fs.writeFile(path.join(cwd, name), bytes, { flag: 'wx', mode: 0o600 });
    let args: string[];
    const outputName = workspaceDependencyOutputName(input.ecosystem);
    if (input.ecosystem === 'npm') {
      if (selection.identity.ecosystem !== 'npm') fail('dependency_install_selection_mismatch');
      await write('package.json', input.manifest);
      await write('package-lock.json', verified.stagedLock);
      await write('installer-user.npmrc', '');
      await write('installer-global.npmrc', '');
      args = ['--no-global-search-paths', inspected.entrypoint, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
        '--no-progress', '--no-update-notifier', '--logs-max=0', '--fetch-retries=0', '--include=dev', '--include=optional', '--include=peer',
        `--userconfig=${path.join(cwd, 'installer-user.npmrc')}`, `--globalconfig=${path.join(cwd, 'installer-global.npmrc')}`,
        `--registry=${selection.identity.registry}`, `--cache=${snapshot.directory}`];
    } else {
      await write('requirements.lock', verified.stagedLock);
      args = ['-I', '-S', '-B', '-c', pipInstall, configured.runtime.directory, configured.installer.directory,
        '--isolated', '--disable-pip-version-check', '--no-cache-dir', 'install', '--no-index',
        `--find-links=${snapshot.directory}`, '--only-binary=:all:', '--require-hashes', '--ignore-installed', '--no-compile',
        `--target=${path.join(cwd, outputName)}`, `--requirement=${path.join(cwd, 'requirements.lock')}`];
    }
    await assertProtectedWorkspacePath(staging, true);
    await runWorkspaceDependencyProcess(launch, args, cwd, installLimitMs, outputLimitBytes);
    await verifyCache();
    await inspectWorkspaceDependencyToolchain(configured, selection.toolchainFingerprint);
    await assertProtectedWorkspacePath(staging, true);
    // An empty graph (or a graph consisting only of skipped optional packages) can create no directory.
    if (input.ecosystem === 'npm') {
      const destination = path.join(cwd, outputName);
      const exists = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!exists) await fs.mkdir(destination, { mode: 0o700 });
    }
    const output = await pinWorkspacePath(cwd, outputName);
    if (output.directory !== path.join(cwd, outputName)) fail('dependency_installed_output_invalid');
    const measurement = await measureWorkspaceDependencyOutput(output, input.ecosystem);
    return { staging, output, measurement };
  } catch (error) {
    safeToRemove = !(error instanceof WorkspaceDependencyProcessError) || error.quiescent;
    if (staging && safeToRemove) {
      await assertProtectedWorkspacePath(staging, true);
      await fs.rm(staging.directory, { recursive: true, force: true });
    }
    if (error instanceof WorkspaceDependencyProcessError) {
      fail(error.reason === 'timeout' ? 'dependency_install_timeout' : error.reason === 'output'
        ? 'dependency_install_output_limit' : 'dependency_install_failed');
    }
    throw error;
  } finally {
    if (safeToRemove) {
      await assertProtectedWorkspacePath(snapshot, true);
      await fs.rm(snapshot.directory, { recursive: true, force: true });
    }
  }
}

interface Publication {
  scratch: WorkspaceProjectBinding;
  checkout: WorkspaceProjectBinding;
  ecosystem: WorkspaceDependencyEcosystem;
  nonce: string;
  receipt: WorkspaceDependencyInstallReceipt;
}

export async function ensureManagedWorkspaceDependencyOutput(store: ManagedWorkspaceStore, owner: ManagedRunOwner,
  ecosystem: WorkspaceDependencyEcosystem, install: (nonce: string) => Promise<WorkspaceDependencyInstallReceipt>): Promise<WorkspaceDependencyInstallReceipt> {
  const allocation = store.get(owner)?.allocation;
  if (!allocation?.gitCheckout || !allocation.dependencySelections?.some(({ identity }) => identity.ecosystem === ecosystem)) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  const locations = { scratch: allocation.scratch, checkout: allocation.gitCheckout.checkout, ecosystem };
  const recorded = store.getDependencyInstall(owner, ecosystem);
  if (recorded) {
    if (!recorded.receipt) throw new ManagedWorkspaceStorageError('dependency_install_incomplete');
    await validatePublishedWorkspaceDependencyOutput({ ...locations, nonce: recorded.nonce, receipt: recorded.receipt });
    return recorded.receipt;
  }
  const nonce = randomBytes(12).toString('hex');
  store.reserveDependencyInstall(owner, ecosystem, nonce);
  // A failed or interrupted publication must never adopt an uncommitted filesystem result on replay.
  const { output, measurement } = await install(nonce);
  const receipt = { output, measurement };
  await publishWorkspaceDependencyOutput({ ...locations, nonce, receipt });
  store.completeDependencyInstall(owner, ecosystem, nonce, receipt);
  return receipt;
}

// Hold the checkout as cwd and let symlink(2) refuse any existing name atomically.
const attachNpmOutput = String.raw`
  const fs = require('node:fs');
  const [directory, dev, ino, target] = process.argv.slice(1);
  const root = fs.statSync('.', { bigint: true });
  if (process.cwd() !== directory || String(root.dev) !== dev || String(root.ino) !== ino
    || !process.geteuid || root.uid !== BigInt(process.geteuid()) || (root.mode & 0o022n) !== 0n) process.exit(1);
  try { fs.symlinkSync(target, 'node_modules', 'dir'); }
  catch (error) { process.exit(error.code === 'EEXIST' ? 2 : 1); }
`;

export async function publishWorkspaceDependencyOutput(request: Publication): Promise<void> {
  await validateReceiptTree(request);
  if (request.ecosystem === 'pip') return;
  const { checkout, receipt } = request;
  try {
    await exec(process.execPath, ['--input-type=commonjs', '-e', attachNpmOutput, '--', checkout.directory, checkout.device,
      checkout.inode, path.relative(checkout.directory, receipt.output.directory)], { cwd: checkout.directory, env: {}, timeout: 10_000, maxBuffer: 1024 });
  } catch (error) {
    return fail((error as { code?: unknown }).code === 2 ? 'dependency_install_output_conflict' : 'dependency_installed_output_invalid');
  }
  await validateNpmAttachment(request);
}

export async function validatePublishedWorkspaceDependencyOutput(request: Publication): Promise<void> {
  await validateReceiptTree(request);
  if (request.ecosystem === 'npm') await validateNpmAttachment(request);
}

async function validateReceiptTree({ scratch, checkout, ecosystem, receipt, nonce }: Publication): Promise<void> {
  try {
    workspaceDependencyInstallReceiptSchema.parse(receipt);
    if (checkout.directory !== path.join(scratch.directory, MANAGED_GIT_CHECKOUT_LEAF)
      || checkout.device !== scratch.device || receipt.output.device !== scratch.device
      || receipt.output.directory !== path.join(scratch.directory, workspaceDependencyInstallLeaf(nonce), workspaceDependencyOutputName(ecosystem))) {
      fail('dependency_installed_output_invalid');
    }
    await assertProtectedWorkspacePath(scratch, true);
    await assertProtectedWorkspacePath(checkout, true);
    if (ecosystem === 'npm' && !(await readWorkspaceDependencyMountPolicy()).supports(checkout.directory)) fail('dependency_installed_output_invalid');
    const actual = await measureWorkspaceDependencyOutput(receipt.output, ecosystem);
    if (actual.digest !== receipt.measurement.digest || actual.entries !== receipt.measurement.entries || actual.bytes !== receipt.measurement.bytes) {
      fail('dependency_installed_output_invalid');
    }
  } catch { return fail('dependency_installed_output_invalid'); }
}

async function validateNpmAttachment({ checkout, receipt }: Publication): Promise<void> {
  try {
    const dependencyLink = path.join(checkout.directory, workspaceDependencyOutputName('npm'));
    const link = await fs.lstat(dependencyLink, { bigint: true });
    if (!link.isSymbolicLink() || link.nlink !== 1n || !process.geteuid || link.uid !== BigInt(process.geteuid())
      || await fs.readlink(dependencyLink) !== path.relative(checkout.directory, receipt.output.directory)
      || await fs.realpath(dependencyLink) !== receipt.output.directory
      || outputStamp(link) !== outputStamp(await fs.lstat(dependencyLink, { bigint: true }))) fail('dependency_installed_output_invalid');
    await assertProtectedWorkspacePath(checkout, true);
    await assertProtectedWorkspacePath(receipt.output, true);
  } catch { return fail('dependency_installed_output_invalid'); }
}

export async function measureWorkspaceDependencyOutput(output: WorkspaceProjectBinding, ecosystem: 'npm' | 'pip') {
  const hash = createHash('sha256').update(JSON.stringify(['workspace-installed-dependencies-v1', ecosystem]));
  const pending: Array<{ relative: string; depth: number }> = [{ relative: '', depth: 0 }];
  const visited: Array<{ filename: string; stamp: string; acl: boolean }> = [];
  const scratch = Buffer.allocUnsafe(128 * 1024);
  let entries = 0;
  let bytes = 0n;
  try {
    if (!process.geteuid) fail('dependency_installed_output_invalid');
    const uid = BigInt(process.geteuid());
    await assertProtectedWorkspacePath(output, true);
    if (!(await readWorkspaceDependencyMountPolicy()).supports(output.directory)) fail('dependency_installed_output_invalid');
    while (pending.length) {
      const { relative, depth } = pending.pop()!;
      const filename = path.join(output.directory, relative);
      if (++entries > maxInstalledEntries || depth > maxInstalledDepth || filename.length > 4096
        || /[\u0000-\u001f\u007f]/.test(relative)) fail('dependency_installed_output_invalid');
      const info = await fs.lstat(filename, { bigint: true });
      if (String(info.dev) !== output.device || info.uid !== uid) fail('dependency_installed_output_invalid');
      const stamp = outputStamp(info);
      visited.push({ filename, stamp, acl: !info.isSymbolicLink() });
      if (info.isSymbolicLink()) {
        const target = decodeFilesystemUtf8(await fs.readlink(filename, { encoding: 'buffer' }));
        const physical = await fs.realpath(filename);
        if (ecosystem !== 'npm' || info.nlink !== 1n || path.isAbsolute(target) || !workspacePathContains(output.directory, path.resolve(path.dirname(filename), target))
          || physical === output.directory || !workspacePathContains(output.directory, physical)) fail('dependency_installed_output_invalid');
        hash.update(JSON.stringify([relative, 'link', target]));
        continue;
      }
      if ((info.mode & 0o7022n) !== 0n) fail('dependency_installed_output_invalid');
      if (info.isDirectory()) {
        const children: string[] = [];
        // Node accepts this runtime encoding for Dirent names, but the type only lists string encodings.
        for await (const child of await fs.opendir(filename, { encoding: 'buffer' as BufferEncoding })) {
          if (entries + children.length + pending.length >= maxInstalledEntries) fail('dependency_installed_output_invalid');
          children.push(path.join(relative, decodeFilesystemUtf8(child.name)));
        }
        for (const child of children.sort().reverse()) pending.push({ relative: child, depth: depth + 1 });
        hash.update(JSON.stringify([relative, 'directory', String(info.mode & 0o777n)]));
      } else {
        if (!info.isFile() || info.nlink !== 1n || (bytes += info.size) > maxInstalledBytes) fail('dependency_installed_output_invalid');
        const digest = await digestOutputFile(filename, info, scratch);
        hash.update(JSON.stringify([relative, 'file', String(info.mode & 0o777n), digest]));
      }
    }
    for (let index = 0; index < visited.length; index += 16) {
      const batch = visited.slice(index, index + 16);
      await assertDenyOnlyWorkspaceAcls(batch.filter(({ acl }) => acl).map(({ filename }) => filename));
      for (const { filename, stamp } of batch) {
        if (stamp !== outputStamp(await fs.lstat(filename, { bigint: true }))) fail('dependency_installed_output_invalid');
      }
    }
    return { digest: hash.digest('hex'), entries, bytes: Number(bytes) };
  } catch { return fail('dependency_installed_output_invalid'); }
}

async function digestOutputFile(filename: string, info: BigIntStats, scratch: Buffer) {
  const fd = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stamp = outputStamp(info);
    if (stamp !== outputStamp(await fd.stat({ bigint: true }))) fail('dependency_installed_output_invalid');
    const hash = createHash('sha256');
    let remaining = Number(info.size);
    while (remaining > 0) {
      const { bytesRead } = await fd.read(scratch, 0, Math.min(scratch.length, remaining), null);
      if (bytesRead === 0) fail('dependency_installed_output_invalid');
      hash.update(scratch.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    if (stamp !== outputStamp(await fd.stat({ bigint: true }))) fail('dependency_installed_output_invalid');
    return hash.digest('hex');
  } finally { await fd.close(); }
}

function outputStamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.ctimeNs, info.mtimeNs].join(':');
}

function decodeFilesystemUtf8(value: unknown): string {
  if (!Buffer.isBuffer(value)) fail('dependency_installed_output_invalid');
  const name = filesystemUtf8.decode(value);
  if (!Buffer.from(name, 'utf8').equals(value)) fail('dependency_installed_output_invalid');
  return name;
}

function fail(code: WorkspaceDependencyInstallError['code']): never { throw new WorkspaceDependencyInstallError(code); }
