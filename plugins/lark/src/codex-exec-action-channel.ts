import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { audit } from './audit-log.js';
import { logSafeError } from './safe-log.js';
import {
  parseCodexExecActionEnvelope,
  type CodexExecAction,
} from './codex-exec-actions.js';

export interface CodexExecActionChannelPromptInfo {
  enabled: boolean;
  filePath: string;
  token: string;
  maxActions: number;
  localCliToolNames?: string[];
  traceQueryEnabled?: boolean;
  continuationEnabled?: boolean;
  continuationWorkingRoot?: string;
  continuationHostToolNames?: string[];
  continuationTrustedPersonalWorkspaceEligible?: boolean;
}

export interface CodexExecActionChannelOptions {
  baseDir: string;
  caller: string | null;
  messageId: string;
  chatId: string;
  threadId?: string;
  maxActions?: number;
}

export interface CodexExecActionChannelReadResult {
  actions: CodexExecAction[];
  requestCount: number;
}

export interface CodexExecActionChannelCleanupOptions {
  maxAgeMs?: number;
  nowMs?: number;
}

export interface CodexExecActionChannelCleanupResult {
  actionDir: string;
  removed: number;
  kept: number;
  errors: number;
}

type ActionChannelRejectReason =
  | 'invalid-json'
  | 'invalid-shape'
  | 'invalid-token'
  | 'identity-field'
  | 'empty-actions'
  | 'too-many-actions'
  | 'duplicate-continuation';

const IDENTITY_FIELDS = new Set([
  'chat_id',
  'chatId',
  'thread_id',
  'threadId',
  'open_id',
  'openId',
  'user_id',
  'userId',
  'caller',
  'created_by',
  'createdBy',
]);

const ACTION_REQUEST_FIELDS = new Set(['version', 'token', 'type', 'actions']);

const DEFAULT_MAX_ACTIONS = 5;
export const CODEX_EXEC_ACTION_CHANNEL_RETENTION_MS = 12 * 60 * 60 * 1000;
export const CODEX_EXEC_ACTION_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function actionParentDir(baseDir: string): string {
  return path.join(baseDir, '.lark-actions');
}

export class CodexExecActionChannelError extends Error {
  readonly reason: ActionChannelRejectReason;
  stdoutTail?: string;

  constructor(reason: ActionChannelRejectReason, detail: string) {
    super(`Codex exec action side channel rejected ${reason}: ${detail}`);
    this.name = 'CodexExecActionChannelError';
    this.reason = reason;
  }
}

export class CodexExecActionChannel {
  readonly filePath: string;
  readonly token: string;

  private readonly maxActions: number;

  constructor(
    private readonly dir: string,
    private readonly options: CodexExecActionChannelOptions,
  ) {
    this.filePath = path.join(dir, 'actions.jsonl');
    this.token = randomUUID();
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  }

  get promptInfo(): CodexExecActionChannelPromptInfo {
    return {
      enabled: true,
      filePath: this.filePath,
      token: this.token,
      maxActions: this.maxActions,
    };
  }

  get extraEnv(): Record<string, string> {
    return {
      CODEX_LARK_ACTIONS_FILE: this.filePath,
      CODEX_LARK_ACTIONS_TOKEN: this.token,
    };
  }

