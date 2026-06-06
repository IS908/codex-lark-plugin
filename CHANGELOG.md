# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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

[1.0.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/IS908/codex-lark-plugin/releases/tag/v1.0.0
