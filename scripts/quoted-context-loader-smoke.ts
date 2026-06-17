import assert from 'node:assert/strict';
import {
  addQuotedContext,
  selectQuotedMessageId,
} from '../src/quoted-context-loader.js';
import { enrichmentPrompt } from '../src/prompts.js';

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
  assert.match(message.parentContent ?? '', /message_id: om_root/);
  assert.match(message.parentContent ?? '', /msg_type: unknown/);
  assert.match(message.parentContent ?? '', /hydration_status: success/);
  assert.match(message.parentContent ?? '', /Root card text/);
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
  assert.match(message.parentContent ?? '', /message_id: om_parent/);
  assert.match(message.parentContent ?? '', /hydration_status: failed/);
  assert.match(message.parentContent ?? '', /reason: fetch_failed/);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => '[Interactive Card]',
  });

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: false });
  assert.match(message.parentContent ?? '', /message_id: om_card/);
  assert.match(message.parentContent ?? '', /hydration_status: failed/);
  assert.match(message.parentContent ?? '', /reason: fetch_failed/);
  assert.doesNotMatch(message.parentContent ?? '', /\[Interactive Card\]/);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_failed_card',
  };
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => null,
    fetchMessageContext: async () => ({
      messageId: 'om_failed_card',
      text: null,
      msgType: 'interactive',
      fetchStage: 'raw_mget',
      diagnostic: 'code=230001 log_id=202606170001',
    } as any),
  });

  assert.deepEqual(result, { quotedMessageId: 'om_failed_card', loaded: false });
  assert.match(message.parentContent ?? '', /message_id: om_failed_card/);
  assert.match(message.parentContent ?? '', /hydration_status: failed/);
  assert.match(message.parentContent ?? '', /reason: fetch_failed/);
  assert.match(message.parentContent ?? '', /fetch_stage: raw_mget/);
  assert.match(message.parentContent ?? '', /diagnostic: code=230001 log_id=202606170001/);
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

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const fetched: string[] = [];
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => {
      throw new Error('fetchMessageContext should be preferred');
    },
    fetchMessageContext: async (messageId: string) => {
      fetched.push(messageId);
      return {
        om_card: {
          messageId: 'om_card',
          text: 'Session Cleanup\nDelete expired session files',
          msgType: 'interactive',
          parentId: 'om_text',
        },
        om_text: {
          messageId: 'om_text',
          text: 'Previous text message',
          msgType: 'text',
        },
      }[messageId] ?? null;
    },
  });

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: true });
  assert.deepEqual(fetched, ['om_card', 'om_text']);
  assert.match(message.parentContent ?? '', /message_id: om_card/);
  assert.match(message.parentContent ?? '', /msg_type: interactive/);
  assert.match(message.parentContent ?? '', /hydration_status: success/);
  assert.match(message.parentContent ?? '', /Session Cleanup/);
  assert.match(message.parentContent ?? '', /reply_to: om_text/);
  assert.match(message.parentContent ?? '', /message_id: om_text/);
  assert.match(message.parentContent ?? '', /Previous text message/);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const fetched: string[] = [];
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => null,
    fetchMessageContext: async (messageId: string) => {
      fetched.push(messageId);
      const chain: Record<string, { messageId: string; text: string; msgType: string; parentId?: string }> = {
        om_card: { messageId: 'om_card', text: 'Card text', msgType: 'interactive', parentId: 'om_1' },
        om_1: { messageId: 'om_1', text: 'First reply', msgType: 'text', parentId: 'om_2' },
        om_2: { messageId: 'om_2', text: 'Second reply', msgType: 'text', parentId: 'om_3' },
        om_3: { messageId: 'om_3', text: 'Third reply', msgType: 'text', parentId: 'om_4' },
        om_4: { messageId: 'om_4', text: 'Beyond default depth', msgType: 'text' },
      };
      return chain[messageId] ?? null;
    },
  });

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: true });
  assert.deepEqual(fetched, ['om_card', 'om_1', 'om_2', 'om_3']);
  assert.match(message.parentContent ?? '', /message_id: om_3/);
  assert.doesNotMatch(message.parentContent ?? '', /message_id: om_4/);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const fetched: string[] = [];
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => null,
    fetchMessageContext: async (messageId: string) => {
      fetched.push(messageId);
      return {
        om_card: {
          messageId: 'om_card',
          text: 'Interactive card quoting text',
          msgType: 'interactive',
          parentId: 'om_text',
        },
        om_text: {
          messageId: 'om_text',
          text: 'Text quoting the original card',
          msgType: 'text',
          parentId: 'om_card',
        },
      }[messageId] ?? null;
    },
  }, { maxDepth: 4 });

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: true });
  assert.deepEqual(fetched, ['om_card', 'om_text']);
  assert.equal((message.parentContent?.match(/message_id: om_card/g) ?? []).length, 1);
  assert.equal((message.parentContent?.match(/message_id: om_text/g) ?? []).length, 1);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => null,
    fetchMessageContext: async () => ({
      messageId: 'om_card',
      text: 'x'.repeat(200),
      msgType: 'interactive',
    }),
  }, { maxBytes: 80 });

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: false });
  assert.match(message.parentContent ?? '', /hydration_status: failed/);
  assert.match(message.parentContent ?? '', /reason: token_budget_exceeded/);
}

{
  const message = {
    messageId: 'om_current',
    parentId: 'om_card',
  };
  const result = await addQuotedContext(message, {
    fetchMessageText: async () => null,
    fetchMessageContext: async () => null,
  });
  const prompt = enrichmentPrompt(
    'open.feishu.cn DNS incident from old memory',
    message.parentContent,
    'ou_sender',
    'oc_chat',
    'Adopt the suggestion and file an issue',
  );

  assert.deepEqual(result, { quotedMessageId: 'om_card', loaded: false });
  assert.match(prompt, /\[Memory Context\]/);
  assert.match(prompt, /\[Quoted Message\]/);
  assert.match(prompt, /message_id: om_card/);
  assert.match(prompt, /hydration_status: failed/);
  assert.match(prompt, /reason: fetch_failed/);
}

console.log('quoted-context-loader smoke: PASS');
