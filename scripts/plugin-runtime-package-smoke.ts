import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const packageRoot = join(process.cwd(), 'plugins/lark');
const runtimeRoot = mkdtempSync(join(tmpdir(), 'lark-runtime-package-'));
const home = mkdtempSync(join(tmpdir(), 'lark-runtime-home-'));
const appId = `runtime_smoke_${process.pid}`;

function copyRuntimePath(relativePath: string): void {
  const source = join(packageRoot, relativePath);
  const destination = join(runtimeRoot, relativePath);
  if (!existsSync(source)) return;
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !path.split('/').includes('node_modules'),
  });
}

function runPluginScript(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('npm', ['run', '--silent', script, ...args], {
    cwd: runtimeRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      ...env,
    },
  });
}

try {
  for (const relativePath of [
    'package.json',
    'package-lock.json',
    '.mcp.json',
    '.codex-plugin',
    '.env.example',
    'skills',
    'runtime',
  ]) {
    copyRuntimePath(relativePath);
  }

  assert.ok(existsSync(join(runtimeRoot, 'runtime/index.js')), 'runtime package must include runtime/index.js');
  assert.ok(existsSync(join(runtimeRoot, 'runtime/stop.js')), 'runtime package must include runtime/stop.js');
  assert.ok(existsSync(join(runtimeRoot, 'runtime/doctor.js')), 'runtime package must include runtime/doctor.js');
  assert.ok(!existsSync(join(runtimeRoot, 'src')), 'runtime package must not include mirrored TypeScript source');
  assert.ok(!existsSync(join(runtimeRoot, 'node_modules')), 'runtime smoke must not copy node_modules');

  const startResult = runPluginScript('start', ['--', '--dry-run'], {
    LARK_APP_ID: appId,
    LARK_APP_SECRET: 'runtime_smoke_secret',
  });

  assert.equal(startResult.stdout, '', 'runtime package startup must not write to stdout');
  assert.equal(
    startResult.status,
    0,
    [
      `runtime package dry-run failed from ${dirname(runtimeRoot)}`,
      `status=${startResult.status}`,
      'stderr:',
      startResult.stderr,
      'stdout:',
      startResult.stdout,
    ].join('\n'),
  );

  const stopResult = runPluginScript('stop', [], {
    LARK_APP_ID: appId,
    LARK_APP_SECRET: 'runtime_smoke_secret',
  });
  assert.equal(stopResult.stdout, '', 'runtime package stop must not write to stdout');
  assert.equal(stopResult.status, 0, `runtime package stop failed:\n${stopResult.stderr}`);

  const doctorResult = runPluginScript('doctor', [], {
    LARK_APP_ID: '',
    LARK_APP_SECRET: '',
  });
  assert.equal(doctorResult.stdout, '', 'runtime package doctor must not write to stdout');
  assert.equal(doctorResult.status, 1, 'doctor without configuration must report a diagnostic failure');
  assert.match(doctorResult.stderr, /codex-lark-plugin doctor/);
  assert.match(doctorResult.stderr, /^FAIL\s/m);
  assert.doesNotMatch(doctorResult.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log('plugin-runtime-package smoke: PASS');
