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
            parent_id: 'om_parent_text',
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
        delete: async (args: any) => {
          calls.push({ method: 'raw.message.delete', args });
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
  recallMessage: async (messageId: string) => {
    calls.push({ method: 'sdk.recallMessage', args: { messageId } });
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
  const diagnostics: string[] = [];
  const failingSdkChannel = {
    rawClient,
    send: async (to: string, input: any, opts?: any) => {
      calls.push({ method: 'sdk.send.fail', args: { to, input, opts } });
      const err = new Error('Internal Error') as Error & {
        code?: string;
        context?: unknown;
        cause?: unknown;
      };
      err.name = 'LarkChannelError';
      err.code = 'unknown';
      err.context = { to };
      err.cause = {
        response: {
          status: 500,
          data: { code: 99991663, msg: 'Internal Error' },
        },
        config: { headers: { Authorization: 'Bearer should-not-log' } },
      };
      throw err;
    },
  };
  const transportWithFallback = createLarkTransport({
    sdkChannel: failingSdkChannel as any,
    rawClient: rawClient as any,
  });
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(String).join(' '));
  };
  try {
    const result = await transportWithFallback.sendMessage({
      chatId: 'oc_chat',
      input: { text: 'fallback' },
      replyTo: 'om_user',
      replyInThread: true,
    });
    assert.deepEqual(result, { messageId: 'om_raw_reply' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls.slice(-2).map((call) => call.method), [
    'sdk.send.fail',
    'raw.message.reply',
  ]);
  const rawReply = calls.at(-1);
  assert.equal(rawReply?.args.path.message_id, 'om_user');
  assert.equal(rawReply?.args.data.reply_in_thread, true);
  assert.equal(rawReply?.args.data.content, JSON.stringify({ text: 'fallback' }));
  assert.ok(
    diagnostics.some(
      (line) =>
        line.includes('[lark-transport] SDK send failed; falling back to raw OpenAPI') &&
        line.includes('code=unknown') &&
        line.includes('status=500') &&
        line.includes('feishu_code=99991663') &&
        !line.includes('should-not-log'),
    ),
    `missing SDK fallback diagnostic: ${diagnostics.join('\n')}`,
  );
}

{
  const diagnostics: string[] = [];
  const failingSdkChannel = {
    rawClient,
    send: async (to: string, input: any, opts?: any) => {
      calls.push({ method: 'sdk.send.withdrawn', args: { to, input, opts } });
      const err = new Error('The message was withdrawn.') as Error & {
        response?: { status: number; data: { code: number; msg: string } };
      };
      err.response = {
        status: 500,
        data: { code: 230011, msg: 'The message was withdrawn.' },
      };
      throw err;
    },
  };
  const transportWithFallback = createLarkTransport({
    sdkChannel: failingSdkChannel as any,
    rawClient: rawClient as any,
  });
  const before = calls.length;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(String).join(' '));
  };
  try {
    await assert.rejects(
      transportWithFallback.sendMessage({
        chatId: 'oc_chat',
        input: { text: 'withdrawn target' },
        replyTo: 'om_withdrawn',
      }),
      /withdrawn/i,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls.slice(before).map((call) => call.method), ['sdk.send.withdrawn']);
  assert.ok(
    diagnostics.some(
      (line) =>
        line.includes('[lark-transport] SDK send skipped') &&
        line.includes('code=230011') &&
        line.includes('raw OpenAPI fallback suppressed'),
    ),
    `missing withdrawn-message skip diagnostic: ${diagnostics.join('\n')}`,
  );
}

