# channel SDK unification plan

This document records the current plan for using the public
`@larksuite/channel` package in `codex-lark-plugin`.

The plugin remains Codex only. This plan does not add Claude support, does not
move memory out of local files, and does not change the Feishu/Lark event stream
as the caller identity trust anchor.

## Decision

Be aggressive: make the channel SDK the unified Lark transport facade for both
receive and send paths, and move quickly through one broad migration branch.

The migration target is not to move product ownership into the SDK. The target
is narrower and more useful:

- all Lark I/O should enter through `@larksuite/channel` public methods where
  they have parity;
- operations not yet covered by public SDK methods should go through
  `channel.rawClient` inside a small SDK transport adapter, not through scattered
  direct `@larksuiteoapi/node-sdk` calls;
- Codex-specific behavior stays local: identity, tools, memory, jobs, audit,
  reply obligations, retry policy, prompt hardening, and rollback control.

This is intentionally a fast trial/fix plan. Prefer a single end-to-end SDK
transport pass with strong smoke coverage over a long sequence of tiny
pre-migration adapter PRs. Keep rollback cheap, then repair parity gaps as they
appear.

## Current Split

As of v1.3.0:

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
  not the production send path yet.

## Target Shape

Create a single local `LarkTransport` boundary owned by this plugin:

- inbound events: `@larksuite/channel` normalized events;
- chat send/edit/reaction/upload/download/fetch: `@larksuite/channel` public
  methods first;
- doc comments and missing APIs: `channel.comments` first, then
  `channel.rawClient` escape hatches inside the transport boundary;
- local control plane: unchanged.

The important rule is: call sites such as `reply`, `edit_message`, scheduler,
doc-comment tools, and ack cleanup should talk to this local transport boundary.
They should not know whether a particular operation used a public SDK method or
the SDK's raw client escape hatch.

## Capability Matrix

| Operation | One-shot SDK target | Known caveat |
| --- | --- | --- |
| Inbound message/comment/reaction events | Already SDK default. Keep mapping into local `LarkMessage`. | Local identity binding remains mandatory before any Codex turn. |
| P2P/group gating | Keep local semantics after SDK normalization. | SDK policy hooks may prefilter later, but local allowlist and precise mention rules stay authoritative. |
| Server-derived identity | Keep local `IdentitySession`. | SDK supplies authenticated event identity only; it must not own tool authorization. |
| Normal chat reply: text | Use `channel.send({ text }, { replyTo, replyInThread })`. | Preserve `reply_to` auto-fill, text chunking, ack revoke, buffer recording, bot tracking, and cron auto-pause. |
| Markdown/card-rendered replies | Keep local `buildCards()` policy, send cards through `channel.send({ card })`. | Visual parity and split ordering must be tested. |
| Raw Schema 2.0 card reply | Send parsed card object through `channel.send({ card })`. | Preserve raw-card bypass semantics and reply-thread routing. |
| Long text and card splitting | Keep local split policy, send every chunk/card through SDK transport. | Track `messageId` and `chunkIds` in `BotMessageTracker`. |
| Thread/root/reply routing | Local code decides `replyTo` and `replyInThread`; SDK performs send. | Root-only and threaded reply smoke tests are required. |
| Message create vs reply fallback | Use SDK send first; map SDK fallback/error results back to local status. | Do not hide target-routing changes behind SDK fallback behavior. |
| Edit message | Use `editMessage()` for text and `updateCard()` for card edits. | Preserve current `card_markdown` edit behavior; use `rawClient` inside transport if needed. |
| Add message reaction | Use `addReaction()`. | Explicit `react` tool and receive-time ack can share transport. |
| Delete ack reaction | Use SDK `removeReaction()` by reaction id where possible. | If SDK delete semantics differ, use `rawClient` inside transport and keep id-based lifecycle. |
| `defer_reply` | Keep local only. | No Lark send is needed; only turn obligation and ack cleanup matter. |
| Image/file upload and follow-up sending | Use `channel.send({ image })` / `channel.send({ file })` with local paths or Buffers. | Preserve thread follow-up routing, failure logging, and bot tracking. |
| Attachment download | Keep SDK `downloadResource()` plus local `writeSdkResource()` caps. | Byte/time caps remain local. |
| Quoted interactive card context | Use SDK `fetchMessage()` first, then fallback through transport raw-client `message.get` / `messages/mget` when SDK content is missing or placeholder-only. | Shipped as best-effort raw context through `LarkTransportCardContext.fetchMessageText()`; keep placeholder-only smoke coverage. |
| Doc-comment mention handling | Keep SDK comment event and SDK `channel.comments.resolveTarget()` / `fetch()` for selected-text context. | Preserve `doc:<file_token>` identity, selected text, document title, and raw-event fallback. |
| Doc-comment reply/create | Keep raw Drive OpenAPI behind `LarkTransport` for now. | SDK `comments.reply()` returns no `reply_id` and may fall back to top-level comments; top-level create still needs raw `comment_id` semantics. |
| Scheduler direct-message delivery | Route through SDK transport. | Preserve deterministic run behavior where possible; if SDK lacks uuid control, document the tradeoff or use raw client inside transport. |
| Cron prompt execution | In `exec` mode, route through the scheduler prompt runner and the same `codex exec` delivery path as chat messages; keep MCP `notifications/Codex/channel` only as the legacy `notification` mode fallback. | Prevents prompt cronjobs from timing out after the host acknowledges a notification without starting a real Codex exec turn. |
| Error taxonomy and retries | Map `LarkChannelError` and raw-client errors into local retry/permanent-failure decisions. | Scheduler auto-pause and reply failures depend on this. |
| SDK logging / MCP stdout safety | Keep injected stderr-only SDK logger. | Non-negotiable: stdout belongs to MCP JSON-RPC. |
| Marketplace/cache packaging | Keep Codex plugin release flow. | Validate installed cache after migration. |

