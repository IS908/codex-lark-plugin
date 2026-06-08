# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed
- Generated Feishu cards now use the `red` header theme, and LLM-facing guidance tells Codex to prefer plain text and use cards sparingly.
- README guidance now documents when to force `format='card'` versus keeping plain text.

## [1.0.10] - 2026-06-08

### Added
- Feishu doc-comment @bot events now route into Codex using synthetic `doc:<file_token>` chats, preserving selected text, parent comment, reply body, document title, caller identity, whitelist checks, and duplicate-event filtering.
- `reply_doc_comment` and `create_doc_comment` MCP tools for owner-scoped replies/new top-level comments in the triggering document, with strict `doc_token` binding against prompt-injected cross-document writes.
- Default `exec` delivery now posts Codex's final answer back to the triggering doc-comment thread instead of treating `doc:<file_token>` as a Feishu IM chat id.
- Smoke tests for doc-comment event routing, SDK payload shape, selected-text/reply degradation, identity binding, whitelist behavior, tool authorization, doc-token mismatches, empty content, and Feishu permission failures.

## [1.0.9] - 2026-06-08

### Added
- Quoted interactive card extraction now surfaces safe visible card text from parent/root messages, including titles, markdown/plain text, localized CardKit content, summaries, button labels, and `div.extra` accessories.
- Smoke tests covering quoted-card fallback, unsafe payload filtering, localized card text, Lark markdown tag sanitization, parent quote integration, and root-only quoted context.

### Fixed
- Malformed or unsupported interactive card payloads now fall back to `[Interactive Card]` instead of exposing raw JSON.
- Quoted-card extraction skips action payloads, callback values, URLs, raw IDs, confirmation payloads, and other machine-only fields while preserving user-visible labels.

## [1.0.8] - 2026-06-08

### Added
- Mechanical reply-obligation tracking for inbound Lark IM turns, with `reply`, `react`, `edit_message`, `download_attachment`, and `defer_reply` as turn satisfiers.
- Line-scoped `[LARK_DEFER]` / `[LARK_NO_REPLY]` parsing for exec-mode assistant text, ignoring code-block spoofing.
- `defer_reply` MCP tool for explicit no-reply/deferred turns with audit logging.
- Smoke tests covering normal replies, missing replies, explicit defers, code-block spoofing, notification fallback ambiguity, active-turn routing, and watchdog audit behavior.

### Fixed
- Omitted `reply_to` fallback now prefers the active queued turn, auto-fills only when exactly one pending turn matches, and rejects ambiguous notification-mode turns instead of replying to the wrong interleaved message.

## [1.0.7] - 2026-06-08

### Fixed
- Hardened ack reaction lifecycle tracking so revoke-before-set races delete late ack reactions instead of leaking them.
- Successful replies, reactions, and attachment downloads now satisfy the originating turn and revoke its ack reaction, including partial multi-message replies after the first visible bot response.
- Active ack reaction handles now survive inbound TTL cleanup so long-running turns can still revoke their Feishu reaction ids.
- Bot-sent message tracking now includes chat/thread metadata across reply and scheduler direct-send paths, improving reaction filtering for passive emoji feedback.

### Added
- Ack lifecycle smoke tests covering late set, create failure, revoke partial failure, stale/non-inbound gating, active-handle TTL/cap behavior, partial reply failure, and non-text satisfiers.

## [1.0.6] - 2026-06-08

### Fixed
- Hardened scheduled jobs against overlapping scheduler ticks, runtime/user-edit write races, stale missed-run replay, and permanent Feishu target errors.
- Prompt cronjob delivery failures now persist an explicit defer/no-reply signal, and permanent reply failures from cronjob turns can auto-pause the originating job.

### Changed
- Friendly `every Nm` / `every Nh` schedule aliases now reject empty, out-of-range, or non-dividing intervals with specific validation errors.

## [1.0.5] - 2026-06-08

### Added
- Daemon resource governance for PID/start-time locks, rotating debug/audit logs, inbox garbage collection, bounded caches, and episode pruning.
- Smoke tests covering lock reuse, live lock rejection, log rotation, inbox LRU cleanup, identity-session caps, and episode pruning.

