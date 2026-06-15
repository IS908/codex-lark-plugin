# channel SDK migration boundary

This document records the current boundary for using the public
`@larksuite/channel` package in `codex-lark-plugin`.

The plugin remains Codex only. This plan does not add Claude support, does not
move memory out of local files, and does not change the Feishu/Lark event stream
as the caller identity trust anchor.

## Decision

As of v1.3.0, keep a hybrid runtime:

- use `@larksuite/channel` as the default inbound live runtime for Lark message,
  comment, reaction, reject, and error events;
- use selected SDK helpers where parity is clear, such as receive-time ack
  reactions, received-resource download, parent/root message fetch, and comment
  context fetch;
- keep primary outbound behavior on the explicit Feishu OpenAPI client from
  `@larksuiteoapi/node-sdk` until each outbound operation has proven parity with
  the local control plane.

Do not pursue a one-shot "all send and receive through the channel SDK" rewrite.
The channel SDK exposes useful outbound APIs, but this plugin's send path also
owns Codex-specific routing, reply obligations, ack cleanup, bot-message
tracking, scheduled-job auto-pause, auditability, and local memory/job
boundaries. Those concerns must stay local even when an SDK method is used as
the transport.

## Current Split

- SDK inbound runtime starts from `src/index.ts` via `startSdkChannelRuntime()`.
- SDK event bridging lives in `src/sdk-channel-runtime.ts`.
- SDK-to-local message mapping lives in `src/sdk-channel-parity.ts` and
  `src/sdk-channel-identity.ts`.
- Inbound SDK helper usage lives in `src/channel.ts`:
  `addReaction()`, `downloadResource()`, `fetchMessage()`, and
  `channel.comments`.
- Primary chat replies, edits, reactions, doc-comment replies, file upload, and
  scheduler direct messages still use the explicit OpenAPI client through
  `src/reply-sender.ts`, `src/tools.ts`, and `src/scheduler.ts`.
- The lightweight `src/sdk-channel-outbound.ts` helpers are parity scaffolding,
  not the production send path.

## Capability Matrix

| Operation | Current owner | Channel SDK support | Recommendation |
| --- | --- | --- | --- |
| Inbound message/comment/reaction events | `@larksuite/channel` runtime plus local adapter | Supported | Keep SDK default. Keep mapping into `LarkMessage` local and identity-bound. |
| P2P/group gating | Local adapter after SDK normalization | SDK has policy hooks, local semantics are stricter | Keep local allowlist and precise mention semantics as the source of truth. |
| Server-derived identity | Local `IdentitySession` | Not an SDK responsibility | Keep local. SDK events only provide authenticated input identity. |
| Normal chat reply: text | `sendFeishuReply()` via OpenAPI | `channel.send({ text })` supported | Candidate only behind an adapter that preserves `reply_to` auto-fill, chunking, ack revoke, buffer recording, bot tracking, and cron auto-pause. |
| Markdown/card-rendered replies | Local `buildCards()` plus OpenAPI `interactive` messages | `send({ markdown })` and `send({ card })` supported | Keep local card builder until visual/card-split parity is proven. |
| Raw Schema 2.0 card reply | OpenAPI `message.reply/create` with `msg_type=interactive` | `send({ card })` likely supports object cards | Candidate, but must preserve raw-card bypass semantics and reply-thread routing. |
| Long text and card splitting | Local chunk/card splitting | SDK `send()` returns chunk ids, but local split policy differs | Keep local policy. SDK can be the transport only after exact count/order/track behavior is tested. |
| Thread/root/reply routing | Local `reply_to`, `thread_id`, `latestMessageTracker`, `TurnObligationTracker` | `SendOptions.replyTo` and `replyInThread` supported | Keep local routing decisions. SDK transport is acceptable only after root-only and threaded reply parity tests. |
| Message create vs reply fallback | Local `sendFollowup()` chooses reply/create | SDK has fallback behavior for some errors | Keep local intent explicit; do not let SDK fallback hide target routing changes without tests. |
| Edit message | OpenAPI `message.patch` | `editMessage()` and `updateCard()` supported | Candidate for small PR. Must preserve `card_markdown` edit behavior and turn satisfaction. |
| Add message reaction | OpenAPI `messageReaction.create`; SDK ack already uses `addReaction()` | `addReaction()` supported | Candidate for explicit `react` tool, but ack lifecycle must keep reaction ids for delete. |
| Delete ack reaction | OpenAPI delete by reaction id | `removeReaction()` or `removeReactionByEmoji()` supported | Keep current id-based delete unless SDK id-based delete parity is wired and tested. |
| `defer_reply` | Local turn-obligation and ack cleanup only | No Lark send needed | Keep local. It is not an SDK transport concern. |
| Image/file upload and follow-up sending | OpenAPI upload plus follow-up message send | `send({ image })`, `send({ file })` supported with SSRF guard | Candidate only if local file path/Buffer behavior, thread follow-up routing, failure logging, and bot tracking stay identical. |
| Attachment download | SDK helper in inbound path plus local byte/time caps | `downloadResource()` supported | Keep SDK helper, but local `writeSdkResource()` caps remain mandatory. |
| Quoted interactive card context | Legacy OpenAPI `message.get` plus `messages/mget` fallback; SDK path currently only `fetchMessage()` | `fetchMessage()` supported, raw card parity unclear | Do not make SDK-only. Add fallback if `fetchMessage()` returns placeholders such as `[Interactive Card]`. |
| Doc-comment mention handling | SDK event plus local fallback to raw event when available | `comment` event and `channel.comments.fetch()` supported | Keep hybrid. Preserve `doc:<file_token>` identity and selected-text context. |
| Doc-comment reply/create | OpenAPI tools with local authorization and audit | `channel.comments.reply()` supports reply/top-level fallback; top-level create coverage is narrower | Candidate for reply only after token/thread authorization, audit args, whole-doc fallback, and error messages match. Keep create on OpenAPI unless SDK has exact top-level semantics. |
| Scheduler direct-message delivery | OpenAPI `message.create` with deterministic uuid and retry policy | `send()` supported | Keep OpenAPI for now. Scheduler retry, permanent-target auto-pause, and run metadata are more important than transport unification. |
| Cron prompt injection | MCP `notifications/Codex/channel` | Not SDK-owned | Keep local. |
| Error taxonomy and retries | `feishuApiCall()` local wrapper | SDK exposes `LarkChannelError` stable codes | Do not replace wholesale. Map SDK errors into local retry/permanent-failure behavior first. |
| SDK logging / MCP stdout safety | Local SDK logger wrappers | SDK accepts logger | Keep local stderr-only logger requirement. |
| Marketplace/cache packaging | Codex plugin metadata and release workflow | Not SDK-owned | Keep local. |

