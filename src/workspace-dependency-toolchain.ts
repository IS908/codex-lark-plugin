import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dependencyDigestSchema, dependencyToolchainSchema, workspaceDependencyToolchainConfigSchema,
  type WorkspaceDependencyToolchainConfig } from './domain/workspace-dependency.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertCompatibleCodexLayers, resolveManagedGitLauncher } from './managed-git-launcher.js';
import { dependencyGuardSandboxOverrides, DEPENDENCY_GUARD_PROFILE } from './managed-git-sandbox.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities } from './managed-workspace-ancestry.js';
import { mkdirTemporaryInsidePinnedRoot } from './managed-workspace-mkdir.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { loadWorkspaceDependencyWriteGuard } from './workspace-dependency-registry.js';
import { validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const maxFiles = 20_000;
const maxBytes = 1024n * 1024n * 1024n;
const maxMetadataBytes = 64n * 1024n;
const installerVersion = /^\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.]+)?$/;
type Entry = { info: BigIntStats; digest?: string; target?: string; header?: string; content?: Buffer };

export class WorkspaceDependencyToolchainError extends Error {
  constructor(readonly code: 'dependency_toolchain_invalid' | 'dependency_toolchain_changed' | 'dependency_toolchain_probe_failed',
    readonly probeStage?: 'private_home' | 'configuration' | 'launcher' | 'runtime' | 'protocol') {
    super({ dependency_toolchain_invalid: 'The configured dependency toolchain or its protected paths are invalid.',
      dependency_toolchain_changed: 'The configured dependency toolchain changed after it was selected.',
      dependency_toolchain_probe_failed: 'The dependency toolchain could not be verified in the private offline sandbox.' }[code]);
  }
}

const nodeProbe = `const os = require('node:os');
const platformAbi = process.platform === 'darwin' ? 'darwin-' + os.release()
  : 'glibc-' + (process.report.getReport().header.glibcVersionRuntime || 'unsupported');
console.log(JSON.stringify({ runtime: process.versions.node, abi: process.versions.modules,
  platform: process.platform, arch: process.arch, platformAbi }));`;

// -S skips .pth startup. Check paths using built-in and frozen modules before loading pip or filesystem-backed probe imports.
const pipProbe = `
import _imp, sys
runtime, package = sys.argv[1:]
assert all(entry.startswith(runtime + '/') and '..' not in entry.split('/') for entry in sys.path)
assert _imp.is_frozen('os')
import os
inside = lambda root, candidate: os.path.commonpath((root, os.path.realpath(candidate))) == root
assert sys.implementation.name == 'cpython'
assert inside(runtime, sys.executable)
assert all(inside(runtime, entry) for entry in sys.path)
import importlib.util, json, sysconfig
init = os.path.join(package, '__init__.py')
spec = importlib.util.spec_from_file_location('pip', init, submodule_search_locations=[package])
pip = importlib.util.module_from_spec(spec)
sys.modules['pip'] = pip
spec.loader.exec_module(pip)
platformAbi = ('darwin-' + os.uname().release if sys.platform == 'darwin'
    else (os.confstr('CS_GNU_LIBC_VERSION') or 'unsupported').replace(' ', '-'))
print(json.dumps(dict(runtime='.'.join(map(str, sys.version_info[:3])), installer=pip.__version__,
    abi=sysconfig.get_config_var('SOABI'), platform=sys.platform,
    arch={'x86_64':'x64','aarch64':'arm64','arm64':'arm64'}.get(os.uname().machine), platformAbi=platformAbi)))
`;

