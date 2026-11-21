import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceProjectBinding } from './domain/workspace.js';
import { isManagedArtifactRelativePath } from './domain/managed-workspace.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';

const exec = promisify(execFile);
const HARD_BYTE_LIMIT = 100 * 1024 * 1024;

// Use a kernel-held cwd at each level: only enter directories that were opened without following links.
const artifactProgram = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const { createHash, randomBytes } = require('node:crypto');
  const [operation, root, dev, ino, relative, limitText, expected] = process.argv.slice(1);
  const limit = Number(limitText);
  const mode = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const stable = (a, b) => same(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const stat = (name) => fs.lstatSync(name, { bigint: true });
  const guard = (ok) => { if (!ok) throw new Error('Invalid artifact'); };
  let current = root;
  let identity;
  function guardParent() {
    const named = stat(current);
    guard(named.isDirectory() && same(identity, named) && same(identity, stat('.')));
    guard(named.uid === BigInt(process.geteuid()) && (named.mode & 0o022n) === 0n);
  }
  function read(leaf, allowedLinks) {
    const fd = fs.openSync(leaf, mode);
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      guard(before.isFile() && before.nlink === allowedLinks && before.size <= BigInt(limit) && stable(before, stat(leaf)));
      const content = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < content.length;) {
        const received = fs.readSync(fd, content, offset, content.length - offset, offset);
        guard(received > 0);
        offset += received;
      }
      guardParent();
      guard(stable(before, fs.fstatSync(fd, { bigint: true })) && stable(before, stat(leaf)));
      guard(!expected || sha(content) === expected);
      return content;
    } finally { fs.closeSync(fd); }
  }
  const prefix = '.lark-retry-' + sha(relative + '\0' + expected) + '-';
  function reconcile(leaf) {
    let existing;
    try { existing = stat(leaf); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stages = fs.readdirSync('.').filter((name) => name.startsWith(prefix)
      && /^[a-f0-9]{32}\.tmp$/.test(name.slice(prefix.length)));
    if (stages.length === 0) return !!existing;
    guard(stages.length === 1);
    const [stage] = stages;
    const staged = stat(stage);
    guard(staged.isFile() && staged.uid === BigInt(process.geteuid()) && (staged.mode & 0o077n) === 0n);
    if (existing) {
      guard(same(existing, staged));
      read(leaf, 2n);
    } else {
      read(stage, 1n);
      guardParent();
      guard(stable(staged, stat(stage)));
      fs.linkSync(stage, leaf);
    }
    guardParent();
    guard(same(staged, stat(stage)) && same(staged, stat(leaf)));
    fs.unlinkSync(stage);
    read(leaf, 1n);
    return true;
  }
  function publish(leaf) {
    const content = fs.readFileSync(0);
    guard(content.length <= limit && sha(content) === expected);
    if (reconcile(leaf)) {
      read(leaf, 1n);
      return;
    }
    const staged = prefix + randomBytes(16).toString('hex') + '.tmp';
    const fd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      guardParent();
      guard(same(fs.fstatSync(fd, { bigint: true }), stat(staged)));
      fs.linkSync(staged, leaf);
    } finally {
      const created = fs.fstatSync(fd, { bigint: true });
      fs.closeSync(fd);
      if (same(created, stat(staged))) fs.unlinkSync(staged);
    }
  }
  function main() {
    const start = stat('.');
    guard(process.geteuid && String(start.dev) === dev && String(start.ino) === ino);
    identity = start;
    guardParent();
    const names = relative.split('/');
    const leaf = names.pop();
    for (const name of names) {
      if (operation === 'publish') {
        try { fs.mkdirSync(name, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      let fd;
      try { fd = fs.openSync(name, mode | fs.constants.O_DIRECTORY); }
      catch (error) {
        if (operation === 'reconcile' && error.code === 'ENOENT') return;
        throw error;
      }
      try {
        const child = fs.fstatSync(fd, { bigint: true });
        guard(child.isDirectory() && child.uid === start.uid && (child.mode & 0o022n) === 0n);
        process.chdir(name);
        current = path.join(current, name);
        identity = child;
        guardParent();
      } finally { fs.closeSync(fd); }
    }
    if (operation === 'publish') {
      publish(leaf);
      guardParent();
    } else if (operation === 'reconcile') {
      reconcile(leaf);
    } else {
      const result = read(leaf, 1n);
      process.stdout.write(result);
    }
  }
  try { main(); } catch {
    process.exitCode = 1;
  }
`;

interface FileOptions {
  binding: WorkspaceProjectBinding;
  relativePath: string;
  maxBytes: number;
  revalidate: () => Promise<string>;
}

export async function readManagedArtifact(options: FileOptions & { expectedSha256?: string }): Promise<{ content: Buffer; sha256: string }> {
  const content = await runArtifactOperation(options, options.expectedSha256?.toLowerCase() ?? '');
  return { content, sha256: createHash('sha256').update(content).digest('hex') };
}

export async function publishManagedArtifact(options: FileOptions & { content: Buffer }): Promise<void> {
  const sha256 = createHash('sha256').update(options.content).digest('hex');
  await runArtifactOperation(options, sha256, options.content);
}

export async function reconcileManagedArtifact(options: FileOptions & { expectedSha256: string }): Promise<void> {
  await runArtifactOperation(options, options.expectedSha256.toLowerCase(), undefined, 'reconcile');
}

async function runArtifactOperation(
  options: FileOptions, sha256: string, input?: Buffer, operation: 'read' | 'publish' | 'reconcile' = input ? 'publish' : 'read',
): Promise<Buffer> {
  const { binding, relativePath, maxBytes, revalidate } = options;
  const safePath = isManagedArtifactRelativePath(relativePath);
  if (!safePath || path.isAbsolute(relativePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 0
    || (operation !== 'read' && !/^[a-f0-9]{64}$/.test(sha256))
    || maxBytes > HARD_BYTE_LIMIT || (input && input.length > maxBytes)) throw new ManagedWorkspaceStorageError('artifact_invalid');
  try {
    if (await revalidate() !== binding.directory) throw new Error('Stale artifact directory.');
    const running = exec(process.execPath, ['--input-type=commonjs', '-e', artifactProgram, '--',
      operation, binding.directory, binding.device, binding.inode, relativePath, String(maxBytes), sha256], {
      cwd: binding.directory, env: {}, maxBuffer: maxBytes + 1024, timeout: 30_000, encoding: 'buffer',
    });
    running.child.stdin?.on('error', () => {});
    running.child.stdin?.end(input);
    const { stdout } = await running;
    if (await revalidate() !== binding.directory) throw new Error('Stale artifact directory.');
    return stdout;
  } catch {
    throw new ManagedWorkspaceStorageError('artifact_invalid');
  }
}
