import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './config.js';

export type CodexExecConfigDiagnosticCode =
  | 'codex_exec_cwd_lark_mcp'
  | 'codex_exec_profile_lark_mcp'
  | 'codex_exec_user_config_enabled';

export interface CodexExecConfigDiagnostic {
  code: CodexExecConfigDiagnosticCode;
  severity: 'warning';
  message: string;
}

export interface CodexExecConfigDiagnosticsInput {
  codexExecCwd: string;
  codexExecProfile: string | null;
  codexExecIgnoreUserConfig: boolean;
  codexHome?: string;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, nested]) => `${key} ${flatten(nested)}`)
      .join(' ');
  }
  return String(value ?? '');
}

function isLarkMcpServer(name: string, server: unknown): boolean {
  const haystack = `${name} ${flatten(server)}`.toLowerCase();
  if (!/\blark\b/.test(haystack)) return false;
  return (
    name.toLowerCase() === 'lark' ||
    haystack.includes('codex-lark-plugin') ||
    haystack.includes('src/index.ts') ||
    haystack.includes('scripts/start.sh') ||
    /\bnpm\b[\s\S]*\bstart\b/.test(haystack)
  );
}

function projectMcpHasLarkServer(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return false;
    return Object.entries(servers).some(([name, server]) => isLarkMcpServer(name, server));
  } catch {
    return false;
  }
}

function normalizeTomlSection(section: string): string {
  return section
    .split('.')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .join('.');
}

function tomlSections(raw: string): Array<{ name: string; body: string }> {
  const sections: Array<{ name: string; body: string }> = [];
  let currentName = '';
  let body: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (match) {
      sections.push({ name: normalizeTomlSection(currentName), body: body.join('\n') });
      currentName = match[1];
      body = [];
    } else {
      body.push(line);
    }
  }
  sections.push({ name: normalizeTomlSection(currentName), body: body.join('\n') });
  return sections;
}

function codexProfileHasLarkMcpServer(raw: string, profile: string): boolean {
  const profilePrefix = `profiles.${profile}`;
  return tomlSections(raw).some((section) => {
    if (section.name !== profilePrefix && !section.name.startsWith(`${profilePrefix}.`)) return false;
    const haystack = `${section.name}\n${section.body}`.toLowerCase();
    return haystack.includes('mcp_servers') && /\blark\b/.test(haystack);
  });
}

export async function collectCodexExecConfigDiagnostics(
  input: CodexExecConfigDiagnosticsInput,
): Promise<CodexExecConfigDiagnostic[]> {
  const diagnostics: CodexExecConfigDiagnostic[] = [];
  const mcpJsonPath = path.join(input.codexExecCwd, '.mcp.json');
  const projectMcp = await readTextIfExists(mcpJsonPath);
  if (projectMcp && projectMcpHasLarkServer(projectMcp)) {
    diagnostics.push({
      code: 'codex_exec_cwd_lark_mcp',
      severity: 'warning',
      message:
        `LARK_CODEX_EXEC_CWD points at a directory whose .mcp.json contains the Lark MCP server (${mcpJsonPath}). ` +
        'This can make child codex exec turns recursively reload this plugin; use a neutral working directory without .mcp.json.',
    });
  }

  if (!input.codexExecIgnoreUserConfig) {
    diagnostics.push({
      code: 'codex_exec_user_config_enabled',
      severity: 'warning',
      message:
        'LARK_CODEX_EXEC_IGNORE_USER_CONFIG=false allows child codex exec turns to load user Codex configuration. ' +
        'Keep the default true unless you have audited the selected profile and MCP server list for recursion risk.',
    });
  }

  if (input.codexExecProfile) {
    const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const codexConfig = await readTextIfExists(path.join(codexHome, 'config.toml'));
    if (codexConfig && codexProfileHasLarkMcpServer(codexConfig, input.codexExecProfile)) {
      diagnostics.push({
        code: 'codex_exec_profile_lark_mcp',
        severity: 'warning',
        message:
          `LARK_CODEX_EXEC_PROFILE=${input.codexExecProfile} appears to include a Lark MCP server in ${path.join(codexHome, 'config.toml')}. ` +
          'This profile can recursively start the current plugin from child codex exec turns; choose a profile without the Lark MCP server.',
      });
    }
  }

  return diagnostics;
}

export async function emitCodexExecConfigDiagnostics(config: AppConfig): Promise<void> {
  const diagnostics = await collectCodexExecConfigDiagnostics({
    codexExecCwd: config.codexExecCwd,
    codexExecProfile: config.codexExecProfile,
    codexExecIgnoreUserConfig: config.codexExecIgnoreUserConfig,
  });
  for (const diagnostic of diagnostics) {
    console.error(`[codex-exec][${diagnostic.severity}] ${diagnostic.message}`);
  }
}
