/**
 * Issue Proposal Store — durable pending GitHub issue proposals.
 *
 * Periodic review jobs can create proposal records and ask a maintainer in
 * Feishu whether to file them. GitHub writes happen later through an
 * allowlisted local CLI tool after explicit human authorization.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';

export type IssueProposalPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type IssueProposalAutomationLevel = 'discovery-only' | 'low-risk-auto-pr-eligible';
export type IssueProposalStatus = 'pending' | 'approved' | 'created' | 'rejected';

export interface IssueProposalMeta {
  id: string;
  title: string;
  body: string;
  evidence: string[];
  impact?: string;
  priority: IssueProposalPriority;
  automation_level: IssueProposalAutomationLevel;
  target_repo: string;
  target_chat_id: string;
  origin_chat_id: string;
  created_by: string;
  created_at: string;
  status: IssueProposalStatus;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  github_issue_url?: string;
  github_issue_number?: number;
  created_issue_at?: string;
  github_pr_url?: string;
  github_pr_number?: number;
  created_pr_at?: string;
  pr_last_error?: string;
  last_error?: string;
}

export interface IssueProposalFile {
  meta: IssueProposalMeta;
}

export interface CreateIssueProposalInput {
  title: string;
  body: string;
  evidence?: string[];
  impact?: string;
  priority?: IssueProposalPriority;
  automationLevel?: IssueProposalAutomationLevel;
  targetRepo: string;
  targetChatId: string;
  originChatId: string;
  createdBy: string;
  now?: Date;
}

export interface IssueProposalListFilter {
  status?: IssueProposalStatus | 'all';
  targetChatId?: string;
  createdBy?: string;
}

export interface MarkIssueProposalApprovedInput {
  approvedBy: string;
  lastError?: string;
  now?: Date;
}

export interface MarkIssueProposalCreatedInput {
  approvedBy: string;
  githubIssueUrl: string;
  githubIssueNumber?: number;
  now?: Date;
}

export interface MarkIssueProposalPullRequestCreatedInput {
  approvedBy: string;
  githubPullRequestUrl: string;
  githubPullRequestNumber?: number;
  now?: Date;
}

export interface MarkIssueProposalPullRequestErrorInput {
  approvedBy: string;
  lastError: string;
  now?: Date;
}

export interface RejectIssueProposalInput {
  rejectedBy: string;
  reason?: string;
  now?: Date;
}

const ID_MAX_SLUG_LENGTH = 60;

function proposalDir(): string {
  return appConfig.issueProposalsDir;
}

function proposalPath(id: string): string {
  return path.join(proposalDir(), `${sanitizeIssueProposalId(id)}.json`);
}

function timestampForId(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

export function sanitizeIssueProposalId(input: string): string {
  const id = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!id) throw new Error('issue proposal id is required');
  return id;
}

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_SLUG_LENGTH);
  return slug || 'issue';
}

function normalizePriority(input?: IssueProposalPriority): IssueProposalPriority {
  return input ?? 'P2';
}

function normalizeAutomationLevel(input?: IssueProposalAutomationLevel): IssueProposalAutomationLevel {
  return input ?? 'discovery-only';
}

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function githubIssueNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/issues\/(\d+)(?:$|[?#])/);
  return match ? Number(match[1]) : undefined;
}

function githubPullRequestNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)(?:$|[?#])/);
  return match ? Number(match[1]) : undefined;
}

export async function writeIssueProposal(proposal: IssueProposalFile): Promise<void> {
  await fs.mkdir(proposalDir(), { recursive: true });
  await fs.writeFile(proposalPath(proposal.meta.id), JSON.stringify(proposal, null, 2));
}

export async function readIssueProposal(id: string): Promise<IssueProposalFile | null> {
  try {
    const raw = await fs.readFile(proposalPath(id), 'utf-8');
    return JSON.parse(raw) as IssueProposalFile;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function createIssueProposal(input: CreateIssueProposalInput): Promise<IssueProposalFile> {
  const now = input.now ?? new Date();
  const title = assertNonEmpty(input.title, 'title');
  const body = assertNonEmpty(input.body, 'body');
  const targetRepo = assertNonEmpty(input.targetRepo, 'targetRepo');
  const targetChatId = assertNonEmpty(input.targetChatId, 'targetChatId');
  const originChatId = assertNonEmpty(input.originChatId, 'originChatId');
  const createdBy = assertNonEmpty(input.createdBy, 'createdBy');
  const baseId = `proposal-${timestampForId(now)}-${slugifyTitle(title)}`;
  let id = baseId;
  for (let i = 2; await readIssueProposal(id); i += 1) {
    id = `${baseId}-${i}`;
  }

  const proposal: IssueProposalFile = {
    meta: {
      id,
      title,
      body,
      evidence: input.evidence?.map((item) => item.trim()).filter(Boolean) ?? [],
      ...(input.impact?.trim() ? { impact: input.impact.trim() } : {}),
      priority: normalizePriority(input.priority),
      automation_level: normalizeAutomationLevel(input.automationLevel),
      target_repo: targetRepo,
      target_chat_id: targetChatId,
      origin_chat_id: originChatId,
      created_by: createdBy,
      created_at: now.toISOString(),
      status: 'pending',
    },
  };

  await writeIssueProposal(proposal);
  return proposal;
}

export async function listIssueProposals(filter: IssueProposalListFilter = {}): Promise<IssueProposalFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(proposalDir());
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const proposals: IssueProposalFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    const proposal = await readIssueProposal(id);
    if (proposal) proposals.push(proposal);
  }

  return proposals
    .filter((proposal) => {
      if (filter.status && filter.status !== 'all' && proposal.meta.status !== filter.status) return false;
      if (filter.targetChatId && proposal.meta.target_chat_id !== filter.targetChatId) return false;
      if (filter.createdBy && proposal.meta.created_by !== filter.createdBy) return false;
      return true;
    })
    .sort((a, b) => a.meta.created_at.localeCompare(b.meta.created_at));
}

export async function markIssueProposalApproved(
  id: string,
  input: MarkIssueProposalApprovedInput,
): Promise<IssueProposalFile | null> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return null;
  if (proposal.meta.status === 'created' || proposal.meta.status === 'rejected') return proposal;

  const now = input.now ?? new Date();
  proposal.meta.status = 'approved';
  proposal.meta.approved_by = input.approvedBy;
  proposal.meta.approved_at = now.toISOString();
  proposal.meta.last_error = input.lastError || undefined;
  await writeIssueProposal(proposal);
  return proposal;
}

export async function markIssueProposalCreated(
  id: string,
  input: MarkIssueProposalCreatedInput,
): Promise<IssueProposalFile | null> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return null;
  if (proposal.meta.status === 'created') return proposal;
  if (proposal.meta.status === 'rejected') return proposal;

  const now = input.now ?? new Date();
  proposal.meta.status = 'created';
  proposal.meta.approved_by = input.approvedBy;
  proposal.meta.approved_at = proposal.meta.approved_at ?? now.toISOString();
  proposal.meta.github_issue_url = assertNonEmpty(input.githubIssueUrl, 'githubIssueUrl');
  proposal.meta.github_issue_number = input.githubIssueNumber ?? githubIssueNumberFromUrl(input.githubIssueUrl);
  proposal.meta.created_issue_at = now.toISOString();
  proposal.meta.last_error = undefined;
  await writeIssueProposal(proposal);
  return proposal;
}

export async function markIssueProposalPullRequestCreated(
  id: string,
  input: MarkIssueProposalPullRequestCreatedInput,
): Promise<IssueProposalFile | null> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return null;
  if (proposal.meta.status === 'rejected') return proposal;
  if (proposal.meta.github_pr_url) return proposal;

  const now = input.now ?? new Date();
  proposal.meta.approved_by = proposal.meta.approved_by ?? input.approvedBy;
  proposal.meta.approved_at = proposal.meta.approved_at ?? now.toISOString();
  proposal.meta.github_pr_url = assertNonEmpty(input.githubPullRequestUrl, 'githubPullRequestUrl');
  proposal.meta.github_pr_number =
    input.githubPullRequestNumber ?? githubPullRequestNumberFromUrl(input.githubPullRequestUrl);
  proposal.meta.created_pr_at = now.toISOString();
  proposal.meta.pr_last_error = undefined;
  await writeIssueProposal(proposal);
  return proposal;
}

export async function markIssueProposalPullRequestError(
  id: string,
  input: MarkIssueProposalPullRequestErrorInput,
): Promise<IssueProposalFile | null> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return null;
  if (proposal.meta.status === 'rejected') return proposal;

  const now = input.now ?? new Date();
  proposal.meta.approved_by = proposal.meta.approved_by ?? input.approvedBy;
  proposal.meta.approved_at = proposal.meta.approved_at ?? now.toISOString();
  proposal.meta.pr_last_error = assertNonEmpty(input.lastError, 'lastError');
  await writeIssueProposal(proposal);
  return proposal;
}

export async function rejectIssueProposal(
  id: string,
  input: RejectIssueProposalInput,
): Promise<IssueProposalFile | null> {
  const proposal = await readIssueProposal(id);
  if (!proposal) return null;
  if (proposal.meta.status === 'created' || proposal.meta.status === 'rejected') return proposal;

  const now = input.now ?? new Date();
  proposal.meta.status = 'rejected';
  proposal.meta.rejected_by = input.rejectedBy;
  proposal.meta.rejected_at = now.toISOString();
  proposal.meta.rejection_reason = input.reason?.trim() || undefined;
  await writeIssueProposal(proposal);
  return proposal;
}

export function formatIssueProposalForList(proposal: IssueProposalFile): string {
  const lines = [
    `**${proposal.meta.id}** [${proposal.meta.status}] ${proposal.meta.title}`,
    `   Priority: ${proposal.meta.priority} | Automation: ${proposal.meta.automation_level} | Repo: ${proposal.meta.target_repo}`,
  ];
  if (proposal.meta.impact) lines.push(`   Impact: ${proposal.meta.impact}`);
  if (proposal.meta.github_issue_url) lines.push(`   Issue: ${proposal.meta.github_issue_url}`);
  if (proposal.meta.github_pr_url) lines.push(`   PR: ${proposal.meta.github_pr_url}`);
  if (proposal.meta.last_error) lines.push(`   Last error: ${proposal.meta.last_error}`);
  if (proposal.meta.pr_last_error) lines.push(`   PR last error: ${proposal.meta.pr_last_error}`);
  if (proposal.meta.rejection_reason) lines.push(`   Rejected: ${proposal.meta.rejection_reason}`);
  return lines.join('\n');
}

export function formatIssueProposalIssueBody(proposal: IssueProposalFile): string {
  const sections = [
    `<!-- issue-proposal-id: ${proposal.meta.id} -->`,
    '## Finding',
    proposal.meta.body,
  ];

  if (proposal.meta.evidence.length) {
    sections.push('', '## Evidence', ...proposal.meta.evidence.map((item) => `- ${item}`));
  }

  if (proposal.meta.impact) {
    sections.push('', '## Impact', proposal.meta.impact);
  }

  sections.push(
    '',
    '## Suggested Priority',
    proposal.meta.priority,
    '',
    '## Automation Level',
    proposal.meta.automation_level,
    '',
    '## Authorization Required',
    'This issue was created from a human-authorized local proposal. Further code changes, PR merge, and release still require explicit maintainer authorization.',
  );

  return sections.join('\n');
}

export function formatIssueProposalPullRequestBody(proposal: IssueProposalFile): string {
  const sections = [
    `<!-- issue-proposal-id: ${proposal.meta.id} -->`,
    '## Linked Discovery Issue',
    proposal.meta.github_issue_url ?? 'A GitHub issue must be created before opening a low-risk PR.',
    '',
    '## Summary',
    proposal.meta.body,
  ];

  if (proposal.meta.evidence.length) {
    sections.push('', '## Evidence', ...proposal.meta.evidence.map((item) => `- ${item}`));
  }

  if (proposal.meta.impact) {
    sections.push('', '## Impact', proposal.meta.impact);
  }

  sections.push(
    '',
    '## Verification',
    'The local low-risk PR wrapper must include concrete verification results before opening the PR.',
    '',
    '## Automation Boundary',
    'This PR was opened from a low-risk proposal. It must not be merged or released automatically; a maintainer must explicitly review and authorize merge or release.',
  );

  return sections.join('\n');
}

export function extractGithubIssueUrl(text: string): string | null {
  return text.match(/https:\/\/[^\s"'<>]+\/[^\s"'<>]+\/[^\s"'<>]+\/issues\/\d+/)?.[0] ?? null;
}

export function extractGithubPullRequestUrl(text: string): string | null {
  return text.match(/https:\/\/github\.com\/[^\s"'<>]+\/pull\/\d+/)?.[0] ?? null;
}
