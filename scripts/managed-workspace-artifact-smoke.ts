import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContinuationArtifactStore } from '../src/continuation/artifact-store.js';
import { publishManagedArtifact, readManagedArtifact } from '../src/managed-workspace-artifact.js';
import { pinWorkspacePath, validateWorkspaceProject } from '../src/workspace-projects.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-artifact-anchor-'));
try {
  const base = await fs.realpath(home);
  const directory = path.join(base, 'artifacts');
  const elsewhere = path.join(base, 'elsewhere');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(elsewhere, { mode: 0o700 });
  const binding = await pinWorkspacePath(base, directory);
  const options = { binding, maxBytes: 1024, revalidate: async () => (await validateWorkspaceProject(base, binding)).directory };
  const content = Buffer.from('checkpoint result');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const relativePath = 'nested/result.txt';
  const publish = (name: string, bytes = content) => publishManagedArtifact({ ...options, relativePath: name, content: bytes });
  const read = (name: string) => readManagedArtifact({ ...options, relativePath: name, expectedSha256: sha256 });
  await publish(relativePath);
  await publish(relativePath);
  assert.deepEqual((await read(relativePath)).content, content);
  await assert.rejects(publish(relativePath, Buffer.from('replacement')), { code: 'artifact_invalid' });
  assert.deepEqual((await read(relativePath)).content, content);

  const previousAttempt = 'nested/resumed.txt';
  const stageKey = createHash('sha256').update(`${previousAttempt}\0${sha256}`).digest('hex');
  const stage = path.join(directory, 'nested', `.lark-retry-${stageKey}-${'a'.repeat(32)}.tmp`);
  await fs.writeFile(stage, content, { flag: 'wx', mode: 0o600 });
  await fs.link(stage, path.join(directory, previousAttempt));
  await publish(previousAttempt);
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
  assert.deepEqual((await read(previousAttempt)).content, content);

  const bounded = new ContinuationArtifactStore(base, content.length);
  const replica = async (name: string) => {
    const folder = path.join(base, name);
    await fs.mkdir(folder, { mode: 0o700 });
    const pin = await pinWorkspacePath(base, folder);
    return { folder, store: bounded.forManagedJob(name, pin, async () => (await validateWorkspaceProject(base, pin)).directory) };
  };
  const original = await replica('job_original');
  const filename = 'result.txt';
  await fs.writeFile(path.join(original.folder, filename), content);
  const replicaKey = createHash('sha256').update(`${filename}\0${sha256}`).digest('hex');
  for (const linked of [false, true]) {
    const jobId = linked ? 'job_interrupted_after_link' : 'job_interrupted_before_link';
    const target = await replica(jobId);
    const staged = path.join(target.folder, `.lark-retry-${replicaKey}-${'b'.repeat(32)}.tmp`);
    const result = path.join(target.folder, filename);
    await fs.writeFile(staged, content, { flag: 'wx', mode: 0o600 });
    if (linked) await fs.link(staged, result);
    assert.equal(await original.store.copyVerified('job_original', jobId,
      [{ id: 'result', deliverableId: 'output', path: filename, sha256 }], target.store), true);
    assert.deepEqual(await fs.readFile(result), content);
    assert.deepEqual(await fs.readdir(target.folder), [filename]);
  }
  const torn = await replica('job_torn');
  const unknown = path.join(torn.folder, `.lark-retry-${replicaKey}-${'c'.repeat(32)}.tmp`);
  await fs.writeFile(unknown, content.subarray(0, 4), { flag: 'wx', mode: 0o600 });
  await assert.rejects(original.store.copyVerified('job_original', 'job_torn',
    [{ id: 'result', deliverableId: 'output', path: filename, sha256 }], torn.store), { code: 'artifact_invalid' });
  assert.deepEqual(await fs.readFile(unknown), content.subarray(0, 4));
  await assert.rejects(fs.stat(path.join(torn.folder, filename)), { code: 'ENOENT' });

  await fs.mkdir(path.join(original.folder, 'nested'), { mode: 0o700 });
  await fs.rename(path.join(original.folder, filename), path.join(original.folder, relativePath));
  const empty = await replica('job_empty');
  assert.equal(await original.store.copyVerified('job_original', 'job_empty',
    [{ id: 'result', deliverableId: 'output', path: relativePath, sha256 }], empty.store), true);
  assert.deepEqual(await fs.readFile(path.join(empty.folder, relativePath)), content);

  await fs.writeFile(path.join(elsewhere, 'result.txt'), content);
  await fs.symlink(elsewhere, path.join(directory, 'linked'), 'dir');
  await assert.rejects(read('linked/result.txt'), { code: 'artifact_invalid' });
  await assert.rejects(publish('linked/new.txt'), { code: 'artifact_invalid' });
  assert.deepEqual(await fs.readdir(elsewhere), ['result.txt']);
  await fs.rename(directory, path.join(base, 'displaced'));
  await fs.mkdir(directory, { mode: 0o700 });
  // A stale in-process resolver must not make the helper trust a replacement root.
  await assert.rejects(publishManagedArtifact({ ...options, relativePath: 'new.txt', content,
    revalidate: async () => directory }), { code: 'artifact_invalid' });
  assert.deepEqual(await fs.readdir(directory), []);
} finally {
  await fs.rm(home, { force: true, recursive: true });
}
