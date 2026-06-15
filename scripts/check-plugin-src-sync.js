import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const sourceDir = path.join(root, 'src');
const wrappedDir = path.join(root, 'plugins/lark/src');

function collectFiles(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

assert.ok(fs.existsSync(sourceDir), 'src directory must exist');
assert.ok(fs.existsSync(wrappedDir), 'plugins/lark/src directory must exist');

const sourceFiles = collectFiles(sourceDir);
const wrappedFiles = collectFiles(wrappedDir);
const sourceSet = new Set(sourceFiles);
const wrappedSet = new Set(wrappedFiles);

const missingInWrapped = sourceFiles.filter((file) => !wrappedSet.has(file));
const extraInWrapped = wrappedFiles.filter((file) => !sourceSet.has(file));
const changed = sourceFiles.filter((file) => {
  if (!wrappedSet.has(file)) return false;
  const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  const wrapped = fs.readFileSync(path.join(wrappedDir, file), 'utf8');
  return source !== wrapped;
});

const failures = [
  ...missingInWrapped.map((file) => `missing in plugins/lark/src: ${file}`),
  ...extraInWrapped.map((file) => `extra in plugins/lark/src: ${file}`),
  ...changed.map((file) => `content differs: ${file}`),
];

if (failures.length > 0) {
  console.error('Plugin wrapper source is out of sync with src/.');
  for (const failure of failures.slice(0, 50)) {
    console.error(`- ${failure}`);
  }
  if (failures.length > 50) {
    console.error(`...and ${failures.length - 50} more difference(s).`);
  }
  process.exit(1);
}

console.error('plugin source sync check ok');
