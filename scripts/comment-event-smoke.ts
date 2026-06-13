import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';

const { handleCommentEvent, LarkChannel } = await import('../src/channel.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { MessageQueue } = await import('../src/queue.js');
const { BoundedCache } = await import('../src/resource-governance.js');
const { ConversationBuffer } = await import('../src/memory/buffer.js');
const { appConfig } = await import('../src/config.js');

(appConfig as { allowedUserIds: string[] }).allowedUserIds = [];
(appConfig as { allowedChatIds: string[] }).allowedChatIds = [];

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function makeEvent(
  overrides: Partial<{
    event_id: string;
    is_mentioned: boolean;
    file_token: string;
    file_type: string;
    comment_id: string;
    reply_id?: string;
    from_open_id: string;
    to_open_id: string;
  }> = {},
) {
  const {
    event_id = `evt_${Math.random().toString(36).slice(2)}`,
    is_mentioned = true,
    file_token = 'dox_doc_1',
    file_type = 'docx',
    comment_id = 'cmt_doc_1',
    reply_id,
    from_open_id = 'ou_owner',
    to_open_id = 'ou_bot',
  } = overrides;
  return {
    schema: '2.0',
    event_id,
    event_type: 'drive.notice.comment_add_v1',
    comment_id,
    reply_id,
    is_mentioned,
    notice_meta: {
      file_type,
      file_token,
      notice_type: reply_id ? 'add_reply' : 'add_comment',
      from_user_id: { open_id: from_open_id, union_id: 'on_from' },
      to_user_id: { open_id: to_open_id, union_id: 'on_to' },
    },
  };
}

function textContent(text: string) {
  return { elements: [{ text_run: { text } }] };
}

function makeDeps(overrides: any = {}) {
  const handlerCalls: any[] = [];
  const replyListCalls: any[] = [];
  const commentListCalls: any[] = [];
  const metaCalls: any[] = [];
  const reactionCalls: any[] = [];
  const identitySession = new IdentitySession(() => 'ou_owner');
  const deps = {
    botOpenId: 'ou_bot',
    seenEventIds: new BoundedCache<string, true>(100),
    identitySession,
    queue: new MessageQueue(),
    messageHandler: async (message: any) => {
      handlerCalls.push(message);
    },
    resolveUserName: async (openId: string) => `Name ${openId}`,
    client: {
      request: async (req: any) => {
        reactionCalls.push(req);
        return { data: {} };
      },
      drive: {
        fileCommentReply: {
          list: async (req: any) => {
            replyListCalls.push(req);
            return {
              data: {
                items: [
                  { reply_id: req.path.comment_id, content: textContent('body') },
                ],
              },
            };
          },
        },
        fileComment: {
          list: async (req: any) => {
            commentListCalls.push(req);
            return {
              data: {
                items: [
                  {
                    comment_id: 'cmt_doc_1',
                    quote: 'selected quote',
                    is_whole: false,
                  },
                ],
              },
            };
          },
        },
        meta: {
          batchQuery: async (req: any) => {
            metaCalls.push(req);
            return { data: { metas: [{ title: 'Document Title' }] } };
          },
        },
      },
    },
    ...overrides,
  };
  return Object.assign(deps, {
    handlerCalls,
    replyListCalls,
    commentListCalls,
    metaCalls,
    reactionCalls,
  });
}

// 1. SDK-unwrapped add_comment payload routes one synthetic doc-comment turn.
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent(), deps);
  await flush();
  assert.equal(deps.replyListCalls.length, 1);
  assert.equal(deps.commentListCalls.length, 1);
  assert.equal(deps.metaCalls.length, 1);
  assert.equal(deps.reactionCalls.length, 1);
  assert.equal(deps.reactionCalls[0].method, 'POST');
  assert.equal(deps.reactionCalls[0].url, 'https://open.feishu.cn/open-apis/drive/v2/files/dox_doc_1/comments/reaction');
  assert.deepEqual(deps.reactionCalls[0].params, { file_type: 'docx' });
  assert.deepEqual(deps.reactionCalls[0].data, {
    action: 'add',
    reply_id: 'cmt_doc_1',
    reaction_type: 'THUMBSUP',
  });
  assert.equal(deps.handlerCalls.length, 1);
  const msg = deps.handlerCalls[0];
  assert.equal(msg.chatId, 'doc:dox_doc_1');
  assert.equal(msg.threadId, 'cmt_doc_1');
  assert.equal(msg.chatType, 'doc_comment');
  assert.equal(msg.messageType, 'doc_comment');
  assert.equal(deps.identitySession.getCaller('doc:dox_doc_1', 'cmt_doc_1'), 'ou_owner');
  assert.match(msg.text, /<doc_comment /);
  assert.match(msg.text, /doc_token="dox_doc_1"/);
  assert.match(msg.text, /comment_id="cmt_doc_1"/);
  assert.match(msg.text, /doc_title="Document Title"/);
  assert.match(msg.text, /<selected_text>selected quote<\/selected_text>/);
  assert.match(msg.text, /<body>body<\/body>/);
  assert.doesNotMatch(msg.text, /<parent>/);
}

