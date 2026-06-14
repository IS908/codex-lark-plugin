import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { appConfig } from './config.js';
import { audit } from './audit-log.js';
import { SYSTEM_FLUSH_CALLER, type IdentitySession } from './identity-session.js';

type CallerMode = 'owners' | 'lark_allowed_user_ids' | 'public' | string[];
type ParamMode = 'allowlist' | 'blocklist';

interface LocalCliToolConfig {
  command: string;
  fixedArgs: string[];
  allowedSubcommands?: string[];
  paramAllowlist?: string[];
  paramBlocklist?: string[];
  envAllowlist: string[];
  env: Record<string, string>;
  inheritEnv: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  allowedCallers: CallerMode;
}

interface LoadedConfig {
  tools: Record<string, LocalCliToolConfig>;
}

interface LocalCliToolServer {
  registerTool: (
    name: string,
    config: { description?: string; inputSchema: z.ZodTypeAny },
    handler: (args: any) => Promise<{
      isError?: boolean;
      content: { type: 'text'; text: string }[];
    }>,
  ) => unknown;
}

export interface RegisterLocalCliToolsOptions {
  server: LocalCliToolServer;
  identitySession: IdentitySession;
}

export interface RunConfiguredLocalCliToolOptions {
  identitySession: IdentitySession;
  tool: string;
  args?: string[];
  chat_id: string;
  thread_id?: string;
  configPath?: string;
}

