import type { LarkChannel } from '../../src/channel.js';
import type { LarkTransport } from '../../src/lark-transport.js';
import type { MemoryStore } from '../../src/memory/file.js';

export type ToolHandler = (args: any) => any | Promise<any>;

export function createToolServerHarness(): {
  server: { registerTool: (name: string, config: any, handler: ToolHandler) => void };
  handlers: Map<string, ToolHandler>;
  getTool: (name: string) => ToolHandler;
} {
  const handlers = new Map<string, ToolHandler>();

  return {
    server: {
      registerTool(name: string, _config: any, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    },
    handlers,
    getTool(name: string): ToolHandler {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool handler not registered: ${name}`);
      return handler;
    },
  };
}

export function createNoopMemoryStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    healthCheck: async () => true,
    getProfile: async () => null,
    saveProfile: async () => {},
    listProfileLines: async () => [],
    removeProfileLine: async () => false,
    searchEpisodes: async () => [],
    saveEpisode: async () => {},
    listEpisodes: async () => [],
    deleteEpisodes: async () => {},
    pruneEpisodes: async () => ({ removedFiles: 0, removedBytes: 0 }),
    searchSkills: async () => [],
    saveSkill: async () => {},
    ...overrides,
  } as unknown as MemoryStore;
}

export function createMockLarkClient(overrides: Record<string, unknown> = {}): any {
  const base = {
    im: {
      v1: {
        message: {
          create: async () => ({}),
          reply: async () => ({}),
          patch: async () => ({}),
          update: async () => ({}),
          get: async () => ({}),
          delete: async () => ({}),
        },
        messageReaction: {
          create: async () => ({}),
          delete: async () => ({}),
        },
        image: {
          create: async () => ({ data: { image_key: 'img' } }),
          get: async () => Buffer.from('x'),
        },
        file: {
          create: async () => ({ data: { file_key: 'file' } }),
        },
        messageResource: {
          get: async () => Buffer.from('x'),
        },
      },
    },
  };

  return mergeRecord(base, overrides);
}

export function createMockTransport(overrides: Partial<LarkTransport> = {}): LarkTransport {
  return {
    sendMessage: async () => ({ messageId: 'om_sent' }),
    editMessage: async () => {},
    updateCard: async () => {},
    recallMessage: async () => {},
    addReaction: async () => 'reaction_id',
    removeReaction: async () => {},
    removeReactionByEmoji: async () => false,
    downloadResource: async () => Buffer.from(''),
    uploadImage: async () => 'img_key',
    uploadFile: async () => 'file_key',
    replyDocComment: async () => ({ replyId: 'reply_id' }),
    findDocCommentReplyByMarker: async () => null,
    createDocComment: async () => ({ commentId: 'comment_id' }),
    fetchMessageText: async () => null,
    fetchMessageContext: async () => null,
    ...overrides,
  };
}

export function createPrivateChatChannel(
  rule: boolean | ((chatId: string) => boolean) = true,
): Pick<LarkChannel, 'isPrivateChat'> {
  const isPrivateChat = typeof rule === 'function' ? rule : () => rule;
  return { isPrivateChat };
}

function mergeRecord<T extends Record<string, unknown>>(base: T, overrides: Record<string, unknown>): T {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeRecord(current, value)
        : value;
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
