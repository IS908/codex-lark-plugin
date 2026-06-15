import assert from 'node:assert/strict';
import {
  createLarkTransport,
  isPlaceholderCardText,
} from '../src/lark-transport.js';

const calls: Array<{ method: string; args: any }> = [];

const rawClient = {
  request: async (args: any) => {
    calls.push({ method: 'raw.request', args });
    if (String(args.url).includes('/comments/') && String(args.url).endsWith('/replies')) {
      return { data: { reply_id: 'reply_1' } };
    }
    if (String(args.url).endsWith('/comments')) {
      return { data: { comment_id: 'comment_1' } };
    }
    return {
      data: {
        items: [
          {
            message_id: 'om_card',
            msg_type: 'interactive',
            body: {
              content: JSON.stringify({
                header: { title: { tag: 'plain_text', content: 'Deploy Card' } },
                elements: [
                  { tag: 'div', text: { tag: 'plain_text', content: 'Status green' } },
                ],
              }),
            },
          },
        ],
      },
    };
  },
  im: {
    v1: {
      message: {
        create: async (args: any) => {
          calls.push({ method: 'raw.message.create', args });
          return { data: { message_id: 'om_raw_created' } };
        },
        reply: async (args: any) => {
          calls.push({ method: 'raw.message.reply', args });
          return { data: { message_id: 'om_raw_reply' } };
        },
        patch: async (args: any) => {
          calls.push({ method: 'raw.message.patch', args });
        },
        get: async (args: any) => {
          calls.push({ method: 'raw.message.get', args });
          return { data: { items: [] } };
        },
      },
      messageReaction: {
        delete: async (args: any) => {
          calls.push({ method: 'raw.messageReaction.delete', args });
        },
      },
      image: {
        create: async () => ({ data: { image_key: 'img_uploaded' } }),
      },
      file: {
        create: async () => ({ data: { file_key: 'file_uploaded' } }),
      },
      messageResource: {
        get: async (args: any) => {
          calls.push({ method: 'raw.messageResource.get', args });
          return Buffer.from('downloaded');
        },
      },
    },
  },
  drive: {
    fileComment: {
      create: async (args: any) => {
        calls.push({ method: 'raw.fileComment.create', args });
        return { data: { comment_id: 'comment_1' } };
      },
    },
    fileCommentReply: {
      create: async (args: any) => {
        calls.push({ method: 'raw.fileCommentReply.create', args });
        return { data: { reply_id: 'reply_1' } };
      },
    },
  },
};

const sdkChannel = {
  rawClient,
  comments: {
    reply: async (...args: any[]) => {
      calls.push({ method: 'sdk.comments.reply', args });
      return { replyId: 'sdk_reply_1' };
    },
  },
  send: async (to: string, input: any, opts?: any) => {
    calls.push({ method: 'sdk.send', args: { to, input, opts } });
    return { messageId: 'om_sdk_sent', chunkIds: ['om_sdk_sent'] };
  },
  editMessage: async (messageId: string, text: string) => {
    calls.push({ method: 'sdk.editMessage', args: { messageId, text } });
  },
  updateCard: async (messageId: string, card: object) => {
    calls.push({ method: 'sdk.updateCard', args: { messageId, card } });
  },
  addReaction: async (messageId: string, emojiType: string) => {
    calls.push({ method: 'sdk.addReaction', args: { messageId, emojiType } });
    return 'reaction_sdk';
  },
  removeReaction: async (messageId: string, reactionId: string) => {
    calls.push({ method: 'sdk.removeReaction', args: { messageId, reactionId } });
  },
  removeReactionByEmoji: async (messageId: string, emojiType: string) => {
    calls.push({ method: 'sdk.removeReactionByEmoji', args: { messageId, emojiType } });
    return true;
  },
  downloadResource: async (messageId: string, fileKey: string, resourceType: string) => {
    calls.push({ method: 'sdk.downloadResource', args: { messageId, fileKey, resourceType } });
    return Buffer.from('sdk-download');
  },
  fetchMessage: async (messageId: string) => {
    calls.push({ method: 'sdk.fetchMessage', args: { messageId } });
    return { messageId, messageType: 'interactive', content: '[Interactive Card]' };
  },
};

const transport = createLarkTransport({
  sdkChannel: sdkChannel as any,
  rawClient: rawClient as any,
});

{
  const result = await transport.sendMessage({
    chatId: 'oc_chat',
    input: { text: 'hello' },
    replyTo: 'om_user',
    replyInThread: true,
  });

  assert.deepEqual(result, { messageId: 'om_sdk_sent', chunkIds: ['om_sdk_sent'] });
  assert.deepEqual(calls.pop(), {
    method: 'sdk.send',
    args: {
      to: 'oc_chat',
      input: { text: 'hello' },
      opts: { replyTo: 'om_user', replyInThread: true },
    },
  });
}

{
  const result = await transport.sendMessage({
    chatId: 'oc_chat',
    input: { text: 'scheduled' },
    uuid: 'job-uuid',
  });

  assert.deepEqual(result, { messageId: 'om_raw_created' });
  assert.deepEqual(calls.pop(), {
    method: 'raw.message.create',
    args: {
      data: {
        receive_id: 'oc_chat',
        msg_type: 'text',
        content: JSON.stringify({ text: 'scheduled' }),
        uuid: 'job-uuid',
      },
      params: { receive_id_type: 'chat_id' },
    },
  });
}

{
  await transport.sendMessage({
    chatId: 'ou_owner',
    input: { text: 'nudge' },
    receiveIdType: 'open_id',
    forceRaw: true,
  });

  const call = calls.pop();
  assert.equal(call?.method, 'raw.message.create');
  assert.equal(call?.args.params.receive_id_type, 'open_id');
  assert.equal(call?.args.data.receive_id, 'ou_owner');
}

await transport.editMessage({ messageId: 'om_msg', text: 'edited' });
assert.deepEqual(calls.pop(), {
  method: 'sdk.editMessage',
  args: { messageId: 'om_msg', text: 'edited' },
});

await transport.updateCard({ messageId: 'om_card_out', card: { type: 'template' } });
assert.deepEqual(calls.pop(), {
  method: 'sdk.updateCard',
  args: { messageId: 'om_card_out', card: { type: 'template' } },
});

const reactionId = await transport.addReaction('om_msg', 'MeMeMe');
assert.equal(reactionId, 'reaction_sdk');
assert.deepEqual(calls.pop(), {
  method: 'sdk.addReaction',
  args: { messageId: 'om_msg', emojiType: 'MeMeMe' },
});

await transport.removeReaction('om_msg', 'reaction_sdk');
assert.deepEqual(calls.pop(), {
  method: 'sdk.removeReaction',
  args: { messageId: 'om_msg', reactionId: 'reaction_sdk' },
});

const reply = await transport.replyDocComment({
  docToken: 'doc_token',
  commentId: 'comment_1',
  content: 'comment body',
  fileType: 'docx',
});
assert.deepEqual(reply, { replyId: 'reply_1' });
assert.equal(calls.at(-1)?.method, 'raw.request');

const cardContext = await transport.fetchMessageText('om_card');
assert.equal(cardContext, 'Deploy Card\nStatus green');
assert.equal(isPlaceholderCardText('[Interactive Card]', 'interactive'), true);
assert.equal(calls.some((call) => call.method === 'raw.request'), true);

console.log('lark-transport smoke: PASS');