export async function inspectWorkspaceDependencyToolchain(input: WorkspaceDependencyToolchainConfig, expectedFingerprint?: string) {
  const parsed = workspaceDependencyToolchainConfigSchema.safeParse(input);
  if (!parsed.success || (expectedFingerprint !== undefined && !dependencyDigestSchema.safeParse(expectedFingerprint).success)) invalid();
  const configured = parsed.data;
  const { ecosystem, executable, runtime, installer } = configured;
  try {
    if (!process.geteuid || process.geteuid() !== process.getuid?.() || !workspacePathContains(runtime.directory, executable)) invalid();
    const mounts = await readWorkspaceDependencyMountPolicy();
    const roots = [runtime, installer];
    const metadata = ecosystem === 'npm' ? path.join(installer.directory, 'package.json') : undefined;
    const visits = new Map<string, Entry>();
    const uid = BigInt(process.geteuid());
    let total = 0n;
    for (const root of roots) {
      await validateWorkspaceProject(root.directory, root);
      await assertProtectedWorkspacePath(root);
      if (!mounts.supports(root.directory)) invalid();
      for (let pending = [root.directory]; pending.length;) {
        const next: string[] = [];
        const batch: Array<[string, BigIntStats]> = [];
        for (const fullPath of pending) {
          if (visits.has(fullPath)) continue;
          if (visits.size >= maxFiles || fullPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(fullPath)) invalid();
          const info = await fs.lstat(fullPath, { bigint: true });
          if (String(info.dev) !== root.device || ![0n, uid].includes(info.uid)) invalid();
          const entry: Entry = { info };
          visits.set(fullPath, entry);
          if (info.isSymbolicLink()) {
            const target = await fs.realpath(fullPath);
            // The CPython probe and installer use -S and an explicit pip package, not this site link.
            const unusedSite = ecosystem === 'pip' && /^lib\/python[0-9.]+\/site-packages$/.test(path.relative(runtime.directory, fullPath));
            if (!unusedSite && !roots.some(({ directory }) => workspacePathContains(directory, target))) invalid();
            entry.target = target;
          } else {
            if ((info.mode & 0o6022n) !== 0n || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n))) invalid();
            batch.push([fullPath, info]);
          }
        }
        await checkAcls(batch.map(([file]) => file));
        for (const [file, info] of batch) {
          if (info.isDirectory()) {
            for await (const child of await fs.opendir(file)) {
              if (next.length + visits.size >= maxFiles) invalid();
              next.push(path.join(file, child.name));
            }
          } else {
            total += info.size;
            if (total > maxBytes) invalid();
            Object.assign(visits.get(file)!, await measureFile(file, info, file === metadata));
          }
        }
        pending = next;
      }
    }
    const bin = visits.get(executable);
    const entrypoint = path.join(installer.directory, ecosystem === 'npm' ? 'bin/npm-cli.js' : '__init__.py');
    if (!bin?.digest || !(bin.info.mode & 0o111n) || !nativeHeader(bin.header) || !visits.get(entrypoint)?.digest) invalid();
    let npmVersion: string | undefined;
    if (metadata) {
      const contents = visits.get(metadata)?.content;
      if (!contents) invalid();
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
      if (manifest?.name !== 'npm' || typeof manifest.version !== 'string' || !installerVersion.test(manifest.version)) invalid();
      npmVersion = manifest.version;
    }
    await fs.access(executable, fs.constants.X_OK);
    for (const { target } of visits.values()) {
      if (target && roots.some(({ directory }) => workspacePathContains(directory, target)) && !visits.has(target)) invalid();
    }
    const hash = createHash('sha256').update(JSON.stringify(['dependency-toolchain-v1', ecosystem, executable, runtime, installer]));
    for (const [file, entry] of [...visits].sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)) {
      if (stamp(entry.info) !== stamp(await fs.lstat(file, { bigint: true }))) changed();
      if (entry.target !== undefined && await fs.realpath(file) !== entry.target) changed();
      hash.update(JSON.stringify([file, stamp(entry.info), entry.digest ?? null, entry.target ?? null]));
    }
    const fingerprint = hash.digest('hex');
    if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) changed();
    return { configured, entrypoint, fingerprint, npmVersion };
  } catch (error) {
    if (error instanceof WorkspaceDependencyToolchainError) throw error;
    return invalid();
  }
}

