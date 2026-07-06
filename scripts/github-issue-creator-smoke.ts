/**
 * Built-in GitHub issue creator smoke tests.
 */
import assert from 'node:assert/strict';
import { createGithubIssue, createGithubIssueFromProposal } from '../src/github-issue-creator.js';
import { appConfig } from '../src/config.js';
import type { IssueProposalFile } from '../src/issue-proposal-store.js';

const oldTimeoutMs = (appConfig as any).githubIssueTimeoutMs;
const oldApiBaseUrl = (appConfig as any).githubIssueApiBaseUrl;
const oldToken = (appConfig as any).githubIssueToken;
const oldFetch = globalThis.fetch;

function proposal(title = 'Use HTTP for issue creation'): IssueProposalFile {
  return {
    meta: {
      id: 'proposal-smoke',
      title,
      body: 'Default issue filing should not require a host-local CLI wrapper.',
      evidence: ['raw executable names are not configured tool aliases'],
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
  (appConfig as any).githubIssueToken = null;
  const missingDirectToken = await createGithubIssue({
    targetRepo: 'IS908/codex-lark-plugin',
    title: 'Missing token',
    body: 'Direct GitHub issue creation needs a token.',
  });
  assert.equal(missingDirectToken.ok, false);
  assert.match(missingDirectToken.message, /LARK_GITHUB_TOKEN/);

  const missingToken = await createGithubIssueFromProposal(proposal('Missing token'));
  assert.equal(missingToken.ok, false);
  assert.match(missingToken.message, /LARK_GITHUB_TOKEN|configured local CLI override tool/);

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
  (appConfig as any).githubIssueApiBaseUrl = 'https://api.test.github.local';
  (appConfig as any).githubIssueTimeoutMs = 5000;
  (appConfig as any).githubIssueToken = 'test-token';

  const directResult = await createGithubIssue({
    targetRepo: 'IS908/codex-lark-plugin',
    title: 'Direct HTTP issue',
    body: 'The user explicitly authorized direct filing.',
  });
  assert.equal(directResult.ok, true, directResult.message);
  assert.equal(directResult.issueUrl, 'https://github.example.test/IS908/codex-lark-plugin/issues/502');
  assert.equal(directResult.method, 'http');
  assert.equal(requestUrl, 'https://api.test.github.local/repos/IS908/codex-lark-plugin/issues');
  assert.equal(requestAuth, 'Bearer test-token');
  let parsedBody = JSON.parse(requestBody);
  assert.equal(parsedBody.title, 'Direct HTTP issue');
  assert.equal(parsedBody.body, 'The user explicitly authorized direct filing.');

  const httpResult = await createGithubIssueFromProposal(proposal('HTTP issue'));
  assert.equal(httpResult.ok, true, httpResult.message);
  assert.equal(httpResult.issueUrl, 'https://github.example.test/IS908/codex-lark-plugin/issues/502');
  assert.equal(httpResult.method, 'http');
  assert.equal(requestUrl, 'https://api.test.github.local/repos/IS908/codex-lark-plugin/issues');
  assert.equal(requestAuth, 'Bearer test-token');
  parsedBody = JSON.parse(requestBody);
  assert.equal(parsedBody.title, 'HTTP issue');
  assert.match(parsedBody.body, /Authorization Required/);
} finally {
  (appConfig as any).githubIssueTimeoutMs = oldTimeoutMs;
  (appConfig as any).githubIssueApiBaseUrl = oldApiBaseUrl;
  (appConfig as any).githubIssueToken = oldToken;
  globalThis.fetch = oldFetch;
}

console.log('github-issue-creator smoke: PASS');
