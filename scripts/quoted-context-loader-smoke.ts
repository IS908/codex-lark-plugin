import assert from 'node:assert/strict';
import {
  addQuotedContext,
  selectQuotedMessageId,
} from '../src/quoted-context-loader.js';

assert.equal(
  selectQuotedMessageId({
    messageId: 'om_current',
    parentId: 'om_parent',
    rootMessageId: 'om_root',
    threadId: 'om_thread',
  }),
  'om_parent',
);

assert.equal(
  selectQuotedMessageId({
    messageId: 'om_current',
    rootMessageId: 'om_root',
    threadId: 'om_thread',
  }),
  'om_root',
);

assert.equal(
  selectQuotedMessageId({
    messageId: 'om_current',
    rootMessageId: 'omt_thread',
    threadId: 'om_thread_root',
  }),
  'om_thread_root',
);

assert.equal(
  selectQuotedMessageId({
    messageId: 'om_current',
    rootMessageId: 'om_current',
    threadId: 'omt_thread',
  }),
  undefined,
);

{
  const message = {
    messageId: 'om_current',
    rootMessageId: 'om_root',
  };
  const fetched: string[] = [];
  const result = await addQuotedContext(message, {
    fetchMessageText: async (messageId: string) => {
      fetched.push(messageId);
      return 'Root card text';
    },
  });

  assert.deepEqual(result, { quotedMessageId: 'om_root', loaded: true });
  assert.deepEqual(fetched, ['om_root']);
  assert.equal(message.parentContent, 'Root card text');
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_parent',
  };
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => {
      throw new Error('fetch failed');
    },
  });

  assert.deepEqual(result, { quotedMessageId: 'om_parent', loaded: false });
  assert.equal(message.parentContent, undefined);
}

{
  const message = {
    messageId: 'om_current',
    threadId: 'omt_thread',
  };
  let fetchCalled = false;
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => {
      fetchCalled = true;
      return 'unexpected';
    },
  });

  assert.deepEqual(result, { loaded: false });
  assert.equal(fetchCalled, false);
  assert.equal(message.parentContent, undefined);
}

console.log('quoted-context-loader smoke: PASS');
