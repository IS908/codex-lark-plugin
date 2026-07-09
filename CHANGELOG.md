# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.15.5] - 2026-07-10

### Fixed
- Shipped a checked-in bundled runtime for the Lark plugin wrapper so Codex plugin cache startup no longer depends on `node_modules` or `tsx` being present.
- Added a no-`node_modules` runtime-package smoke test to guard MCP startup from regressing before the `initialize` response.

## [1.15.4] - 2026-07-10

### Fixed
- Kept MCP stdio startup alive when the Lark SDK runtime cannot initially resolve or reach Feishu, retrying the channel connection in the background and starting channel-dependent services only after the runtime connects.

## [1.15.3] - 2026-07-09

### Fixed
- Hid stale `next_run_at` values from paused cronjob update receipts, list output, and codex exec job actions while preserving active-job next-run formatting.

## [1.15.2] - 2026-07-08

### Added
- Added monthly gzip archival and retention for local debug/audit/trace logs.

### Changed
- Moved default debug/audit/trace log paths under `~/.codex/channels/lark/logs/` instead of placing loose log files in the channel root.
- Documented log archive retention and ignore patterns for custom project/workdir log paths.

## [1.15.1] - 2026-07-07

### Removed
- Removed provider-specific GitHub issue/proposal/low-risk PR MCP tools and codex exec actions from the core Lark plugin boundary.
- Removed the built-in `plugin-self-review` and `plugin-low-risk-auto-fix` preset job creator; external project-governance workflows should be configured through user skills, custom MCP tools, or allowlisted `run_local_cli_tool` wrappers.
- Removed `LARK_GITHUB_*` configuration fields and obsolete issue-proposal smoke coverage.

## [1.15.0] - 2026-07-07

### Added
- Added direct `create_github_issue` MCP and codex exec actions for explicitly authorized GitHub issue filing, keeping proposal approval as a separate periodic-review policy path.

## [1.14.0] - 2026-07-06

### Added
- Added a low-priority Lark/Feishu reply presentation guideline so longer replies prefer lightweight Markdown structure while preserving short replies, code, logs, JSON, diffs, command output, action blocks, and explicit user formatting.

## [1.13.1] - 2026-07-06

### Fixed
- Restored local diagnostic logs to compact human-readable text lines instead of JSONL.
- Added codex exec trace log ids so ordinary message-triggered turns use the source message id and cronjob prompt turns use the cronjob name.
- Kept trace/audit redaction, truncation, and rotating append behavior while updating smoke coverage and docs for the text-line format.

## [1.13.0] - 2026-07-06

### Changed
- Changed `audit.log` from whitespace-delimited text to JSONL records with `at`, `kind`, `tool`, `outcome`, `caller`, and redacted `args` fields.
- Added `kind: "trace"` to codex exec tool trace records so local diagnostic logs share a common JSONL envelope.
- Documented the canonical local diagnostic JSONL format and clarified audit/trace rotation settings.

## [1.12.5] - 2026-07-06

### Changed
- Removed the legacy `LARK_CODEX_DELIVERY_MODE=notification` delivery path. Chat, doc-comment, reaction, and cron prompt turns now always use codex exec delivery.
- Kept stale `LARK_CODEX_DELIVERY_MODE=exec` as a harmless no-op for upgrade compatibility, while `LARK_CODEX_DELIVERY_MODE=notification` now fails config validation and points operators to package downgrade rollback.
- Updated scheduler prompt-job execution so missing prompt runners produce explicit Feishu error reports instead of falling back to MCP channel notifications.

### Removed
- Removed the `notifications/Codex/channel` delivery branch, channel notification metadata builder, and notification delivery smoke coverage.

## [1.12.4] - 2026-07-06

### Changed
- Removed the pre-SDK channel runtime selector and legacy WebSocket startup path. The SDK channel runtime is now the only live runtime.
- Kept stale `LARK_CHANNEL_RUNTIME=sdk` as a harmless no-op for upgrade compatibility, while `LARK_CHANNEL_RUNTIME=legacy` now fails config validation and points operators to package downgrade rollback.

