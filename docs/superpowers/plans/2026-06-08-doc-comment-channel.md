# Doc Comment Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Feishu/Lark document-comment @bot channel so doc comments can create Codex turns and receive replies in the same comment thread.

**Architecture:** Add a pure doc-comment event dispatcher in `src/channel.ts`, using the existing `MessageQueue`, `IdentitySession`, `BoundedCache`, memory enrichment, and notification flow. Add narrowly-scoped MCP tools in `src/tools.ts` for doc-comment replies/creates, with server-derived identity and `doc:<file_token>` binding checks.

**Tech Stack:** TypeScript ESM, `@larksuiteoapi/node-sdk`, MCP `registerTool`, existing smoke-test scripts via `node --import tsx`.

---

## File Structure

- Modify `src/identity-session.ts` and `plugins/lark/src/identity-session.ts`: export `DOC_CHAT_ID_PREFIX = 'doc:'`; keep doc sessions resolved only from real `setCaller` entries, never owner fallback.
- Modify `src/config.ts`, `plugins/lark/src/config.ts`, `.env.example`, `plugins/lark/.env.example`: add bounded doc-comment event cache size if needed; no doc-comment ack in this issue.
- Modify `src/channel.ts` and `plugins/lark/src/channel.ts`: add `passesDocCommentWhitelist`, doc-comment body extraction helpers, event dispatcher, event registration, and synthetic `LarkMessage` routing.
- Modify `src/tools.ts` and `plugins/lark/src/tools.ts`: add `registerDocCommentTools`, `reply_doc_comment`, `create_doc_comment`, and raw-HTTP SDK adapters.
- Modify `src/prompts.ts` and `plugins/lark/src/prompts.ts`: add doc-comment tool guidance to MCP instructions.
- Create `scripts/comment-event-smoke.ts`: smoke tests for event filtering, SDK payload shape, prefetch, quote/body context, whitelist, dedup, identity binding, and failure degradation.
- Create `scripts/reply-doc-comment-smoke.ts`: smoke tests for tool auth, doc-token binding, terminal rejection, empty content, permission failures, and create/reply wire shapes.
- Modify `scripts/test.sh`: add the two new smoke scripts.
- Modify `README.md`, `README_CN.md`, `CHANGELOG.md`: document scopes, event subscription, tools, and release notes.

## Task 1: Event Dispatcher Red Tests

**Files:**
- Create: `scripts/comment-event-smoke.ts`
- Test target: `node --import tsx scripts/comment-event-smoke.ts`

- [ ] **Step 1: Write failing smoke tests**

Cover these cases in the new smoke file:

```ts
// Event shape must match Lark SDK unwrapped payload:
const event = {
  schema: '2.0',
  event_id: 'evt_doc_1',
  event_type: 'drive.notice.comment_add_v1',
  comment_id: 'cmt_1',
  reply_id: undefined,
  is_mentioned: true,
  notice_meta: {
    file_type: 'docx',
    file_token: 'dox_1',
    notice_type: 'add_comment',
    from_user_id: { open_id: 'ou_owner' },
    to_user_id: { open_id: 'ou_bot' },
  },
};
```

Assertions:

```ts
assert.equal(handlerCalls.length, 1);
assert.equal(handlerCalls[0].chatId, 'doc:dox_1');
assert.equal(handlerCalls[0].threadId, 'cmt_1');
assert.equal(identitySession.getCaller('doc:dox_1', 'cmt_1'), 'ou_owner');
assert.match(handlerCalls[0].text, /<doc_comment /);
assert.match(handlerCalls[0].text, /<body>body<\/body>/);
```

Also assert:

```ts
// dropped
is_mentioned === false;
to_user_id.open_id !== botOpenId;
from_user_id.open_id === botOpenId;
allowedUserIds excludes sender;
duplicate event_id;

// degraded but routed
fileCommentReply.list rejects while meta lookup succeeds;
fileComment.list rejects while body still routes without selected_text;
anchored comment includes target quote from fileComment.list;
add_reply includes parent body and reply body;
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
LARK_APP_ID=cli_test_app_id LARK_APP_SECRET=test_app_secret node --import tsx scripts/comment-event-smoke.ts
```

Expected: fails because `handleCommentEvent` and doc-chat constants do not exist.

## Task 2: Implement Doc-Comment Event Routing

**Files:**
- Modify: `src/identity-session.ts`
- Modify: `src/channel.ts`
- Mirror: `plugins/lark/src/identity-session.ts`, `plugins/lark/src/channel.ts`

- [ ] **Step 1: Add doc chat prefix**

Add:

```ts
export const DOC_CHAT_ID_PREFIX = 'doc:';
```

Do not add any `getCaller()` shortcut for doc chat IDs. Doc-comment identities must come only from `setCaller('doc:<token>', comment_id, open_id)`.

- [ ] **Step 2: Add whitelist helper**

Add an exported helper next to `passesWhitelist`:

```ts
export function passesDocCommentWhitelist(senderId: string): boolean {
  if (appConfig.allowedUserIds.length === 0) return true;
  return appConfig.allowedUserIds.includes(senderId);
}
```