### Changed
- Startup now schedules inbox and episode cleanup without blocking the Feishu WebSocket connection path.
- MCP server metadata version now matches the current package release.

## [1.0.4] - 2026-06-07

### Added
- Shared Feishu API retry/timeout wrapper with bounded exponential backoff.
- Config flags for Feishu API timeout/retry tuning and download byte/time limits.
- Dependency audit gate via `npm run audit:deps`.

### Changed
- Hot-path Feishu calls for replies, edits, reactions, attachment/image downloads, metadata lookups, and scheduler sends now use the shared retry wrapper.
- Attachment/image downloads stream to disk through a temp file with byte caps and cleanup on timeout or oversize failures.
- Patched transitive dependency versions are pinned with npm overrides so `npm run audit:deps` passes without downgrading the Lark SDK.
- Feishu message sends include idempotency `uuid` values, and timeout retries are disabled for non-idempotent writes/uploads.
- The marketplace wrapper package now carries the same dependency audit gate and patched overrides as the root package.
- npm dry-run packages now use explicit ignore files to avoid stale generated artifacts.
- Write-file-only SDK download fallbacks now require a preflight `content-length` before writing so byte caps are not bypassed.

## [1.0.3] - 2026-06-07

### Added
- `LARK_MAX_EPISODE_BYTES` to cap persisted episode file size.

### Changed
- Memory, quote, flush, cronjob, and L2 privacy-rule prompt inputs are escaped and wrapped as untrusted data.
- Same-user profile operations are serialized to avoid migration/write/delete races.

### Fixed
- Default Codex exec delivery now wraps Feishu display data, quotes, attachments, and current messages as escaped untrusted data.
- Cron job names are now treated as untrusted prompt data, and cron routing chat ids reject control characters.
- Direct public profile writes now apply the L1 privacy safety net and route sensitive spillover to the private tier.
- Direct public profile writes now also apply deterministic L2 always-private spillover.
- Episode persistence now respects the configured UTF-8 byte cap without splitting multi-byte characters.
- L2 privacy rule additions now reject empty, multiline, heading-like, over-broad, or oversized rules.

## [1.0.2] - 2026-06-06

### Fixed
- User emoji reactions on bot replies are now treated as passive feedback and ignored after filtering, preventing confusing "missing original message" follow-up replies.

## [1.0.1] - 2026-06-06

### Added
- Codex exec delivery now preserves multi-turn context by storing one Codex session id per Feishu `chat_id` / `thread_id` and resuming it with `codex exec resume` on later messages.
- `LARK_CODEX_EXEC_USE_SESSIONS` config flag, defaulting to `true`, to opt out of Codex session resume behavior when needed.
- Local Codex exec session mapping files under `~/.codex/channels/lark/codex-sessions/`.

### Changed
- Exec prompts now tell Codex that the turn may be part of a resumed session for the same Feishu chat/thread.
- `$lark:configure`, `.env.example`, and bilingual README docs now describe the exec session behavior.

### Fixed
- If a stored Codex session id is stale or missing, exec delivery retries once with a fresh Codex session and overwrites the stored mapping.

## [1.0.0] - 2026-06-06

### Added
- Initial public release of Codex Lark Plugin.
- Feishu/Lark WebSocket channel integration for receiving direct messages, group @mentions, rich messages, attachments, and reactions.
- Codex reply tooling for text, cards, message edits, emoji reactions, image uploads, file uploads, and attachment downloads.
- Local memory system with conversation buffer, episodic markdown memories, tiered public/private user profiles, privacy rules, memory transparency, and audit logging.
- Scheduled jobs with cron expressions, friendly schedule aliases, crash recovery, owner-scoped updates, and chat-aware visibility filtering.
- One-shot `codex exec` delivery mode for running Codex from a persistent Lark bridge process.
- Codex plugin metadata, MCP configuration, Lark skills, bilingual README documentation, and GitHub publishing guidance.

[Unreleased]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.10...HEAD
[1.0.10]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.0