// 2. Duplicate event_id is processed once.
{
  const deps = makeDeps();
  const event = makeEvent({ event_id: 'evt_duplicate' });
  await handleCommentEvent(event, deps);
  await handleCommentEvent(event, deps);
  await flush();
  assert.equal(deps.handlerCalls.length, 1);
}

// 3. Non-mentions, wrong recipient, and bot-authored comments are ignored.
{
  for (const event of [
    makeEvent({ is_mentioned: false }),
    makeEvent({ to_open_id: 'ou_someone_else' }),
    makeEvent({ from_open_id: 'ou_bot' }),
  ]) {
    const deps = makeDeps();
    await handleCommentEvent(event, deps);
    await flush();
    assert.equal(deps.handlerCalls.length, 0);
    assert.equal(deps.replyListCalls.length, 0);
  }
}

// 4. Doc-comment whitelist gates on users when configured.
{
  const originalAllowedUsers = appConfig.allowedUserIds;
  const originalAllowedChats = appConfig.allowedChatIds;
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = ['ou_allowed'];
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = ['oc_irrelevant'];
  try {
    const denied = makeDeps();
    await handleCommentEvent(makeEvent({ from_open_id: 'ou_denied' }), denied);
    await flush();
    assert.equal(denied.handlerCalls.length, 0);

    const allowed = makeDeps();
    await handleCommentEvent(makeEvent({ from_open_id: 'ou_allowed' }), allowed);
    await flush();
    assert.equal(allowed.handlerCalls.length, 1);
  } finally {
    (appConfig as { allowedUserIds: string[] }).allowedUserIds = originalAllowedUsers;
    (appConfig as { allowedChatIds: string[] }).allowedChatIds = originalAllowedChats;
  }
}

// 5. add_reply includes original comment as parent and target reply as body.
{
  const deps = makeDeps({
    client: {
      request: async (req: any) => {
        deps.reactionCalls.push(req);
        return { data: {} };
      },
      drive: {
        fileCommentReply: {
          list: async (req: any) => {
            deps.replyListCalls.push(req);
            return {
              data: {
                items: [
                  { reply_id: req.path.comment_id, content: textContent('parent body') },
                  { reply_id: 'rpl_doc_1', content: textContent('reply body') },
                ],
              },
            };
          },
        },
        fileComment: {
          list: async (req: any) => {
            deps.commentListCalls.push(req);
            return { data: { items: [{ comment_id: 'cmt_doc_1', quote: 'anchored selection' }] } };
          },
        },
        meta: {
          batchQuery: async (req: any) => {
            deps.metaCalls.push(req);
            return { data: { metas: [{ title: 'Reply Doc' }] } };
          },
        },
      },
    },
  });
  await handleCommentEvent(makeEvent({ reply_id: 'rpl_doc_1' }), deps);
  await flush();
  assert.equal(deps.handlerCalls.length, 1);
  assert.equal(deps.reactionCalls.length, 1);
  assert.deepEqual(deps.reactionCalls[0].data, {
    action: 'add',
    reply_id: 'rpl_doc_1',
    reaction_type: 'THUMBSUP',
  });
  assert.match(deps.handlerCalls[0].text, /kind="reply"/);
  assert.match(deps.handlerCalls[0].text, /reply_id="rpl_doc_1"/);
  assert.match(deps.handlerCalls[0].text, /<selected_text>anchored selection<\/selected_text>/);
  assert.match(deps.handlerCalls[0].text, /<parent>parent body<\/parent>/);
  assert.match(deps.handlerCalls[0].text, /<body>reply body<\/body>/);
}

// 5b. Empty LARK_DOC_COMMENT_ACK_EMOJI disables doc-comment ack reactions.
{
  const originalAck = (appConfig as any).docCommentAckEmoji;
  (appConfig as any).docCommentAckEmoji = '';
  try {
    const deps = makeDeps();
    await handleCommentEvent(makeEvent(), deps);
    await flush();
    assert.equal(deps.handlerCalls.length, 1);
    assert.equal(deps.reactionCalls.length, 0);
  } finally {
    (appConfig as any).docCommentAckEmoji = originalAck;
  }
}