## Quoted Interactive Cards

The quoted-card path is now handled through the local transport boundary rather
than separate legacy and SDK parsing branches.

Legacy inbound handling fetches quoted parent/root messages via
`client.im.v1.message.get`, extracts text by message type, and for interactive
messages calls `extractInteractiveCardText(rawContent)`. If the fetched content
is only a placeholder, such as `[Interactive Card]`, a compact `<card>` shell, an
upgrade-client message, or empty interactive text, legacy handling calls
`fetchCachedCardContext()` and then `/open-apis/im/v1/messages/mget` as a second
fetch path.

The SDK inbound path selects the same quoted message id order (`parentId`,
distinct `rootMessageId`, distinct open-message `threadId`) and then calls the
transport `fetchMessageText()` boundary. In the SDK-backed transport,
`LarkTransportCardContext.fetchMessageText()` now prioritizes event/cache
context, then bot-identity `messages/mget` raw card content, then the optional
user-identity `lark-cli im +messages-mget --as user` fallback. SDK
`fetchMessage()` and raw `message.get` remain compatibility fallbacks when the
raw-card mget paths are unavailable, but they no longer run before bot/user mget
for quoted Interactive Card hydration.

## Risk Classification

| Risk | Severity | Reversibility | Fast-fix posture |
| --- | --- | --- | --- |
| Quoted interactive card readability regresses to placeholders | Medium | Easy | Preserve cache -> bot mget -> user mget fallback smoke coverage. |
| Thread/root reply routing changes | High | Medium | Keep local routing decisions, add root-only/threaded smoke tests, rollback via legacy runtime if live trial fails. |
| Scheduler permanent-failure auto-pause stops working | High | Medium | Map SDK/raw errors into existing permanent-failure logic before enabling scheduler transport. |
| SDK fallback hides raw Feishu error codes | Medium | Medium | Wrap SDK errors into local error taxonomy with original cause attached. |
| Doc-comment authorization or token binding changes | High | Medium | Keep local tool auth and audit untouched; only swap transport under the boundary. |
| SDK logger writes to stdout | High | Easy | Keep explicit stderr logger in every SDK constructor. |
| SDK send lacks uuid/idempotency knobs for scheduler | Medium | Medium | Use rawClient inside transport for scheduler if deterministic uuid cannot be preserved. |
| One broad PR creates noisy diff | Medium | Easy | Accept initially; rely on smoke tests and focused self-review by workflow area. |

## Implementation Path

1. Introduce a local `LarkTransport` interface with SDK-backed implementation.
2. Store the live SDK channel on startup and expose it to tools, reply sender,
   scheduler, ack cleanup, and doc-comment helpers through that transport.
3. Move chat reply, edit, reaction, ack delete, attachment upload/download,
   parent/root fetch, doc-comment operations, and scheduler direct sends behind
   the SDK transport boundary in one migration branch.
4. Use public `@larksuite/channel` APIs first; use `channel.rawClient` only
   inside the transport for missing parity such as `messages/mget`, deterministic
   scheduler uuid, or doc-comment return ids.
5. Keep rollback at the package level after SDK unification; do not reintroduce
   a runtime selector or hidden legacy flag.
6. Run a fast trial loop: merge only after smoke/dry-run passes, deploy
   internally, capture regressions as small fixes, and cut patch releases as
   needed.

## Validation Checklist

- `npm run smoke:sdk`
- `npm test`
- `npm run typecheck`
- `cd plugins/lark && npm run typecheck`
- default SDK dry-run from workspace and installed plugin cache
- config validation proving stale `LARK_CHANNEL_RUNTIME=legacy` fails loudly
  while stale `LARK_CHANNEL_RUNTIME=sdk` remains a harmless no-op
- manual internal Lark checks for:
  - owner P2P reply;
  - group `@bot` reply;
  - threaded reply;
  - quoted parent interactive card;
  - quoted root interactive card;
  - placeholder-only quoted card fallback;
  - doc-comment mention and reply/create;
  - explicit `reply`, `edit_message`, `react`, and `defer_reply`;
  - image/file upload and download;
  - scheduled direct-message delivery;
  - permanent-target auto-pause;
  - one Codex exec resumed session across multiple turns.

## Conclusion

The working strategy is now aggressive SDK unification, not conservative
coexistence. Use the channel SDK as the single Lark transport facade, keep local
Codex ownership above that facade, and use raw-client escape hatches only inside
the transport boundary when the public SDK surface lacks exact parity.
