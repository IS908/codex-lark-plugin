import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const packageRoot = join(process.cwd(), 'plugins/lark');
const runtimeRoot = mkdtempSync(join(tmpdir(), 'lark-runtime-package-'));
const home = mkdtempSync(join(tmpdir(), 'lark-runtime-home-'));

function copyRuntimePath(relativePath: string): void {
  const source = join(packageRoot, relativePath);
  const destination = join(runtimeRoot, relativePath);
  if (!existsSync(source)) return;
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !path.split('/').includes('node_modules'),
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
  assert.ok(!existsSync(join(runtimeRoot, 'node_modules')), 'runtime smoke must not copy node_modules');

  const result = spawnSync('npm', ['run', '--silent', 'start', '--', '--dry-run'], {
    cwd: runtimeRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      LARK_APP_ID: 'runtime_smoke_app_id',
      LARK_APP_SECRET: 'runtime_smoke_secret',
    },
  });

  assert.equal(result.stdout, '', 'runtime package startup must not write to stdout');
  assert.equal(
    result.status,
    0,
    [
      `runtime package dry-run failed from ${dirname(runtimeRoot)}`,
      `status=${result.status}`,
      'stderr:',
      result.stderr,
      'stdout:',
      result.stdout,
    ].join('\n'),
  );
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log('plugin-runtime-package smoke: PASS');
