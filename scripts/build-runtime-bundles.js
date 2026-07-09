import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
const targets =
  targetIndex >= 0 && args[targetIndex + 1]
    ? [args[targetIndex + 1]]
    : ['.', 'plugins/lark'];

const nodeEsmCompatBanner = [
  "import { createRequire as __larkCreateRequire } from 'node:module';",
  "import { fileURLToPath as __larkFileURLToPath } from 'node:url';",
  "import { dirname as __larkPathDirname } from 'node:path';",
  'const require = __larkCreateRequire(import.meta.url);',
  'const __filename = __larkFileURLToPath(import.meta.url);',
  'const __dirname = __larkPathDirname(__filename);',
].join(' ');

for (const target of targets) {
  const packageRoot = path.resolve(repoRoot, target);
  const indexEntry = path.join(packageRoot, 'src/index.ts');
  const stopEntry = path.join(packageRoot, 'src/stop.ts');
  const outputDir = target === 'plugins/lark' ? 'runtime' : 'dist';

  if (!existsSync(indexEntry) || !existsSync(stopEntry)) {
    throw new Error(`runtime bundle target is missing src/index.ts or src/stop.ts: ${target}`);
  }

  await build({
    entryPoints: [indexEntry, stopEntry],
    outdir: path.join(packageRoot, outputDir),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: target !== 'plugins/lark',
    banner: { js: nodeEsmCompatBanner },
    logLevel: 'silent',
  });

  console.error(`[build-runtime] bundled ${path.relative(repoRoot, packageRoot) || '.'}/${outputDir}`);
}
