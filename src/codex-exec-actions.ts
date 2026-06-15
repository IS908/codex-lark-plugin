import { z } from 'zod';
import { audit } from './audit-log.js';
import type { LarkMessage } from './channel.js';
import type { IdentitySession } from './identity-session.js';
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { appConfig } from './config.js';
import type { MemoryStore } from './memory/file.js';
import { assertSafeChatId } from './prompts.js';
import {
  computeNextRun,
  expandSchedule,
  jobExists,
  sanitizeJobId,
  writeJob,
  type JobFile,
} from './job-store.js';
import { findLarkDeferSentinel } from './turn-obligation.js';
import { runConfiguredLocalCliTool } from './local-cli-tools.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import { logSafeError } from './safe-log.js';
import type { BotMessageTracker } from './channel.js';
import type { LarkTransport } from './lark-transport.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import { validateTrackedBotMessageScope } from './message-mutation.js';

export const CODEX_EXEC_ACTIONS_START = '<LARK_ACTIONS_JSON>';
export const CODEX_EXEC_ACTIONS_END = '</LARK_ACTIONS_JSON>';

const SaveMemoryActionSchema = z.object({
  type: z.literal('save_memory'),
  memory_type: z.enum(['profile', 'chat', 'thread']),
  content: z.string().min(1),
  reason: z.string().min(1),
  tier: z.enum(['public', 'private']).optional(),
  mode: z.enum(['append', 'replace']).optional(),
});

const CreateJobActionSchema = z.object({
  type: z.literal('create_job'),
  name: z.string().min(1),
  job_type: z.enum(['prompt', 'message']),
  schedule: z.string().min(1),
  prompt: z.string().optional(),
  content: z.string().optional(),
  target_chat_id: z.string().optional(),
  model: z.string().optional(),
});

const RunLocalCliToolActionSchema = z.object({
  type: z.literal('run_local_cli_tool'),
  tool: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const RecallMessageActionSchema = z.object({
  type: z.literal('recall_message'),
  message_id: z.string().min(1),
});

const CodexExecActionSchema = z.discriminatedUnion('type', [
  SaveMemoryActionSchema,
  CreateJobActionSchema,
  RunLocalCliToolActionSchema,
  RecallMessageActionSchema,
]);

const CodexExecActionEnvelopeSchema = z.object({
  version: z.literal(1),
  reply: z.string().optional(),
  actions: z.array(CodexExecActionSchema).min(1).max(5),
});

export type CodexExecAction = z.infer<typeof CodexExecActionSchema>;

export interface CodexExecActionExecutionResult {
  ok: boolean;
  action: CodexExecAction['type'];
  message: string;
}

export type CodexExecParsedOutput =
  | { kind: 'reply'; replyText: string; actions: [] }
  | { kind: 'defer'; replyText: string; actions: [] }
  | { kind: 'actions'; replyText: string; actions: CodexExecAction[] }
  | { kind: 'invalid_actions'; replyText: string; actions: []; error: string };

export interface CodexExecActionDispatchRequest {
  message: LarkMessage;
  actions: CodexExecAction[];
}

export interface CodexExecActionDispatcher {
  execute(request: CodexExecActionDispatchRequest): Promise<CodexExecActionExecutionResult[]>;
}

export interface CreateCodexExecActionDispatcherOptions {
  memoryStore: MemoryStore;
  identitySession: IdentitySession;
  localCliToolsConfigPath?: string;
  profileDistiller?: ProfileDistillationDispatcher;
  larkTransport?: Pick<LarkTransport, 'recallMessage'> | (() => Pick<LarkTransport, 'recallMessage'>);
  botMessageTracker?: Pick<BotMessageTracker, 'get'>;
  turnObligations?: Pick<TurnObligationTracker, 'markSatisfied'>;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseCodexExecActionOutput(text: string): CodexExecParsedOutput {
  const firstStart = text.indexOf(CODEX_EXEC_ACTIONS_START);
  if (firstStart < 0) {
    return findLarkDeferSentinel(text)
      ? { kind: 'defer', replyText: text.trim(), actions: [] }
      : { kind: 'reply', replyText: text.trim(), actions: [] };
  }

  const secondStart = text.indexOf(CODEX_EXEC_ACTIONS_START, firstStart + CODEX_EXEC_ACTIONS_START.length);
  if (secondStart >= 0) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'multiple Lark action blocks are not allowed',
    };
  }

  const end = text.indexOf(CODEX_EXEC_ACTIONS_END, firstStart + CODEX_EXEC_ACTIONS_START.length);
  if (end < 0) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'missing closing Lark action block marker',
    };
  }

  const trailing = text.slice(end + CODEX_EXEC_ACTIONS_END.length).trim();
  if (trailing) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: 'text after the Lark action block is not allowed',
    };
  }

  const rawJson = text.slice(firstStart + CODEX_EXEC_ACTIONS_START.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const envelope = CodexExecActionEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      kind: 'invalid_actions',
      replyText: text.slice(0, firstStart).trim(),
      actions: [],
      error: formatZodError(envelope.error),
    };
  }

  return {
    kind: 'actions',
    replyText: text.slice(0, firstStart).trim() || envelope.data.reply?.trim() || '',
    actions: envelope.data.actions,
  };
}