## Quoted Interactive Cards

The quoted-card path is the clearest known inbound gap after making SDK runtime
the default.

Legacy inbound handling fetches quoted parent/root messages via
`client.im.v1.message.get`, extracts text by message type, and for interactive
messages calls `extractInteractiveCardText(rawContent)`. If the fetched content
is only a placeholder, such as `[Interactive Card]`, a compact `<card>` shell, an
upgrade-client message, or empty interactive text, legacy handling calls
`fetchCachedCardContext()` and then `/open-apis/im/v1/messages/mget` as a second
fetch path.

The SDK inbound path currently selects the same quoted message id order
(`parentId`, distinct `rootMessageId`, distinct open-message `threadId`), but it
only calls `sdkChannel.fetchMessage(quotedMessageId)` and assigns
`normalizeFetchedMessageText(parent.content)`. It does not currently run the
legacy `needsCardContextFetch()` plus `messages/mget` fallback.

Therefore, if a quoted interactive card only appears as `[Interactive Card]`,
the runtime probably only had placeholder text at that stage. Real visible card
text depends on whether parent/root message fetch successfully returns the raw
interactive card JSON needed for extraction. If `fetchMessage()` returns only a
placeholder, SDK inbound must keep an OpenAPI `messages/mget` fallback or use a
future SDK raw-message fetch surface.

The concrete SDK fallback parity fix is tracked in #76.

## Risk Classification

| Risk | Severity | Reversibility | Notes |
| --- | --- | --- | --- |
| Quoted interactive card readability regresses to placeholders | Medium | Easy | Fixable with fallback. User-visible but not data-lossy. |
| Thread/root reply routing changes | High | Medium | Can send replies into the wrong place. Requires strong smoke and manual tests. |
| Scheduler permanent-failure auto-pause stops working | High | Medium | Can repeatedly fail scheduled jobs instead of pausing bad targets. |
| SDK fallback hides raw Feishu error codes | Medium | Medium | Could weaken operator debugging and retry decisions. |
| Doc-comment authorization or token binding changes | High | Medium | Sensitive because doc-comment tools are scoped to current `doc:<file_token>` turns. |
| SDK logger writes to stdout | High | Easy | Would corrupt MCP stdio framing. Always inject stderr logger. |
| Full outbound rewrite spans too many behaviors | High | Hard | Avoid. Use small transport-adapter PRs only after parity tests exist. |

## Recommended Implementation Path

1. Keep SDK inbound as the default and keep `LARK_CHANNEL_RUNTIME=legacy` as the
   rollback path.
2. Fix SDK quoted interactive-card fallback first, because it is an inbound
   parity issue in the default runtime.
3. If outbound migration is still desired, create small opt-in adapter PRs in
   this order:
   - explicit `react` tool via SDK `addReaction()`;
   - `edit_message` text-only via SDK `editMessage()`;
   - plain text reply transport behind a feature flag, while preserving local
     routing, ack, bot tracking, and reply obligation logic.
4. Do not move scheduler delivery, doc-comment create/reply, file uploads, or
   card-split replies until the smaller adapters prove parity.
5. Do not remove OpenAPI/raw-client escape hatches while SDK parity for quoted
   cards, doc comments, uploads, and error taxonomy is still partial.

## Validation Checklist

- `npm run smoke:sdk`
- `npm test`
- `npm run typecheck`
- `cd plugins/lark && npm run typecheck`
- default SDK dry-run from workspace and installed plugin cache
- explicit `LARK_CHANNEL_RUNTIME=legacy` dry-run from workspace and installed
  plugin cache
- manual internal Lark checks for:
  - owner P2P reply;
  - group `@bot` reply;
  - threaded reply;
  - quoted parent interactive card;
  - quoted root interactive card;
  - placeholder-only quoted card fallback;
  - doc-comment mention and reply;
  - explicit `reply`, `edit_message`, `react`, and `defer_reply`;
  - scheduled direct-message delivery and permanent-target auto-pause.

## Conclusion

`@larksuite/channel` is suitable as the inbound runtime and as a transport
candidate for narrow outbound operations. It should not become the single owner
of all Lark send/receive behavior in one migration. The durable boundary is:
SDK for normalized Lark transport where parity is proven; local plugin code for
Codex identity, tools, memory, jobs, audit, reply obligations, retry policy, and
rollback control.
