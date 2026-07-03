/**
 * Built-in GitHub issue creator smoke tests.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubIssueFromProposal } from '../src/github-issue-creator.js';
import { appConfig } from '../src/config.js';
import type { IssueProposalFile } from '../src/issue-proposal-store.js';

const root = mkdtempSync(join(tmpdir(), 'github-issue-creator-'));
const oldGhCommand = (appConfig as any).githubIssueGhCommand;
const oldTimeoutMs = (appConfig as any).githubIssueTimeoutMs;
const oldApiBaseUrl = (appConfig as any).githubIssueApiBaseUrl;
const oldToken = (appConfig as any).githubIssueToken;
const oldFetch = globalThis.fetch;

function proposal(title = 'Use gh first for issue creation'): IssueProposalFile {
  return {
    meta: {
      id: 'proposal-smoke',
      title,
      body: 'Default issue filing should not require a custom local wrapper.',
      evidence: ['wrapper name was easy to misconfigure'],
      priority: 'P1',
      automation_level: 'discovery-only',
      target_repo: 'IS908/codex-lark-plugin',
      target_chat_id: 'oc_review',
      origin_chat_id: 'oc_review',
      created_by: 'ou_owner',
      created_at: '2026-07-04T00:00:00.000Z',
      status: 'approved',
    },
  };
}

try {
  const ghSuccess = join(root, 'fake-gh-success.js');
  const ghCalls = join(root, 'gh-calls.json');
  writeFileSync(
    ghSuccess,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `const callsPath = ${JSON.stringify(ghCalls)};`,
      'const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, "utf8")) : [];',
      'calls.push(process.argv.slice(2));',
      'fs.writeFileSync(callsPath, JSON.stringify(calls, null, 2));',
      'console.log("https://github.com/IS908/codex-lark-plugin/issues/501");',
    ].join('\n'),
  );
  chmodSync(ghSuccess, 0o755);

  (appConfig as any).githubIssueGhCommand = ghSuccess;
  (appConfig as any).githubIssueTimeoutMs = 5000;
  (appConfig as any).githubIssueToken = null;

  const ghResult = await createGithubIssueFromProposal(proposal());
  assert.equal(ghResult.ok, true, ghResult.message);
  assert.equal(ghResult.issueUrl, 'https://github.com/IS908/codex-lark-plugin/issues/501');
  assert.equal(ghResult.method, 'gh');
  const calls = JSON.parse(await readFile(ghCalls, 'utf-8')) as string[][];
  assert.deepEqual(calls[0].slice(0, 4), ['issue', 'create', '--repo', 'IS908/codex-lark-plugin']);
  assert.ok(calls[0].includes('--title'));
  assert.ok(calls[0].includes('--body'));

  const ghFailure = join(root, 'fake-gh-failure.js');
  writeFileSync(
    ghFailure,
    [
      '#!/usr/bin/env node',
      'console.error("gh auth status: not logged in");',
      'process.exit(1);',
    ].join('\n'),
  );
  chmodSync(ghFailure, 0o755);

  let requestUrl = '';
  let requestBody = '';
  let requestAuth = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestAuth = String(init?.headers ? (init.headers as Record<string, string>).Authorization : '');
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ html_url: 'https://github.example.test/IS908/codex-lark-plugin/issues/502' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  (appConfig as any).githubIssueGhCommand = ghFailure;
  (appConfig as any).githubIssueApiBaseUrl = 'https://api.test.github.local';
  (appConfig as any).githubIssueToken = 'test-token';

  const httpResult = await createGithubIssueFromProposal(proposal('HTTP fallback issue'));
  assert.equal(httpResult.ok, true, httpResult.message);
  assert.equal(httpResult.issueUrl, 'https://github.example.test/IS908/codex-lark-plugin/issues/502');
  assert.equal(httpResult.method, 'http');
  assert.equal(requestUrl, 'https://api.test.github.local/repos/IS908/codex-lark-plugin/issues');
  assert.equal(requestAuth, 'Bearer test-token');
  const parsedBody = JSON.parse(requestBody);
  assert.equal(parsedBody.title, 'HTTP fallback issue');
  assert.match(parsedBody.body, /Authorization Required/);
} finally {
  (appConfig as any).githubIssueGhCommand = oldGhCommand;
  (appConfig as any).githubIssueTimeoutMs = oldTimeoutMs;
  (appConfig as any).githubIssueApiBaseUrl = oldApiBaseUrl;
  (appConfig as any).githubIssueToken = oldToken;
  globalThis.fetch = oldFetch;
  rmSync(root, { recursive: true, force: true });
}

console.log('github-issue-creator smoke: PASS');
