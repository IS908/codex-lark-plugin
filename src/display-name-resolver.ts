import { feishuApiCall } from './feishu-retry.js';

export interface DisplayNameCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface DisplayNameClient {
  contact: {
    v3: {
      user: {
        get(req: {
          path: { user_id: string };
          params: { user_id_type: 'open_id' };
        }): Promise<any>;
      };
    };
  };
  im: {
    v1: {
      chat: {
        get(req: { path: { chat_id: string } }): Promise<any>;
      };
    };
  };
}

export type DisplayNameApiCall = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export type DisplayNameClientProvider = DisplayNameClient | (() => DisplayNameClient);

export interface DisplayNameResolverOptions {
  cache: DisplayNameCache;
  client: DisplayNameClientProvider;
  call?: DisplayNameApiCall;
}

export function generateUserAlias(id: string): string {
  return `user_${id.slice(-7)}`;
}

export function generateChatAlias(chatId: string): string {
  return `chat_${chatId.slice(-7)}`;
}

export class DisplayNameResolver {
  private readonly cache: DisplayNameCache;
  private readonly client: () => DisplayNameClient;
  private readonly call: DisplayNameApiCall;

  constructor(options: DisplayNameResolverOptions) {
    this.cache = options.cache;
    if (typeof options.client === 'function') {
      this.client = options.client;
    } else {
      const client = options.client;
      this.client = () => client;
    }
    this.call = options.call ?? feishuApiCall;
  }

  async resolveUserName(openId: string): Promise<string> {
    if (!openId) return '';

    const cached = this.cache.get(openId);
    if (cached) return cached;

    try {
      const resp = await this.call('channel.contact.user.get', () =>
        this.client().contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        }),
      );
      const name = (resp?.data as any)?.user?.name;
      if (name) {
        this.cache.set(openId, name);
        return name;
      }
    } catch {
      // Permission not granted or API failed; fall through to a stable alias.
    }

    const alias = generateUserAlias(openId);
    this.cache.set(openId, alias);
    return alias;
  }

  async resolveChatName(chatId: string): Promise<string> {
    if (!chatId) return '';

    const cached = this.cache.get(chatId);
    if (cached) return cached;

    try {
      const resp = await this.call('channel.chat.get', () =>
        this.client().im.v1.chat.get({
          path: { chat_id: chatId },
        }),
      );
      const name = (resp?.data as any)?.name;
      if (name) {
        this.cache.set(chatId, name);
        return name;
      }
    } catch {
      // Chat name fetch failed; fall through to alias.
    }

    const alias = generateChatAlias(chatId);
    this.cache.set(chatId, alias);
    return alias;
  }
}