### Removed
- Removed the legacy raw message normalizer, legacy reaction event mapper, and legacy inbound image-download branch that were only used by the pre-SDK runtime.

## [1.12.3] - 2026-07-06

### Changed
- Extracted issue proposal lifecycle logic into `issue-proposal-service`, making MCP issue proposal tools and codex exec issue proposal actions thin adapters over the same visibility, mutation authorization, GitHub issue filing, and low-risk PR creation paths.

### Added
- Added `issue-proposal-lifecycle-parity-smoke` coverage to compare persisted proposal state, list visibility, authorization failures, and rejection behavior across MCP and exec surfaces.

## [1.12.2] - 2026-07-06

### Changed
- Extracted shared cronjob lifecycle logic into `job-service`, making MCP job tools and codex exec job actions thin adapters over the same visibility, reference resolution, owner check, schedule parsing, create/update/delete persistence, and runtime initialization paths.

### Added
- Added `job-lifecycle-parity-smoke` coverage to compare persisted job state across MCP create/update and exec create/upsert surfaces.

## [1.12.1] - 2026-07-06

### Fixed
- Unified new cronjob runtime initialization across MCP `create_job`, exec `create_job` / `upsert_job`, and default review presets so all creation paths persist the same diagnostic runtime schema.

## [1.12.0] - 2026-07-06

### Changed
- Replaced the visible `codex exec` action marker protocol with a required parent-owned JSONL side channel for structured Lark actions, so stdout is always user-visible reply text and malformed action requests fail through the side-channel diagnostics.

### Added
- Added side-channel retention cleanup and smoke coverage for action file permissions, token/schema validation, identity-field rejection, action ordering, and stale turn cleanup.

## [1.11.1] - 2026-07-06

### Fixed
- Tightened `codex exec` action-block parsing so ordinary reports that mention `<LARK_ACTIONS_JSON>` inline, inside code fences, after trailing text, or without a closing marker are delivered as normal text instead of parser errors.
- Mark cronjob runs with complete but invalid action blocks as failed reports and preserve the original Codex output tail in diagnostics instead of sending `Invalid Lark action block` as a successful scheduled-job result.

## [1.11.0] - 2026-07-06

### Added
- Added optional local `codex exec --json` tool execution tracing with `LARK_CODEX_EXEC_TOOL_TRACE`, `LARK_CODEX_EXEC_TOOL_TRACE_MODE`, and `LARK_CODEX_EXEC_TRACE_LOG`.
- Added sanitized compact/full/hidden trace modes for tool events without rendering tool traces into Feishu replies.

## [1.10.2] - 2026-07-06

### Fixed
- Bound quoted-message fetch/download transport methods before invoking them so `send_message` with `quoted_message:first_image` keeps the `LarkTransport` instance context.

## [1.10.1] - 2026-07-06

### Added
- Added `quoted_message:first_image` as a `send_message` image source for single-image and rich text+image exec replies.

### Fixed
- Preserved quoted message image attachment metadata during message hydration so exec media actions can download and re-upload quoted images with the plugin runtime identity.

## [1.10.0] - 2026-07-06

### Added
- Added ordered `kind=rich` `send_message` payloads for `codex exec`, supporting text plus image parts with Feishu post delivery and ordered split fallback.
- Documented the outbound message support matrix and unsupported fallback behavior for text, rich post, image, file, audio/video, and interactive card forms.

### Changed
- Expanded exec media reply validation so rich payloads verify that all referenced image parts were delivered.
- Tightened `send_message` payload parsing so unsupported media kinds are rejected instead of silently degrading.

## [1.9.8] - 2026-07-06

### Added
- Added the first `codex exec` structured `send_message` media action for plugin-owned image/file replies, supporting local paths and the current inbound message's first downloaded image.

### Fixed
- Avoid sending an empty text message before media-only image/file replies, and count uploaded attachment messages in reply results.

## [1.9.7] - 2026-07-06

