import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspaceDependencyToolchain, probeWorkspaceDependencyToolchain } from '../src/workspace-dependency-toolchain.js';
import { pinWorkspacePath } from '../src/workspace-projects.js';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-dependency-toolchain-')));
const pin = async (directory: string) => pinWorkspacePath(directory, '.');
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

  const native = process.env.LARK_TEST_CODEX_NATIVE_BINARY;
  if (native) {
    const npmCommand = process.env.LARK_TEST_NPM || execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    const nodeBinary = await fs.realpath(process.execPath);
    const nodePrefix = path.dirname(path.dirname(nodeBinary));
    const npmCli = await fs.realpath(process.platform === 'linux' && !process.env.LARK_TEST_NPM
      ? path.join(nodePrefix, 'lib/node_modules/npm/bin/npm-cli.js') : npmCommand);
    assert.equal(path.basename(npmCli), 'npm-cli.js', 'Use an npm CLI entrypoint, not a wrapper or shim.');
    const npmInstaller = path.dirname(path.dirname(npmCli));
    const nodeRuntime = path.join(fixture, 'node-runtime');
    const npmRoot = path.join(fixture, 'npm-installer');
    const nodeExecutable = path.join(nodeRuntime, 'bin', 'node');
    if (process.platform === 'linux') {
      // The CI Node executable needs only system libraries; do not copy unrelated tools in its install prefix.
      await fs.mkdir(path.dirname(nodeExecutable), { recursive: true, mode: 0o700 });
      await fs.copyFile(nodeBinary, nodeExecutable);
    } else {
      // The Homebrew executable also needs its private libnode dylib relative to bin/.
      await fs.cp(nodePrefix, nodeRuntime, { recursive: true, verbatimSymlinks: true, filter: (source) => {
        const relative = path.relative(nodePrefix, source);
        return relative !== 'bin/npm' && relative !== 'bin/npx';
      } });
    }
    await fs.cp(npmInstaller, npmRoot, { recursive: true, verbatimSymlinks: true });
    const common = { codexCommand: native, temporaryRoot: await pin(fixture) };
    const npmProbe = await probeWorkspaceDependencyToolchain({ ...common,
      configured: { ecosystem: 'npm', executable: nodeExecutable, runtime: await pin(nodeRuntime), installer: await pin(npmRoot) } });
    assert.equal(npmProbe.toolchain.runtime, process.versions.node);
    assert.equal(npmProbe.toolchain.abi, process.versions.modules);
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
    const pipProbe = await probeWorkspaceDependencyToolchain({ ...common,
      configured: { ecosystem: 'pip', executable: pythonExecutable, runtime: await pin(pythonRuntime), installer: await pin(pipRoot) } });
    assert.equal(pipProbe.toolchain.abi, pythonMetadata.abi);
    assert.match(pipProbe.toolchain.installer, /^\d+\.\d+/);
    assert.equal(pipProbe.toolchain.platformAbi, npmProbe.toolchain.platformAbi);
    console.log(`workspace dependency native toolchains: Node ${npmProbe.toolchain.runtime}/npm ${npmProbe.toolchain.installer}; CPython ${pipProbe.toolchain.runtime}/pip ${pipProbe.toolchain.installer}; ${pipProbe.toolchain.platformAbi}`);
  }
  console.log('workspace dependency toolchain smoke: PASS');
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
