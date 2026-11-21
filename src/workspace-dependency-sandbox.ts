import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceDependencyToolchainConfigSchema, type WorkspaceDependencyToolchainConfig } from './domain/workspace-dependency.js';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { assertCompatibleCodexLayers, resolveManagedGitLauncher } from './managed-git-launcher.js';
import { addCodexWorkspaceWriteRoot, namedCodexSandboxOverrides } from './managed-git-sandbox.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath, readWorkspaceAncestorIdentities } from './managed-workspace-ancestry.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { validateWorkspaceProject, workspacePathContains } from './workspace-projects.js';

const profile = 'lark-dependency-installer';
const seatbelt = '/usr/bin/sandbox-exec';
const unshare = '/usr/bin/unshare';
const darwinSystem = ['/usr/lib', '/System/Library/Frameworks', '/System/Library/PrivateFrameworks', '/System/Library/SubFrameworks'];
const darwinVersion = '/System/Library/CoreServices/SystemVersion.plist';
const processSysctls = ['kern.ostype', 'kern.osrelease', 'kern.osversion', 'kern.osproductversion', 'kern.version', 'kern.argmax', 'kern.hostname',
  'kern.osvariant_status', 'machdep.cpu.brand_string', 'machdep.ptrauth_enabled', 'security.mac.lockdown_mode_state', 'sysctl.proc_cputype'];

export class WorkspaceDependencySandboxError extends Error {
  readonly code = 'dependency_installer_sandbox_invalid';
  constructor() { super('The dependency installer sandbox cannot enforce the required filesystem boundary.'); }
}

export async function prepareWorkspaceDependencySandbox(input: {
  codexCommand: string;
  configured: WorkspaceDependencyToolchainConfig;
  staging: WorkspaceProjectBinding;
  artifacts?: WorkspaceProjectBinding;
  protectedBindings?: WorkspaceProjectBinding[];
}) {
  try {
    const { ecosystem, executable, runtime, installer } = workspaceDependencyToolchainConfigSchema.parse(input.configured);
    const staging = await validateWorkspaceProject(input.staging.directory, input.staging);
    await assertProtectedWorkspacePath(staging, true);
    const stageInfo = await fs.lstat(staging.directory, { bigint: true });
    if ((stageInfo.mode & 0o077n) !== 0n) invalid();
    const readonly = [runtime, installer, ...(input.artifacts ? [input.artifacts] : [])];
    const mounts = await readWorkspaceDependencyMountPolicy();
    if (!process.getuid || process.getuid() === 0 || process.getuid() !== process.geteuid?.()
      || !literalPath(staging.directory) || !literalPath(executable) || !workspacePathContains(runtime.directory, executable)
      || !mounts.supports(staging.directory) || await fs.realpath(executable) !== executable) invalid();
    const binary = await fs.lstat(executable, { bigint: true });
    if (!binary.isFile() || ![0n, BigInt(process.getuid())].includes(binary.uid) || binary.nlink !== 1n
      || (binary.mode & 0o6022n) !== 0n || (binary.mode & 0o111n) === 0n) invalid();
    await assertDenyOnlyWorkspaceAcls([executable]);
    const stagingAncestors = await readWorkspaceAncestorIdentities(staging.directory);
    const aliases = mounts.aliases(staging.directory);
    for (const root of [...readonly, ...(input.protectedBindings ?? [])]) {
      const actual = await validateWorkspaceProject(root.directory, root);
      await assertProtectedWorkspacePath(actual);
      if (!literalPath(root.directory) || !mounts.supports(root.directory)
        || stagingAncestors.has(`${root.device}:${root.inode}`)
        || (await readWorkspaceAncestorIdentities(root.directory)).has(`${staging.device}:${staging.inode}`)
        || mounts.aliases(root.directory).some((read) => aliases.some((write) => mounts.contains(read, write) || mounts.contains(write, read)))) invalid();
    }
    const cwd = staging.directory;
    const env = { HOME: cwd, CODEX_HOME: cwd, CODEX_SQLITE_HOME: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd,
      PATH: '/usr/bin:/bin', LC_ALL: 'C', PIP_CONFIG_FILE: '/dev/null', OPENSSL_CONF: '/dev/null' };
    if (process.platform === 'darwin') {
      const system = await fs.stat('/', { bigint: true });
      for (const item of [seatbelt, darwinVersion, ...darwinSystem]) {
        if (!mounts.supportsSystemRead?.(item) || !(await protectedSystemPath(item, system.dev))) invalid();
      }
      return { command: seatbelt, args: ['-p', darwinPolicy(executable, runtime.directory, readonly.map(({ directory }) => directory), cwd), executable],
        env, isolatesDescendants: true as const };
    }
    if (process.platform !== 'linux' || !path.isAbsolute(input.codexCommand)) invalid();
    if (await protectedSystemPath(unshare) !== unshare || !mounts.supports(unshare)) invalid();
    env.CODEX_HOME = path.join(cwd, 'codex-home');
    env.TMPDIR = env.TMP = env.TEMP = path.join(cwd, 'tmp');
    for (const directory of [env.CODEX_HOME, env.TMPDIR]) await fs.mkdir(directory, { mode: 0o700 });
    await assertProtectedWorkspacePath(staging, true);
    await assertCompatibleCodexLayers(env, [cwd]);
    const launcher = await resolveManagedGitLauncher(input.codexCommand, env, [staging, ...readonly, ...(input.protectedBindings ?? [])]);
    const system = await linuxSystemReads();
    for (const entry of system.readable) {
      if (!mounts.supports(entry) || !mounts.supports(await fs.realpath(entry))) invalid();
    }
    if (!literalPath(launcher.command)) invalid();
    // The pinned Linux launcher re-enters itself inside Bubblewrap before executing the payload.
    const rules = new Map<string, 'read' | 'write'>([...system.readable, launcher.command, ...readonly.map(({ directory }) => directory)]
      .map((root) => [root, 'read']));
    addCodexWorkspaceWriteRoot(rules, cwd);
    let command = [executable];
    if (ecosystem === 'pip') {
      const lib = path.join(runtime.directory, 'lib');
      if (/[:;$]/.test(lib) || await fs.realpath(lib) !== lib || !(await fs.lstat(lib)).isDirectory()) invalid();
      // Select only the registered runtime's libraries, after Bubblewrap has entered the restricted filesystem.
      command = [system.loader, '--inhibit-cache', '--library-path', lib, '--argv0', executable, executable];
    }
    // Bubblewrap can report payload exit before its reaper exits. Wait for the enclosing namespace's PID 1 instead.
    return { command: unshare, args: ['--user', '--map-current-user', '--pid', '--fork', '--kill-child', '--mount-proc',
      '--', launcher.command, 'sandbox', ...namedCodexSandboxOverrides(profile, rules, false)
        .flatMap((setting) => ['-c', setting]), '-P', profile, '-C', cwd, '--', ...command], env: launcher.env,
      isolatesDescendants: true as const };
  } catch { return invalid(); }
}