This preserves user-list enforcement while allowing chat-list-only setups, because synthetic `doc:<file_token>` cannot match a real chat id.

- [ ] **Step 3: Add `handleCommentEvent`**

Implement a pure exported dispatcher:

```ts
export interface CommentEventDeps {
  botOpenId: string;
  seenEventIds: BoundedCache<string, true>;
  identitySession: IdentitySession;
  queue: MessageQueue;
  messageHandler: MessageHandler | null;
  resolveUserName: (openId: string) => Promise<string>;
  client: {
    drive: {
      fileComment: { list: (req: any) => Promise<any> };
      fileCommentReply: { list: (req: any) => Promise<any> };
      meta: { batchQuery: (req: any) => Promise<any> };
    };
  };
}
```

Behavior:

```ts
const eventId = data?.event_id;
if (eventId && deps.seenEventIds.has(eventId)) return;
if (eventId) deps.seenEventIds.set(eventId, true);

const meta = data?.notice_meta;
if (!meta || data?.is_mentioned !== true) return;
if (meta.to_user_id?.open_id !== deps.botOpenId) return;
if (meta.from_user_id?.open_id === deps.botOpenId) return;
if (!passesDocCommentWhitelist(meta.from_user_id?.open_id ?? '')) return;
```

Prefetch with `Promise.allSettled`:

```ts
deps.client.drive.fileCommentReply.list({
  path: { file_token: fileToken, comment_id: commentId },
  params: { file_type: fileType, page_size: 100 },
});
deps.client.drive.fileComment.list({
  path: { file_token: fileToken },
  params: { file_type: fileType, page_size: 100 },
});
```

Build a bounded escaped envelope:

```xml
<doc_comment doc_token="..." comment_id="..." kind="comment|reply" operator="..." doc_title="..." file_type="docx" is_mentioned="true">
  <selected_text>...</selected_text>
  <parent>...</parent>
  <body>...</body>
</doc_comment>
```

Route:

```ts
const chatId = `${DOC_CHAT_ID_PREFIX}${fileToken}`;
const threadId = commentId;
deps.queue.enqueue(chatId, threadId, async () => {
  deps.identitySession.setCaller(chatId, threadId, fromOpenId);
  await deps.messageHandler?.(syntheticMessage);
});
```

- [ ] **Step 4: Register event with SDK**

Chain another `EventDispatcher.register` block in `LarkChannel.start()`:

```ts
}).register({
  'drive.notice.comment_add_v1': async (data: any) => {
    debugLog(`[channel] Event received: drive.notice.comment_add_v1`);
    await handleCommentEvent(data, {
      botOpenId: this.botOpenId,
      seenEventIds: this.commentEventIdSeen,
      identitySession: this.identitySession!,
      queue: this.queue,
      messageHandler: this.messageHandler,
      resolveUserName: this.resolveUserName.bind(this),
      client: this.client as any,
    });
  },
});
```

- [ ] **Step 5: Run focused test**

Run:

```bash
LARK_APP_ID=cli_test_app_id LARK_APP_SECRET=test_app_secret node --import tsx scripts/comment-event-smoke.ts
```

Expected: PASS.

## Task 3: Doc-Comment Tool Red Tests

**Files:**
- Create: `scripts/reply-doc-comment-smoke.ts`
- Test target: `node --import tsx scripts/reply-doc-comment-smoke.ts`

- [ ] **Step 1: Write failing smoke tests**

Create a fake MCP server:

```ts
const registered: Record<string, (args: any) => Promise<any>> = {};
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    registered[name] = handler;
  },
};
```

Assert these cases:

```ts
// owner-bound doc turn can reply
session.setCaller('doc:dox_a', 'cmt_a', 'ou_owner');
await registered.reply_doc_comment({
  chat_id: 'doc:dox_a',
  thread_id: 'cmt_a',
  doc_token: 'dox_a',
  comment_id: 'cmt_a',
  content: 'hello',
  file_type: 'docx',
});

// rejects
non-owner caller;
missing thread_id;
chat_id='__terminal__';
doc_token mismatch;
empty content;

// API failure
code=1069302 returns collaborator-comment hint;

// create_doc_comment
owner path posts top-level comment;
same doc-token and terminal rejection rules apply;
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
LARK_APP_ID=cli_test_app_id LARK_APP_SECRET=test_app_secret LARK_OWNER_OPEN_ID=ou_owner node --import tsx scripts/reply-doc-comment-smoke.ts
```

Expected: fails because `registerDocCommentTools` does not exist.

## Task 4: Implement Doc-Comment Tools

**Files:**
- Modify: `src/tools.ts`
- Mirror: `plugins/lark/src/tools.ts`

- [ ] **Step 1: Add structural doc-comment client**

Add:

```ts
interface DocCommentClient {
  drive: {
    fileCommentReply: {
      create: (req: any) => Promise<{ data?: { reply_id?: string } }>;
    };
    fileComment: {
      create: (req: any) => Promise<{ data?: { comment_id?: string } }>;
    };
  };
}
```

