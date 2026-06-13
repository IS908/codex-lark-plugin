import { createHash } from 'node:crypto';

export type MemoryContextBlockKind =
  | 'profile'
  | 'mentioned_profile'
  | 'thread_episode'
  | 'chat_episode'
  | 'skill';

export interface MemoryContextBlock {
  key: string;
  kind: MemoryContextBlockKind;
  label: string;
  content: string;
}

export interface MemoryContextDedupResult {
  memoryContext: string;
  injectedCount: number;
  suppressedCount: number;
  bytesSaved: number;
}

interface MemoryContextDeduperOptions {
  windowMs: number;
  maxScopes?: number;
}

interface BlockState {
  hash: string;
  injectedAtMs: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderBlock(block: MemoryContextBlock): string {
  return `${block.label}\n${block.content}`;
}

function renderSuppressedProfileStub(block: MemoryContextBlock): string {
  return [
    `<memory_context_omitted kind="${escapeAttr(block.kind)}" key="${escapeAttr(block.key)}" reason="unchanged_within_dedup_window">`,
    'Previously injected unchanged profile context for this chat/thread; content omitted to avoid repeated hot-context injection.',
    '</memory_context_omitted>',
  ].join('\n');
}

export function createMemoryDedupScopeKey(chatId: string, threadId?: string): string {
  return `${chatId}::${threadId || '_'}`;
}

export class MemoryContextDeduper {
  private readonly maxScopes: number;
  private readonly scopes = new Map<string, Map<string, BlockState>>();
  private readonly scopeOrder: string[] = [];
  private windowMs: number;

  constructor(options: MemoryContextDeduperOptions) {
    this.windowMs = Math.max(0, options.windowMs);
    this.maxScopes = Math.max(1, options.maxScopes ?? 1000);
  }

  setWindowMs(windowMs: number): void {
    this.windowMs = Math.max(0, windowMs);
  }

  invalidate(scopeKey: string): void {
    this.scopes.delete(scopeKey);
    const index = this.scopeOrder.indexOf(scopeKey);
    if (index >= 0) this.scopeOrder.splice(index, 1);
  }

  filter(scopeKey: string, blocks: MemoryContextBlock[], nowMs = Date.now()): MemoryContextDedupResult {
    if (blocks.length === 0) {
      return { memoryContext: '', injectedCount: 0, suppressedCount: 0, bytesSaved: 0 };
    }

    if (this.windowMs <= 0) {
      return {
        memoryContext: blocks.map(renderBlock).join('\n\n'),
        injectedCount: blocks.length,
        suppressedCount: 0,
        bytesSaved: 0,
      };
    }

    const state = this.ensureScope(scopeKey);
    const rendered: string[] = [];
    let injectedCount = 0;
    let suppressedCount = 0;
    let bytesSaved = 0;

    for (const block of blocks) {
      const blockText = renderBlock(block);
      const hash = sha256(blockText);
      const previous = state.get(block.key);
      const unchanged = previous?.hash === hash;
      const withinWindow = previous ? nowMs - previous.injectedAtMs < this.windowMs : false;

      if (unchanged && withinWindow) {
        suppressedCount += 1;
        bytesSaved += Buffer.byteLength(blockText, 'utf8');
        if (block.kind === 'profile' || block.kind === 'mentioned_profile') {
          rendered.push(renderSuppressedProfileStub(block));
        }
        continue;
      }

      state.set(block.key, { hash, injectedAtMs: nowMs });
      injectedCount += 1;
      rendered.push(blockText);
    }

    return {
      memoryContext: rendered.join('\n\n'),
      injectedCount,
      suppressedCount,
      bytesSaved,
    };
  }

  private ensureScope(scopeKey: string): Map<string, BlockState> {
    const existing = this.scopes.get(scopeKey);
    if (existing) return existing;

    const state = new Map<string, BlockState>();
    this.scopes.set(scopeKey, state);
    this.scopeOrder.push(scopeKey);

    while (this.scopeOrder.length > this.maxScopes) {
      const evicted = this.scopeOrder.shift();
      if (evicted) this.scopes.delete(evicted);
    }

    return state;
  }
}
