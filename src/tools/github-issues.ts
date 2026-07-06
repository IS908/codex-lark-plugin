import { z } from 'zod';
import { createDirectGithubIssue, type GithubIssueLocalCliRunner } from '../github-issue-service.js';
import { runConfiguredLocalCliTool } from '../local-cli-tools.js';
import type { ToolContext, ToolResult } from './tool-context.js';

function textResult(text: string, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

function createLocalCliRunner(
  ctx: ToolContext,
  chatId: string,
  threadId: string | undefined,
): GithubIssueLocalCliRunner {
  return (tool, args) =>
    runConfiguredLocalCliTool({
      identitySession: ctx.identitySession,
      tool,
      args,
      chat_id: chatId,
      thread_id: threadId,
    });
}

export function registerGithubIssueTools(ctx: ToolContext): void {
  const { server, resolveCaller } = ctx;

  server.registerTool(
    'create_github_issue',
    {
      description:
        'Create a GitHub issue directly after explicit user authorization. For agent-generated review findings, prefer create_issue_proposal unless the maintainer explicitly asked to file the issue now.',
      inputSchema: z.object({
        title: z.string().describe('GitHub issue title'),
        body: z.string().describe('GitHub issue body'),
        target_repo: z.string().describe('GitHub repository in owner/name form'),
        tool: z.string().optional().describe('Configured local-cli-tools.json tool name override. Omit for the built-in GitHub HTTP path.'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id when present'),
      }),
    },
    async ({ title, body, target_repo, tool, chat_id, thread_id }) => {
      const auditArgs = { title, target_repo, tool: tool ?? '<builtin>', chat_id, thread_id };
      const auth = resolveCaller('create_github_issue', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const result = await createDirectGithubIssue({
        title,
        body,
        targetRepo: target_repo,
        caller,
        tool,
        runLocalCli: createLocalCliRunner(ctx, chat_id, thread_id),
        auditArgs,
      });
      return textResult(result.message, !result.ok);
    },
  );
}
