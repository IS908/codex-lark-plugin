import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const rootTools = await import('../src/tools.js');
const replyTools = await import('../src/tools/reply.js');
const mutationTools = await import('../src/tools/message-mutation.js');
const memoryTools = await import('../src/tools/memory.js');
const jobTools = await import('../src/tools/jobs.js');
const githubIssueTools = await import('../src/tools/github-issues.js');

const expectedExports = [
  ['registerReplyTools', replyTools.registerReplyTools],
  ['capSanitizedFilename', replyTools.capSanitizedFilename],
  ['registerMessageMutationTools', mutationTools.registerMessageMutationTools],
  ['registerMemoryTools', memoryTools.registerMemoryTools],
  ['registerJobTools', jobTools.registerJobTools],
  ['registerGithubIssueTools', githubIssueTools.registerGithubIssueTools],
] as const;

for (const [name, fn] of expectedExports) {
  assert.equal(typeof fn, 'function', `${name} is exported from its domain module`);
  assert.equal(
    (rootTools as Record<string, unknown>)[name],
    fn,
    `root tools.js re-exports ${name} for compatibility`,
  );
}

assert.equal(replyTools.capSanitizedFilename('../../etc/passwd', 200), 'passwd');
assert.equal(replyTools.capSanitizedFilename('报告.pdf', 200), '__.pdf');

console.log('PASS');
