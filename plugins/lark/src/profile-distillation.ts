import { audit as defaultAudit, type AuditOutcome } from './audit-log.js';
import { appConfig } from './config.js';
import { normalizeCodexExecResult, runCodexExecCommand, type CodexExecRunner } from './codex-exec.js';
import { SYSTEM_FLUSH_CALLER, TERMINAL_CHAT_ID } from './identity-session.js';
import type { MemoryStore } from './memory/file.js';
import { buildProfileDistillationPrompt, parseTieredProfile } from './memory/distiller.js';
import { loadL2Rules } from './privacy-rules.js';

export type ProfileDistillationChatType = 'p2p' | 'group';

export type ProfileDistillationStatus =
  | 'disabled'
  | 'skipped_system_user'
  | 'insufficient_episodes'
  | 'cooldown'
  | 'dispatched'
  | 'empty'
  | 'error';

export interface ProfileDistillationTrigger {
  userId: string | null | undefined;
  chatId: string;
  threadId?: string;
  chatType: ProfileDistillationChatType;
}

export interface ProfileDistillationResult {
  status: ProfileDistillationStatus;
  episodeCount?: number;
  wrotePublic?: number;
  wrotePrivate?: number;
  error?: string;
}

export interface ProfileDistillationManagerOptions {
  enabled: boolean;
  memoryStore: MemoryStore;
  minEpisodes: number;
  maxEpisodes: number;
  cooldownMs: number;
  runCodexExec?: CodexExecRunner;
  audit?: (
    tool: string,
    caller: string | null,
    args: Record<string, unknown>,
    outcome: AuditOutcome,
  ) => Promise<void>;
  now?: () => number;
}

export interface ProfileDistillationDispatcher {
  maybeDispatch(input: ProfileDistillationTrigger): Promise<ProfileDistillationResult>;
}

interface LockedProfileDistillationTrigger {
  userId: string;
  chatId: string;
  threadId?: string;
  chatType: ProfileDistillationChatType;
}

function markdownList(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^[-*]\s+/.test(line) ? line : `- ${line}`))
    .join('\n');
}

function isRealProfileUser(userId: string | null | undefined): userId is string {
  return !!userId && userId !== SYSTEM_FLUSH_CALLER && userId !== TERMINAL_CHAT_ID && userId !== 'system';
}

export class ProfileDistillationManager implements ProfileDistillationDispatcher {
  private readonly enabled: boolean;
  private readonly memoryStore: MemoryStore;
  private readonly minEpisodes: number;
  private readonly maxEpisodes: number;
  private readonly cooldownMs: number;
  private readonly runCodexExec: CodexExecRunner;
  private readonly audit: NonNullable<ProfileDistillationManagerOptions['audit']>;
  private readonly now: () => number;
  private readonly lastDispatchAt = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: ProfileDistillationManagerOptions) {
    this.enabled = options.enabled;
    this.memoryStore = options.memoryStore;
    this.minEpisodes = Math.max(1, Math.floor(options.minEpisodes));
    this.maxEpisodes = Math.max(1, Math.floor(options.maxEpisodes));
    this.cooldownMs = Math.max(0, Math.floor(options.cooldownMs));
    this.runCodexExec = options.runCodexExec ?? runCodexExecCommand;
    this.audit = options.audit ?? defaultAudit;
    this.now = options.now ?? (() => Date.now());
  }

  async maybeDispatch(input: ProfileDistillationTrigger): Promise<ProfileDistillationResult> {
    if (!this.enabled) return { status: 'disabled' };
    const userId = input.userId;
    if (!isRealProfileUser(userId)) return { status: 'skipped_system_user' };

    return this.withUserLock(userId, async () => this.dispatchLocked({
      userId,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      chatType: input.chatType,
    }));
  }

  private async dispatchLocked(input: LockedProfileDistillationTrigger): Promise<ProfileDistillationResult> {
    const now = this.now();
    const last = this.lastDispatchAt.get(input.userId);
    if (last !== undefined && now - last < this.cooldownMs) {
      return { status: 'cooldown' };
    }

    const episodes = await this.memoryStore.listEpisodes(input.chatId, input.threadId);
    const recent = episodes.slice(-this.maxEpisodes);
    if (recent.length < this.minEpisodes) {
      return { status: 'insufficient_episodes', episodeCount: recent.length };
    }

    this.lastDispatchAt.set(input.userId, now);
    const auditArgs = {
      chat_id: input.chatId,
      thread_id: input.threadId,
      chat_type: input.chatType,
      episode_count: recent.length,
    };

    try {
      const currentProfile = await this.memoryStore.getProfile(input.userId, input.userId);
      const prompt = buildProfileDistillationPrompt({
        userId: input.userId,
        currentProfile,
        episodeSummaries: recent.map((episode) => episode.content),
        chatType: input.chatType,
        l2Rules: await loadL2Rules(),
      });
      const result = normalizeCodexExecResult(await this.runCodexExec({
        prompt,
        command: appConfig.codexExecCommand,
        cwd: appConfig.codexExecCwd,
        timeoutMs: appConfig.codexExecTimeoutMs,
        sandbox: appConfig.codexExecSandbox,
        model: appConfig.codexExecModel,
        profile: appConfig.codexExecProfile,
        ignoreUserConfig: appConfig.codexExecIgnoreUserConfig,
        skipGitRepoCheck: true,
        resumeSessionId: null,
      }));
      const tiered = parseTieredProfile(result.text);
      const publicContent = markdownList(tiered.public);
      const privateContent = markdownList(tiered.private);
      if (publicContent) await this.memoryStore.saveProfile(input.userId, publicContent, 'public', 'append');
      if (privateContent) await this.memoryStore.saveProfile(input.userId, privateContent, 'private', 'append');
      await this.audit('profile_distill', input.userId, auditArgs, 'ok');
      if (!publicContent && !privateContent) {
        return { status: 'empty', episodeCount: recent.length, wrotePublic: 0, wrotePrivate: 0 };
      }
      return {
        status: 'dispatched',
        episodeCount: recent.length,
        wrotePublic: tiered.public.length,
        wrotePrivate: tiered.private.length,
      };
    } catch (err) {
      await this.audit('profile_distill', input.userId, auditArgs, 'error');
      return {
        status: 'error',
        episodeCount: recent.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous
      .catch(() => {})
      .then(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
    this.locks.set(userId, current);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(userId) === current) this.locks.delete(userId);
    }
  }
}
