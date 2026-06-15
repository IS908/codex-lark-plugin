import assert from 'node:assert/strict';
import {
  DisplayNameResolver,
  generateChatAlias,
  generateUserAlias,
} from '../src/display-name-resolver.js';

class MapCache {
  readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

assert.equal(generateUserAlias('ou_abcdef1234567'), 'user_1234567');
assert.equal(generateChatAlias('oc_abcdef1234567'), 'chat_1234567');

{
  const cache = new MapCache();
  cache.set('ou_cached', 'Cached User');
  let called = false;
  const resolver = new DisplayNameResolver({
    cache,
    client: {
      contact: {
        v3: {
          user: {
            get: async () => {
              called = true;
              return { data: { user: { name: 'Unexpected' } } };
            },
          },
        },
      },
      im: { v1: { chat: { get: async () => ({ data: { name: 'Unexpected' } }) } } },
    },
    call: async (_name, fn) => fn(),
  });

  assert.equal(await resolver.resolveUserName('ou_cached'), 'Cached User');
  assert.equal(called, false);
}

{
  const cache = new MapCache();
  const resolver = new DisplayNameResolver({
    cache,
    client: {
      contact: {
        v3: {
          user: {
            get: async (req: any) => {
              assert.deepEqual(req.path, { user_id: 'ou_api' });
              assert.deepEqual(req.params, { user_id_type: 'open_id' });
              return { data: { user: { name: 'API User' } } };
            },
          },
        },
      },
      im: { v1: { chat: { get: async () => ({ data: { name: 'Unexpected' } }) } } },
    },
    call: async (_name, fn) => fn(),
  });

  assert.equal(await resolver.resolveUserName('ou_api'), 'API User');
  assert.equal(cache.get('ou_api'), 'API User');
}

{
  const cache = new MapCache();
  const resolver = new DisplayNameResolver({
    cache,
    client: {
      contact: { v3: { user: { get: async () => { throw new Error('no scope'); } } } },
      im: {
        v1: {
          chat: {
            get: async (req: any) => {
              assert.deepEqual(req.path, { chat_id: 'oc_api' });
              return { data: { name: 'API Chat' } };
            },
          },
        },
      },
    },
    call: async (_name, fn) => fn(),
  });

  assert.equal(await resolver.resolveUserName(''), '');
  assert.equal(await resolver.resolveUserName('ou_fallback123'), 'user_back123');
  assert.equal(cache.get('ou_fallback123'), 'user_back123');
  assert.equal(await resolver.resolveChatName('oc_api'), 'API Chat');
  assert.equal(cache.get('oc_api'), 'API Chat');
}

{
  const cache = new MapCache();
  const resolver = new DisplayNameResolver({
    cache,
    client: {
      contact: { v3: { user: { get: async () => ({ data: { user: {} } }) } } },
      im: { v1: { chat: { get: async () => { throw new Error('not found'); } } } },
    },
    call: async (_name, fn) => fn(),
  });

  assert.equal(await resolver.resolveChatName(''), '');
  assert.equal(await resolver.resolveChatName('oc_fallback123'), 'chat_back123');
  assert.equal(cache.get('oc_fallback123'), 'chat_back123');
}

{
  const cache = new MapCache();
  let client: any = {
    contact: { v3: { user: { get: async () => ({ data: { user: { name: 'Initial User' } } }) } } },
    im: { v1: { chat: { get: async () => ({ data: { name: 'Initial Chat' } }) } } },
  };
  const resolver = new DisplayNameResolver({
    cache,
    client: () => client,
    call: async (_name, fn) => fn(),
  });

  client = {
    contact: { v3: { user: { get: async () => ({ data: { user: { name: 'Updated User' } } }) } } },
    im: { v1: { chat: { get: async () => ({ data: { name: 'Updated Chat' } }) } } },
  };

  assert.equal(await resolver.resolveUserName('ou_provider'), 'Updated User');
  assert.equal(await resolver.resolveChatName('oc_provider'), 'Updated Chat');
}

console.log('display-name-resolver smoke: PASS');
