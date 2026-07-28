import { build } from 'esbuild';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function normalizeGeneratedFile(file) {
  if (!file.path.endsWith('.js')) return Buffer.from(file.contents);
  return Buffer.from(
    Buffer.from(file.contents)
      .toString('utf8')
      .replace(/[ \t]+$/gm, ''),
  );
}

function collectGeneratedPaths(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      return collectGeneratedPaths(path.join(dir, entry.name), relativePath);
    }
    return entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.js.map'))
      ? [relativePath]
      : [];
  });
}

for (const target of targets) {
  const packageRoot = path.resolve(repoRoot, target);
  const sourceRoot = path.join(repoRoot, 'src');
  const entryPoints = {
    index: path.join(sourceRoot, 'index.ts'),
    stop: path.join(sourceRoot, 'stop.ts'),
    ...(target === 'plugins/lark'
      ? { doctor: path.join(sourceRoot, 'configure-doctor-cli.ts') }
      : {}),
  };
  const outputDir = target === 'plugins/lark' ? 'runtime' : 'dist';

  const missingEntries = Object.values(entryPoints).filter((entry) => !existsSync(entry));
  if (missingEntries.length > 0) {
    throw new Error(`Runtime bundle source is missing: ${missingEntries.join(', ')}`);
  }

  const outputPath = path.join(packageRoot, outputDir);
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints,
    outdir: outputPath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    splitting: target === 'plugins/lark',
    chunkNames: 'chunks/[name]-[hash]',
    sourcemap: target !== 'plugins/lark',
    banner: { js: nodeEsmCompatBanner },
    logLevel: 'silent',
    write: false,
  });

  const label = `${path.relative(repoRoot, packageRoot) || '.'}/${outputDir}`;
  const generated = result.outputFiles ?? [];
  if (checkOnly) {
    const generatedNames = new Set(
      generated.map((file) => path.relative(outputPath, file.path)),
    );
    const actualNames = collectGeneratedPaths(outputPath);
    const extra = actualNames.filter((name) => !generatedNames.has(name));
    const changed = generated.filter((file) => {
      if (!existsSync(file.path)) return true;
      return !normalizeGeneratedFile(file).equals(readFileSync(file.path));
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
    if (target === 'plugins/lark') {
      rmSync(outputPath, { recursive: true, force: true });
    }
    mkdirSync(outputPath, { recursive: true });
    for (const file of generated) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, normalizeGeneratedFile(file));
    }
    console.error(`[build-runtime] bundled ${label}`);
  }
}