{
  const failingSdkChannel = {
    rawClient,
    send: async (to: string, input: any, opts?: any) => {
      calls.push({ method: 'sdk.send.card.fail', args: { to, input, opts } });
      throw new Error('Internal Error');
    },
  };
  const transportWithFallback = createLarkTransport({
    sdkChannel: failingSdkChannel as any,
    rawClient: rawClient as any,
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await transportWithFallback.sendMessage({
      chatId: 'oc_chat',
      input: { card: { elements: [{ tag: 'markdown', content: 'card body' }] } },
    });
    assert.deepEqual(result, { messageId: 'om_raw_created' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls.slice(-2).map((call) => call.method), [
    'sdk.send.card.fail',
    'raw.message.create',
  ]);
  const rawCreate = calls.at(-1);
  assert.equal(rawCreate?.args.data.msg_type, 'interactive');
  assert.equal(
    rawCreate?.args.data.content,
    JSON.stringify({ elements: [{ tag: 'markdown', content: 'card body' }] }),
  );
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

await transport.recallMessage('om_recall_sdk');
assert.deepEqual(calls.pop(), {
  method: 'sdk.recallMessage',
  args: { messageId: 'om_recall_sdk' },
});

{
  const failingRecallSdkChannel = {
    rawClient,
    recallMessage: async (messageId: string) => {
      calls.push({ method: 'sdk.recallMessage.fail', args: { messageId } });
      throw new Error('Internal Error');
    },
  };
  const transportWithFallback = createLarkTransport({
    sdkChannel: failingRecallSdkChannel as any,
    rawClient: rawClient as any,
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await transportWithFallback.recallMessage('om_recall_raw');
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(calls.slice(-2), [
    { method: 'sdk.recallMessage.fail', args: { messageId: 'om_recall_raw' } },
    { method: 'raw.message.delete', args: { path: { message_id: 'om_recall_raw' } } },
  ]);
}

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
const cardMessageContext = await transport.fetchMessageContext('om_card');
assert.deepEqual(cardMessageContext, {
  messageId: 'om_card',
  text: 'Deploy Card\nStatus green',
  msgType: 'interactive',
  parentId: 'om_parent_text',
  replyTo: 'om_parent_text',
  interactiveCard: {
    title: 'Deploy Card',
    text: 'Deploy Card\nStatus green',
    rawContentShape: 'feishu_card_json',
  },
  fetchStage: 'bot_mget',
  fetchIdentity: 'bot',
  fetchResult: 'success',
});
assert.equal(isPlaceholderCardText('[Interactive Card]', 'interactive'), true);
assert.equal(calls.some((call) => call.method === 'raw.request'), true);

{
  const sdkJsonTransport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => {
        calls.push({ method: 'sdk.fetchMessage.json', args: { messageId } });
        return {
          messageId,
          messageType: 'interactive',
          parentId: 'om_sdk_parent',
          content: JSON.stringify({
            header: { title: { tag: 'plain_text', content: 'SDK Card' } },
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'From SDK JSON' } }],
          }),
        };
      },
    } as any,
  });
  const before = calls.length;
  assert.equal(await sdkJsonTransport.fetchMessageText('om_sdk_json_card'), 'SDK Card\nFrom SDK JSON');
  assert.deepEqual(await sdkJsonTransport.fetchMessageContext('om_sdk_json_card'), {
    messageId: 'om_sdk_json_card',
    text: 'SDK Card\nFrom SDK JSON',
    msgType: 'interactive',
    parentId: 'om_sdk_parent',
    replyTo: 'om_sdk_parent',
    interactiveCard: {
      title: 'SDK Card',
      text: 'SDK Card\nFrom SDK JSON',
      rawContentShape: 'feishu_card_json',
    },
    fetchStage: 'sdk_fetch',
    fetchIdentity: 'bot',
    fetchResult: 'success',
  });
  assert.deepEqual(calls.slice(before).map((call) => call.method), ['sdk.fetchMessage.json']);
}

{
  const cachedTransport = createLarkTransport({
    outboundMessageContextCache: {
      get: (messageId: string) => messageId === 'om_cached_bot_card'
        ? {
            quotedContext: {
              text: 'Cached Bot Card\nApprove deployment?',
              msgType: 'interactive',
              parentId: 'om_user_request',
            },
          }
        : undefined,
    },
  } as any);

  assert.deepEqual(await cachedTransport.fetchMessageContext('om_cached_bot_card'), {
    messageId: 'om_cached_bot_card',
    text: 'Cached Bot Card\nApprove deployment?',
    msgType: 'interactive',
    parentId: 'om_user_request',
    fetchStage: 'outbound_cache',
    fetchIdentity: 'cache',
    fetchResult: 'success',
  });
  assert.equal(await cachedTransport.fetchMessageText('om_cached_bot_card'), 'Cached Bot Card\nApprove deployment?');
}

{
  const runtimeCalls: Array<{ method: string; args?: any }> = [];
  const runtimeMgetTransport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => {
        runtimeCalls.push({ method: 'sdk.fetchMessage.placeholder', args: { messageId } });
        return { messageId, messageType: 'interactive', content: '[Interactive Card]' };
      },
    } as any,
    rawClient: {
      request: async (args: any) => {
        runtimeCalls.push({ method: 'raw.request.mget', args });
        assert.equal(args.method, 'GET');
        assert.match(
          args.url,
          /\/open-apis\/im\/v1\/messages\/mget\?card_msg_content_type=raw_card_content&message_ids=om_cli_card$/,
        );
        assert.deepEqual(args.params, {});
        assert.equal(args.data, undefined);
        return {
          data: {
            messages: [
              {
                message_id: 'om_cli_card',
                msg_type: 'interactive',
                content: JSON.stringify({
                  header: { title: { tag: 'plain_text', content: 'CLI Card' } },
                  elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Fetched through runtime mget' } }],
                }),
              },
            ],
          },
        };
      },
      im: {
        v1: {
          message: {
            get: async (args: any) => {
              runtimeCalls.push({ method: 'raw.message.get', args });
              return { data: { items: [] } };
            },
          },
        },
      },
    } as any,
  });

  assert.deepEqual(await runtimeMgetTransport.fetchMessageContext('om_cli_card'), {
    messageId: 'om_cli_card',
    text: 'CLI Card\nFetched through runtime mget',
    msgType: 'interactive',
    interactiveCard: {
      title: 'CLI Card',
      text: 'CLI Card\nFetched through runtime mget',
      rawContentShape: 'feishu_card_json',
    },
    fetchStage: 'bot_mget',
    fetchIdentity: 'bot',
    fetchResult: 'success',
  });
  assert.deepEqual(runtimeCalls.map((call) => call.method), [
    'raw.request.mget',
  ]);
}

