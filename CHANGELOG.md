# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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

[Unreleased]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.0
