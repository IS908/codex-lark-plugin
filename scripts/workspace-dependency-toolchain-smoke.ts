import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareWorkspaceDependencySandbox } from '../src/workspace-dependency-sandbox.js';
import { measureWorkspaceDependencyOutput } from '../src/workspace-dependency-install.js';
import { runWorkspaceDependencyProcess } from '../src/workspace-dependency-process.js';
import { inspectWorkspaceDependencyToolchain, probeWorkspaceDependencyToolchain } from '../src/workspace-dependency-toolchain.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';
import { exerciseWorkspaceDependencyInstall } from './workspace-dependency-install-fixture.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-toolchain-')));
const pin = async (directory: string) => pinWorkspacePath(directory, '.');

async function makeLinuxFixturePrivate(root: string): Promise<void> {
  const info = await fs.lstat(root);
  if (info.isSymbolicLink()) return;
  assert.ok(info.isDirectory() || (info.isFile() && info.nlink === 1), 'Only ordinary fixture files can be made private.');
  await fs.chmod(root, info.isDirectory() || (info.mode & 0o111) !== 0 ? 0o700 : 0o600);
  if (info.isDirectory()) {
    for await (const child of await fs.opendir(root)) await makeLinuxFixturePrivate(path.join(root, child.name));
  }
}

try {
  const runtime = path.join(fixture, 'runtime');
  const npm = path.join(fixture, 'npm');
  const executable = path.join(runtime, 'node');
  await fs.mkdir(runtime, { mode: 0o700 });
  await fs.mkdir(path.join(npm, 'bin'), { recursive: true, mode: 0o700 });
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o700);
  await fs.writeFile(path.join(npm, 'bin', 'npm-cli.js'), 'fixture only\n');
  await fs.writeFile(path.join(npm, 'package.json'), '{"name":"npm","version":"12.0.0"}\n');
  const module = path.join(npm, 'support.js');
  await fs.writeFile(module, 'module fixture\n');
  await fs.symlink('support.js', path.join(npm, 'supported-link.js'));
  const configured = { ecosystem: 'npm', executable, runtime: await pin(runtime), installer: await pin(npm) } as const;
  const first = await inspectWorkspaceDependencyToolchain(configured);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.npmVersion, '12.0.0');
  assert.deepEqual(await inspectWorkspaceDependencyToolchain(configured, first.fingerprint), first);
  await fs.writeFile(module, 'module changed\n');
  await assert.rejects(inspectWorkspaceDependencyToolchain(configured, first.fingerprint), { code: 'dependency_toolchain_changed' });
  await fs.writeFile(module, 'module fixture\n');
  await fs.writeFile(path.join(fixture, 'outside.js'), 'not part of the installer\n');
  await fs.symlink('../outside.js', path.join(npm, 'outside-link.js'));
  await assert.rejects(inspectWorkspaceDependencyToolchain(configured), { code: 'dependency_toolchain_invalid' });
  await fs.unlink(path.join(npm, 'outside-link.js'));
  await assert.rejects(inspectWorkspaceDependencyToolchain({ ...configured, executable: '/usr/bin/true' }), { code: 'dependency_toolchain_invalid' });
  await fs.writeFile(path.join(npm, 'package.json'), '{"name":"different-package","version":"12.0.0"}\n');
  await assert.rejects(inspectWorkspaceDependencyToolchain(configured), { code: 'dependency_toolchain_invalid' });

  const output = path.join(fixture, 'output-measurement');
  const outputFile = path.join(output, 'index.js');
  await fs.mkdir(output, { mode: 0o700 });
  await fs.writeFile(outputFile, 'first version');
  const outputBinding = await pin(output);
  const firstOutput = await measureWorkspaceDependencyOutput(outputBinding, 'npm');
  assert.deepEqual(await measureWorkspaceDependencyOutput(outputBinding, 'npm'), firstOutput);
  await fs.writeFile(outputFile, 'second version');
  assert.notEqual((await measureWorkspaceDependencyOutput(outputBinding, 'npm')).digest, firstOutput.digest);
  const entry = path.join(output, 'link');
  await fs.symlink('../outside.js', entry);
  await assert.rejects(measureWorkspaceDependencyOutput(outputBinding, 'npm'), { code: 'dependency_installed_output_invalid' });
  await fs.unlink(entry);
  await fs.link(outputFile, entry);
  await assert.rejects(measureWorkspaceDependencyOutput(outputBinding, 'npm'), { code: 'dependency_installed_output_invalid' });
  await fs.unlink(entry);
  await fs.symlink('index.js', entry);
  await measureWorkspaceDependencyOutput(outputBinding, 'npm');
  await assert.rejects(measureWorkspaceDependencyOutput(outputBinding, 'pip'), { code: 'dependency_installed_output_invalid' });
  if (process.platform === 'linux') {
    const validName = path.join(output, '\uFFFD');
    await fs.writeFile(validName, 'valid Unicode filename');
    const invalidName = Buffer.concat([Buffer.from(output + '/'), Buffer.from([0xff])]);
    await fs.writeFile(invalidName, 'raw Linux filename');
    try { await assert.rejects(measureWorkspaceDependencyOutput(outputBinding, 'npm'), { code: 'dependency_installed_output_invalid' }); }
    finally { await fs.unlink(invalidName); }
    await measureWorkspaceDependencyOutput(outputBinding, 'npm');
    await fs.unlink(validName);
  }

  const processFixture = { command: process.execPath, args: ['-e'], env: {} };
  await assert.rejects(runWorkspaceDependencyProcess(processFixture, ['setTimeout(() => {}, 5000)'], fixture, 100, 1024),
    { reason: 'timeout', quiescent: false });
  await assert.rejects(runWorkspaceDependencyProcess(processFixture, ["process.stdout.write('x'.repeat(4096))"], fixture, 5000, 1024),
    { reason: 'output', quiescent: false });

  const native = process.env.LARK_TEST_CODEX_NATIVE_BINARY;
  if (native) {
    const npmCommand = process.env.LARK_TEST_NPM || execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    const nodeBinary = await fs.realpath(process.env.LARK_TEST_NODE_PATH || process.execPath);
    const nodePrefix = path.dirname(path.dirname(nodeBinary));
    const npmCli = await fs.realpath(process.platform === 'linux' && !process.env.LARK_TEST_NPM
      ? path.join(nodePrefix, 'lib/node_modules/npm/bin/npm-cli.js') : npmCommand);
    assert.equal(path.basename(npmCli), 'npm-cli.js', 'Use an npm CLI entrypoint, not a wrapper or shim.');
    const npmInstaller = path.dirname(path.dirname(npmCli));
    const nodeRuntime = path.join(fixture, 'node-runtime');
    const npmRoot = path.join(fixture, 'npm-installer');
    const nodeExecutable = path.join(nodeRuntime, 'bin', 'node');
    // Use a standalone Node executable with no dependencies in ambient package-manager prefixes.
    await fs.mkdir(path.dirname(nodeExecutable), { recursive: true, mode: 0o700 });
    await fs.copyFile(nodeBinary, nodeExecutable);
    await fs.cp(npmInstaller, npmRoot, { recursive: true, verbatimSymlinks: true });
    const common = { codexCommand: native, temporaryRoot: await pin(fixture) };
    const nodeConfig = { ecosystem: 'npm', executable: nodeExecutable, runtime: await pin(nodeRuntime), installer: await pin(npmRoot) } as const;
    const staging = path.join(fixture, 'sandbox-boundary');
    const sibling = path.join(fixture, 'outside-readable.txt');
    const privateRead = path.join(npmRoot, 'package.json');
    const blockedWrite = path.join(npmRoot, 'blocked-write');
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(sibling, 'outside fixture');
    assert.equal(await fs.readFile(sibling, 'utf8'), 'outside fixture');
    await fs.writeFile(blockedWrite, 'outside sandbox write check');
    await fs.unlink(blockedWrite);
    await assert.rejects(prepareWorkspaceDependencySandbox({ codexCommand: native, configured: nodeConfig, staging: nodeConfig.installer }),
      { code: 'dependency_installer_sandbox_invalid' });
    const stagingBinding = await pin(staging);
    await fs.chmod(staging, 0o755);
    await assert.rejects(prepareWorkspaceDependencySandbox({ codexCommand: native, configured: nodeConfig, staging: stagingBinding }),
      { code: 'dependency_installer_sandbox_invalid' });
    await fs.chmod(staging, 0o700);
    const launch = await prepareWorkspaceDependencySandbox({ codexCommand: native, configured: nodeConfig, staging: stagingBinding });
    const shared = await fs.realpath(await fs.mkdtemp('/tmp/lark-dependency-read-guard-'));
    const server = createServer((socket) => socket.end());
    try {
      const ambient = path.join(shared, 'ambient.txt');
      await fs.writeFile(ambient, 'ambient fixture');
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const hostPidNamespace = process.platform === 'linux' ? await fs.readlink('/proc/self/ns/pid') : '';
      await promisify(execFile)(launch.command, [...launch.args, '--no-global-search-paths', '-e', `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [allowed, sibling, denied, ambient, port, hostPidNamespace] = process.argv.slice(1);
assert.equal(JSON.parse(fs.readFileSync(allowed, 'utf8')).name, 'npm');
assert.throws(() => fs.readFileSync(sibling));
assert.throws(() => fs.readFileSync(ambient));
assert.throws(() => fs.writeFileSync(denied, 'not allowed'));
assert.throws(() => fs.linkSync(allowed, 'hardlink'));
assert.ok(require('node:os').release());
if (process.platform === 'darwin') {
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, null);
  assert.equal(child.error?.code, 'EPERM');
}
if (process.platform === 'linux') assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), hostPidNamespace);
const socket = require('node:net').createConnection(Number(port), '127.0.0.1');
socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
socket.on('error', () => fs.writeFileSync('allowed', 'private', { flag: 'wx' }));
socket.setTimeout(2000, () => { socket.destroy(); process.exitCode = 1; });`, privateRead, sibling, blockedWrite, ambient, String(address.port), hostPidNamespace],
      { cwd: staging, env: launch.env, timeout: 15_000, maxBuffer: 16 * 1024 });
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(shared, { recursive: true, force: true });
    }
    assert.equal(await fs.readFile(path.join(staging, 'allowed'), 'utf8'), 'private');
    await assert.rejects(fs.stat(blockedWrite), { code: 'ENOENT' });
    const npmProbe = await probeWorkspaceDependencyToolchain({ ...common,
      configured: nodeConfig });
    const nodeVersions = JSON.parse(execFileSync(nodeExecutable, ['-p', 'JSON.stringify(process.versions)'], { encoding: 'utf8' }));
    assert.equal(npmProbe.toolchain.runtime, nodeVersions.node);
    assert.equal(npmProbe.toolchain.abi, nodeVersions.modules);
    assert.match(npmProbe.toolchain.installer, /^\d+\.\d+\.\d+/);
    console.log(`workspace dependency native Node/npm: ${npmProbe.toolchain.runtime}/${npmProbe.toolchain.installer}`);
    const pythonPath = process.env.LARK_TEST_PYTHON_PATH;
    assert.ok(pythonPath, 'Set the exact Python binary for the native toolchain probe.');
    const python = await fs.realpath(pythonPath);
    const pythonMetadata = JSON.parse(execFileSync(python, ['-I', '-B', '-c',
      `import json, os, pip, sys, sysconfig
print(json.dumps(dict(prefix=os.path.realpath(sys.prefix), installer=os.path.dirname(os.path.realpath(pip.__file__)),
    abi=sysconfig.get_config_var("SOABI"), stdlib=sysconfig.get_path("stdlib"),
    libdir=sysconfig.get_config_var("LIBDIR"), libname=sysconfig.get_config_var("INSTSONAME"))))`],
    { encoding: 'utf8' })) as { prefix: string; installer: string; abi: string; stdlib: string; libdir: string; libname: string | null };
    const pythonRuntime = path.join(fixture, 'python-runtime');
    const pipRoot = path.join(fixture, 'pip-installer');
    const pythonExecutable = path.join(pythonRuntime, path.relative(pythonMetadata.prefix, python));
    if (process.platform === 'linux') {
      // A relocated fixture needs the real binary and stdlib, not the toolcache's install aliases.
      assert.equal(path.dirname(pythonExecutable), path.join(pythonRuntime, 'bin'));
      await fs.mkdir(path.dirname(pythonExecutable), { recursive: true, mode: 0o700 });
      await fs.copyFile(python, pythonExecutable);
      const lib = path.join(pythonRuntime, 'lib');
      const version = path.basename(pythonMetadata.stdlib);
      assert.match(version, /^python3\.\d+$/);
      await fs.mkdir(lib, { mode: 0o700 });
      if (pythonMetadata.libname) {
        assert.match(pythonMetadata.libname, /^libpython3\.\d+\.so(?:\.\d+)*$/);
        await fs.copyFile(path.join(pythonMetadata.libdir, pythonMetadata.libname), path.join(lib, pythonMetadata.libname));
      }
      await fs.cp(pythonMetadata.stdlib, path.join(lib, version), { recursive: true, verbatimSymlinks: true,
        filter: (source) => !/^(?:site-packages|test|config-[^/]+)$/.test(path.relative(pythonMetadata.stdlib, source))
          && path.basename(source) !== '__pycache__' });
    } else {
      await fs.cp(pythonMetadata.prefix, pythonRuntime, { recursive: true, verbatimSymlinks: true,
        filter: (source) => !/^lib\/python[0-9.]+\/site-packages$/.test(path.relative(pythonMetadata.prefix, source)) });
    }
    await fs.cp(pythonMetadata.installer, pipRoot, { recursive: true, verbatimSymlinks: true });
    if (process.platform === 'linux') {
      // Normalize only the disposable copies; hosted toolcache permissions vary by runner image.
      await makeLinuxFixturePrivate(pythonRuntime);
      await makeLinuxFixturePrivate(pipRoot);
    }
    const pythonConfig = { ecosystem: 'pip', executable: pythonExecutable, runtime: await pin(pythonRuntime), installer: await pin(pipRoot) } as const;
    const pipProbe = await probeWorkspaceDependencyToolchain({ ...common, configured: pythonConfig }).catch(async (error) => {
      const diagnostic = path.join(fixture, 'python-startup-diagnostic');
      await fs.mkdir(diagnostic, { mode: 0o700 });
      const command = await prepareWorkspaceDependencySandbox({ ...common, configured: pythonConfig, staging: await pin(diagnostic) });
      await promisify(execFile)(command.command, [...command.args, '-I', '-S', '-B', '-c', 'import os, sysconfig, json; os.uname()'],
        { cwd: diagnostic, env: command.env, timeout: 15_000, maxBuffer: 8192 });
      throw error;
    });
    assert.equal(pipProbe.toolchain.abi, pythonMetadata.abi);
    assert.match(pipProbe.toolchain.installer, /^\d+\.\d+/);
    assert.equal(pipProbe.toolchain.platformAbi, npmProbe.toolchain.platformAbi);
    console.log(`workspace dependency native toolchains: Node ${npmProbe.toolchain.runtime}/npm ${npmProbe.toolchain.installer}; CPython ${pipProbe.toolchain.runtime}/pip ${pipProbe.toolchain.installer}; ${pipProbe.toolchain.platformAbi}`);
    await exerciseWorkspaceDependencyInstall(fixture, common, npmProbe, pipProbe);
  }
  console.log('workspace dependency toolchain smoke: PASS');
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