{
  const compactCalls: Array<{ method: string; args?: any }> = [];
  const compactCardTransport = createLarkTransport({
    rawClient: {
      request: async (args: any) => {
        compactCalls.push({ method: 'raw.request.mget.compact', args });
        return {
          data: {
            messages: [
              {
                chat_id: 'oc_compact',
                message_id: 'om_compact_card',
                msg_type: 'interactive',
                content: '<card title="CLI Compact Card">\nCompact body from lark-cli\n</card>',
                create_time: '2026-06-17 22:49',
                message_position: '120',
                reply_to: 'om_previous_prompt',
                sender: {
                  id: 'cli_app_id',
                  id_type: 'app_id',
                  sender_type: 'app',
                },
              },
            ],
          },
        };
      },
      im: { v1: { message: { get: async () => ({ data: { items: [] } }) } } },
    } as any,
  });

  const compactContext = await compactCardTransport.fetchMessageContext('om_compact_card');
  assert.equal(compactContext?.messageId, 'om_compact_card');
  assert.equal(compactContext?.chatId, 'oc_compact');
  assert.equal(compactContext?.replyTo, 'om_previous_prompt');
  assert.equal(compactContext?.text, 'CLI Compact Card\nCompact body from lark-cli');
  assert.equal(compactContext?.msgType, 'interactive');
  assert.equal(compactContext?.createTime, '2026-06-17 22:49');
  assert.equal(compactContext?.messagePosition, '120');
  assert.equal(compactContext?.sender?.senderType, 'app');
  assert.equal(compactContext?.sender?.idType, 'app_id');
  assert.equal(compactContext?.interactiveCard?.title, 'CLI Compact Card');
  assert.equal(compactContext?.interactiveCard?.rawContentShape, 'card_text');
  assert.equal(compactContext?.interactiveCard?.text, 'CLI Compact Card\nCompact body from lark-cli');
  assert.equal(compactContext?.fetchStage, 'bot_mget');
  assert.equal(compactContext?.fetchIdentity, 'bot');
  assert.equal(compactContext?.fetchResult, 'success');
  assert.equal(typeof compactContext?.timestampMs, 'number');
  assert.deepEqual(compactCalls.map((call) => call.method), [
    'raw.request.mget.compact',
  ]);
}

{
  const userFallbackCalls: Array<{ method: string; args?: any }> = [];
  const userFallbackTransport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => {
        userFallbackCalls.push({ method: 'sdk.fetchMessage.placeholder', args: { messageId } });
        return { messageId, messageType: 'interactive', content: '[Interactive Card]' };
      },
    } as any,
    rawClient: {
      request: async (args: any) => {
        userFallbackCalls.push({ method: 'raw.request.mget.placeholder', args });
        return {
          data: {
            messages: [
              {
                message_id: 'om_user_fetch_card',
                msg_type: 'interactive',
                content: '[Interactive Card]',
              },
            ],
          },
        };
      },
      im: {
        v1: {
          message: {
            get: async (args: any) => {
              userFallbackCalls.push({ method: 'raw.message.get.empty', args });
              return { data: { items: [] } };
            },
          },
        },
      },
    } as any,
    userMessageFetcher: {
      fetchMessage: async (messageId: string) => {
        userFallbackCalls.push({ method: 'user.fetchMessage', args: { messageId } });
        return {
          item: {
            message_id: messageId,
            msg_type: 'interactive',
            content: JSON.stringify({
              header: { title: { tag: 'plain_text', content: 'User Identity Card' } },
              elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Fetched through user identity' } }],
            }),
          },
        };
      },
    },
  } as any);

  assert.deepEqual(await userFallbackTransport.fetchMessageContext('om_user_fetch_card'), {
    messageId: 'om_user_fetch_card',
    text: 'User Identity Card\nFetched through user identity',
    msgType: 'interactive',
    interactiveCard: {
      title: 'User Identity Card',
      text: 'User Identity Card\nFetched through user identity',
      rawContentShape: 'feishu_card_json',
    },
    fetchStage: 'user_mget',
    fetchIdentity: 'user',
    fetchResult: 'success',
  });
  assert.deepEqual(userFallbackCalls.map((call) => call.method), [
    'raw.request.mget.placeholder',
    'user.fetchMessage',
  ]);
}