export async function probeWorkspaceDependencyToolchain(input: {
  configured: WorkspaceDependencyToolchainConfig;
  codexCommand: string;
  temporaryRoot: WorkspaceProjectBinding;
  configPath?: string;
  expectedFingerprint?: string;
}) {
  const selected = await inspectWorkspaceDependencyToolchain(input.configured, input.expectedFingerprint);
  const { ecosystem, executable, runtime, installer } = selected.configured;
  const mounts = await readWorkspaceDependencyMountPolicy().catch(invalid);
  const guard = await loadWorkspaceDependencyWriteGuard(input.configPath);
  const parent = await validateWorkspaceProject(input.temporaryRoot.directory, input.temporaryRoot);
  await assertProtectedWorkspacePath(parent, false, true);
  const leaf = `lark-dependency-probe-${randomBytes(12).toString('hex')}`;
  const planned = path.join(parent.directory, leaf);
  const ancestors = await readWorkspaceAncestorIdentities(parent.directory);
  if (!path.isAbsolute(input.codexCommand) || !mounts.supports(planned) || [runtime, installer].some((root) =>
    ancestors.has(`${root.device}:${root.inode}`) || mounts.aliases(planned).some((candidate) => mounts.aliases(root.directory)
      .some((protectedPath) => mounts.contains(protectedPath, candidate) || mounts.contains(candidate, protectedPath))))) invalid();
  if (guard) await guard.assertNewDirectory(planned);
  const home = await mkdirTemporaryInsidePinnedRoot(parent, leaf);
  let stage: WorkspaceDependencyToolchainError['probeStage'] = 'private_home';
  try {
    await assertProtectedWorkspacePath(home, true);
    const cwd = home.directory;
    const env = { HOME: cwd, CODEX_HOME: cwd, CODEX_SQLITE_HOME: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd, PATH: '/usr/bin:/bin',
      LC_ALL: 'C', PIP_CONFIG_FILE: '/dev/null' };
    stage = 'configuration';
    await assertCompatibleCodexLayers(env, [cwd]);
    stage = 'launcher';
    const launcher = await resolveManagedGitLauncher(input.codexCommand, env, [home, runtime, installer, ...(guard?.protectedBindings ?? [])]);
    const profileArgs = ['sandbox', ...dependencyGuardSandboxOverrides([cwd], false).flatMap((setting) => ['-c', setting]),
      '-P', DEPENDENCY_GUARD_PROFILE, '-C', cwd, '--', executable];
    const run = async (args: string[]) => {
      stage = 'runtime';
      const raw = await probeOutput(launcher.command, [...profileArgs, ...args], cwd, launcher.env);
      stage = 'protocol';
      return JSON.parse(raw);
    };
    let output: unknown;
    if (ecosystem === 'npm') {
      const measured = await run(['--no-global-search-paths', '-e', nodeProbe]);
      // Do not resolve npm's executable module graph merely to identify its measured package version.
      output = { ...measured, installer: selected.npmVersion };
    } else {
      output = await run(['-I', '-S', '-B', '-c', pipProbe, runtime.directory, installer.directory]);
    }
    const toolchain = dependencyToolchainSchema.safeParse(output);
    if (!toolchain.success || toolchain.data.platform !== process.platform || toolchain.data.arch !== process.arch
      || !/^(?:darwin|glibc)-[0-9]+(?:\.[0-9]+){1,2}$/.test(toolchain.data.platformAbi)
      || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?$/.test(toolchain.data.runtime)
      || !installerVersion.test(toolchain.data.installer)) invalid();
    await inspectWorkspaceDependencyToolchain(selected.configured, selected.fingerprint);
    return { ...selected, toolchain: toolchain.data };
  } catch (error) {
    if (error instanceof WorkspaceDependencyToolchainError) throw error;
    throw new WorkspaceDependencyToolchainError('dependency_toolchain_probe_failed', stage);
  } finally {
    await assertProtectedWorkspacePath(home, true);
    await fs.rm(home.directory, { recursive: true, force: true });
  }
}

function probeOutput(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let size = 0;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Exited. */ } }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new WorkspaceDependencyToolchainError('dependency_toolchain_probe_failed', 'runtime'));
    };
    const timer = setTimeout(stop, 15_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > 16 * 1024) stop();
      else if (stream === child.stdout) output.push(chunk);
    });
    child.once('error', stop);
    child.once('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else reject(new WorkspaceDependencyToolchainError('dependency_toolchain_probe_failed', 'runtime'));
    });
  });
}

async function measureFile(file: string, expected: BigIntStats, capture: boolean) {
  if (capture && expected.size > maxMetadataBytes) invalid();
  const fd = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const expectedStamp = stamp(expected);
    if (stamp(await fd.stat({ bigint: true })) !== expectedStamp) changed();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(128 * 1024);
    const content = capture ? Buffer.alloc(Number(expected.size)) : undefined;
    let remaining = Number(expected.size);
    let header: string | undefined;
    while (remaining) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(remaining, buffer.length), null);
      if (!bytesRead) changed();
      header ??= buffer.subarray(0, Math.min(bytesRead, 4)).toString('hex');
      hash.update(buffer.subarray(0, bytesRead));
      if (content) buffer.copy(content, content.length - remaining, 0, bytesRead);
      remaining -= bytesRead;
    }
    if (stamp(await fd.stat({ bigint: true })) !== expectedStamp) changed();
    return { digest: hash.digest('hex'), header, content };
  } finally { await fd.close(); }
}

async function checkAcls(files: string[]) {
  if (process.platform !== 'darwin') return;
  for (let index = 0; index < files.length; index += 16) await assertDenyOnlyWorkspaceAcls(files.slice(index, index + 16));
}

function nativeHeader(header?: string): boolean {
  return !!header && (process.platform === 'linux' ? header === '7f454c46' : process.platform === 'darwin'
    && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'].includes(header));
}

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.ctimeNs, info.mtimeNs].join(':');
}

function invalid(): never { throw new WorkspaceDependencyToolchainError('dependency_toolchain_invalid'); }
function changed(): never { throw new WorkspaceDependencyToolchainError('dependency_toolchain_changed'); }