export interface RunConfiguredLocalCliToolResult {
  ok: boolean;
  message: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_RE = /(token|secret|password|passwd|credential|authorization|api[_-]?key|app[_-]?secret)/i;
const DEFAULT_ENV_KEYS = ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE'];

function mcpText(text: string, isError = false) {
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

function optionName(arg: string): string | null {
  if (!arg.startsWith('-') || arg === '-') return null;
  const eq = arg.indexOf('=');
  return eq >= 0 ? arg.slice(0, eq) : arg;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/((?:token|secret|password|passwd|credential|authorization|api[_-]?key|app[_-]?secret)\s*[=:]\s*)([^\s"'`]+)/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push('<redacted>');
      redactNext = false;
      continue;
    }
    const name = optionName(arg);
    if (name && SECRET_KEY_RE.test(name)) {
      redacted.push(arg.includes('=') ? `${name}=<redacted>` : name);
      if (!arg.includes('=')) redactNext = true;
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

function parseStringArray(value: unknown, field: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function parseEnvAllowlist(value: unknown, field: string): string[] {
  const keys = parseStringArray(value, field);
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`${field} contains invalid environment key "${key}"`);
  }
  return keys;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object with string values`);
  }

  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`${field} contains invalid environment key "${key}"`);
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`);
    parsed[key] = item;
  }
  return parsed;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function parseAllowedCallers(value: unknown): CallerMode {
  if (value === undefined) return 'owners';
  if (value === 'owners' || value === 'lark_allowed_user_ids' || value === 'public') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)) {
    return value;
  }
  throw new Error('allowedCallers must be "owners", "lark_allowed_user_ids", "public", or an array of open_id strings');
}

function parsePositiveNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number`);
  return Math.floor(parsed);
}

function parseToolConfig(name: string, raw: any): LocalCliToolConfig {
  if (!TOOL_NAME_RE.test(name)) throw new Error(`Invalid tool name: ${name}`);
  if (!raw || typeof raw !== 'object') throw new Error(`Tool ${name} config must be an object`);
  if (typeof raw.command !== 'string' || !raw.command) {
    throw new Error(`Tool ${name} command must be a non-empty string`);
  }
  if (!path.isAbsolute(raw.command)) {
    throw new Error(`Tool ${name} command must be an absolute path`);
  }

  const hasAllowlist = raw.paramAllowlist !== undefined;
  const hasBlocklist = raw.paramBlocklist !== undefined;
  if (hasAllowlist === hasBlocklist) {
    throw new Error(`Tool ${name} must configure exactly one of paramAllowlist or paramBlocklist`);
  }

  return {
    command: raw.command,
    fixedArgs: parseStringArray(raw.fixedArgs, `Tool ${name} fixedArgs`),
    allowedSubcommands:
      raw.allowedSubcommands === undefined
        ? undefined
        : parseStringArray(raw.allowedSubcommands, `Tool ${name} allowedSubcommands`),
    ...(hasAllowlist ? { paramAllowlist: parseStringArray(raw.paramAllowlist, `Tool ${name} paramAllowlist`) } : {}),
    ...(hasBlocklist ? { paramBlocklist: parseStringArray(raw.paramBlocklist, `Tool ${name} paramBlocklist`) } : {}),
    envAllowlist: parseEnvAllowlist(raw.envAllowlist, `Tool ${name} envAllowlist`),
    env: parseStringRecord(raw.env, `Tool ${name} env`),
    inheritEnv: parseBoolean(raw.inheritEnv, `Tool ${name} inheritEnv`, false),
    timeoutMs: parsePositiveNumber(raw.timeoutMs, `Tool ${name} timeoutMs`, 30_000),
    maxOutputBytes: parsePositiveNumber(raw.maxOutputBytes, `Tool ${name} maxOutputBytes`, 64 * 1024),
    allowedCallers: parseAllowedCallers(raw.allowedCallers),
  };
}

async function loadConfig(configPath = appConfig.localCliToolsConfigPath): Promise<LoadedConfig> {
  let rawText: string;
  try {
    rawText = await fs.readFile(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { tools: {} };
    throw err;
  }

  const parsed = JSON.parse(rawText);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.tools ||
    typeof parsed.tools !== 'object' ||
    Array.isArray(parsed.tools)
  ) {
    throw new Error('local CLI config must contain a "tools" object');
  }

  const tools: Record<string, LocalCliToolConfig> = Object.create(null);
  for (const [name, raw] of Object.entries(parsed.tools)) {
    tools[name] = parseToolConfig(name, raw);
  }
  return { tools };
}

function isCallerAllowed(caller: string, mode: CallerMode): boolean {
  if (mode === 'public') return true;
  if (mode === 'owners') return !!appConfig.ownerOpenId && caller === appConfig.ownerOpenId;
  if (mode === 'lark_allowed_user_ids') return appConfig.allowedUserIds.includes(caller);
  return mode.includes(caller);
}

function validateSubcommand(config: LocalCliToolConfig, args: string[]): string | null {
  if (!config.allowedSubcommands?.length) return null;
  const subcommand = args[0] ?? config.fixedArgs[0];
  if (!subcommand) return `missing subcommand; allowed: ${config.allowedSubcommands.join(', ')}`;
  if (!config.allowedSubcommands.includes(subcommand)) {
    return `subcommand "${subcommand}" is not allowed; allowed: ${config.allowedSubcommands.join(', ')}`;
  }
  return null;
}

function validateParams(config: LocalCliToolConfig, args: string[]): string | null {
  const mode: ParamMode = config.paramAllowlist ? 'allowlist' : 'blocklist';
  const configured = new Set(config.paramAllowlist ?? config.paramBlocklist ?? []);
  const subcommandIndex = config.allowedSubcommands?.length && args.length > 0 ? 0 : -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (i === subcommandIndex) continue;
    if (arg === '--') return 'argument terminator "--" is not allowed';

    const name = optionName(arg);
    if (!name) {
      if (mode === 'allowlist') return `positional argument "${arg}" is not allowed in paramAllowlist mode`;
      continue;
    }

    if (mode === 'allowlist' && !configured.has(name)) {
      return `parameter "${name}" is not allowlisted`;
    }
    if (mode === 'blocklist' && configured.has(name)) {
      return `blocked parameter "${name}" was requested`;
    }

    if (!arg.includes('=') && i + 1 < args.length && !optionName(args[i + 1])) {
      i += 1;
    }
  }
  return null;
}

function validateExecution(config: LocalCliToolConfig, args: string[]): string | null {
  return validateSubcommand(config, args) ?? validateParams(config, args);
}

function buildProcessEnv(config: LocalCliToolConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) return { ...process.env, ...config.env };

  const env: NodeJS.ProcessEnv = {};
  const copyFromProcess = (key: string) => {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  };

  for (const key of DEFAULT_ENV_KEYS) copyFromProcess(key);
  for (const key of config.envAllowlist) copyFromProcess(key);
  return { ...env, ...config.env };
}

function appendCappedOutput(
  current: string,
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
): string {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return current;
  }
  const remaining = maxBytes - state.bytes;
  const slice = chunk.subarray(0, remaining);
  state.bytes += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  return current + slice.toString('utf8');
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  let stdout = '';
  let stderr = '';
  const outputState = { bytes: 0, truncated: false };
  let timedOut = false;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCappedOutput(stdout, chunk, outputState, maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCappedOutput(stderr, chunk, outputState, maxOutputBytes);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        truncated: outputState.truncated,
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr),
      });
    });
  });
}

export async function runConfiguredLocalCliTool(
  options: RunConfiguredLocalCliToolOptions,
): Promise<RunConfiguredLocalCliToolResult> {
  const { identitySession, tool, chat_id, thread_id, configPath } = options;
  const requestedArgs = Array.isArray(options.args) ? options.args.map(String) : [];
  const auditArgs = { tool, chat_id, thread_id, args: redactArgs(requestedArgs) };

  if (!chat_id) {
    await audit('run_local_cli_tool', null, auditArgs, 'denied');
    return { ok: false, message: 'chat_id is required for run_local_cli_tool' };
  }

  const caller = identitySession.getCaller(chat_id, thread_id);
  if (!caller) {
    await audit('run_local_cli_tool', null, auditArgs, 'denied');
    return { ok: false, message: `No active identity session for chat ${chat_id}.` };
  }
  if (caller === SYSTEM_FLUSH_CALLER) {
    await audit('run_local_cli_tool', caller, auditArgs, 'denied');
    return { ok: false, message: 'System flush identity is not authorized for local CLI execution.' };
  }

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfig(configPath);
  } catch (err: any) {
    await audit('run_local_cli_tool', caller, auditArgs, 'denied');
    return { ok: false, message: `Invalid local CLI config: ${err?.message ?? String(err)}` };
  }

  const config = Object.prototype.hasOwnProperty.call(loaded.tools, tool)
    ? loaded.tools[tool]
    : undefined;
  if (!config) {
    await audit('run_local_cli_tool', caller, auditArgs, 'denied');
    return { ok: false, message: `Local CLI tool "${tool}" is not configured.` };
  }

  if (!isCallerAllowed(caller, config.allowedCallers)) {
    await audit('run_local_cli_tool', caller, auditArgs, 'denied');
    return { ok: false, message: `Caller ${caller} is not authorized for local CLI tool "${tool}".` };
  }

  const validationError = validateExecution(config, requestedArgs);
  if (validationError) {
    await audit('run_local_cli_tool', caller, auditArgs, 'denied');
    return { ok: false, message: validationError };
  }

  const finalArgs = [...config.fixedArgs, ...requestedArgs];
  let result: ProcessResult;
  try {
    result = await runProcess(config.command, finalArgs, config.timeoutMs, config.maxOutputBytes, buildProcessEnv(config));
  } catch (err: any) {
    await audit('run_local_cli_tool', caller, auditArgs, 'error');
    return { ok: false, message: `Failed to execute local CLI tool "${tool}": ${err?.message ?? String(err)}` };
  }

  const ok = !result.timedOut && result.exitCode === 0;
  await audit('run_local_cli_tool', caller, auditArgs, ok ? 'ok' : 'error');
  return {
    ok,
    message: JSON.stringify(
      {
        tool,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        truncated: result.truncated,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ),
  };
}

export function registerLocalCliTools(options: RegisterLocalCliToolsOptions): void {
  const { server, identitySession } = options;

  server.registerTool(
    'run_local_cli_tool',
    {
      description:
        'Run a configured allowlisted local CLI capability on the plugin host. Pass chat_id/thread_id from the current channel metadata. The server resolves caller identity and applies the configured authorization and parameter filter.',
      inputSchema: z.object({
        tool: z.string().describe('Configured local CLI tool name from local-cli-tools.json'),
        args: z.array(z.string()).default([]).describe('CLI arguments to append after the configured fixedArgs'),
        chat_id: z.string().describe('Current channel chat_id for server-side caller resolution'),
        thread_id: z.string().optional().describe('Current channel thread_id for server-side caller resolution'),
      }),
    },
    async ({ tool, args = [], chat_id, thread_id }) => {
      const result = await runConfiguredLocalCliTool({
        identitySession,
        tool,
        args,
        chat_id,
        thread_id,
      });
      return mcpText(result.message, !result.ok);
    },
  );
}
