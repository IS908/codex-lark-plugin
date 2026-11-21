import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Standalone native sandbox feasibility test; all inputs and outputs are disposable.
const exec = promisify(execFile);
const codex = process.env.LARK_TEST_CODEX_NATIVE_BINARY;
assert.ok(codex && path.isAbsolute(codex), 'Provide the absolute path of a native Codex installation.');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-deps-feasibility-')));
const home = path.join(root, 'home');
const cache = path.join(root, 'npm-cache');
const py = process.env.LARK_TEST_PYTHON || 'python3';
const npm = process.env.LARK_TEST_NPM || 'npm';
const digest = (value, type = 'sha256', format = 'hex') => createHash(type).update(value).digest(format);
const run = (cmd, args, cwd, extra = {}) => exec(cmd, args, { cwd, timeout: 45_000,
  env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, LC_ALL: 'C', ...extra } });
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function permissions(dir, readonly) {
  if (!readonly) await fs.chmod(dir, 0o700);
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await permissions(file, readonly);
    else if (item.isFile()) await fs.chmod(file, readonly ? 0o400 : 0o600);
    else throw new Error('Unexpected file type in fixture cache.');
  }
  if (readonly) await fs.chmod(dir, 0o500);
}

async function fingerprint(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(entries.map(async (entry) => [entry.name, entry.isDirectory()
    ? await fingerprint(path.join(dir, entry.name)) : digest(await fs.readFile(path.join(dir, entry.name)))]));
  return digest(JSON.stringify(parts.sort(([a], [b]) => a.localeCompare(b))));
}

const npmOptions = ['--ignore-scripts', '--no-audit', '--no-fund', '--logs-max=0', '--fetch-retries=0',
  `--userconfig=${path.join(home, 'user.npmrc')}`, `--globalconfig=${path.join(home, 'global.npmrc')}`];
const contents = new Map();
const requests = new Set();
const server = createServer((req, res) => {
  requests.add(req.url);
  const artifact = contents.get(req.url);
  if (req.method !== 'GET' || !artifact) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': req.url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json',
    'content-length': artifact.length });
  res.end(artifact);
});