function currentCaller(
  identitySession: IdentitySession,
  message: LarkMessage,
  action: CodexExecAction['type'],
): { caller: string } | { error: CodexExecActionExecutionResult } {
  const caller = identitySession.getCaller(message.chatId, message.threadId);
  if (!caller) {
    void audit(action, null, { chat_id: message.chatId, thread_id: message.threadId }, 'denied');
    return {
      error: {
        ok: false,
        action,
        message: `No active identity session for chat ${message.chatId}.`,
      },
    };
  }
  return { caller };
}

async function executeSaveMemory(
  action: z.infer<typeof SaveMemoryActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'save_memory');
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const auditArgs =
    action.memory_type === 'profile'
      ? {
          type: action.memory_type,
          chat_id: message.chatId,
          thread_id: message.threadId,
          tier: action.tier,
          mode: action.mode,
        }
      : { type: action.memory_type, chat_id: message.chatId, thread_id: message.threadId };

  if (action.memory_type === 'profile' && caller === SYSTEM_FLUSH_CALLER) {
    void audit('save_memory', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'save_memory',
      message: 'save_memory(type=profile) denied: caller is the system-flush sentinel.',
    };
  }

  if (action.memory_type === 'profile') {
    const tier = action.tier ?? 'private';
    const mode = action.mode ?? 'append';
    await deps.memoryStore.saveProfile(caller, action.content, tier, mode);
    void audit('save_memory', caller, auditArgs, 'ok');
    return { ok: true, action: 'save_memory', message: `Saved ${tier} profile for ${caller} (mode: ${mode}).` };
  }

  if (action.memory_type === 'thread' && !message.threadId) {
    void audit('save_memory', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'save_memory',
      message: 'save_memory(type=thread) requires the current thread_id.',
    };
  }

  await deps.memoryStore.saveEpisode(action.memory_type, action.content, {
    chatId: message.chatId,
    threadId: message.threadId,
  });
  if (deps.profileDistiller) {
    void deps.profileDistiller
      .maybeDispatch({
        userId: caller,
        chatId: message.chatId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        chatType: message.chatType === 'p2p' ? 'p2p' : 'group',
      })
      .then((result) => {
        if (result.status === 'error') {
          console.error(`[profile-distill] dispatch failed for ${caller}: ${result.error ?? 'unknown error'}`);
        }
      })
      .catch((err) => logSafeError('[profile-distill] dispatch failed:', err));
  }
  void audit('save_memory', caller, auditArgs, 'ok');
  return { ok: true, action: 'save_memory', message: `Saved ${action.memory_type} episode for chat ${message.chatId}.` };
}