### Changed
- Removed built-in `gh` CLI compatibility from approved issue proposal filing; the built-in path now uses token-backed GitHub HTTP only, while host-local issue creation commands must be explicitly configured through `local-cli-tools.json`.
- Clarified issue proposal action prompts, docs, `.env.example`, and configure skill text so `tool` overrides are configured local tool names, not raw executable names.

### Fixed
- Added regression coverage to reject raw `tool: "gh"` issue filing overrides and to keep failed proposal filing attempts auditable.

## [1.9.6] - 2026-07-04

### Added
- Added structured diagnostics for prompt cronjob Codex exec runs, including run metadata, observable stage timings, diagnostic-only progress snapshots, redacted stdout/stderr tails on exec failures, and persisted runtime diagnostics for timeout triage.

## [1.9.5] - 2026-07-04

### Fixed
- Synced runtime configuration defaults across `.env.example`, README docs, and the configure skill, and added a config-surface smoke test to catch future drift from runtime `LARK_*` settings.

## [1.9.4] - 2026-07-04

### Fixed
- Changed approved issue-proposal filing to use built-in `gh issue create` first, with GitHub HTTP API fallback when a token is configured, while retaining explicit local CLI tool overrides for advanced setups.

## [1.9.3] - 2026-07-04

### Fixed
- Exposed `P0` consistently in the issue-proposal action prompt and MCP tool field description, matching the stored proposal schema.

## [1.9.2] - 2026-07-04

### Fixed
- Removed startup-time `npm install` lifecycle hooks from the root and plugin package manifests, so MCP startup no longer performs dependency installation work on every launch.

## [1.9.1] - 2026-07-04

### Fixed
- Allowed `npm start -- --dry-run` to validate local startup wiring without real Lark app credentials, while keeping live startup strict about missing `LARK_APP_ID` / `LARK_APP_SECRET`.

## [1.9.0] - 2026-07-03

### Added
- Added a guarded low-risk PR proposal path for periodic review workflows: eligible issue proposals can call an allowlisted `gh_low_risk_pr_create` local CLI wrapper through `create_low_risk_pr_from_proposal`, record the PR URL, and still never merge or release automatically.

## [1.8.3] - 2026-07-03

### Fixed
- Routed prompt cronjobs through the same `codex exec` delivery path as chat messages in `exec` mode, so scheduled prompt reports start real Codex turns and persist success/failure instead of waiting for the watchdog timeout after a channel notification is only acknowledged.

## [1.8.2] - 2026-07-03

### Changed
- Moved the disabled default `plugin-self-review` cronjob preset one hour earlier to `weekly on fri at 17:00`; the low-risk auto-fix preset remains `weekly on fri at 18:00`.

## [1.8.1] - 2026-07-03

### Fixed
- Changed the disabled default self-review and low-risk auto-fix cronjob presets to `weekly on fri at 18:00`, while keeping both jobs paused until the maintainer explicitly enables them.

## [1.8.0] - 2026-07-03

### Added
- Added a durable issue-proposal workflow for periodic Codex reviews: review jobs can create/list/reject local proposals, then file GitHub issues only after explicit maintainer approval through an allowlisted `gh_issue_create` local CLI tool.
- Added Codex exec action bridge support for issue proposals and for creating disabled-by-default self-review / low-risk auto-fix cronjob presets.
- Added `create_default_review_jobs`, which preconfigures `plugin-self-review` and `plugin-low-risk-auto-fix` as paused jobs so users must explicitly enable them before any self-review or self-fix automation runs.

## [1.7.10] - 2026-07-02

### Fixed
- Added an explicit per-job `meta.timezone` field for cronjobs, with legacy-job backfill from `LARK_CRON_TIMEZONE`, so changing the global default no longer silently retimes existing jobs.
- Evaluated scheduler `next_run_at` and missed-run recovery using each job's stored timezone, while keeping persisted timestamps in UTC ISO format.
- Updated job creation, update, listing, and Codex exec action bridge responses to accept/render IANA timezones and show both wall-clock time and UTC.

## [1.7.9] - 2026-07-02