{
  const userAfterBot404Calls: Array<{ method: string; args?: any }> = [];
  const userAfterBot404Transport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => {
        userAfterBot404Calls.push({ method: 'sdk.fetchMessage.placeholder', args: { messageId } });
        return { messageId, messageType: 'interactive', content: '[Interactive Card]' };
      },
    } as any,
    rawClient: {
      request: async (args: any) => {
        userAfterBot404Calls.push({ method: 'raw.request.mget.404', args });
        const error: any = new Error('Request failed with status code 404');
        error.response = { status: 404, data: { code: 230001, msg: 'not found' } };
        throw error;
      },
      im: {
        v1: {
          message: {
            get: async (args: any) => {
              userAfterBot404Calls.push({ method: 'raw.message.get.empty', args });
              return { data: { items: [] } };
            },
          },
        },
      },
    } as any,
    userMessageFetcher: {
      fetchMessage: async (messageId: string) => {
        userAfterBot404Calls.push({ method: 'user.fetchMessage', args: { messageId } });
        return {
          item: {
            message_id: messageId,
            msg_type: 'interactive',
            content: JSON.stringify({
              header: { title: { tag: 'plain_text', content: 'User Visible Card' } },
              elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Bot mget could not see this' } }],
            }),
          },
        };
      },
    },
  } as any);

  assert.deepEqual(await userAfterBot404Transport.fetchMessageContext('om_user_after_bot_404'), {
    messageId: 'om_user_after_bot_404',
    text: 'User Visible Card\nBot mget could not see this',
    msgType: 'interactive',
    interactiveCard: {
      title: 'User Visible Card',
      text: 'User Visible Card\nBot mget could not see this',
      rawContentShape: 'feishu_card_json',
    },
    fetchStage: 'user_mget',
    fetchIdentity: 'user',
    fetchResult: 'success',
  });
  assert.deepEqual(userAfterBot404Calls.map((call) => call.method), [
    'raw.request.mget.404',
    'user.fetchMessage',
  ]);
}

{
  const userUnavailableTransport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => ({ messageId, messageType: 'interactive', content: '[Interactive Card]' }),
    } as any,
    rawClient: {
      request: async () => ({ data: { messages: [] } }),
      im: { v1: { message: { get: async () => ({ data: { items: [] } }) } } },
    } as any,
    userMessageFetcher: {
      fetchMessage: async () => ({
        fetchResult: 'unavailable',
        diagnostic: 'spawn_error=ENOENT',
      }),
    },
  } as any);

  const failedContext = await userUnavailableTransport.fetchMessageContext('om_user_fetch_unavailable');
  assert.equal(failedContext?.text, null);
  assert.equal(failedContext?.msgType, 'interactive');
  assert.equal(failedContext?.fetchStage, 'user_mget');
  assert.equal(failedContext?.fetchIdentity, 'user');
  assert.equal(failedContext?.fetchResult, 'unavailable');
  assert.equal(failedContext?.diagnostic, 'spawn_error=ENOENT');
}

{
  const failingMgetTransport = createLarkTransport({
    sdkChannel: {
      fetchMessage: async (messageId: string) => ({ messageId, messageType: 'interactive', content: '[Interactive Card]' }),
    } as any,
    rawClient: {
      request: async () => {
        const error: any = new Error('Feishu request failed');
        error.response = {
          status: 404,
          data: {
            code: 230001,
            msg: 'invalid parameter',
            error: { log_id: '202606170001' },
          },
        };
        throw error;
      },
      im: { v1: { message: { get: async () => ({ data: { items: [] } }) } } },
    } as any,
  });

  const failedContext = await failingMgetTransport.fetchMessageContext('om_failed_card');
  assert.equal(failedContext?.text, null);
  assert.equal(failedContext?.msgType, 'interactive');
  assert.equal(failedContext?.fetchStage, 'bot_mget');
  assert.equal(failedContext?.fetchIdentity, 'bot');
  assert.equal(failedContext?.fetchResult, '404');
  assert.match(failedContext?.diagnostic ?? '', /code=230001/);
  assert.match(failedContext?.diagnostic ?? '', /status=404/);
  assert.match(failedContext?.diagnostic ?? '', /log_id=202606170001/);
}

console.log('lark-transport smoke: PASS');