// 5c. Doc-comment ack failures are fire-and-forget and do not block routing.
{
  const deps = makeDeps({
    client: {
      request: async () => {
        throw new Error('reaction denied');
      },
      drive: {
        fileCommentReply: {
          list: async (req: any) => {
            deps.replyListCalls.push(req);
            return { data: { items: [{ reply_id: req.path.comment_id, content: textContent('body ok') }] } };
          },
        },
        fileComment: {
          list: async (req: any) => {
            deps.commentListCalls.push(req);
            return { data: { items: [{ comment_id: 'cmt_doc_1', quote: 'quote ok' }] } };
          },
        },
        meta: { batchQuery: async (req: any) => { deps.metaCalls.push(req); return { data: { metas: [] } }; } },
      },
    },
  });
  await handleCommentEvent(makeEvent(), deps);
  await flush();
  assert.equal(deps.handlerCalls.length, 1);
  assert.match(deps.handlerCalls[0].text, /<body>body ok<\/body>/);
}

// 6. Comment list failure omits selected text but still routes body.
{
  const deps = makeDeps({
    client: {
      drive: {
        fileCommentReply: {
          list: async (req: any) => {
            deps.replyListCalls.push(req);
            return { data: { items: [{ reply_id: req.path.comment_id, content: textContent('body ok') }] } };
          },
        },
        fileComment: {
          list: async (req: any) => {
            deps.commentListCalls.push(req);
            throw new Error('comment list failed');
          },
        },
        meta: { batchQuery: async (req: any) => { deps.metaCalls.push(req); return { data: { metas: [] } }; } },
      },
    },
  });
  await handleCommentEvent(makeEvent(), deps);
  await flush();
  assert.equal(deps.handlerCalls.length, 1);
  assert.match(deps.handlerCalls[0].text, /<body>body ok<\/body>/);
  assert.doesNotMatch(deps.handlerCalls[0].text, /<selected_text>/);
}

// 7. Reply-list failure routes a degraded turn with fetch_error and unknown body.
{
  const deps = makeDeps({
    client: {
      drive: {
        fileCommentReply: {
          list: async (req: any) => {
            deps.replyListCalls.push(req);
            throw new Error('reply list failed');
          },
        },
        fileComment: {
          list: async (req: any) => {
            deps.commentListCalls.push(req);
            return { data: { items: [{ comment_id: 'cmt_doc_1', quote: 'quote still available' }] } };
          },
        },
        meta: { batchQuery: async (req: any) => { deps.metaCalls.push(req); return { data: { metas: [] } }; } },
      },
    },
  });
  await handleCommentEvent(makeEvent(), deps);
  await flush();
  assert.equal(deps.handlerCalls.length, 1);
  assert.match(deps.handlerCalls[0].text, /<fetch_error>reply list failed<\/fetch_error>/);
  assert.match(deps.handlerCalls[0].text, /<selected_text>quote still available<\/selected_text>/);
  assert.match(deps.handlerCalls[0].text, /<body unknown="true"><\/body>/);
}

// 8. LarkChannel's shared queued processor applies doc-comment identity,
// buffer recording, and memory enrichment just like IM messages.
{
  const channel = new LarkChannel();
  const session = new IdentitySession(() => null);
  const buffer = new ConversationBuffer();
  const handled: any[] = [];
  channel.setIdentitySession(session);
  channel.setConversationBuffer(buffer);
  channel.setMemoryStore({
    getProfile: async () => '- likes concise reviews',
    searchEpisodes: async () => [
      { content: 'prior doc context', timestamp: '2026-06-08T00:00:00.000Z', score: 0.9 },
    ],
    searchSkills: async () => [],
  } as any);
  channel.setMessageHandler(async (msg: any) => {
    handled.push(msg);
  });

  await (channel as any).processEnqueuedMessage({
    messageId: 'rpl_mem',
    chatId: 'doc:dox_mem',
    chatType: 'doc_comment',
    senderId: 'ou_owner',
    text: '<doc_comment doc_token="dox_mem" comment_id="cmt_mem"><body>@Codex review</body></doc_comment>',
    messageType: 'doc_comment',
    threadId: 'cmt_mem',
    rawContent: '{}',
    docComment: { fileToken: 'dox_mem', commentId: 'cmt_mem', fileType: 'docx' },
  });

  assert.equal(session.getCaller('doc:dox_mem', 'cmt_mem'), 'ou_owner');
  assert.equal(buffer.getMessages('doc:dox_mem').length, 1);
  assert.equal(handled.length, 1);
  assert.match(handled[0].text, /\[Memory Context\]/);
  assert.match(handled[0].text, /likes concise reviews/);
  assert.match(handled[0].text, /prior doc context/);
}

console.log('PASS');
