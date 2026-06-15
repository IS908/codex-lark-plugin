import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_OWNER_OPEN_ID = 'ou_owner';

const { registerDocCommentTools } = await import('../src/tools/doc-comments.js');
const rootTools = await import('../src/tools.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { ConversationBuffer } = await import('../src/memory/buffer.js');

assert.equal(
  rootTools.registerDocCommentTools,
  registerDocCommentTools,
  'root tools.js re-exports registerDocCommentTools for compatibility',
);

function makeHarness() {
  const session = new IdentitySession(() => 'ou_owner');
  const buffer = new ConversationBuffer();
  const replyCalls: any[] = [];
  const createCalls: any[] = [];
  const client = {
    drive: {
      fileCommentReply: {
        create: async (req: any) => {
          replyCalls.push(req);
          return { data: { reply_id: 'rpl_created' } };
        },
      },
      fileComment: {
        create: async (req: any) => {
          createCalls.push(req);
          return { data: { comment_id: 'cmt_created' } };
        },
      },
    },
  };
  const registered: Record<string, (args: any) => Promise<any>> = {};
  const fakeServer = {
    registerTool(name: string, _config: any, handler: any) {
      registered[name] = handler;
    },
  };
  registerDocCommentTools({
    server: fakeServer as any,
    client: client as any,
    identitySession: session,
    conversationBuffer: buffer,
  });
  return { session, buffer, registered, replyCalls, createCalls };
}

// 1. Owner-bound doc turn can reply to the triggering thread.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello doc',
    file_type: 'docx',
  });
  assert.equal(result?.isError, undefined);
  assert.equal(h.replyCalls.length, 1);
  assert.equal(h.replyCalls[0].path.file_token, 'dox_a');
  assert.equal(h.replyCalls[0].path.comment_id, 'cmt_a');
  assert.equal(h.replyCalls[0].params.file_type, 'docx');
  assert.equal(h.replyCalls[0].params.user_id_type, 'open_id');
  assert.equal(h.replyCalls[0].data.content.elements[0].text_run.text, 'hello doc');
  assert.equal(h.buffer.getMessages('doc:dox_a').at(-1)?.role, 'assistant');
  assert.equal(h.buffer.getMessages('doc:dox_a').at(-1)?.text, 'hello doc');
}

// 2. Non-owner doc caller is denied.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_someone_else');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /owner-only/i);
  assert.equal(h.replyCalls.length, 0);
}

// 3. Missing thread_id cannot resolve a per-comment identity binding.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /No active identity session/i);
  assert.equal(h.replyCalls.length, 0);
}

// 4. Terminal context is rejected even though terminal can resolve owner.
{
  const h = makeHarness();
  const result = await h.registered.reply_doc_comment({
    chat_id: '__terminal__',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /doc-comment-triggered/i);
  assert.equal(h.replyCalls.length, 0);
}

// 5. Prompt-injected doc_token mismatch is rejected.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_other',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /doc_token mismatch/i);
  assert.equal(h.replyCalls.length, 0);
}

// 6. Empty reply content is rejected before API call.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: '   ',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /empty|cannot be empty/i);
  assert.equal(h.replyCalls.length, 0);
}

// 6b. reply_doc_comment cannot target a different comment in the same document.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const result = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_other',
    content: 'wrong thread',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /comment_id mismatch/i);
  assert.equal(h.replyCalls.length, 0);
  assert.equal(h.buffer.getMessages('doc:dox_a').length, 0);
}

// 7. Feishu collaborator-comment denial returns an operator hint.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
  const failing = {
    drive: {
      fileCommentReply: {
        create: async () => {
          const err: any = new Error('blocked');
          err.code = 1069302;
          throw err;
        },
      },
      fileComment: { create: async () => ({ data: {} }) },
    },
  };
  const registered: Record<string, (args: any) => Promise<any>> = {};
  registerDocCommentTools({
    server: { registerTool: (n: string, _c: any, fn: any) => { registered[n] = fn; } } as any,
    client: failing as any,
    identitySession: h.session,
  });
  const result = await registered.reply_doc_comment({
    chat_id: 'doc:dox_a',
    thread_id: 'cmt_a',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /collaborator|comment/i);
}

// 8. Owner can create a new top-level comment in the triggering doc.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_new', 'cmt_seed', 'ou_owner');
  const result = await h.registered.create_doc_comment({
    chat_id: 'doc:dox_new',
    thread_id: 'cmt_seed',
    doc_token: 'dox_new',
    content: 'new thread',
    file_type: 'docx',
  });
  assert.equal(result?.isError, undefined);
  assert.equal(h.createCalls.length, 1);
  assert.equal(h.createCalls[0].path.file_token, 'dox_new');
  assert.equal(h.createCalls[0].params.file_type, 'docx');
  assert.equal(h.createCalls[0].data.reply_list.replies[0].content.elements[0].text_run.text, 'new thread');
  assert.equal(h.buffer.getMessages('doc:dox_new').at(-1)?.role, 'assistant');
  assert.equal(h.buffer.getMessages('doc:dox_new').at(-1)?.text, 'new thread');
}

// 9. create_doc_comment applies the same doc binding and terminal rejection.
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_new', 'cmt_seed', 'ou_owner');
  const mismatch = await h.registered.create_doc_comment({
    chat_id: 'doc:dox_new',
    thread_id: 'cmt_seed',
    doc_token: 'dox_other',
    content: 'new thread',
    file_type: 'docx',
  });
  assert.equal(mismatch?.isError, true);
  assert.match(mismatch.content[0].text, /doc_token mismatch/i);

  const terminal = await h.registered.create_doc_comment({
    chat_id: '__terminal__',
    thread_id: 'cmt_seed',
    doc_token: 'dox_new',
    content: 'new thread',
    file_type: 'docx',
  });
  assert.equal(terminal?.isError, true);
  assert.match(terminal.content[0].text, /doc-comment-triggered/i);
  assert.equal(h.createCalls.length, 0);
}

console.log('PASS');
