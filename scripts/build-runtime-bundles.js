import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
const checkOnly = args.includes('--check');
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

  const outputPath = path.join(packageRoot, outputDir);
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [indexEntry, stopEntry],
    outdir: outputPath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: target !== 'plugins/lark',
    banner: { js: nodeEsmCompatBanner },
    logLevel: 'silent',
    write: !checkOnly,
  });

  const label = `${path.relative(repoRoot, packageRoot) || '.'}/${outputDir}`;
  if (checkOnly) {
    const generated = result.outputFiles ?? [];
    const generatedNames = new Set(generated.map((file) => path.basename(file.path)));
    const actualNames = existsSync(outputPath)
      ? readdirSync(outputPath).filter((name) => name.endsWith('.js') || name.endsWith('.js.map'))
      : [];
    const extra = actualNames.filter((name) => !generatedNames.has(name));
    const changed = generated.filter((file) => {
      if (!existsSync(file.path)) return true;
      return !Buffer.from(file.contents).equals(readFileSync(file.path));
    });
    if (extra.length > 0 || changed.length > 0) {
      const details = [
        ...changed.map((file) => `${path.basename(file.path)} is missing or stale`),
        ...extra.map((name) => `${name} is not generated`),
      ];
      throw new Error(`Runtime bundle is out of sync for ${label}: ${details.join(', ')}`);
    }
    console.error(`[build-runtime] bundle sync ok ${label}`);
  } else {
    console.error(`[build-runtime] bundled ${label}`);
  }
}