### Fixed
- Added durable cronjob run/output/delivery status fields so report-like scheduled jobs expose whether the latest run started, generated output, and was delivered through Feishu.
- Ensured prompt cronjob reports are user-visible through the Feishu channel: successful reports are recorded only after `reply` delivery succeeds, notification failures send an error report to the target chat, and pending prompt runs emit a Feishu error report if Codex never replies.
- Routed transient error-report delivery failures back through the scheduler retry loop instead of silently marking the report failed on disk.

## [1.7.8] - 2026-07-02

### Fixed
- Changed generated rich Markdown Feishu cards to aitask-style body-only Schema 2.0 cards with `config.width_mode="fill"` and no generated `header`/`template`, so automatic rich replies render like Markdown content instead of traditional app cards.
- Aligned Markdown table card elements with aitask by using stable `c0`/`c1` column keys, auto-width text columns, and the same compact gray header style.

## [1.7.7] - 2026-07-02

### Fixed
- Restored bridge-layer rich Markdown auto-rendering to Feishu Schema 2.0 interactive cards for headings, fenced code blocks, Markdown tables, multi-item lists, and structured analysis, while keeping simple replies as text and allowing `format="text"` to force plain text.
- Converted Markdown tables into v2 card table elements and added generated-card delivery fallback to the original text reply when card construction or delivery fails before any card is sent.

## [1.7.6] - 2026-07-02

### Changed
- Changed default Feishu replies to send Markdown/text as normal copyable text messages; generated cards now require explicit `format="card"` or a raw `card` payload.

## [1.7.5] - 2026-06-29

### Added
- Added Codex exec action bridge support for `list_jobs`, `update_job`, `disable_job`, `delete_job`, and `upsert_job`, with stable `job_id` reporting so existing reminders can be modified instead of recreated.

## [1.7.4] - 2026-06-25

### Fixed
- Rejected unsupported `create_job.schedule` aliases such as `once`, `now`, `later`, and one-off timestamp forms during Codex exec action parsing, with a supported-format hint before job creation runs.
- Hardened the Codex exec action prompt so `create_job` uses recurring aliases or 5-field cron schedules only.

## [1.7.3] - 2026-06-22

### Fixed
- Treated Feishu `230011` withdrawn-message reply failures as non-retryable delivery skips, suppressing raw OpenAPI fallback and closing the active turn as no-reply instead of surfacing a misleading Codex delivery failure.

## [1.7.2] - 2026-06-20

### Added
- Added owner-only file permissions and best-effort 12-hour retention cleanup for Codex exec progress side-channel files under `.lark-progress/turn-*`.

## [1.7.1] - 2026-06-19

### Fixed
- Ensured Codex exec timeouts are handled by the exec delivery layer, with a visible English timeout reply, no fresh-session fallback after timeout, and a queue guardrail that leaves a reply buffer.

## [1.7.0] - 2026-06-18

### Removed
- Removed the built-in `create_github_issue` Codex exec action and `LARK_GITHUB_*` configuration surface from the core Lark bridge. GitHub issue creation should now be modeled as an explicitly configured `run_local_cli_tool` workflow when needed.

## [1.6.4] - 2026-06-18

### Added
- Added a bounded Codex exec progress side channel so long-running IM/doc-comment turns can emit validated milestone updates before the final reply, with token validation, identity-field rejection, low-signal filtering, rate/length/count limits, and safe fallback when progress setup is unavailable.

## [1.6.3] - 2026-06-18

### Changed
- Upgraded `@larksuite/channel` to `^0.2.0`, aligned the direct `@larksuiteoapi/node-sdk` dependency to `^1.67.0`, and raised the `protobufjs` override to `7.6.4` so root and wrapper dependency audits resolve without vulnerabilities.
- Treat user emoji reactions on tracked bot messages as normal interaction turns, interpreting `DONE`/`OK`/`THUMBSUP` with the reacted bot message context instead of classifying them as passive acknowledgements by emoji type alone.
- Show successful visible side-effect action results, such as created GitHub issue URLs, even when Codex exec also returns normal reply text; successful `save_memory` actions remain silent when a reply is already present.

## [1.6.2] - 2026-06-18

