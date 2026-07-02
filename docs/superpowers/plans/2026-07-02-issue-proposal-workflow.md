# Issue Proposal Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable human-authorized issue proposal workflow for periodic Codex reviews.

**Architecture:** Add a focused local proposal store, then expose it through MCP tools and Codex exec structured actions. GitHub writes stay behind the existing allowlisted `run_local_cli_tool` mechanism.

**Tech Stack:** TypeScript ESM, MCP tool registration, local JSON files, existing smoke-test scripts.

## Global Constraints

- Do not auto-merge or auto-release anything.
- GitHub issue creation must go through `run_local_cli_tool`.
- Caller identity must be server-derived from the active Feishu session.
- Feishu-visible errors should use English by default.
- Self-review and self-repair cronjob presets may be built in, but must be disabled by default until the user explicitly enables them.
- Keep `src/` and `plugins/lark/src/` synchronized.

---

### Task 1: Proposal Store

**Files:**
- Create: `src/issue-proposal-store.ts`
- Test: `scripts/issue-proposal-store-smoke.ts`
- Modify: `scripts/test.sh`

**Interfaces:**
- Produces: `createIssueProposal(input)`, `listIssueProposals(filter)`, `readIssueProposal(id)`, `createIssueFromProposal(id, input)`, `rejectIssueProposal(id, input)`, `formatIssueProposalForList(proposal)`.

- [ ] Write failing store smoke tests for create/list/read/created/reject idempotency.
- [ ] Run `node --import tsx scripts/issue-proposal-store-smoke.ts` and confirm it fails because the module is missing.
- [ ] Implement the store with JSON files under `appConfig.issueProposalsDir`.
- [ ] Run the store smoke test and confirm it passes.

### Task 2: MCP Tools

**Files:**
- Create: `src/tools/issue-proposals.ts`
- Modify: `src/tools.ts`
- Test: `scripts/issue-proposal-tools-smoke.ts`

**Interfaces:**
- Produces MCP tools: `create_issue_proposal`, `list_issue_proposals`, `reject_issue_proposal`, `create_issue_from_proposal`.

- [ ] Write failing tool smoke tests for create/list authorization and issue creation through a configured local CLI tool.
- [ ] Run `node --import tsx scripts/issue-proposal-tools-smoke.ts` and confirm it fails because tools are not registered.
- [ ] Implement the tools with server-derived caller identity.
- [ ] Run the tool smoke test and confirm it passes.

### Task 3: Codex Exec Actions

**Files:**
- Modify: `src/codex-exec-actions.ts`
- Modify: `src/codex-exec-delivery.ts`
- Test: `scripts/codex-exec-actions-smoke.ts`

**Interfaces:**
- Produces action types: `create_issue_proposal`, `list_issue_proposals`, `reject_issue_proposal`, `create_issue_from_proposal`.

- [ ] Add failing exec action smoke coverage for proposal creation and approval.
- [ ] Run `node --import tsx scripts/codex-exec-actions-smoke.ts` and confirm it fails.
- [ ] Implement parsing, validation, and dispatch.
- [ ] Run the exec action smoke test and confirm it passes.

### Task 4: Docs, Sync, Verification

**Files:**
- Modify: `src/tools/jobs.ts`
- Modify: `README.md`
- Modify: `README_CN.md`
- Mirror `src/` changes into `plugins/lark/src/`

- [ ] Add disabled self-review/self-repair job preset guidance without enabling jobs automatically.
- [ ] Document the periodic review issue proposal flow and local CLI wrapper shape.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run --silent check:plugin-src-sync`.
- [ ] Run `git diff --check`.