  async prepare(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    await fs.writeFile(this.filePath, '', { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(this.filePath, 0o600);
  }

  async reset(): Promise<void> {
    await fs.writeFile(this.filePath, '', { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async read(): Promise<CodexExecActionChannelReadResult> {
    const text = await fs.readFile(this.filePath, 'utf-8').catch((err: any) => {
      if (err?.code === 'ENOENT') return '';
      throw err;
    });
    const actions: CodexExecAction[] = [];
    let requestCount = 0;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      requestCount += 1;
      const parsed = this.parseLine(line);
      actions.push(...parsed);
      if (actions.length > this.maxActions) {
        this.reject('too-many-actions', `received ${actions.length} actions; max ${this.maxActions}`);
      }
      if (actions.filter((action) => action.type === 'create_continuation_job').length > 1) {
        this.reject('duplicate-continuation', 'only one continuation job may be created per turn');
      }
    }

    if (requestCount > 0 && actions.length === 0) {
      this.reject('empty-actions', 'no executable actions were provided');
    }

    if (requestCount > 0) {
      void audit(
        'codex_exec_action_channel',
        this.options.caller,
        this.auditArgs({ request_count: requestCount, action_count: actions.length }),
        'ok',
      );
    }
    return { actions, requestCount };
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private parseLine(line: string): CodexExecAction[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.reject('invalid-json', err instanceof Error ? err.message : String(err));
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.reject('invalid-shape', 'expected a JSON object');
    }
    const event = parsed as Record<string, unknown>;
    if (event.version !== 1 || event.type !== 'lark_action_request') {
      this.reject('invalid-shape', 'expected version=1 and type="lark_action_request"');
    }
    if (event.token !== this.token) {
      this.reject('invalid-token', 'token mismatch');
    }
    if (Object.keys(event).some((key) => IDENTITY_FIELDS.has(key))) {
      this.reject('identity-field', 'identity fields are parent-derived and not accepted');
    }
    const unknownField = Object.keys(event).find((key) => !ACTION_REQUEST_FIELDS.has(key));
    if (unknownField) {
      this.reject('invalid-shape', `unsupported top-level field "${unknownField}"`);
    }

    const envelope = parseCodexExecActionEnvelope({
      version: event.version,
      actions: event.actions,
    });
    if (!envelope.ok) {
      this.reject('invalid-shape', envelope.error);
    }
    return envelope.envelope.actions;
  }

  private reject(reason: ActionChannelRejectReason, detail: string): never {
    void audit('codex_exec_action_channel', this.options.caller, this.auditArgs({ reason }), 'denied');
    throw new CodexExecActionChannelError(reason, detail);
  }

  private auditArgs(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      message_id: this.options.messageId,
      chat_id: this.options.chatId,
      thread_id: this.options.threadId,
      ...extra,
    };
  }
}

export async function createCodexExecActionChannel(
  options: CodexExecActionChannelOptions,
): Promise<CodexExecActionChannel | null> {
  try {
    const parentDir = actionParentDir(options.baseDir);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await fs.chmod(parentDir, 0o700);
    await cleanupCodexExecActionChannels(options.baseDir).catch((err) => {
      logSafeError('[codex-exec-actions] cleanup before setup failed:', err);
    });
    const dir = await fs.mkdtemp(path.join(parentDir, 'turn-'));
    await fs.chmod(dir, 0o700);
    const channel = new CodexExecActionChannel(dir, options);
    await channel.prepare();
    return channel;
  } catch (err) {
    logSafeError('[codex-exec-actions] side channel setup failed:', err);
    return null;
  }
}

export async function cleanupCodexExecActionChannels(
  baseDir: string,
  options: CodexExecActionChannelCleanupOptions = {},
): Promise<CodexExecActionChannelCleanupResult> {
  const actionDir = actionParentDir(baseDir);
  const maxAgeMs = options.maxAgeMs ?? CODEX_EXEC_ACTION_CHANNEL_RETENTION_MS;
  const nowMs = options.nowMs ?? Date.now();
  const result: CodexExecActionChannelCleanupResult = { actionDir, removed: 0, kept: 0, errors: 0 };

  let entries: Array<{ name: string }>;
  try {
    entries = await fs.readdir(actionDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return result;
    result.errors += 1;
    logSafeError('[codex-exec-actions] cleanup failed to read action dir:', err);
    return result;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith('turn-')) continue;
    const entryPath = path.join(actionDir, entry.name);
    try {
      const entryStat = await fs.lstat(entryPath);
      if (nowMs - entryStat.mtimeMs <= maxAgeMs) {
        result.kept += 1;
        continue;
      }
      await fs.rm(entryPath, { recursive: true, force: true });
      result.removed += 1;
    } catch (err) {
      result.errors += 1;
      logSafeError(`[codex-exec-actions] cleanup failed for ${entryPath}:`, err);
    }
  }

  return result;
}

export function startCodexExecActionChannelRetention(
  baseDir: string,
  options: CodexExecActionChannelCleanupOptions & { intervalMs?: number } = {},
): NodeJS.Timeout | null {
  const intervalMs = options.intervalMs ?? CODEX_EXEC_ACTION_CHANNEL_CLEANUP_INTERVAL_MS;
  const cleanup = () => {
    void cleanupCodexExecActionChannels(baseDir, options).catch((err) => {
      logSafeError('[codex-exec-actions] retention cleanup failed:', err);
    });
  };
  cleanup();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(cleanup, intervalMs);
  timer.unref?.();
  return timer;
}

export function buildCodexExecActionChannelPrompt(info: CodexExecActionChannelPromptInfo | null): string[] {
  if (!info?.enabled) return [];
  const localCliToolNames = [...new Set(info.localCliToolNames ?? [])].filter(Boolean).sort();
  const continuationHostToolNames = [
    ...new Set(info.continuationHostToolNames ?? localCliToolNames),
  ].filter(Boolean).sort();
  const primaryLocalCliToolName = localCliToolNames[0];
  const traceQueryLines = info.traceQueryEnabled
    ? [
        '  - {"type":"get_run_trace","source":"message","target":"current|quoted","log_id":"optional current-or-quoted message id","run_id":"optional","within_hours":12}',
        '  - {"type":"get_run_trace","source":"cronjob","log_id":"job_id","run_id":"optional","within_hours":12}',
        '  - {"type":"get_run_trace","source":"continuation","log_id":"continuation job ID","run_id":"optional","within_hours":12}',
        '    Use get_run_trace only for bounded sanitized local tool-call summaries. Do not read trace.log directly; ordinary message queries are limited to the current or quoted message, cronjob queries use stable job_id values, and continuation queries require a creator- or owner-visible job.',
      ]
    : [];
  const localCliToolLines =
    primaryLocalCliToolName
      ? [
          '- Sandbox host-tool bridge: run_local_cli_tool executes one of the listed allowlisted CLI tools on the plugin host, outside the Codex exec sandbox. Use it when sandbox restrictions prevent an in-scope operation and a matching listed tool fits.',
          '- This bridge is an additional capability, not an exclusive tool route. You may use other available skills, connectors, MCP tools, or runtime tools. Do not ask for separate permission to use it when the user already authorized the operation; tool availability does not expand the user request scope.',
          `  - {"type":"run_local_cli_tool","tool":"${primaryLocalCliToolName}","args":["..."]}`,
          `    Configured host tools: ${localCliToolNames.join(', ')}`,
        ]
      : [];
  const continuationLines = info.continuationEnabled
    ? [
        '  - {"type":"create_continuation_job","title":"...","objective":"...","acceptance_criteria":["..."],"context_snapshot":{"summary":"...","completed_steps":[],"remaining_steps":["..."],"constraints":[],"decisions":[],"references":[]},"required_tools":[],"working_directory":"."}',
        '    Use this only when work must continue after the current reply. The parent derives caller, route, session, model, retry policy, and Job ID; one turn may create at most one continuation.',
        '    required_tools declares only additional host CLI tools. Do not declare standard Codex tools such as exec_command or apply_patch; those remain governed by the continuation sandbox.',
        '    requested_paths is optional. It may contain absolute paths or paths relative to the configured continuation working root; omitted values default to the canonical working_directory. Paths are canonicalized and audited before creation.',
        ...(info.continuationWorkingRoot
          ? [`    Configured continuation working root: ${JSON.stringify(info.continuationWorkingRoot)}. working_directory must be relative to this root.`]
          : []),
        ...(info.continuationTrustedPersonalWorkspaceEligible
          ? [
              '    Eligible callers are automatically assigned the trusted_personal_workspace profile by the parent, enabling broad local reads, network, and external side effects. Do not include capability_profile in the action.',
            ]
          : []),
        ...(continuationHostToolNames.length > 0
          ? [`    For local CLI access, required_tools must use exact configured host tool names: ${continuationHostToolNames.join(', ')}. The declaration does not grant access; runtime config and caller policy are checked again.`]
          : ['    No continuation host CLI tools are configured; required_tools must remain empty.']),
      ]
    : [];

  return [
    'Structured Lark actions (optional):',
    '- Final stdout is user-visible reply text only. Do not include control payloads in the visible reply.',
    `- To request Lark bridge actions, append newline-delimited JSON to ${info.filePath}.`,
    `- Use token ${info.token}.`,
    `- You may request at most ${info.maxActions} total actions for this turn.`,
    '- Do not include chat_id, thread_id, open_id, user_id, caller, or created_by; the parent Lark bridge derives identity.',
    '- JSONL schema: {"version":1,"token":"<token>","type":"lark_action_request","actions":[{"type":"list_jobs","status":"all"}]}',
    '- Supported action payloads inside actions[]:',
    '  - {"type":"save_memory","memory_type":"profile|chat|thread","content":"...","reason":"...","tier":"public|private","mode":"append|replace"}',
    '  - {"type":"create_job","name":"...","job_type":"prompt|message","schedule":"...","timezone":"IANA timezone","prompt":"...","content":"...","target_chat_id":"...","model":"..."}',
    '  - {"type":"list_jobs","status":"active|paused|all"}',
    '  - {"type":"run_job","job_id":"..."} or {"type":"run_job","name":"unique existing job name"}',
    '    Use run_job to execute an existing cronjob immediately from its persisted definition. Do not reconstruct a cronjob rerun as a continuation.',
    '  - {"type":"update_job","job_id":"...","name":"...","new_name":"...","status":"active|paused","schedule":"...","timezone":"IANA timezone","prompt":"...","content":"...","model":"..."}',
    '  - {"type":"disable_job","job_id":"..."} or {"type":"delete_job","job_id":"..."}',
    '  - {"type":"upsert_job","name":"...","job_type":"prompt|message","schedule":"...","timezone":"IANA timezone","prompt":"...","content":"...","target_chat_id":"...","model":"...","status":"active|paused"}',
    ...localCliToolLines,
    '  - {"type":"manage_access_control","action":"list|add|remove","list":"allowed_user_ids|allowed_chat_ids|group_no_mention_chat_ids","value":"ou_xxx, oc_xxx, or current"}',
    '    Use value="current" for the current group chat; never guess chat IDs.',
    ...traceQueryLines,
    ...continuationLines,
    '  - {"type":"send_message","message":{"kind":"image|file","source":"local_path|current_message:first_image|quoted_message:first_image","path":"...","text":"..."}}',
    '  - {"type":"send_message","message":{"kind":"rich","parts":[{"type":"text","text":"..."},{"type":"image","source":"local_path|current_message:first_image|quoted_message:first_image","path":"...","alt":"..."}]},"reply_in_thread":true}',
    '  - {"type":"recall_message","message_id":"..."}',
  ];
}