### Added
- Added an optional `create_github_issue` Codex exec action bridge with default-off configuration, repo policy checks, bounded `gh issue create` execution, audit logging, and same-turn IM/doc-comment result reporting.
- Routed real user emoji reactions on tracked bot replies into Codex as low-noise `reaction` turns so Codex can decide whether to return `[LARK_NO_REPLY]` or send a visible follow-up.

### Changed
- Prioritized quoted interactive-card context hydration through event/outbound cache, bot `messages/mget`, then optional user `messages/mget`, while keeping legacy SDK/raw fetches as compatibility fallbacks.
- Strengthened Codex exec prompts and delivery guards so chat/doc-comment final answers cannot imply post-reply background follow-up without a structured action, defer/no-reply marker, or scheduled job.

### Fixed
- Preserved bot self-reaction echo filtering while allowing user reactions such as `DONE` on bot replies to reach the runtime.
- Raised dependency overrides/locks for `form-data` and `hono` so the release audit gate no longer reports high-severity advisories.

## [1.6.1] - 2026-06-18

### Added
- Added recent Lark thread context rendering so prompts can include the nearby chat turns that led into the current message without duplicating quoted-message bodies.

### Changed
- Consolidated Lark message context schema and envelope rendering behind shared helpers used by quoted-message hydration, outbound cache context, and recent-thread context.
- Split memory enrichment, doc-comment inbound handling, and inbound turn preparation out of `LarkChannel` to keep channel orchestration boundaries focused.

## [1.6.0] - 2026-06-17

### Added
- Standardized hydrated quoted/referenced Lark message context as a `lark_message` envelope with role, source, identity, message ids, chat/thread metadata, timestamps, sender type, hydration status, and interactive-card metadata.
- Added compact `lark-cli` card text detection so `<card title="...">...</card>` hydration results are preserved as readable card text and marked with `raw_content_shape: card_text`; raw Feishu card JSON remains routed through the safe interactive-card text extractor and marked `feishu_card_json`.

### Changed
- Quoted Interactive Card prompt context now renders `interactive_card` consistently across outbound cache, SDK/raw Feishu API fetches, and optional `lark-cli` user fallback, while preserving existing explicit failure diagnostics and recovery hints.

## [1.5.20] - 2026-06-17

### Fixed
- Added a best-effort `lark-cli im +messages-mget --as user` fallback for quoted Interactive Card hydration when outbound cache and bot-identity SDK/raw fetches miss, covering P2P bot-card visibility gaps where user identity can still read the card.
- Added explicit `user_mget` diagnostics for user-identity fallback empty, unavailable, timeout, and error cases so quoted-card hydration failures remain actionable instead of silently falling back to placeholder context.

## [1.5.19] - 2026-06-17

### Fixed
- Fixed quoted bot-authored Interactive Card context when bot/user fetch identities diverge by caching plugin-sent card context on the returned `message_id`, hydrating quoted cards from that cache before OpenAPI fetches, and surfacing `fetch_identity`/`fetch_result` plus a Codex recovery hint when bot-identity fetch still cannot access the quoted card.

## [1.5.18] - 2026-06-17

### Fixed
- Changed quoted-card `messages/mget` hydration to match `lark-cli im +messages-mget`: `GET /open-apis/im/v1/messages/mget?card_msg_content_type=raw_card_content&message_ids=...`, avoiding the previous raw `POST` shape that returned 404 in runtime.

## [1.5.17] - 2026-06-17

### Fixed
- Fixed quoted Interactive Card hydration fallback for Feishu `messages/mget` responses that expose message content at the top-level `content` field, and surfaced safe `fetch_stage`/diagnostic metadata when quoted-message hydration still fails.

## [1.5.16] - 2026-06-17

### Added
- Added configurable retention cleanup for Codex exec resume-pointer records under `~/.codex/channels/lark/codex-sessions/`, with a 14-day default TTL, dry-run logging, active/recent/abnormal skips, empty-directory pruning, and cleanup metrics.

## [1.5.15] - 2026-06-17