async function executeCreateJob(
  action: z.infer<typeof CreateJobActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'create_job');
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const targetChatId = action.target_chat_id ?? message.chatId;
  const auditArgs = {
    name: action.name,
    type: action.job_type,
    schedule: action.schedule,
    target_chat_id: targetChatId,
    model: action.model,
    chat_id: message.chatId,
    thread_id: message.threadId,
  };

  if (action.job_type === 'prompt' && !action.prompt) {
    return { ok: false, action: 'create_job', message: 'prompt is required for job_type=prompt.' };
  }
  if (action.job_type === 'message' && !action.content) {
    return { ok: false, action: 'create_job', message: 'content is required for job_type=message.' };
  }
  try {
    assertSafeChatId(targetChatId);
  } catch (err: any) {
    return { ok: false, action: 'create_job', message: `Invalid target_chat_id: ${err?.message ?? targetChatId}` };
  }

  let cron: string;
  let scheduleHuman: string;
  try {
    const expanded = expandSchedule(action.schedule);
    cron = expanded.cron;
    scheduleHuman = expanded.human;
  } catch (err: any) {
    return { ok: false, action: 'create_job', message: `Invalid schedule expression: ${err?.message ?? action.schedule}` };
  }

  const id = sanitizeJobId(action.name);
  if (await jobExists(id)) {
    return { ok: false, action: 'create_job', message: `Job "${id}" already exists.` };
  }

  const nextRunAt = computeNextRun(cron);
  const job: JobFile = {
    meta: {
      id,
      name: action.name,
      type: action.job_type,
      schedule: cron,
      schedule_human: scheduleHuman,
      ...(action.job_type === 'prompt' ? { prompt: action.prompt } : { content: action.content, msg_type: 'text' }),
      target_chat_id: targetChatId,
      ...(action.model ? { model: action.model } : {}),
      origin_chat_id: message.chatId,
      status: 'active',
      created_by: caller,
      created_at: new Date().toISOString(),
    },
    runtime: {
      last_run_at: null,
      next_run_at: nextRunAt,
      run_count: 0,
      last_error: null,
    },
  };

  await writeJob(job);
  void audit('create_job', caller, auditArgs, 'ok');
  return { ok: true, action: 'create_job', message: `Created job "${id}" (${scheduleHuman}). Next run: ${nextRunAt}` };
}

async function executeRunLocalCliTool(
  action: z.infer<typeof RunLocalCliToolActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const result = await runConfiguredLocalCliTool({
    identitySession: deps.identitySession,
    tool: action.tool,
    args: action.args ?? [],
    chat_id: message.chatId,
    thread_id: message.threadId,
    configPath: deps.localCliToolsConfigPath,
  });
  return { ok: result.ok, action: 'run_local_cli_tool', message: result.message };
}

function resolveRecallTransport(
  transport: CreateCodexExecActionDispatcherOptions['larkTransport'],
): Pick<LarkTransport, 'recallMessage'> | undefined {
  return typeof transport === 'function' ? transport() : transport;
}

async function executeRecallMessage(
  action: z.infer<typeof RecallMessageActionSchema>,
  message: LarkMessage,
  deps: CreateCodexExecActionDispatcherOptions,
): Promise<CodexExecActionExecutionResult> {
  const auth = currentCaller(deps.identitySession, message, 'recall_message');
  const auditArgs = { message_id: action.message_id, chat_id: message.chatId, thread_id: message.threadId };
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  const tracked = validateTrackedBotMessageScope({
    toolName: 'recall_message',
    messageId: action.message_id,
    chatId: message.chatId,
    threadId: message.threadId,
    botMessageTracker: deps.botMessageTracker,
  });
  if (!tracked.ok) {
    void audit('recall_message', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'recall_message',
      message: tracked.message,
    };
  }

  const transport = resolveRecallTransport(deps.larkTransport);
  if (!transport?.recallMessage) {
    void audit('recall_message', caller, auditArgs, 'denied');
    return {
      ok: false,
      action: 'recall_message',
      message: 'recall_message is not configured for this runtime.',
    };
  }

  try {
    await transport.recallMessage(action.message_id);
  } catch (err) {
    void audit('recall_message', caller, auditArgs, 'error');
    return {
      ok: false,
      action: 'recall_message',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  deps.turnObligations?.markSatisfied(message.messageId, 'recall_message');
  void audit('recall_message', caller, auditArgs, 'ok');
  return { ok: true, action: 'recall_message', message: `Recalled message ${action.message_id}.` };
}

export function formatCodexExecActionResults(results: CodexExecActionExecutionResult[]): string {
  return results
    .map((result) => `${result.ok ? 'OK' : 'ERROR'} ${result.action}: ${result.message}`)
    .join('\n');
}

export function createCodexExecActionDispatcher(
  deps: CreateCodexExecActionDispatcherOptions,
): CodexExecActionDispatcher {
  return {
    async execute(request) {
      const results: CodexExecActionExecutionResult[] = [];
      for (const action of request.actions) {
        if (action.type === 'save_memory') {
          results.push(await executeSaveMemory(action, request.message, deps));
        } else if (action.type === 'create_job') {
          results.push(await executeCreateJob(action, request.message, deps));
        } else if (action.type === 'recall_message') {
          results.push(await executeRecallMessage(action, request.message, deps));
        } else {
          results.push(await executeRunLocalCliTool(action, request.message, deps));
        }
      }
      return results;
    },
  };
}