try {
  await Promise.all([home, cache].map((dir) => fs.mkdir(dir)));
  await Promise.all(['user.npmrc', 'global.npmrc'].map((name) => fs.writeFile(path.join(home, name), '')));
  const lockPackages = {};
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const registry = `http://127.0.0.1:${server.address().port}`;
  const registryOption = `--registry=${registry}`;
  for (const [name, dependencies] of [['lark-fixture-a', { 'lark-fixture-b': '1.0.0' }], ['lark-fixture-b', {}]]) {
    const pack = path.join(root, name);
    await fs.mkdir(pack);
    await json(path.join(pack, 'package.json'), { name, version: '1.0.0', dependencies,
      scripts: { install: 'node -e "process.exit(9)"' } });
    await fs.writeFile(path.join(pack, 'index.js'), `module.exports = '${name}';\n`);
    await run(npm, ['pack', ...npmOptions, `--cache=${cache}`], pack);
    const filename = `${name}-1.0.0.tgz`;
    const archive = await fs.readFile(path.join(pack, filename));
    const route = `/${name}/-/${filename}`;
    contents.set(route, archive);
    const resolved = `${registry}${route}`;
    const integrity = `sha512-${digest(archive, 'sha512', 'base64')}`;
    contents.set(`/${name}`, Buffer.from(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0', dependencies, dist: { tarball: resolved, integrity } } } })));
    await run(npm, ['cache', 'add', `${name}@1.0.0`, ...npmOptions, registryOption, `--cache=${cache}`], root);
    lockPackages[`node_modules/${name}`] = { version: '1.0.0', resolved, integrity,
      dependencies, hasInstallScript: true };
  }
  assert.deepEqual(requests, new Set(contents.keys()));
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await permissions(cache, true);
  const cacheHash = await fingerprint(cache);
  const metadata = { name: 'lark-probe-project', version: '1.0.0', dependencies: { 'lark-fixture-a': '1.0.0' } };
  const lock = { name: metadata.name, version: metadata.version, lockfileVersion: 3, requires: true, packages: { '': metadata, ...lockPackages } };
  const bootstrapNode = async (dest) => {
    await fs.mkdir(dest);
    await json(path.join(dest, 'package.json'), metadata);
    await json(path.join(dest, 'package-lock.json'), lock);
  };
  const dirs = ['npm-run-a', 'npm-run-b', 'npm-missing', 'npm-lock-mismatch'].map((name) => path.join(root, name));
  await Promise.all(dirs.map(bootstrapNode));
  await Promise.all(dirs.slice(0, 2).map((dir) => run(npm, ['ci', '--offline', ...npmOptions, registryOption, `--cache=${cache}`], dir)));
  const js = (dir) => path.join(dir, 'node_modules/lark-fixture-b/index.js');
  assert.notEqual((await fs.stat(js(dirs[0]))).ino, (await fs.stat(js(dirs[1]))).ino);
  await fs.writeFile(js(dirs[0]), 'changed');
  assert.match(await fs.readFile(js(dirs[1]), 'utf8'), /lark-fixture-b/);
  assert.equal(await fingerprint(cache), cacheHash);
  await assert.rejects(run(npm, ['ci', '--offline', ...npmOptions, registryOption, `--cache=${path.join(root, 'empty-npm-cache')}`], dirs[2]),
    (error) => /ENOTCACHED|only-if-cached/i.test(error.stderr));
  await json(path.join(dirs[3], 'package.json'), { ...metadata, dependencies: { 'lark-fixture-a': '2.0.0' } });
  await assert.rejects(run(npm, ['ci', '--offline', ...npmOptions, registryOption, `--cache=${cache}`], dirs[3]),
    (error) => /lock file|ENOTCACHED|No matching version/i.test(error.stderr));
  console.log(`Node ${process.version}, npm ${(await run(npm, ['--version'], root)).stdout.trim()}: two isolated transitive installs, read-only cache digest unchanged, missing cache and inconsistent lock rejected.`);

  const wheelhouse = path.join(root, 'wheelhouse');
  await fs.mkdir(wheelhouse);
  const requirements = [];
  for (const [name, depends] of [['lark_fixture_a', 'Requires-Dist: lark-fixture-b (>=1)\n'], ['lark_fixture_b', '']]) {
    const build = path.join(root, `${name}-wheel`);
    const distInfo = `${name}-1.0.0.dist-info`;
    const files = {
      [`${name}/__init__.py`]: `VALUE = '${name}'\n`,
      [`${distInfo}/METADATA`]: `Metadata-Version: 2.1\nName: ${name.replaceAll('_', '-')}\nVersion: 1.0.0\n${depends}\n`,
      [`${distInfo}/WHEEL`]: 'Wheel-Version: 1.0\nGenerator: offline-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
    };
    files[`${distInfo}/RECORD`] = Object.entries(files).map(([file, value]) =>
      `${file},sha256=${digest(value, 'sha256', 'base64url')},${Buffer.byteLength(value)}`).join('\n') + `\n${distInfo}/RECORD,,\n`;
    for (const [file, value] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(build, file)), { recursive: true });
      await fs.writeFile(path.join(build, file), value);
    }
    const destination = path.join(wheelhouse, `${name}-1.0.0-py3-none-any.whl`);
    await run('/usr/bin/zip', ['-q', destination, ...Object.keys(files)], build);
    requirements.push(`${name}==1.0.0 --hash=sha256:${digest(await fs.readFile(destination))}`);
  }
  await permissions(wheelhouse, true);
  const wheelsHash = await fingerprint(wheelhouse);
  const req = path.join(root, 'requirements.lock');
  await fs.writeFile(req, requirements.join('\n') + '\n');
  const installPython = (target, lockfile, from = wheelhouse) => run(py, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
    '--no-cache-dir', '--no-index', `--find-links=${from}`, '--only-binary=:all:', '--require-hashes', '--ignore-installed',
    `--target=${target}`, `--requirement=${lockfile}`], root, { PIP_CONFIG_FILE: '/dev/null' });
  const pyDirs = ['py-run-a', 'py-run-b', 'py-missing', 'py-hash-mismatch', 'py-incomplete-lock'].map((name) => path.join(root, name));
  await Promise.all(pyDirs.slice(0, 2).map((dir) => installPython(dir, req)));
  const module = (dir) => path.join(dir, 'lark_fixture_b', '__init__.py');
  assert.notEqual((await fs.stat(module(pyDirs[0]))).ino, (await fs.stat(module(pyDirs[1]))).ino);
  await fs.writeFile(module(pyDirs[0]), 'changed');
  assert.match(await fs.readFile(module(pyDirs[1]), 'utf8'), /lark_fixture_b/);
  assert.equal(await fingerprint(wheelhouse), wheelsHash);
  const emptyWheels = path.join(root, 'empty-wheels');
  await fs.mkdir(emptyWheels);
  await assert.rejects(installPython(pyDirs[2], req, emptyWheels), (error) => /No matching distribution found/i.test(error.stderr));
  const badLock = path.join(root, 'bad.lock');
  await fs.writeFile(badLock, requirements[0].replace(/:[a-f0-9]{64}$/, ':' + '0'.repeat(64)) + '\n');
  await assert.rejects(installPython(pyDirs[3], badLock), (error) => /do not match the hashes/i.test(error.stderr));
  const incompleteLock = path.join(root, 'incomplete.lock');
  await fs.writeFile(incompleteLock, `${requirements[0]}\n`);
  await assert.rejects(installPython(pyDirs[4], incompleteLock), (error) => /require-hashes/i.test(error.stderr));
  const { stdout: version } = await run(py, ['-I', '-m', 'pip', '--version'], root);
  console.log(`${version.trim().split(' from ')[0]}: two isolated wheel installs, read-only wheelhouse digest unchanged, missing wheel, invalid hash, and incomplete transitive lock rejected.`);

  const codexHome = path.join(root, 'codex-home');
  const sandboxRun = path.join(root, 'sandbox-run');
  const privateTemp = path.join(sandboxRun, 'tmp');
  await fs.mkdir(codexHome);
  await bootstrapNode(sandboxRun);
  await fs.mkdir(privateTemp);
  const rules = new Map([[':root', 'read'], [sandboxRun, 'write'], [cache, 'read'], [wheelhouse, 'read']]);
  const rulesConfig = [...rules].map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  const permission = `permissions={lark-deps={filesystem={${rulesConfig}},network={enabled=false}}}`;
  const usingSandbox = (cmd, args, profile = 'lark-deps') => run(codex, ['sandbox', '-c', permission, '-P', profile, '-C', sandboxRun, '--', cmd, ...args],
    sandboxRun, { CODEX_HOME: codexHome, TMPDIR: privateTemp, PIP_CONFIG_FILE: '/dev/null' });
  await usingSandbox('/usr/bin/touch', [path.join(sandboxRun, 'allowed')]);
  const denied = path.join(cache, 'denied');
  // This directory must be writable outside the sandbox, otherwise the denial proves nothing.
  await fs.chmod(cache, 0o700);
  try {
    await run('/usr/bin/touch', [denied], sandboxRun);
    await fs.unlink(denied);
    await assert.rejects(usingSandbox('/usr/bin/touch', [denied]),
      (error) => /permission denied|operation not permitted|read-only file system/i.test(error.stderr));
    await assert.rejects(fs.stat(denied), { code: 'ENOENT' });
  } finally {
    await fs.chmod(cache, 0o500);
  }
  const invalidMarker = path.join(sandboxRun, 'unexpected-profile-launch');
  await assert.rejects(usingSandbox('/usr/bin/touch', [invalidMarker], 'missing-profile'));
  await assert.rejects(fs.stat(invalidMarker), { code: 'ENOENT' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const connect = ['-e', `const socket = require('node:net').connect({ host: '127.0.0.1', port: ${server.address().port} });
    socket.once('connect', () => { socket.destroy(); });
    socket.on('error', () => { process.exitCode = 42; });
    socket.setTimeout(2000, () => { socket.destroy(); process.exitCode = 42; });`];
  await run(process.execPath, connect, sandboxRun);
  await assert.rejects(usingSandbox(process.execPath, connect), { code: 42 });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await usingSandbox(npm, ['ci', '--offline', ...npmOptions, registryOption, `--cache=${cache}`]);
  assert.match(await fs.readFile(js(sandboxRun), 'utf8'), /lark-fixture-b/);
  const sandboxPython = path.join(sandboxRun, 'python');
  await usingSandbox(py, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-index',
    `--find-links=${wheelhouse}`, '--only-binary=:all:', '--require-hashes', '--ignore-installed', `--target=${sandboxPython}`, `--requirement=${req}`]);
  assert.match(await fs.readFile(module(sandboxPython), 'utf8'), /lark_fixture_b/);
  assert.equal(await fingerprint(cache), cacheHash);
  assert.equal(await fingerprint(wheelhouse), wheelsHash);
  console.log('Native Codex: direct offline npm/pip installs passed; private writes allowed, shared writes and network denied, invalid profile rejected.');
} catch (error) {
  console.error(error.stderr || error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  for (const dir of [cache, path.join(root, 'wheelhouse')]) {
    try { await permissions(dir, false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.rm(root, { recursive: true, force: true });
}