### Fixed
- Hydrate quoted Lark messages as structured context with message id, type, status, recursive reply chain, depth/budget limits, deduplication, and explicit failure markers so quoted Interactive Card placeholders do not let memory context dominate the turn.

## [1.5.14] - 2026-06-16

### Changed
- Documented the doc-comment SDK decision: receive and selected-text context stay SDK-backed, while reply/create writes remain raw-only until SDK semantics preserve reply/comment ids and strict thread scope.
- Added transport policy smoke coverage for the doc-comment SDK decision.

## [1.5.13] - 2026-06-16

### Fixed
- Made `save-skill` smoke audit-log polling wait for the expected success audit line instead of returning as soon as the log file exists.

## [1.5.12] - 2026-06-16

### Fixed
- Updated the channel SDK migration document to reflect the shipped quoted-card `fetchMessageText` SDK/raw get/mget fallback path.
- Added doc smoke coverage to prevent stale quoted-card fallback migration wording from returning.

## [1.5.11] - 2026-06-16

### Changed
- Added script-friendly shared smoke-test fixtures under `scripts/test-helpers/` for MCP tool handler capture, noop memory, mock Lark client, mock transport, and private-chat channel setup.
- Migrated the tool-context and job-tool smoke tests to the shared fixtures while preserving their lightweight script style and behavior.

## [1.5.10] - 2026-06-16

### Changed
- Completed the #89 MCP tool-domain split by moving reply/defer/download, message mutation, memory write, and cronjob tool registrations into focused modules.
- Reduced `src/tools.ts` to registration orchestration while preserving root compatibility exports and public MCP tool schemas.

## [1.5.9] - 2026-06-16

### Changed
- Introduced a shared `ToolContext` for MCP tool registration dependencies, caller resolution, profile-distillation dispatch, transport resolution, and turn-satisfaction helpers.
- Split doc-comment and memory-transparency MCP tool registrations into focused domain modules while preserving public tool names, schemas, and behavior.

## [1.5.8] - 2026-06-15

### Changed
- Split `LarkTransport` internals into message, reaction, resource, doc-comment, and card-context modules while preserving the public transport facade.
- Generalized SDK fallback diagnostics and documented transport fallback/fail-closed policy for SDK-backed operations.

## [1.5.7] - 2026-06-15

### Changed
- Completed the remaining #90 inbound-boundary split by extracting legacy message normalization, inbound image download handling, and display-name resolution out of `LarkChannel` while keeping channel-level ack, queue, memory, and quoted-context orchestration unchanged.

## [1.5.6] - 2026-06-15

### Changed
- Extracted quoted parent/root context selection and best-effort fetch enrichment into a shared quoted-context loader used by both legacy and SDK message paths.

## [1.5.5] - 2026-06-15

### Changed
- Extracted Lark reaction routing into a shared router used by both legacy WebSocket events and SDK reaction events, keeping `LarkChannel` as the orchestration facade while preserving passive reaction behavior.

## [1.5.4] - 2026-06-15

### Changed
- Consolidated message text, mention, fetched-card normalization, and attachment parsing behind shared message-content helpers used by both inbound channel handling and Lark transport fetch paths.

## [1.5.3] - 2026-06-15

### Changed
- Documented MCP-tool versus Codex-exec Lark action parity and shared the tracked bot-message scope guard between MCP message mutations and Codex exec recall actions.

## [1.5.2] - 2026-06-15

### Fixed
- Restricted `edit_message` to tracked bot messages in the current chat/thread and aligned its mutation guard with `recall_message`.

## [1.5.1] - 2026-06-15

### Fixed
- Resynchronized the packaged `plugins/lark/src` runtime source with the workspace `src` source and added a test gate so future wrapper-source drift fails before release.

## [1.5.0] - 2026-06-15

### Added
- Added protected `recall_message` support for tracked bot messages, exposed through MCP tools and Codex exec structured actions with chat/thread scope checks and audit logging.
- Added transport support for SDK/raw message recall with raw OpenAPI fallback when SDK recall fails.

## [1.4.1] - 2026-06-15

