import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

function listFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported entry in Skill tree: ${relative(root, path)}`);
    }
    files.push(relative(root, path));
  }
  return files.sort();
}

function firstDifferingLine(left: Buffer, right: Buffer): number {
  const leftLines = left.toString('utf8').split(/\r?\n/);
  const rightLines = right.toString('utf8').split(/\r?\n/);
  const lineCount = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < lineCount; index++) {
    if (leftLines[index] !== rightLines[index]) return index + 1;
  }
  return lineCount;
}

export function findSkillMirrorDrift(canonicalRoot: string, mirrorRoot: string): string[] {
  const canonicalFiles = new Set(listFiles(canonicalRoot));
  const mirrorFiles = new Set(listFiles(mirrorRoot));
  const paths = [...new Set([...canonicalFiles, ...mirrorFiles])].sort();
  const drift: string[] = [];

  for (const path of paths) {
    if (!canonicalFiles.has(path)) {
      drift.push(`unexpected mirror file: ${path}`);
      continue;
    }
    if (!mirrorFiles.has(path)) {
      drift.push(`missing mirror file: ${path}`);
      continue;
    }
    const canonical = readFileSync(join(canonicalRoot, path));
    const mirror = readFileSync(join(mirrorRoot, path));
    if (!canonical.equals(mirror)) {
      drift.push(`content mismatch: ${path} (first differing line ${firstDifferingLine(canonical, mirror)})`);
    }
  }
  return drift;
}

function writeFixture(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'skill-mirror-sync-'));
try {
  const canonical = join(fixtureRoot, 'canonical');
  const mirror = join(fixtureRoot, 'mirror');
  mkdirSync(canonical);
  mkdirSync(mirror);
  writeFixture(canonical, 'configure/SKILL.md', 'canonical\n');
  writeFixture(canonical, 'jobs/SKILL.md', 'same\n');
  writeFixture(mirror, 'configure/SKILL.md', 'changed\n');
  writeFixture(mirror, 'extra/SKILL.md', 'extra\n');

  assert.deepEqual(findSkillMirrorDrift(canonical, mirror), [
    'content mismatch: configure/SKILL.md (first differing line 1)',
    'unexpected mirror file: extra/SKILL.md',
    'missing mirror file: jobs/SKILL.md',
  ]);

  rmSync(mirror, { recursive: true });
  mkdirSync(mirror);
  writeFixture(mirror, 'configure/SKILL.md', 'canonical\n');
  writeFixture(mirror, 'jobs/SKILL.md', 'same\n');
  assert.deepEqual(findSkillMirrorDrift(canonical, mirror), []);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const drift = findSkillMirrorDrift('skills', 'plugins/lark/skills');
if (drift.length > 0) {
  throw new Error(
    `Skill mirror drift detected. Keep plugins/lark/skills identical to canonical skills/:\n- ${drift.join('\n- ')}`,
  );
}

console.log('skill-mirror-sync smoke: PASS');