- [ ] **Step 2: Export `registerDocCommentTools`**

Register `reply_doc_comment` and `create_doc_comment` before the existing IM tools or at the top of `registerTools`.

Shared auth rules:

```ts
const caller = identitySession.getCaller(chat_id, thread_id);
if (!caller) return error('No active identity session...');
if (!chat_id.startsWith(DOC_CHAT_ID_PREFIX)) return error('chat_id must start with "doc:"');
if (doc_token !== chat_id.slice(DOC_CHAT_ID_PREFIX.length)) return error('doc_token mismatch...');
if (!content.trim()) return error('content cannot be empty');
```

Owner gate: use `appConfig.ownerOpenId`; this repo does not expose `identitySession.getOwner()`.

```ts
if (caller !== appConfig.ownerOpenId) {
  return { isError: true, content: [{ type: 'text', text: 'reply_doc_comment is owner-only.' }] };
}
```

Call Feishu:

```ts
await client.drive.fileCommentReply.create({
  path: { file_token: doc_token, comment_id },
  params: { file_type, user_id_type: 'open_id' },
  data: { content: { elements: buildCommentElements(content) } },
});
```

For `create_doc_comment`:

```ts
await client.drive.fileComment.create({
  path: { file_token: doc_token },
  params: { file_type, user_id_type: 'open_id' },
  data: { reply_list: { replies: [{ content: { elements: buildCommentElements(content) } }] } },
});
```

- [ ] **Step 3: Add raw HTTP adapter in `registerTools`**

Because typed SDK create methods may be missing, wrap `client.request`:

```ts
const docCommentClient: DocCommentClient = {
  drive: {
    fileCommentReply: {
      create: async (req) => client.request({
        method: 'POST',
        url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(req.path.file_token)}/comments/${encodeURIComponent(req.path.comment_id)}/replies`,
        params: req.params,
        data: req.data,
      }) as any,
    },
    fileComment: {
      create: async (req) => client.request({
        method: 'POST',
        url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(req.path.file_token)}/comments`,
        params: req.params,
        data: req.data,
      }) as any,
    },
  },
};
registerDocCommentTools({ server, client: docCommentClient, identitySession });
```

- [ ] **Step 4: Run focused test**

Run:

```bash
LARK_APP_ID=cli_test_app_id LARK_APP_SECRET=test_app_secret LARK_OWNER_OPEN_ID=ou_owner node --import tsx scripts/reply-doc-comment-smoke.ts
```

Expected: PASS.

## Task 5: Prompt, Docs, and Full Verification

**Files:**
- Modify: `src/prompts.ts`, `plugins/lark/src/prompts.ts`
- Modify: `README.md`, `README_CN.md`, `.env.example`, `plugins/lark/.env.example`
- Modify: `CHANGELOG.md`
- Modify: `scripts/test.sh`

- [ ] **Step 1: Update MCP prompt instructions**

Add `reply_doc_comment` and `create_doc_comment` to sensitive-tool guidance. Explicitly state:

```text
For doc-comment turns, pass chat_id="doc:<file_token>" and thread_id=<comment_id> verbatim from metadata. reply_doc_comment/create_doc_comment reject terminal context and any doc_token mismatch.
```

- [ ] **Step 2: Update test runner**

Add:

```bash
echo ""
echo "=== Comment event unit checks ==="
node --import tsx scripts/comment-event-smoke.ts

echo ""
echo "=== Doc comment tool unit checks ==="
node --import tsx scripts/reply-doc-comment-smoke.ts
```

- [ ] **Step 3: Update docs**

Document scopes:

```markdown
| `docs:document.comment:read` | Pre-fetch doc-comment bodies |
| `docs:document.comment:create` | Reply/create doc comments |
```

Document event:

```markdown
`drive.notice.comment_add_v1` — receive doc-comment notifications when @mentioned.
```

Document tools:

```markdown
| `reply_doc_comment` | Reply to the triggering Feishu doc-comment thread. |
| `create_doc_comment` | Create a new top-level comment in the triggering document. |
```

- [ ] **Step 4: Verify everything**

Run:

```bash
npm test
npm run build
(cd plugins/lark && npm run build)
npm run --silent start -- --dry-run
(cd plugins/lark && npm run --silent start -- --dry-run)
npm --cache /private/tmp/codex-npm-cache run audit:deps
diff -qr src plugins/lark/src
git diff --check
```

Expected: all pass.

## Self-Review

- Spec coverage: event subscription, @bot/self filters, context fetch, synthetic doc chat/thread, identity binding, tools, doc-token binding, doc-comment whitelist, and smoke tests are covered by Tasks 1-5.
- Placeholder scan: no task uses TBD/TODO language; each task names files and exact expected commands.
- Type consistency: `DOC_CHAT_ID_PREFIX`, `CommentEventDeps`, `registerDocCommentTools`, `reply_doc_comment`, and `create_doc_comment` names are consistent across tasks.