### Fixed
- Added raw OpenAPI fallback and structured diagnostics when SDK outbound `send` fails, preventing SDK `Internal Error` responses from surfacing as failed Codex exec replies.

## [1.4.0] - 2026-06-15

### Added
- Added a unified `LarkTransport` boundary for SDK-first Lark IM send/edit/reaction/download/fetch operations, with raw OpenAPI access contained inside the transport fallback.
- Added transport smoke coverage for SDK sends, deterministic raw scheduler sends, edits, card updates, reactions, doc-comment writes, and quoted interactive-card fallback.

### Changed
- Production reply, edit, reaction, attachment download, doc-comment reply/create, Codex exec error reply, and fixed-message scheduler paths now call the transport boundary instead of scattered direct OpenAPI calls.
- SDK runtime now swaps the channel to an SDK-backed transport after startup while preserving `LARK_CHANNEL_RUNTIME=legacy` rollback.
- Quoted/root interactive-card context fetching now uses the same transport fallback for SDK and legacy paths, including cached `messages/mget` recovery when only `[Interactive Card]` or client-upgrade placeholders are available.
- Scheduler fixed-message delivery keeps the existing one-shot Feishu write semantics while routing through transport with deterministic `uuid`.

## [1.3.0] - 2026-06-15

### Added
- Added a live SDK channel runtime bridge that connects `@larksuite/channel` `message`, `comment`, and `reaction` events into the existing local Codex processing pipeline.
- Added SDK runtime smoke coverage with a fake SDK channel, covering live event registration, message delivery, doc-comment delivery, server-derived identity binding, attachment metadata, and passive reaction handling.

### Changed
- `LARK_CHANNEL_RUNTIME` now defaults to `sdk` for internal testing.
- `LARK_CHANNEL_RUNTIME=legacy` remains available as a rollback path to the pre-SDK WebSocket runtime.
- Updated SDK rollout documentation, README configuration tables, and `.env.example` for the SDK-default runtime.

## [1.2.0] - 2026-06-14

### Added
- Added the first SDK migration layer with `LARK_CHANNEL_RUNTIME=legacy|sdk`, defaulting to the existing legacy runtime while allowing SDK scaffold validation in dry-run mode.
- Added `@larksuite/channel` scaffold loading with stderr-only logging checks and live SDK startup fail-closed until rollout criteria are met.
- Added SDK dry-run parity adapters and smoke tests for server-derived identity binding, reserved terminal-id rejection, normalized message mapping, doc-comment identity envelopes, outbound reply/edit/reaction/defer mappings, and SDK rollout documentation.
- Added `npm run smoke:sdk` plus `docs/sdk-channel-rollout.md` covering SDK validation commands, rollback steps, workspace/marketplace/cache sync requirements, and criteria for making SDK the default or removing the legacy path.

### Changed
- Documented `LARK_CHANNEL_RUNTIME` in README and `.env.example`; `sdk` remains validation-only for 1.2.0 and real operation should keep `legacy` or leave the variable unset.

## [1.1.3] - 2026-06-14

### Added
- Added a parent-process Codex exec action bridge for `save_memory`, `create_job`, and `run_local_cli_tool`, so exec mode can safely invoke supported built-in Lark actions without exposing caller identity fields to model output.
- Added `npm run stop` / `scripts/stop.sh` to safely stop a matching plugin process or clear stale single-instance locks without killing unrelated processes.
- Added default-off Stage 2 profile distillation from recent episodes into tiered profiles, gated by minimum episode count, per-user cooldown, per-user locking, L1/L2 safety checks, and audit logging.

### Changed
- Default Codex exec working directory now uses an isolated channel workdir, with startup diagnostics for `.mcp.json` / profile recursion risk.
- Session-health nudges now prefer reported Codex exec token/context usage when JSONL exposes it, falling back to prompt-byte heuristics only when usage is unavailable.

### Fixed
- Exec-mode structured Lark actions now execute in the parent bridge with server-derived caller identity instead of being unavailable to `codex exec`.
- Interactive-card thread roots now keep `thread_id` / `omt_*` separate from root `om_*` message ids and can recover readable card content through `messages/mget` when event/parent context contains only client-upgrade placeholders.
- Episode filenames now avoid same-millisecond overwrites so profile distillation thresholds and episode history remain accurate.