async function linuxSystemReads() {
  const arch = process.arch === 'x64' ? { triple: 'x86_64-linux-gnu', loader: '/lib64/ld-linux-x86-64.so.2' }
    : process.arch === 'arm64' ? { triple: 'aarch64-linux-gnu', loader: '/lib/ld-linux-aarch64.so.1' } : invalid();
  const dirs = [`/lib/${arch.triple}`, `/usr/lib/${arch.triple}`];
  const paths = await Promise.all(dirs.map((directory) => protectedSystemPath(directory)));
  const resolvedLoader = await protectedSystemPath(arch.loader);
  if (paths.some((real) => real && !dirs.includes(real))
    || !resolvedLoader || !paths.some((real) => real && workspacePathContains(real, resolvedLoader))) invalid();
  return { readable: [...dirs.filter((_, index) => !!paths[index]), arch.loader], loader: arch.loader };
}

async function protectedSystemPath(candidate: string, device?: bigint): Promise<string | undefined> {
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.lstat(real, { bigint: true });
    if (!literalPath(real) || stat.uid !== 0n || (device !== undefined && (real !== candidate || stat.dev !== device))
      || (stat.mode & 0o6022n) !== 0n || (!stat.isDirectory() && !stat.isFile())) invalid();
    const parent = stat.isDirectory() ? real : path.dirname(real);
    const bound = await fs.lstat(parent, { bigint: true });
    if (bound.uid !== 0n) invalid();
    await assertProtectedWorkspacePath({ directory: parent, device: String(bound.dev), inode: String(bound.ino) });
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function darwinPolicy(executable: string, runtime: string, readonly: string[], cwd: string): string {
  const q = JSON.stringify;
  const subpaths = (paths: string[]) => [...new Set(paths)].map((entry) => `(subpath ${q(entry)})`).join(' ');
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec (literal ${q(executable)}))`,
    '(deny process-fork)', '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    `(allow sysctl-read (sysctl-name-prefix "hw.") ${processSysctls.map((name) => `(sysctl-name ${q(name)})`).join(' ')})`,
    // dyld opens / as an anchor; this literal does not grant its descendants.
    '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    `(allow file-read* (literal ${q(darwinVersion)}))`,
    `(allow file-read* ${subpaths([...darwinSystem, ...readonly, cwd])})`,
    `(allow file-map-executable ${subpaths([...darwinSystem, runtime])})`,
    `(allow file-read-metadata (path-ancestors ${q(cwd)}))`,
    `(allow file-write* (subpath ${q(cwd)}))`,
    '(deny file-link)',
    '(deny system-fcntl (fcntl-command 80 110))',
  ].join('\n');
}

function literalPath(value: string): boolean {
  return value !== '/' && value === path.resolve(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f*?\[\]\\]/.test(value);
}

function invalid(): never { throw new WorkspaceDependencySandboxError(); }