## [1.1.2] - 2026-06-14

### Added
- `scripts/start.sh` now prefixes launcher and child-process stderr lines with local timestamps while keeping MCP stdout clean.
- Added a launcher smoke test to guard timestamped stderr output and stdout cleanliness.

## [1.1.1] - 2026-06-14

### Security
- Blocked the reserved `__terminal__` owner fallback while active Lark channel turns are in flight.
- Made `save_skill` owner-only with server-derived caller identity and audit logging because skills are global across users and chats.
- Stopped `run_local_cli_tool` from inheriting the plugin process environment by default; tool configs must now explicitly use `envAllowlist`, literal `env`, or opt-in `inheritEnv`.
- Updated the locked `tsx` / `esbuild` dependency set so `npm run audit:deps` passes again.

### Fixed
- Aligned README, AGENTS, `.env.example`, and MCP server instructions with the current tool list and config surface.
- Rejected invalid numeric configuration values at startup instead of silently falling back or accepting unsafe ranges.

## [1.1.0] - 2026-06-14

### Added
- Persistent acknowledgement reactions for Feishu doc-comment turns, including comment-event smoke coverage.
- Session health nudges for long-running Codex exec sessions, gated by idle queue/ack/turn state and owner-only notifications.
- `run_local_cli_tool` for allowlisted host-local CLI execution with server-derived caller identity, per-tool caller authorization, parameter allow/block filters, bounded output, secret redaction, and audit logging.

### Changed
- MCP server metadata now reads the version from package metadata, and release checks verify package, wrapper, plugin manifest, README badge, and changelog versions stay aligned.
- Repeated memory context injection is deduplicated per chat/thread scope, with invalidation after delivery failures so the next turn receives full context again.

### Fixed
- Local CLI tool lookup now uses own-property resolution and rejects the system-flush sentinel, avoiding accidental execution from synthetic memory-distillation turns.

## [1.0.12] - 2026-06-08

### Fixed
- Suppressed Feishu replies for synthetic auto-flush `flush-*` turns so exec failures no longer call `message.reply` with invalid open message ids.
- Added defensive `reply_to` validation and sanitized Feishu/Axios error logging to avoid leaking authorization headers while preserving Feishu diagnostic codes and log ids.

## [1.0.11] - 2026-06-08

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

[Unreleased]: https://github.com/IS908/codex-lark-plugin/compare/v1.7.4...HEAD
[1.7.4]: https://github.com/IS908/codex-lark-plugin/compare/v1.7.3...v1.7.4
[1.7.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/IS908/codex-lark-plugin/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.6.4...v1.7.0
[1.6.4]: https://github.com/IS908/codex-lark-plugin/compare/v1.6.3...v1.6.4
[1.6.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/IS908/codex-lark-plugin/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.20...v1.6.0
[1.5.20]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.19...v1.5.20
[1.5.19]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.18...v1.5.19
[1.5.18]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.17...v1.5.18
[1.5.17]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.16...v1.5.17
[1.5.16]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.15...v1.5.16
[1.5.15]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.14...v1.5.15
[1.5.14]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.13...v1.5.14
[1.5.13]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.12...v1.5.13
[1.5.12]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.11...v1.5.12
[1.5.11]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.10...v1.5.11
[1.5.10]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.9...v1.5.10
[1.5.9]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.8...v1.5.9
[1.5.8]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.7...v1.5.8
[1.5.7]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.6...v1.5.7
[1.5.6]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.5...v1.5.6
[1.5.5]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.4...v1.5.5
[1.5.4]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/IS908/codex-lark-plugin/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/IS908/codex-lark-plugin/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/IS908/codex-lark-plugin/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/IS908/codex-lark-plugin/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/IS908/codex-lark-plugin/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.12...v1.1.0
[1.0.12]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/IS908/codex-lark-plugin/compare/v1.0.10...v1.0.11
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
